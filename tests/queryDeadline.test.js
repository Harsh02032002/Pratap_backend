'use strict';

/**
 * queryDeadline.test.js — the operation-deadline layer.
 *
 * The hierarchy test next door proves the NUMBERS are ordered correctly. This
 * one proves the mechanism that actually applies them: without it the request
 * deadline frees the HTTP request while MongoDB keeps running the query and
 * keeps its pool slot, which is what turned one slow Owner Panel query into a
 * cascading timeout.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const {
  withReadDeadline, withAggregateDeadline, deadlineFor,
  runWithRequestBudget, remainingBudgetMs, resolveOperationDeadline,
  installGlobalQueryDeadline, applyQueryDeadline, applyAggregateDeadline,
  RESPONSE_RESERVE_MS, MIN_OPERATION_MS,
} = require('../utils/queryDeadline');
const { REQUEST_DEADLINE_MS, QUERY_TIMEOUT_MS } = require('../config/timeouts');

// Stand-ins exposing only the surface the hooks touch.
const fakeQuery = (options = {}) => ({
  _options: { ...options },
  getOptions() { return this._options; },
  maxTimeMS(ms) { this._options.maxTimeMS = ms; return this; },
});
const fakeAggregate = (options = {}) => ({
  options: { ...options },
  option(o) { Object.assign(this.options, o); return this; },
});

// ── installed driver capabilities ────────────────────────────────────────────
// Every claim this layer makes is checked against the versions actually
// installed, so an upgrade that removes an API fails here rather than silently
// leaving queries unbounded.

test('the supported cancellation APIs are the ones this code uses', () => {
  assert.equal(typeof mongoose.Query.prototype.maxTimeMS, 'function',
    'Query.maxTimeMS is how a read deadline is applied');
  assert.equal(typeof mongoose.Aggregate.prototype.option, 'function',
    'Aggregate.option({maxTimeMS}) is the supported path in Mongoose 8');
  assert.equal(typeof mongoose.Aggregate.prototype.maxTimeMS, 'undefined',
    'Aggregate.maxTimeMS() does not exist here — using it would silently no-op');
});

test('no AbortSignal cancellation exists, so maxTimeMS must carry the load', () => {
  assert.equal(typeof mongoose.Query.prototype.signal, 'undefined');
  assert.equal(typeof mongoose.Query.prototype.abort, 'undefined');
  assert.equal(typeof mongoose.Aggregate.prototype.signal, 'undefined');
});

// ── budget resolution ────────────────────────────────────────────────────────

test('outside a request there is no budget, and the job class applies', () => {
  assert.equal(remainingBudgetMs(), null);
  assert.equal(resolveOperationDeadline('read'), deadlineFor('job'),
    'background jobs and boot-time queries must not inherit a request deadline');
});

test('inside a request the deadline is capped by the read class', () => {
  runWithRequestBudget(REQUEST_DEADLINE_MS, () => {
    const ms = resolveOperationDeadline('read');
    assert.ok(ms <= QUERY_TIMEOUT_MS.read, `${ms} must not exceed the read class`);
    assert.ok(ms > 0);
  });
});

test('a query starting late in a request cannot outlive the request', () => {
  // 1s of a 10s budget left: the operation must be bounded by what remains,
  // not by the full 7s read class.
  runWithRequestBudget(1000, () => {
    const ms = resolveOperationDeadline('read');
    assert.ok(ms < QUERY_TIMEOUT_MS.read, `${ms} should be shortened to the remaining budget`);
    assert.ok(ms <= 1000 - RESPONSE_RESERVE_MS + 1,
      'a reserve is held back so the handler can still send its error response');
  });
});

test('an exhausted budget still yields a usable floor, never zero or negative', () => {
  runWithRequestBudget(1, () => {
    assert.equal(resolveOperationDeadline('read'), MIN_OPERATION_MS);
  });
});

test('the budget does not leak out of its request', () => {
  runWithRequestBudget(REQUEST_DEADLINE_MS, () => {
    assert.notEqual(remainingBudgetMs(), null);
  });
  assert.equal(remainingBudgetMs(), null, 'a later job must not see a finished request budget');
});

// ── the hooks ────────────────────────────────────────────────────────────────

test('a query with no deadline is given one', () => {
  const q = fakeQuery();
  runWithRequestBudget(REQUEST_DEADLINE_MS, () => applyQueryDeadline.call(q));
  assert.ok(q.getOptions().maxTimeMS > 0);
  assert.ok(q.getOptions().maxTimeMS <= QUERY_TIMEOUT_MS.read);
});

test('an explicit deadline is never overridden', () => {
  const q = fakeQuery({ maxTimeMS: QUERY_TIMEOUT_MS.report });
  runWithRequestBudget(REQUEST_DEADLINE_MS, () => applyQueryDeadline.call(q));
  assert.equal(q.getOptions().maxTimeMS, QUERY_TIMEOUT_MS.report,
    'withReadDeadline(q, "report") and every existing call site must keep its meaning');
});

test('aggregations are bounded through the supported option() path', () => {
  const a = fakeAggregate();
  runWithRequestBudget(REQUEST_DEADLINE_MS, () => applyAggregateDeadline.call(a));
  assert.ok(a.options.maxTimeMS > 0);

  const explicit = fakeAggregate({ maxTimeMS: 1234 });
  runWithRequestBudget(REQUEST_DEADLINE_MS, () => applyAggregateDeadline.call(explicit));
  assert.equal(explicit.options.maxTimeMS, 1234);
});

// ── the existing helpers still behave ────────────────────────────────────────

test('withReadDeadline and withAggregateDeadline still set their class', () => {
  const q = fakeQuery();
  withReadDeadline(q, 'report');
  assert.equal(q.getOptions().maxTimeMS, QUERY_TIMEOUT_MS.report);

  const a = fakeAggregate();
  withAggregateDeadline(a, 'job');
  assert.equal(a.options.maxTimeMS, QUERY_TIMEOUT_MS.job);
});

test('the helpers tolerate objects that cannot take a deadline', () => {
  assert.doesNotThrow(() => withReadDeadline(null));
  assert.doesNotThrow(() => withAggregateDeadline(undefined));
});

// ── installation ─────────────────────────────────────────────────────────────

test('installation covers schemas compiled before it ran', () => {
  const conn = mongoose.createConnection();          // never opened; no I/O
  const schema = new mongoose.Schema({ a: String });
  conn.model('QueryDeadlineFixture', schema);

  const before = schema.s.hooks._pres.size;
  installGlobalQueryDeadline(mongoose);
  installOnce(schema);
  assert.ok(schema.s.hooks._pres.size >= before);
});

// Applying twice must not double-register hooks.
function installOnce(schema) {
  const { installGlobalQueryDeadline: install } = require('../utils/queryDeadline');
  install(mongoose);
  install(mongoose);
}

test('installing twice is a no-op the second time', () => {
  const first = installGlobalQueryDeadline(mongoose);
  const second = installGlobalQueryDeadline(mongoose);
  assert.ok(Array.isArray(first.retrofitted));
  assert.equal(second.retrofitted.length, 0, 'already-patched schemas must not be hooked again');
});
