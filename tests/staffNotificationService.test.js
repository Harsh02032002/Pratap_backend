'use strict';

/**
 * Unit tests for the staff notification service.
 * Run with:  npm test        (uses node --test)
 *
 * No database required — the repository is mocked, so these tests exercise all
 * validation, filtering, authorization-scoping, pagination and shaping logic in
 * isolation and run in milliseconds.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const svc = require('../services/staffNotificationService');

/** A fake repository that records the filter/options it was called with. */
function makeRepo({ docs = [], total = docs.length } = {}) {
  const calls = {};
  return {
    calls,
    async findPage(filter, opts) { calls.findPage = { filter, opts }; return docs; },
    async countByFilter(filter) { calls.countByFilter = { filter }; return total; },
  };
}

const sampleDocs = [
  { _id: 'a1', type: 'task', priority: 'high', read: false, createdAt: new Date('2026-07-10T10:00:00Z'), meta: { title: 'New task', message: 'Clean lobby', ownerSecret: 'hidden' } },
  { _id: 'a2', type: 'complaint', read: true, createdAt: new Date('2026-07-09T10:00:00Z'), meta: { title: 'Complaint', message: 'Leaky tap' } },
];

// ── Authorization scoping ────────────────────────────────────────────────────
test('always scopes the query to the authenticated login id', async () => {
  const repo = makeRepo({ docs: sampleDocs, total: 2 });
  await svc.listForRecipient({ loginId: 'STAFF0001', query: {} }, repo);
  assert.equal(repo.calls.findPage.filter.toLoginId, 'STAFF0001');
  assert.equal(repo.calls.countByFilter.filter.toLoginId, 'STAFF0001');
});

test('client-supplied toLoginId cannot widen/override the scope', async () => {
  const repo = makeRepo({ docs: sampleDocs, total: 2 });
  // Attempt to read another staff member's notifications via the query string.
  await svc.listForRecipient({ loginId: 'STAFF0001', query: { toLoginId: 'STAFF9999' } }, repo);
  assert.equal(repo.calls.findPage.filter.toLoginId, 'STAFF0001');
});

test('missing authenticated login id is rejected', async () => {
  const repo = makeRepo();
  await assert.rejects(
    () => svc.listForRecipient({ loginId: '', query: {} }, repo),
    (e) => e.name === 'ValidationError' && e.errorCode === 'UNAUTHENTICATED'
  );
});

// ── Pagination ───────────────────────────────────────────────────────────────
test('default pagination is page 1, limit 20', async () => {
  const repo = makeRepo({ docs: sampleDocs, total: 42 });
  const res = await svc.listForRecipient({ loginId: 'S1', query: {} }, repo);
  assert.deepEqual(repo.calls.findPage.opts, { skip: 0, limit: 20 });
  assert.deepEqual(res.pagination, {
    page: 1, limit: 20, total: 42, totalPages: 3, hasNext: true, hasPrevious: false,
  });
});

test('computes skip and pagination metadata for a middle page', async () => {
  const repo = makeRepo({ docs: sampleDocs, total: 42 });
  const res = await svc.listForRecipient({ loginId: 'S1', query: { page: '2', limit: '20' } }, repo);
  assert.deepEqual(repo.calls.findPage.opts, { skip: 20, limit: 20 });
  assert.deepEqual(res.pagination, {
    page: 2, limit: 20, total: 42, totalPages: 3, hasNext: true, hasPrevious: true,
  });
});

test('clamps limit to the maximum instead of erroring', async () => {
  const repo = makeRepo({ docs: sampleDocs, total: 500 });
  await svc.listForRecipient({ loginId: 'S1', query: { limit: '9999' } }, repo);
  assert.equal(repo.calls.findPage.opts.limit, svc.MAX_LIMIT);
});

// ── Filtering ────────────────────────────────────────────────────────────────
test('isRead=false maps to read:false', async () => {
  const repo = makeRepo();
  await svc.listForRecipient({ loginId: 'S1', query: { isRead: 'false' } }, repo);
  assert.equal(repo.calls.findPage.filter.read, false);
});

test('isRead=true maps to read:true', async () => {
  const repo = makeRepo();
  await svc.listForRecipient({ loginId: 'S1', query: { isRead: 'true' } }, repo);
  assert.equal(repo.calls.findPage.filter.read, true);
});

test('type and priority filters are applied', async () => {
  const repo = makeRepo();
  await svc.listForRecipient({ loginId: 'S1', query: { type: 'task', priority: 'high' } }, repo);
  assert.equal(repo.calls.findPage.filter.type, 'task');
  assert.equal(repo.calls.findPage.filter.priority, 'high');
});

test('date range builds a createdAt bound', async () => {
  const repo = makeRepo();
  await svc.listForRecipient({ loginId: 'S1', query: { from: '2026-07-01', to: '2026-07-31' } }, repo);
  const c = repo.calls.findPage.filter.createdAt;
  assert.ok(c.$gte instanceof Date && c.$lte instanceof Date);
});

// ── Invalid query parameters ─────────────────────────────────────────────────
test('rejects a non-numeric page', async () => {
  await assert.rejects(
    () => svc.listForRecipient({ loginId: 'S1', query: { page: 'abc' } }, makeRepo()),
    (e) => e.name === 'ValidationError' && e.errorCode === 'INVALID_QUERY'
  );
});

test('rejects an invalid priority', async () => {
  await assert.rejects(
    () => svc.listForRecipient({ loginId: 'S1', query: { priority: 'banana' } }, makeRepo()),
    (e) => e.name === 'ValidationError'
  );
});

test('rejects an invalid isRead value', async () => {
  await assert.rejects(
    () => svc.listForRecipient({ loginId: 'S1', query: { isRead: 'maybe' } }, makeRepo()),
    (e) => e.name === 'ValidationError'
  );
});

test('rejects an inverted date range', async () => {
  await assert.rejects(
    () => svc.listForRecipient({ loginId: 'S1', query: { from: '2026-08-01', to: '2026-07-01' } }, makeRepo()),
    (e) => e.name === 'ValidationError'
  );
});

test('rejects a type with unsafe characters', async () => {
  await assert.rejects(
    () => svc.listForRecipient({ loginId: 'S1', query: { type: 'a b/../$where' } }, makeRepo()),
    (e) => e.name === 'ValidationError'
  );
});

// ── Empty results ────────────────────────────────────────────────────────────
test('empty result set returns [] and zeroed pagination', async () => {
  const repo = makeRepo({ docs: [], total: 0 });
  const res = await svc.listForRecipient({ loginId: 'S1', query: {} }, repo);
  assert.deepEqual(res.data, []);
  assert.deepEqual(res.pagination, {
    page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrevious: false,
  });
});

// ── Output shaping (field selection) ─────────────────────────────────────────
test('shapes docs to only the UI fields and hides internal meta', async () => {
  const repo = makeRepo({ docs: sampleDocs, total: 2 });
  const res = await svc.listForRecipient({ loginId: 'S1', query: {} }, repo);
  assert.deepEqual(Object.keys(res.data[0]).sort(), ['createdAt', 'id', 'isRead', 'message', 'priority', 'title', 'type']);
  assert.equal(res.data[0].id, 'a1');
  assert.equal(res.data[0].title, 'New task');
  assert.equal(res.data[0].isRead, false);
  assert.equal(res.data[0].priority, 'high');
  // Internal / owner-only meta never leaks to the client shape.
  assert.equal('ownerSecret' in res.data[0], false);
});

test('shape defaults missing priority to "normal" and missing read to false', async () => {
  const shaped = svc.shapeNotification({ _id: 'x', type: 'info', meta: {} });
  assert.equal(shaped.priority, 'normal');
  assert.equal(shaped.isRead, false);
});
