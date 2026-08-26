'use strict';

/**
 * queryDeadline.js — server-side deadlines for MongoDB operations.
 *
 * WHY maxTimeMS AND NOT AbortSignal
 * ─────────────────────────────────
 * Verified against the installed versions (mongoose 8.24.2, mongodb 6.20.0):
 * `Query.prototype.signal` and `Query.prototype.abort` are both `undefined`,
 * so there is no supported way to cancel an in-flight find/aggregate from Node.
 *
 * maxTimeMS is the mechanism that actually works: MongoDB itself kills the
 * operation server-side when the limit is reached, which is what frees the
 * connection. Without it, the request deadline would return 503 to the user
 * while the query kept running and kept holding its pool slot — exactly the
 * saturation this change exists to prevent.
 *
 * CLASSES
 * ───────
 * These are NOT one number. A dashboard read and a monthly report have
 * different legitimate durations:
 *
 *   read   7s   dashboard / list / detail — must finish inside the 10s deadline
 *   report 25s  exports and analytics — routes exempt from the deadline
 *   job    60s  scheduled work — must never inherit request-scale limits
 *
 * maxTimeMS is a guardrail, not a fix for a slow query. If a read is hitting
 * 7s, the query needs work — the limit just stops it taking the pool with it.
 */

const { QUERY_TIMEOUT_MS } = require('../config/timeouts');

/**
 * Apply a deadline to a Mongoose Query (find / findOne / countDocuments / …).
 *
 * @template T
 * @param {T} query        a Mongoose Query
 * @param {'read'|'report'|'job'} [cls='read']
 * @returns {T} the same query, chainable
 */
function withReadDeadline(query, cls = 'read') {
  const ms = QUERY_TIMEOUT_MS[cls] ?? QUERY_TIMEOUT_MS.read;
  return typeof query?.maxTimeMS === 'function' ? query.maxTimeMS(ms) : query;
}

/**
 * Apply a deadline to a Mongoose Aggregate.
 *
 * Aggregate has no `.maxTimeMS()` in Mongoose 8 — the supported path is
 * `.option({ maxTimeMS })`, which is what this uses.
 *
 * @template T
 * @param {T} aggregate    a Mongoose Aggregate
 * @param {'read'|'report'|'job'} [cls='read']
 * @returns {T} the same aggregate, chainable
 */
function withAggregateDeadline(aggregate, cls = 'read') {
  const ms = QUERY_TIMEOUT_MS[cls] ?? QUERY_TIMEOUT_MS.read;
  return typeof aggregate?.option === 'function' ? aggregate.option({ maxTimeMS: ms }) : aggregate;
}

/** The raw millisecond value for a class, for callers building options objects. */
const deadlineFor = (cls = 'read') => QUERY_TIMEOUT_MS[cls] ?? QUERY_TIMEOUT_MS.read;

module.exports = { withReadDeadline, withAggregateDeadline, deadlineFor };
