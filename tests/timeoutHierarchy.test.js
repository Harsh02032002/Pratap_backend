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

  // NOT "waitQueue < read maxTimeMS". That was the original assertion here and
  // it was wrong: it forced waitQueueTimeoutMS below connectTimeoutMS, so a
  // waiter gave up before the connection it was waiting for could finish being
  // established. The result was "Timed out while checking out a connection from
  // connection pool" at boot with the pool only 4/10 in use — not saturation,
  // just a pool that had not finished growing.
  assert.ok(MONGO.waitQueueTimeoutMS > MONGO.connectTimeoutMS,
    `pool wait (${MONGO.waitQueueTimeoutMS}) must EXCEED connect (${MONGO.connectTimeoutMS}) — ` +
    'a waiter is often waiting for a NEW connection, which is allowed connectTimeoutMS to establish');

  assert.ok(MONGO.waitQueueTimeoutMS < REQUEST_DEADLINE_MS,
    `pool wait (${MONGO.waitQueueTimeoutMS}) must stay under the request deadline ` +
    `(${REQUEST_DEADLINE_MS}) so the deadline remains the outer bound on a request`);

  // The full mandated chain. This link was dropped while connectTimeoutMS was
  // 8s, because it could not hold at the same time as waitQueue > connect. Both
  // hold now that connect is 2.5s, so the chain is complete again.
  assert.ok(MONGO.waitQueueTimeoutMS < QUERY_TIMEOUT_MS.read,
    `pool wait (${MONGO.waitQueueTimeoutMS}) must be under the read deadline ` +
    `(${QUERY_TIMEOUT_MS.read}) so a saturated pool fails fast instead of ` +
    'consuming the budget the query itself needs');

  assert.ok(MONGO.serverSelectionTimeoutMS < REQUEST_DEADLINE_MS,
    'server selection must resolve inside the request deadline');
  assert.ok(MONGO.connectTimeoutMS < REQUEST_DEADLINE_MS,
    'a new connection handshake must fit inside the request deadline');
  assert.ok(cfg.MONGOOSE_BUFFER_TIMEOUT_MS < REQUEST_DEADLINE_MS,
    'mongoose buffering must not consume the whole request budget during a reconnect');
});

test('acquiring a connection cannot consume the request budget', () => {
  const { MONGO, REQUEST_DEADLINE_MS, QUERY_TIMEOUT_MS } = cfg;

  // The configuration this test exists to make impossible: request 10000 with
  // waitQueue 9000 left ~1s of execution, so a request could burn its whole
  // life queueing and 503 without MongoDB ever starting the query.
  const share = MONGO.waitQueueTimeoutMS / REQUEST_DEADLINE_MS;
  assert.ok(share <= 0.4,
    `pool wait is ${Math.round(share * 100)}% of the request budget — it must stay at or under 40%, ` +
    'or a queued request has no meaningful time left to do work');

  // Worst case has to add up: wait the full pool budget, then run a full-length
  // read, and the request deadline is exactly reached rather than overrun.
  assert.ok(MONGO.waitQueueTimeoutMS + QUERY_TIMEOUT_MS.read <= REQUEST_DEADLINE_MS,
    `pool wait (${MONGO.waitQueueTimeoutMS}) + read (${QUERY_TIMEOUT_MS.read}) must not exceed ` +
    `the request deadline (${REQUEST_DEADLINE_MS})`);

  // Named explicitly so the exact pair that caused the incident can never come
  // back through an env override.
  assert.ok(!(REQUEST_DEADLINE_MS === 10000 && MONGO.waitQueueTimeoutMS === 9000),
    'request 10000 / waitQueue 9000 is the configuration this guard exists for');
});

test('connect keeps real headroom over a measured Atlas handshake', () => {
  // Measured on this cluster: 220-520ms with family:4 warm, and 788/1125/1135ms
  // for a full SRV-resolve + connect + auth + ping from a home link.
  assert.ok(cfg.MONGO.connectTimeoutMS >= 2000,
    'below ~2s a cold SRV resolve plus TLS plus auth has no margin');
  assert.ok(cfg.MONGO.connectTimeoutMS < cfg.MONGO.waitQueueTimeoutMS,
    'connect must fit inside the time a waiter is willing to wait for it');
});

test('the pool size is not quietly widened instead of fixing the queue', () => {
  // Raising this is a load-test decision, not a timeout fix: a bigger pool with
  // unbounded queries just lets more requests pile onto slow work.
  assert.strictEqual(cfg.MONGO.maxPoolSize, 10,
    'maxPoolSize changed — justify it with load-test evidence before updating this test');
});

test('the pool is pre-warmed so normal traffic never waits for it to grow', () => {
  // The boot burst (demo-owner init + cron registrations + socket + escalation)
  // hit the database together; with minPoolSize 2 everything after the first
  // two queued behind connection establishment.
  assert.ok(cfg.MONGO.minPoolSize >= 5,
    `minPoolSize ${cfg.MONGO.minPoolSize} is too low for the startup burst`);
  assert.ok(cfg.MONGO.minPoolSize < cfg.MONGO.maxPoolSize);
});

test('the pre-fix inverted values are gone', () => {
  const { MONGO } = cfg;
  assert.notStrictEqual(MONGO.waitQueueTimeoutMS, 30000, 'waitQueueTimeoutMS 30000 was 2.5x the client timeout');
  // 3000 was previously rejected here because it sat below an 8s
  // connectTimeoutMS. The hazard was never the number — it was the inversion,
  // and that is asserted directly above as waitQueue > connect, which holds at
  // any pair of values. Pinning the number instead outlawed the correct
  // configuration once connectTimeoutMS came down to 2.5s.
  assert.ok(MONGO.waitQueueTimeoutMS > MONGO.connectTimeoutMS,
    'a pool waiter must never give up before a new connection can be established');
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

test('exemptions survive being mounted at /api', () => {
  const { exemptionPath, isExempt } = require('../middleware/requestDeadline');

  // app.use('/api', requestDeadline) makes Express strip the mount path, so a
  // request to /api/upload/x reaches the handler as req.path '/upload/x'. The
  // exemption list is written with /api prefixes, so testing req.path directly
  // matched nothing and every exempt route was silently being deadlined.
  const mounted = { baseUrl: '/api', path: '/upload/x', originalUrl: '/api/upload/x' };
  assert.strictEqual(exemptionPath(mounted), '/api/upload/x');
  assert.ok(isExempt(exemptionPath(mounted)), 'uploads must stay exempt when mounted at /api');
  assert.ok(!isExempt(mounted.path), 'the raw req.path is exactly what used to be checked');

  // Still correct if the middleware is ever mounted globally instead.
  const global = { baseUrl: '', path: '/api/payments/x', originalUrl: '/api/payments/x' };
  assert.ok(isExempt(exemptionPath(global)));

  // And an owner route mounted the same way must remain deadlined.
  const owner = { baseUrl: '/api', path: '/owners/ROOMHY1/tenants', originalUrl: '/api/owners/ROOMHY1/tenants' };
  assert.ok(!isExempt(exemptionPath(owner)), 'owner reads must stay bounded');
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

test('a controller-swallowed pool timeout is normalised to 503, not leaked as 500', () => {
  const { dbTimeoutResponseNormalizer, resetTimeoutCounters } = require('../middleware/requestDeadline');
  resetTimeoutCounters();

  // What nearly every controller does: catch, then answer 500 with the driver's
  // own text. That never reaches Express's error pipeline, so dbTimeoutErrorHandler
  // could not see it and the Owner Panel received a 500 carrying driver internals.
  const sent = {};
  const req = {};
  const res = {
    statusCode: 200, headersSent: false, headers: {},
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    json(b) { sent.status = this.statusCode; sent.body = b; return this; },
  };

  dbTimeoutResponseNormalizer(req, res, () => {});
  res.status(500).json({ success: false, message: 'Timed out while checking out a connection from connection pool' });

  assert.strictEqual(sent.status, 503, 'a retryable pool timeout must not be reported as 500');
  assert.strictEqual(res.headers['Retry-After'], '2');
  assert.strictEqual(sent.body.reason, 'DB_POOL_WAIT_TIMEOUT');
  assert.ok(!/connection pool|checking out/i.test(sent.body.message),
    'the driver diagnostic string must not reach the client');
});

test('the normaliser leaves every other response alone', () => {
  const { dbTimeoutResponseNormalizer } = require('../middleware/requestDeadline');
  const seen = {};
  const res = {
    statusCode: 200, headersSent: false, headers: {},
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    json(b) { seen.status = this.statusCode; seen.body = b; return this; },
  };
  dbTimeoutResponseNormalizer({}, res, () => {});

  res.status(200).json({ success: true, tenants: [] });
  assert.strictEqual(seen.status, 200);
  assert.deepEqual(seen.body, { success: true, tenants: [] });

  res.status(500).json({ success: false, message: 'ValidationError: name required' });
  assert.strictEqual(seen.status, 500, 'a genuine application error stays a 500');
  assert.strictEqual(seen.body.message, 'ValidationError: name required');
});

test('a database timeout is counted once, not twice', () => {
  const { dbTimeoutResponseNormalizer, dbTimeoutErrorHandler, getTimeoutCounters, resetTimeoutCounters } =
    require('../middleware/requestDeadline');
  resetTimeoutCounters();

  const req = {};
  const res = {
    statusCode: 200, headersSent: false, headers: {},
    status(c) { this.statusCode = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    json() { return this; },
  };
  dbTimeoutResponseNormalizer(req, res, () => {});
  res.status(500).json({ success: false, message: 'Timed out while checking out a connection from connection pool' });

  // The same failure reaching the error handler afterwards must not count again.
  let passedOn = false;
  dbTimeoutErrorHandler(new Error('connection pool'), req, res, () => { passedOn = true; });

  assert.strictEqual(getTimeoutCounters().poolWaitTimeouts, 1, 'one failure, one count');
  assert.ok(passedOn, 'an already-classified error is handed on, not answered twice');
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

// ─────────────────────────────────────────────────────────────────────────────
// Post-response work must not run on the request's budget
//
// Regression: POST /api/visits/submit awaited the owner KYC email, the
// superadmin email and a WhatsApp send before replying. Together they ran past
// REQUEST_DEADLINE_MS, so the deadline answered 503 ("The server took too long
// to respond") for a submission that had in fact saved and mailed, and the
// handler's own res.json() afterwards threw ERR_HTTP_HEADERS_SENT twice.
// ─────────────────────────────────────────────────────────────────────────────

const {
  runWithRequestBudget,
  runOutsideRequestBudget,
  remainingBudgetMs,
  resolveOperationDeadline,
} = require('../utils/queryDeadline');

test('runOutsideRequestBudget detaches work from the request budget', () => {
  runWithRequestBudget(cfg.REQUEST_DEADLINE_MS, () => {
    assert.ok(remainingBudgetMs() > 0, 'inside a request there is a budget');

    runOutsideRequestBudget(() => {
      assert.strictEqual(remainingBudgetMs(), null,
        'detached work must see no request budget');
      assert.strictEqual(resolveOperationDeadline('read'), cfg.QUERY_TIMEOUT_MS.job,
        'detached work must fall back to the job deadline, not a clamped remainder');
    });

    assert.ok(remainingBudgetMs() > 0, 'the budget is restored after the detached block');
  });
});

test('the detachment survives the async boundary of un-awaited work', async () => {
  let seen = 'unset';
  await new Promise((resolve) => {
    runWithRequestBudget(cfg.REQUEST_DEADLINE_MS, () => {
      runOutsideRequestBudget(() => {
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          seen = remainingBudgetMs();
          resolve();
        })();
      });
    });
  });
  assert.strictEqual(seen, null,
    'a query started after the first slow SMTP call would otherwise be clamped to MIN_OPERATION_MS');
});

test('visit submit replies before it sends any email', () => {
  const src = read('routes/visitDataRoutes.js');
  const handler = src.slice(src.indexOf("router.post('/submit'"));
  const body = handler.slice(0, handler.indexOf('\n});'));

  // Every fan-out must be preceded by a reply on its own path — checked per
  // call site, because the handler has two (the normal save and the idempotent
  // duplicate-retry branch) and a positional check would silently pass once a
  // second one appeared earlier in the file.
  const dispatches = [...body.matchAll(/dispatchVisitSubmissionNotices\(/g)].map((m) => m.index);
  assert.ok(dispatches.length >= 1, 'expected the reply-first shape to be present');
  for (const at of dispatches) {
    const before = body.slice(0, at);
    assert.match(before.slice(before.lastIndexOf('respondOnce(res,')), /respondOnce\(res,/,
      'the response must be flushed before the mail fan-out starts, or the deadline fires first');
    assert.ok(before.lastIndexOf('respondOnce(res,') > -1,
      'a fan-out with no reply before it means the request is still on the clock');
  }

  assert.ok(!/await\s+sendOwnerKycLink/.test(body),
    'awaiting the KYC email inside the request is what blew the 10s deadline');
  assert.ok(!/await\s+notifySuperadmin/.test(body),
    'awaiting the superadmin email + WhatsApp inside the request is what blew the 10s deadline');
  assert.match(body, /runOutsideRequestBudget\(/,
    'the fan-out must be detached from the request budget');
});

test('visit submit cannot double-send after a deadline response', () => {
  const src = read('routes/visitDataRoutes.js');
  const handler = src.slice(src.indexOf("router.post('/submit'"));
  const body = handler.slice(0, handler.indexOf('\n});'));

  assert.ok(!/res\.status\(\d+\)\.json/.test(body),
    'both the success and error replies must go through respondOnce()');
  assert.match(read('routes/visitDataRoutes.js'),
    /function respondOnce\([\s\S]{0,300}res\.headersSent \|\| res\.writableEnded/,
    'respondOnce must check headersSent, or a late reply throws ERR_HTTP_HEADERS_SENT');
});

test('the post-response fan-out can never reject unhandled', () => {
  const src = read('routes/visitDataRoutes.js');
  const idx = src.indexOf('runOutsideRequestBudget(');
  assert.match(src.slice(idx, idx + 400), /\.catch\(/,
    'un-awaited work must carry its own .catch or it becomes an unhandled rejection');
});

test('visit submit is idempotent, so a retry cannot duplicate the report', () => {
  const src = read('routes/visitDataRoutes.js');
  const handler = src.slice(src.indexOf("router.post('/submit'"));
  const body = handler.slice(0, handler.indexOf('\n});'));

  assert.match(body, /11000/,
    'a retry reuses the same unique visitId, so the duplicate-key case must be handled');
  assert.match(body, /duplicate: true/,
    'the retry must confirm the existing report rather than 500');
  assert.match(body, /kycStatus !== 'sent'/,
    'a retry must not re-send a KYC link that already went out');
});

// ─────────────────────────────────────────────────────────────────────────────
// Cloudinary document uploads
//
// Regression: POST /api/checkin/owner/documents takes base64 data URLs and
// streams them to Cloudinary, but was not on the exempt list. Measured against
// the running server, a single 4.2MB PNG 503'd at 10.03s while the upload was
// still in flight; the handler then ran on to Cloudinary's own 60s timeout.
// ─────────────────────────────────────────────────────────────────────────────

test('Cloudinary document uploads are exempt from the request deadline', () => {
  for (const p of ['/api/checkin/owner/documents', '/api/checkin/tenant/documents']) {
    assert.ok(isExempt(p), `${p} streams to Cloudinary and cannot live inside a 10s budget`);
  }
});

test('the rest of the check-in router stays bounded', () => {
  // '/api/checkin' as a blanket prefix would have exempted ordinary reads too.
  for (const p of ['/api/checkin/owner/profile', '/api/checkin/tenant/save',
    '/api/checkin/owner/aadhaar/ocr']) {
    assert.ok(!isExempt(p), `${p} is not an upload and must keep its deadline`);
  }
});

test('the Cloudinary upload carries an explicit, bounded timeout', () => {
  const src = read('routes/checkinRoutes.js');
  assert.match(src, /CLOUDINARY_UPLOAD_TIMEOUT_MS/,
    'relying on the SDK default (60s) leaves the request unbounded');
  assert.match(src, /timeout: CLOUDINARY_UPLOAD_TIMEOUT_MS/,
    'the timeout must actually be passed to uploader.upload');

  const m = src.match(/CLOUDINARY_UPLOAD_TIMEOUT_MS[\s\S]{0,160}?\|\|\s*(\d+)/);
  assert.ok(m, 'expected a numeric default');
  assert.ok(Number(m[1]) < 60000,
    'must be under the SDK default it is replacing');
});

test('Cloudinary errors keep a message the browser can show', () => {
  // The SDK rejects with a PLAIN OBJECT { error: { message, http_code, name } },
  // so `err.message` is undefined and the old handler sent a body with no
  // message — which is why the page rendered a bare "HTTP 500".
  const src = read('routes/checkinRoutes.js');
  const helper = src.slice(src.indexOf('const uploadDoc ='), src.indexOf('const uploadDoc =') + 1400);
  assert.match(helper, /err\?\.error \|\| err/,
    'the { error: {...} } wrapper must be unwrapped');
  assert.match(helper, /new Error\(/,
    'a plain object must be turned into a real Error or .message is lost again');
  assert.match(helper, /499|TimeoutError/,
    'the timeout case deserves its own actionable message');
});

test('owner document uploads run concurrently', () => {
  const src = read('routes/checkinRoutes.js');
  const handler = src.slice(src.indexOf("router.post('/owner/documents'"));
  const body = handler.slice(0, handler.indexOf('\n});'));
  assert.match(body, /Promise\.all\(/,
    'three independent uploads awaited in series triples the wall-clock time');
});

// ─────────────────────────────────────────────────────────────────────────────
// Approve: same reply-before-mail rule, plus duplicate protection
// ─────────────────────────────────────────────────────────────────────────────

const approveBody = () => {
  const src = read('routes/visitDataRoutes.js');
  const h = src.slice(src.indexOf("router.post('/approve'"));
  return h.slice(0, h.indexOf('\n});'));
};

test('approve replies before it sends the credentials email', () => {
  const body = approveBody();
  const reply = body.indexOf('respondOnce(res, 200');
  const mail = body.indexOf('sendApprovalCredentialsEmail');
  assert.ok(reply > -1 && mail > -1, 'expected the reply-first shape');
  assert.ok(reply < mail, 'the SMTP round-trip must not sit inside the request');
  assert.ok(!/await\s+mailer\.sendMail/.test(body),
    'awaiting the credentials mail inside the request is what blew the deadline');
  assert.match(body, /runOutsideRequestBudget\(/,
    'the mail must be detached from the request budget');
});

test('approve cannot double-send after a deadline response', () => {
  assert.strictEqual((approveBody().match(/res\.status\(\d+\)\.json/g) || []).length, 0,
    'every reply in approve must go through respondOnce()');
});

test('approve claims the transition atomically', () => {
  const body = approveBody();
  // Without the $ne, two clicks both pass the checks and both run the Owner
  // upsert, the Property create and the credentials mail.
  assert.match(body, /status:\s*\{\s*\$ne:\s*targetStatus\s*\}/,
    'the status transition must be conditional, or concurrent approves both win');
  assert.match(body, /alreadyApproved: true/,
    'the loser of the race must report the approval as already done, not fail');
});

test('submit dedupes with a unique index, not a lookup', () => {
  const src = read('routes/visitDataRoutes.js');
  assert.match(src, /claimVisitSubmission/, 'expected the claim to be used');
  assert.match(src, /buildVisitFingerprint/, 'expected a normalised fingerprint');

  const fn = src.slice(src.indexOf('async function claimVisitSubmission'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // A lookup-then-insert loses a race: measured, five simultaneous submits each
  // read "nothing filed yet" and each created a report plus its own Owner.
  assert.match(body, /VisitSubmitClaim\.create\(/,
    'the claim must be an insert, so the unique index arbitrates concurrency');
  assert.match(body, /11000/, 'the losers of the race are E11000, and must be handled');
  assert.ok(!/findOne[\s\S]{0,120}?then[\s\S]{0,80}?create/.test(body),
    'a read-then-write guard is exactly what this replaces');
});

test('the fingerprint needs both a property and an owner', () => {
  const src = read('routes/visitDataRoutes.js');
  const fn = src.slice(src.indexOf('function buildVisitFingerprint'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /return null/,
    'too little to identify a report must mean no claim, not a bogus one');
  assert.match(body, /toLowerCase|replace/,
    'casing and whitespace must not be able to sneak a duplicate past');
});

test('the duplicate claim expires, so re-listing stays possible', () => {
  const model = read('models/VisitSubmitClaim.js');
  assert.match(model, /unique: true/, 'without this the claim cannot arbitrate a race');
  assert.match(model, /expireAfterSeconds: 0/,
    'a permanent claim would block a legitimate re-listing forever');

  const src = read('routes/visitDataRoutes.js');
  assert.match(src, /releaseVisitSubmission/,
    'a claim whose report failed to save must be released, or a retry is locked out');
});

test('the duplicate window sits between a retry and a real re-listing', () => {
  // Measured from the real data: the accidental pair was 57s apart, the
  // legitimate re-listings ~20 days apart.
  const src = read('routes/visitDataRoutes.js');
  const m = src.match(/DUPLICATE_SUBMIT_WINDOW_MS[\s\S]{0,200}?\|\|\s*([\d\s*]+);/);
  assert.ok(m, 'expected a numeric default');
  const ms = eval(m[1]);
  assert.ok(ms > 60 * 1000, `${ms}ms is too tight to catch a retry a minute later`);
  assert.ok(ms < 24 * 60 * 60 * 1000, `${ms}ms would block a legitimate re-listing`);
});
