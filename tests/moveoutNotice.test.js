'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { calcNoticeEndDate, isOnNotice } = require('../services/moveoutService');

// ── calcNoticeEndDate ────────────────────────────────────────────────────────
// The notice clock starts the day the OWNER APPROVES the move-out, and runs a
// fixed one calendar month.

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

test('adds one calendar month to the approval date', () => {
  assert.strictEqual(ymd(calcNoticeEndDate(new Date('2026-09-01T10:00:00'))), '2026-10-01');
});

test('clamps to the last day when the next month is shorter', () => {
  // 31 Jan + 1 month would overflow into 3 March; must land on 28 Feb.
  assert.strictEqual(ymd(calcNoticeEndDate(new Date('2026-01-31T10:00:00'))), '2026-02-28');
});

test('handles a leap-year February', () => {
  assert.strictEqual(ymd(calcNoticeEndDate(new Date('2028-01-29T10:00:00'))), '2028-02-29');
});

test('rolls over the year boundary', () => {
  assert.strictEqual(ymd(calcNoticeEndDate(new Date('2026-12-15T10:00:00'))), '2027-01-15');
});

test('normalises to start of day so the 01:00 completion job fires that same date', () => {
  // Keeping the approval's time-of-day would push completion to the next day's
  // run, making the tenant serve a month plus a day.
  const end = calcNoticeEndDate(new Date('2026-09-01T15:40:33'));
  assert.strictEqual(end.getHours(), 0);
  assert.strictEqual(end.getMinutes(), 0);
  assert.strictEqual(end.getSeconds(), 0);
  assert.strictEqual(end.getMilliseconds(), 0);
});

// ── isOnNotice ───────────────────────────────────────────────────────────────

test('a pending request is not on notice', () => {
  assert.strictEqual(isOnNotice({ status: 'active', moveoutRequest: { status: 'pending' } }), false);
});

test('an approved request that has not completed is on notice', () => {
  assert.strictEqual(isOnNotice({ status: 'active', moveoutRequest: { status: 'approved' } }), true);
});

test('a completed move-out is no longer on notice', () => {
  assert.strictEqual(
    isOnNotice({ status: 'inactive', moveoutRequest: { status: 'approved', completedAt: new Date() } }),
    false
  );
});

test('a rejected request is not on notice', () => {
  assert.strictEqual(isOnNotice({ status: 'active', moveoutRequest: { status: 'rejected' } }), false);
});

test('a tenant with no move-out request is not on notice', () => {
  assert.strictEqual(isOnNotice({ status: 'active' }), false);
});
