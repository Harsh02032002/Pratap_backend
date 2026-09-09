'use strict';

/**
 * requestDeadline.js — bounded lifetime for user-facing requests, plus the
 * shared translation of database timeout errors into a sane API response.
 *
 * WHAT THIS DOES
 * ──────────────
 * • Gives every non-exempt request a deadline (default 10s, under the client's
 *   12s) and an AbortSignal on `req.deadlineSignal`.
 * • Responds 503 + Retry-After once, and never after headers are sent.
 * • Marks the request aborted so downstream code can stop doing pointless work.
 * • Counts deadline hits, pool-wait timeouts, server-selection failures and
 *   query timeouts so saturation is visible instead of being guessed at.
 *
 * WHAT THIS HONESTLY CANNOT DO
 * ────────────────────────────
 * It cannot cancel a query that MongoDB is already running. mongoose 8.24.2 /
 * driver 6.20.0 expose no AbortSignal on Query or Aggregate (verified:
 * `Query.prototype.signal` is undefined). The deadline frees the HTTP request
 * and the pool slot is released when the driver finishes, but the server-side
 * work is stopped by `maxTimeMS` — which is why every user-facing query must
 * carry one. See utils/queryDeadline.js.
 */

const { REQUEST_DEADLINE_MS, DEADLINE_EXEMPT_PREFIXES } = require('../config/timeouts');
const { runWithRequestBudget } = require('../utils/queryDeadline');

// ── Counters ─────────────────────────────────────────────────────────────────
// Plain in-process counters, exposed for the health/metrics endpoint. Reset on
// restart; they exist to make saturation visible, not to be a metrics backend.
const counters = {
  requestsDeadlineExceeded: 0,
  poolWaitTimeouts: 0,
  serverSelectionTimeouts: 0,
  queryTimeouts: 0,
  clientAborted: 0,
};

const getTimeoutCounters = () => ({ ...counters });
const resetTimeoutCounters = () => {
  for (const k of Object.keys(counters)) counters[k] = 0;
};

const isExempt = (path) => DEADLINE_EXEMPT_PREFIXES.some((p) => path.startsWith(p));

/**
 * The path the exemption list is written against.
 *
 * This middleware is mounted with `app.use('/api', requestDeadline)`, and Express
 * strips the mount path from `req.path` — inside the handler a request to
 * /api/upload/x arrives as `/upload/x`. Testing that against prefixes that all
 * begin with `/api` matched nothing, so every deliberately exempt route
 * (uploads, Cashfree, payments, webhooks, reports, chat, SSE, WhatsApp) was in
 * fact being cut off at the 10s deadline. Rejoining baseUrl restores the path
 * the list describes, and still works if the middleware is ever mounted
 * globally, where baseUrl is empty.
 */
const exemptionPath = (req) => `${req.baseUrl || ''}${req.path || ''}` || req.originalUrl || '';

/** Correlation id, reusing whatever the request already carries. */
// Marks a request whose database timeout has already been classified, so the
// normaliser and the error handler cannot both count the same failure.
const CLASSIFIED = Symbol('roomhy.dbTimeoutClassified');

// Optional chaining throughout: this only ever feeds a log line, and a missing
// header bag must not be able to throw inside a response path.
const requestIdOf = (req) =>
  req?.id || req?.requestId || req?.headers?.['x-request-id'] || req?.headers?.['x-correlation-id'] || '-';

/**
 * Classify a database error by failure mode. The driver's messages differ per
 * mode and each one means something different operationally, so they are not
 * collapsed into one bucket.
 *
 * @returns {{reason:string, status:number, message:string}|null}
 */
function classifyDbTimeout(err) {
  if (!err) return null;
  const name = String(err.name || '');
  const msg = String(err.message || '');

  // Pool exhausted — the request could not even get a connection.
  if (name === 'MongoPoolClearedError' || /waitQueueTimeout|timed out.*connection.*pool|connection pool/i.test(msg)) {
    counters.poolWaitTimeouts += 1;
    return {
      reason: 'DB_POOL_WAIT_TIMEOUT',
      status: 503,
      message: 'The service is busy right now. Please try again in a moment.',
    };
  }

  // No suitable server — replica set election, network partition, DB down.
  if (name === 'MongoServerSelectionError' || /server selection/i.test(msg)) {
    counters.serverSelectionTimeouts += 1;
    return {
      reason: 'DB_SERVER_SELECTION_TIMEOUT',
      status: 503,
      message: 'The service is temporarily unavailable. Please try again shortly.',
    };
  }

  // maxTimeMS fired — MongoDB killed the operation server-side.
  if (err.code === 50 || name === 'MongoExecutionTimeoutError' || /maxTimeMS|operation exceeded time limit/i.test(msg)) {
    counters.queryTimeouts += 1;
    return {
      reason: 'DB_QUERY_TIMEOUT',
      status: 503,
      message: 'That request took too long to complete. Please narrow your filters and try again.',
    };
  }

  // Mongoose buffered the op because the connection was down.
  if (/buffering timed out/i.test(msg)) {
    counters.serverSelectionTimeouts += 1;
    return {
      reason: 'DB_DISCONNECTED',
      status: 503,
      message: 'The service is reconnecting. Please try again shortly.',
    };
  }

  return null;
}

/**
 * Attaches a deadline to user-facing requests.
 *
 * Skips exempt prefixes (payments, uploads, webhooks, reports, chat/SSE) —
 * those do legitimate work past 10s and cutting them off mid-flight would be
 * worse than the wait.
 */
function requestDeadline(req, res, next) {
  if (isExempt(exemptionPath(req))) return next();

  const controller = new AbortController();
  req.deadlineSignal = controller.signal;
  req.startedAt = Date.now();

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    counters.requestsDeadlineExceeded += 1;
    controller.abort();
    req.deadlineExceeded = true;

    const durationMs = Date.now() - req.startedAt;
    // Structured, no bodies, no headers, no PII.
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'request_deadline_exceeded',
      requestId: requestIdOf(req),
      method: req.method,
      route: req.route?.path || req.path,
      durationMs,
      reason: 'REQUEST_DEADLINE',
    }));

    // Never write twice, and never write to a socket the client already left.
    if (res.headersSent || res.writableEnded) return;
    res.setHeader('Retry-After', '2');
    res.status(503).json({
      success: false,
      message: 'The server took too long to respond. Please try again.',
      reason: 'REQUEST_DEADLINE',
    });
  }, REQUEST_DEADLINE_MS);

  // Client hung up first — stop the clock, don't try to respond.
  req.on('aborted', () => {
    if (!settled) counters.clientAborted += 1;
    req.clientAborted = true;
    controller.abort();
    finish();
  });

  res.on('finish', finish);
  res.on('close', finish);

  // Carry the budget down to every database operation this request starts, so
  // MongoDB is told to stop at the same moment the deadline would fire instead
  // of running on and holding its pool slot. Exempt routes returned above and
  // never enter this context — they must not inherit a request-scale deadline.
  return runWithRequestBudget(REQUEST_DEADLINE_MS, next);
}

/**
 * Normalises database timeouts that a controller already turned into a response.
 *
 * dbTimeoutErrorHandler below is correct but unreachable for most routes: nearly
 * every controller wraps its body in try/catch and answers with
 * `res.status(500).json({ message: error.message })`, so the error never enters
 * Express's error pipeline. Under pool exhaustion that surfaced to the Owner
 * Panel as HTTP 500 carrying the driver's own text — "Timed out while checking
 * out a connection from connection pool" — which is both the wrong status for a
 * retryable condition and a driver diagnostic string that should not leave the
 * server.
 *
 * Wrapping res.json fixes every route at once without touching a single
 * controller's logic: only the status, message and Retry-After of an
 * already-failed database timeout change. Everything else passes through
 * untouched.
 */
function dbTimeoutResponseNormalizer(req, res, next) {
  const sendJson = res.json.bind(res);

  res.json = function normalizedJson(body) {
    if (res.headersSent || res.writableEnded) return res;
    try {
      if (
        !req[CLASSIFIED] &&
        res.statusCode >= 500 &&
        !res.headersSent &&
        body && typeof body === 'object' && typeof body.message === 'string'
      ) {
        const classified = classifyDbTimeout({ message: body.message, name: body.name, code: body.code });
        if (classified) {
          req[CLASSIFIED] = true;
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'db_timeout',
            requestId: requestIdOf(req),
            method: req.method,
            route: req.route?.path || req.path,
            durationMs: req.startedAt ? Date.now() - req.startedAt : undefined,
            reason: classified.reason,
            source: 'controller_catch',
            detail: String(body.message).slice(0, 300),
          }));
          res.status(classified.status);
          res.set('Retry-After', '2');
          return sendJson({ success: false, message: classified.message, reason: classified.reason });
        }
      }
    } catch (_) {
      // Normalisation must never be the reason a response fails to send.
    }
    return sendJson(body);
  };

  next();
}

/**
 * Error middleware translating database timeouts into the project's standard
 * `{ success, message }` shape. Register AFTER the routes.
 *
 * Internal driver text is logged, never returned to the caller.
 */
function dbTimeoutErrorHandler(err, req, res, next) {
  if (req[CLASSIFIED]) return next(err);
  const classified = classifyDbTimeout(err);
  if (!classified) return next(err);
  req[CLASSIFIED] = true;

  console.warn(JSON.stringify({
    level: 'warn',
    event: 'db_timeout',
    requestId: requestIdOf(req),
    method: req.method,
    route: req.route?.path || req.path,
    durationMs: req.startedAt ? Date.now() - req.startedAt : undefined,
    reason: classified.reason,
    // The driver's own message — operational detail, kept server-side only.
    detail: String(err.message || '').slice(0, 300),
  }));

  if (res.headersSent || res.writableEnded) return next(err);
  res.setHeader('Retry-After', '2');
  return res.status(classified.status).json({
    success: false,
    message: classified.message,
    reason: classified.reason,
  });
}

module.exports = {
  exemptionPath,
  requestDeadline,
  dbTimeoutResponseNormalizer,
  dbTimeoutErrorHandler,
  classifyDbTimeout,
  getTimeoutCounters,
  resetTimeoutCounters,
  isExempt,
};
