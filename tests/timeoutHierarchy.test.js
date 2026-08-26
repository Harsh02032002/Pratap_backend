'use strict';

/**
 * Guards the timeout hierarchy.
 *
 * The bug this prevents is subtle and silent: someone raises one value in
 * isolation, the ordering inverts again, and the symptom (pool saturation,
 * "random" API timeouts) shows up days later somewhere unrelated. These tests
 * fail the build the moment the ordering breaks.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const cfg = require('../config/timeouts');
const { classifyDbTimeout, isExempt, getTimeoutCounters, resetTimeoutCounters } =
  require('../middleware/requestDeadline');
const { withReadDeadline, withAggregateDeadline, deadlineFor } = require('../utils/queryDeadline');

// ─────────────────────────────────────────────────────────────────────────────
// 1. The ordering itself
// ─────────────────────────────────────────────────────────────────────────────

test('HIERARCHY: client > request deadline > read query > pool wait', () => {
  const { CLIENT_TIMEOUT_MS, REQUEST_DEADLINE_MS, QUERY_TIMEOUT_MS, MONGO } = cfg;

  assert.ok(REQUEST_DEADLINE_MS < CLIENT_TIMEOUT_MS,
    `request deadline (${REQUEST_DEADLINE_MS}) must be under the client timeout (${CLIENT_TIMEOUT_MS}) ` +
    'or the server never gets to explain why it failed');

  assert.ok(QUERY_TIMEOUT_MS.read < REQUEST_DEADLINE_MS,
    `read maxTimeMS (${QUERY_TIMEOUT_MS.read}) must be under the request deadline (${REQUEST_DEADLINE_MS}) ` +
    'so MongoDB kills the query while the handler can still respond');

  assert.ok(MONGO.waitQueueTimeoutMS < QUERY_TIMEOUT_MS.read,
    `pool wait (${MONGO.waitQueueTimeoutMS}) must be under the read deadline (${QUERY_TIMEOUT_MS.read}) ` +
    'so a saturated pool fails fast instead of consuming the whole request budget');

  assert.ok(MONGO.serverSelectionTimeoutMS < REQUEST_DEADLINE_MS,
    'server selection must resolve inside the request deadline');
  assert.ok(MONGO.connectTimeoutMS < REQUEST_DEADLINE_MS,
    'a new connection handshake must fit inside the request deadline');
  assert.ok(cfg.MONGOOSE_BUFFER_TIMEOUT_MS < REQUEST_DEADLINE_MS,
    'mongoose buffering must not consume the whole request budget during a reconnect');
});

test('the pre-fix inverted values are gone', () => {
  const { MONGO } = cfg;
  assert.notStrictEqual(MONGO.waitQueueTimeoutMS, 30000, 'waitQueueTimeoutMS 30000 was 2.5x the client timeout');
  assert.notStrictEqual(MONGO.serverSelectionTimeoutMS, 30000);
  assert.notStrictEqual(MONGO.connectTimeoutMS, 30000);
  assert.ok(MONGO.socketTimeoutMS < 45000, 'socketTimeoutMS was 45000');
});

test('socketTimeoutMS stays ABOVE request scale on purpose', () => {
  // It is a per-connection setting shared with the scheduled jobs. Squeezing it
  // to ~9s would kill long background aggregations mid-flight (Phase 11).
  assert.ok(cfg.MONGO.socketTimeoutMS > cfg.REQUEST_DEADLINE_MS,
    'socketTimeoutMS is connection-level, not request-level — it must accommodate background jobs');
  assert.ok(cfg.MONGO.socketTimeoutMS >= cfg.QUERY_TIMEOUT_MS.job,
    'socketTimeoutMS must not cut off a job-class query');
});

test('background jobs do not inherit request-scale deadlines', () => {
  assert.ok(cfg.QUERY_TIMEOUT_MS.job > cfg.QUERY_TIMEOUT_MS.read);
  assert.ok(cfg.QUERY_TIMEOUT_MS.job > cfg.REQUEST_DEADLINE_MS,
    'a cron sweep must not die because the browser timeout is 12s');
  assert.ok(cfg.QUERY_TIMEOUT_MS.report > cfg.QUERY_TIMEOUT_MS.read,
    'reports are legitimately slower than dashboard reads');
});

test('HTTP backstops bound the server without truncating uploads', () => {
  assert.ok(cfg.HTTP.requestTimeout < 300000, 'must be below the 300s Node default');
  assert.ok(cfg.HTTP.requestTimeout > cfg.REQUEST_DEADLINE_MS * 2,
    'requestTimeout covers the full request body — uploads need room, so it stays well above the deadline');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Deadline scope
// ─────────────────────────────────────────────────────────────────────────────

test('payment, upload, webhook, report and chat routes are exempt from the deadline', () => {
  for (const p of ['/api/upload', '/api/cashfree/order', '/api/payment/verify',
    '/api/webhook/cashfree', '/api/reports/owner', '/api/chat/messages']) {
    assert.ok(isExempt(p), `${p} must be exempt — cutting it off at 10s would be worse than waiting`);
  }
});

test('dashboard and owner reads DO get a deadline', () => {
  for (const p of ['/api/dashboard/ROOMHY1', '/api/owners/ROOMHY1/properties',
    '/api/owners/ROOMHY1/tenants', '/api/rooms/owner/ROOMHY1']) {
    assert.ok(!isExempt(p), `${p} must be bounded`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Error classification — each failure mode is distinguishable
// ─────────────────────────────────────────────────────────────────────────────

test('pool exhaustion is classified as its own failure mode', () => {
  resetTimeoutCounters();
  const c = classifyDbTimeout(new Error('Timed out while checking out a connection from connection pool'));
  assert.strictEqual(c.reason, 'DB_POOL_WAIT_TIMEOUT');
  assert.strictEqual(c.status, 503);
  assert.strictEqual(getTimeoutCounters().poolWaitTimeouts, 1);
});

test('server selection failure is distinguishable from pool exhaustion', () => {
  resetTimeoutCounters();
  const err = new Error('connection timed out');
  err.name = 'MongoServerSelectionError';
  const c = classifyDbTimeout(err);
  assert.strictEqual(c.reason, 'DB_SERVER_SELECTION_TIMEOUT');
  assert.strictEqual(getTimeoutCounters().serverSelectionTimeouts, 1);
});

test('a maxTimeMS kill is classified as a query timeout', () => {
  resetTimeoutCounters();
  const err = new Error('operation exceeded time limit');
  err.code = 50;
  const c = classifyDbTimeout(err);
  assert.strictEqual(c.reason, 'DB_QUERY_TIMEOUT');
  assert.strictEqual(getTimeoutCounters().queryTimeouts, 1);
});

test('mongoose buffering timeout is classified as disconnected', () => {
  resetTimeoutCounters();
  const c = classifyDbTimeout(new Error('Operation `owners.findOne()` buffering timed out after 3000ms'));
  assert.strictEqual(c.reason, 'DB_DISCONNECTED');
});

test('unrelated errors are passed through untouched', () => {
  assert.strictEqual(classifyDbTimeout(new Error('ValidationError: name required')), null);
  assert.strictEqual(classifyDbTimeout(null), null);
});

test('driver internals are never returned to the caller', () => {
  const c = classifyDbTimeout(new Error(
    'Timed out while checking out a connection from connection pool: mongodb+srv://user:secret@host'));
  assert.ok(!c.message.includes('mongodb+srv'), 'connection strings must not leak');
  assert.ok(!c.message.includes('secret'));
  assert.ok(!/pool/i.test(c.message), 'user-facing copy should not expose internals');
});

test('every classified timeout is 503 so clients can back off, not a misleading 500', () => {
  for (const msg of ['connection pool timeout', 'server selection error', 'buffering timed out']) {
    const c = classifyDbTimeout(new Error(msg));
    if (c) assert.strictEqual(c.status, 503);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Query deadline helpers — verified against the INSTALLED driver
// ─────────────────────────────────────────────────────────────────────────────

test('withReadDeadline sets maxTimeMS on a real Mongoose query', () => {
  const M = mongoose.models.__TimeoutProbe__
    || mongoose.model('__TimeoutProbe__', new mongoose.Schema({ a: String }));
  const q = withReadDeadline(M.find({ a: 'x' }));
  assert.strictEqual(q.getOptions().maxTimeMS, cfg.QUERY_TIMEOUT_MS.read);
});

test('withReadDeadline honours the job class', () => {
  const M = mongoose.models.__TimeoutProbe__;
  assert.strictEqual(withReadDeadline(M.find(), 'job').getOptions().maxTimeMS, cfg.QUERY_TIMEOUT_MS.job);
  assert.strictEqual(withReadDeadline(M.find(), 'report').getOptions().maxTimeMS, cfg.QUERY_TIMEOUT_MS.report);
});

test('withAggregateDeadline uses .option() — Aggregate has no maxTimeMS() in Mongoose 8', () => {
  // Documents why the two helpers differ; if this ever changes, update the util.
  assert.strictEqual(typeof mongoose.Aggregate.prototype.maxTimeMS, 'undefined');
  const M = mongoose.models.__TimeoutProbe__;
  const agg = withAggregateDeadline(M.aggregate([{ $match: {} }]));
  assert.strictEqual(agg.options.maxTimeMS, cfg.QUERY_TIMEOUT_MS.read);
});

test('the helpers tolerate a non-query argument instead of throwing', () => {
  assert.deepStrictEqual(withReadDeadline(null), null);
  assert.deepStrictEqual(withAggregateDeadline(undefined), undefined);
});

test('deadlineFor falls back to the read class for an unknown name', () => {
  assert.strictEqual(deadlineFor('nonsense'), cfg.QUERY_TIMEOUT_MS.read);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Wiring
// ─────────────────────────────────────────────────────────────────────────────

test('server.js uses the shared config, not inline timeout literals', () => {
  const src = read('server.js');
  assert.match(src, /const mongoOptions = \{ \.\.\.MONGO \}/);
  assert.ok(!/waitQueueTimeoutMS:\s*30000/.test(src), 'inline inverted values must be gone');
  assert.match(src, /mongoose\.set\('bufferTimeoutMS'/);
  assert.match(src, /app\.use\('\/api', requestDeadline\)/);
  assert.match(src, /app\.use\(dbTimeoutErrorHandler\)/);
  assert.match(src, /server\.requestTimeout = HTTP\.requestTimeout/);
});

test('the db timeout handler runs before the generic 500 handler', () => {
  const src = read('server.js');
  assert.ok(src.indexOf('app.use(dbTimeoutErrorHandler)') < src.indexOf('app.use((err, req, res, next)'),
    'otherwise every DB timeout surfaces as an opaque 500');
});

test('the generic error handler cannot double-send after a deadline response', () => {
  const src = read('server.js');
  const idx = src.indexOf('app.use((err, req, res, next)');
  assert.match(src.slice(idx, idx + 400), /res\.headersSent \|\| res\.writableEnded/);
});

test('hot dashboard queries carry a server-side deadline', () => {
  const src = read('routes/dashboardRoutes.js');
  const bounded = (src.match(/withReadDeadline\(/g) || []).length;
  assert.ok(bounded >= 7, `expected the dashboard reads to be bounded, found ${bounded}`);
});

test('the dead config files are marked so nobody tunes the wrong one', () => {
  for (const rel of ['config/db.js', 'config/database.js']) {
    assert.match(read(rel), /NOT USED BY THE RUNNING APPLICATION/,
      `${rel} is never required by the app and must say so`);
  }
});

test('pool size is unchanged pending load-test data', () => {
  // Raising maxPoolSize x process-count without knowing the PM2 topology could
  // mean hundreds of Atlas connections. Deliberately deferred.
  assert.strictEqual(cfg.MONGO.maxPoolSize, 10);
  assert.match(read('config/timeouts.js'), /deliberately UNCHANGED/);
});
