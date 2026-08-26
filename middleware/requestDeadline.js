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

/** Correlation id, reusing whatever the request already carries. */
const requestIdOf = (req) =>
  req.id || req.requestId || req.headers['x-request-id'] || req.headers['x-correlation-id'] || '-';

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
  if (isExempt(req.path)) return next();

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

  next();
}

/**
 * Error middleware translating database timeouts into the project's standard
 * `{ success, message }` shape. Register AFTER the routes.
 *
 * Internal driver text is logged, never returned to the caller.
 */
function dbTimeoutErrorHandler(err, req, res, next) {
  const classified = classifyDbTimeout(err);
  if (!classified) return next(err);

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
  requestDeadline,
  dbTimeoutErrorHandler,
  classifyDbTimeout,
  getTimeoutCounters,
  resetTimeoutCounters,
  isExempt,
};
