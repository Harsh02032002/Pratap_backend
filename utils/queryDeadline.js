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
 *   read    dashboard / list / detail — must finish inside the request deadline
 *   report  exports and analytics — routes exempt from the deadline
 *   job     scheduled work — must never inherit request-scale limits
 *
 * The numbers themselves live in config/timeouts.js and are deliberately not
 * repeated here: this comment previously said 7s/25s/60s while the config held
 * 7s/20s/25s, and a stale copy of a value is worse than no copy.
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

// ─────────────────────────────────────────────────────────────────────────────
// Global coverage
//
// The helpers above only bound the queries someone remembered to wrap. Audited
// across the backend they appeared in 3 files out of 71 route files and 44
// controllers, so on nearly every Owner Panel endpoint the middle layer of the
// hierarchy was simply absent: the request deadline returned 503 at 10s while
// MongoDB kept running the query and kept its pool slot, which is the mechanism
// behind the cascading Owner Panel timeouts.
//
// Wrapping every call site by hand is not a fix that survives contact with new
// code. Instead a schema-level hook applies a default maxTimeMS to queries and
// aggregations that do not already carry one, and an AsyncLocalStorage budget
// tells it which deadline applies:
//
//   inside a deadlined request  -> whatever is LEFT of the request budget,
//                                  capped at the read class, so a query started
//                                  late in a request cannot outlive its deadline
//   anywhere else               -> the job class; background work, boot-time
//   (jobs, boot, exempt routes)    queries and the deliberately exempt routes
//                                  (uploads, payments, webhooks, chat, SSE)
//                                  must never inherit a request-scale deadline
//
// An explicitly set maxTimeMS always wins, so withReadDeadline(q, 'report') and
// every existing call site keep their exact meaning.
// ─────────────────────────────────────────────────────────────────────────────

const { AsyncLocalStorage } = require('node:async_hooks');

const requestBudget = new AsyncLocalStorage();

// Left unspent so a handler can still build and send its error response after
// MongoDB kills the operation, rather than the deadline firing mid-write.
const RESPONSE_RESERVE_MS = 500;

// A deadline below this is not worth issuing — it would fail the operation for
// arithmetic reasons rather than because the query is slow.
const MIN_OPERATION_MS = 250;

/** Run `fn` with a request budget that downstream database operations inherit. */
function runWithRequestBudget(budgetMs, fn) {
  return requestBudget.run({ startedAt: Date.now(), budgetMs }, fn);
}

/**
 * Run `fn` detached from any request budget, so its database operations are
 * bounded by the job class instead of by whatever is left of a request's 10s.
 *
 * For work a handler deliberately starts and does NOT await — a post-response
 * email, a notification fan-out. Such work outlives the response by design, so
 * inheriting the request budget would clamp every query it runs afterwards to
 * MIN_OPERATION_MS and fail it for arithmetic reasons. This is the same
 * "background work must never inherit a request-scale deadline" rule the
 * AsyncLocalStorage note above describes; an un-awaited call needs it stated
 * explicitly, because the context propagates into it automatically.
 */
function runOutsideRequestBudget(fn) {
  return requestBudget.exit(fn);
}

/** Milliseconds left in the current request budget, or null outside a request. */
function remainingBudgetMs() {
  const store = requestBudget.getStore();
  if (!store) return null;
  return store.budgetMs - (Date.now() - store.startedAt);
}

/**
 * The maxTimeMS an operation starting now should carry.
 * @param {'read'|'report'|'job'} [cls]
 */
function resolveOperationDeadline(cls = 'read') {
  const configured = deadlineFor(cls);
  const remaining = remainingBudgetMs();
  if (remaining === null) return deadlineFor('job');
  return Math.max(MIN_OPERATION_MS, Math.min(configured, remaining - RESPONSE_RESERVE_MS));
}

function applyQueryDeadline() {
  // An explicit maxTimeMS is a deliberate choice by the call site — never
  // second-guess it.
  const options = typeof this.getOptions === 'function' ? this.getOptions() : null;
  if (options && options.maxTimeMS != null) return;
  this.maxTimeMS(resolveOperationDeadline('read'));
}

function applyAggregateDeadline() {
  if (this.options && this.options.maxTimeMS != null) return;
  this.option({ maxTimeMS: resolveOperationDeadline('read') });
}

// Only hooks that are unambiguously QUERY middleware in Mongoose 8. deleteOne /
// updateOne are deliberately excluded: they are document middleware too, and
// registering them here would change document-save semantics, which is well
// outside a timeout fix.
const QUERY_HOOKS = /^(find|count|countDocuments|estimatedDocumentCount|distinct)/;

const INSTALLED = Symbol.for('roomhy.queryDeadlineInstalled');

function installOnSchema(schema) {
  if (!schema || schema[INSTALLED]) return false;
  schema[INSTALLED] = true;
  schema.pre(QUERY_HOOKS, applyQueryDeadline);
  schema.pre('aggregate', applyAggregateDeadline);
  return true;
}

/**
 * Install the default operation deadline across every model.
 *
 * Must run before route/model requires so schemas compiled later pick up the
 * global plugin; models already compiled by then are patched directly, so the
 * order of requires cannot silently leave a collection uncovered.
 *
 * @returns {{ plugin: boolean, retrofitted: string[] }}
 */
function installGlobalQueryDeadline(mongoose) {
  mongoose.plugin((schema) => { installOnSchema(schema); });

  const retrofitted = [];
  for (const name of mongoose.modelNames()) {
    try {
      if (installOnSchema(mongoose.model(name).schema)) retrofitted.push(name);
    } catch (_) {
      // A model that cannot be resolved here is one this process never uses.
    }
  }
  return { plugin: true, retrofitted };
}

module.exports = {
  withReadDeadline,
  withAggregateDeadline,
  deadlineFor,
  runWithRequestBudget,
  runOutsideRequestBudget,
  remainingBudgetMs,
  resolveOperationDeadline,
  installGlobalQueryDeadline,
  RESPONSE_RESERVE_MS,
  MIN_OPERATION_MS,
  // Exported so the regression tests can drive the hooks directly. Executing a
  // real hook needs a live connection, and a timeout guard that is only ever
  // checked against a database is a guard that stops being checked.
  applyQueryDeadline,
  applyAggregateDeadline,
};
