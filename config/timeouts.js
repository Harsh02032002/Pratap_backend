'use strict';

/**
 * timeouts.js — the single source of truth for every timeout in the backend.
 *
 * THE RULE
 * ────────
 * Each layer must give up BEFORE the layer above it, so a request fails at the
 * innermost level that can actually release resources:
 *
 *   client 12s  >  request deadline 10s  >  query maxTimeMS 7s  >  pool wait 3s
 *
 * Before this file existed the hierarchy was inverted: the browser aborted at
 * 12s while the driver was still willing to wait 30s for a pool connection and
 * 45s on the socket. The server kept a pool slot busy for up to 33s after
 * nobody was listening any more, users retried, each retry took another slot,
 * and a 10-connection pool saturated. That is the "random dashboard timeout".
 *
 * WHY socketTimeoutMS IS *NOT* SQUEEZED TO REQUEST SCALE
 * ─────────────────────────────────────────────────────
 * socketTimeoutMS is a property of the CONNECTION, not the request, and the
 * same pool serves the scheduled jobs (owner-property heal, rent evaluator,
 * auto-absent). Dropping it to ~9s would kill legitimate long background
 * aggregations mid-flight. Per-request bounding is done with maxTimeMS and the
 * request deadline instead — those are per-operation and per-request.
 *
 * CANCELLATION LIMITATION (verified, not assumed)
 * ───────────────────────────────────────────────
 * mongoose 8.24.2 / mongodb driver 6.20.0: `Query.prototype.signal` and
 * `Query.prototype.abort` are both `undefined` — the driver exposes no
 * AbortSignal hook for find/aggregate. So a request that hits its deadline
 * CANNOT force an in-flight query to stop from the Node side. What we can do,
 * and do below, is give the SERVER a deadline via maxTimeMS so MongoDB itself
 * kills the operation. maxTimeMS is therefore the primary mechanism; the
 * request deadline is the backstop that frees the HTTP request.
 *
 * Every value is env-overridable so production can tune without a deploy.
 */

const int = (name, fallback) => {
  const raw = process.env[name];
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// ── Reference point: what the browser does ───────────────────────────────────
// src/utils/api.js aborts at 12000ms. Everything below is derived from it.
const CLIENT_TIMEOUT_MS = int('CLIENT_TIMEOUT_MS', 12000);

// ── Request deadline (user-facing reads) ─────────────────────────────────────
// 2s under the client so the server responds first and can log WHY.
const REQUEST_DEADLINE_MS = int('REQUEST_DEADLINE_MS', 10000);

// ── Query deadlines, by endpoint class ───────────────────────────────────────
// Not one number for everything: a dashboard read and a report have different
// legitimate durations.
const QUERY_TIMEOUT_MS = {
  // Dashboard / list / detail reads. 3s under the request deadline so MongoDB
  // kills the query and the handler can still build an error response.
  read: int('QUERY_TIMEOUT_READ_MS', 7000),
  // Reports and exports — deliberately slower, and these routes are exempt
  // from the request deadline.
  report: int('QUERY_TIMEOUT_REPORT_MS', 20000),
  // Scheduled jobs. Background work must NOT inherit request-scale deadlines,
  // but must still be bounded.
  //
  // Capped BELOW socketTimeoutMS on purpose. socketTimeoutMS measures socket
  // inactivity, and a long aggregation sends nothing until it has results — so
  // if a per-operation deadline exceeded it, the socket would kill the
  // operation first and maxTimeMS would be a lie. Keeping every per-operation
  // deadline under the socket timeout means maxTimeMS is always what fires,
  // which is the precise, server-side mechanism.
  //
  // A single background query needing more than this is a query to fix, not a
  // timeout to raise: a job's overall runtime is bounded by its lock TTL
  // (15-20 min), not by one operation.
  job: int('QUERY_TIMEOUT_JOB_MS', 25000),
};

// ── MongoDB driver options ───────────────────────────────────────────────────
const MONGO = {
  // Time spent finding a suitable server. Covers an Atlas failover blip.
  // Was 30s, then briefly 5s — 5s proved too tight on a loaded host, where the
  // process can be descheduled mid-handshake and a 250ms TLS negotiation
  // stalls past the limit. 8s respected that but left only 2s of the request
  // budget if selection was the blocker; 6s stays clear of the 5s that failed
  // and still finishes inside QUERY_TIMEOUT_MS.read.
  serverSelectionTimeoutMS: int('MONGO_SERVER_SELECTION_MS', 6000),

  // TCP + TLS + auth handshake for a NEW pool connection. Must stay BELOW
  // waitQueueTimeoutMS — see the note there.
  //
  // Note what this budget actually covers: Node starts the connectTimeoutMS
  // timer before DNS resolution, so a slow getaddrinfo is spent here and is
  // then reported as "Socket 'secureConnect' timed out after 8001ms" — a DNS
  // stall wearing a TLS error message.
  //
  // 8s was sized for that DNS stall. `family: 4` below removed the stall at its
  // source: the measurement recorded there is 220-520ms cold and ~250ms warm,
  // and a full SRV-resolve + connect + auth + ping from a home link measured
  // 788/1135/1125ms. 2.5s is ~5x the warm path and still ~2x the worst of those
  // three, while sitting under waitQueueTimeoutMS so a pool waiter can never
  // give up before the connection it is waiting for is able to finish. Holding
  // 8s here is what forced waitQueueTimeoutMS up to 9s and left a request ~1s
  // of usable budget after acquiring a connection.
  connectTimeoutMS: int('MONGO_CONNECT_TIMEOUT_MS', 2500),

  // Resolve the Atlas hosts over IPv4 only.
  //
  // Atlas publishes no AAAA records for this cluster — the shard hostnames
  // are CNAMEs onto EC2 A records. Left at the default, every fresh lookup
  // still asks for AAAA alongside A, and that answer is pure waste: at best
  // an empty response, at worst a stalled query. Measured on a cold resolver
  // cache, the default path took 5.5s per host to reach a TLS handshake and
  // one AAAA query timed out against systemd-resolved outright
  // ("communications error to 127.0.0.53#53: timed out"); the same handshakes
  // forced to IPv4 took 220-520ms, and ~250ms once the cache was warm.
  //
  // A cold start resolves the SRV record plus three shard hosts at once, so
  // that penalty lands exactly when the pool is opening its first connections
  // and is what pushed a boot-time connect past connectTimeoutMS. Dropping
  // the half of the DNS work that can never return a usable address removes
  // the stall instead of budgeting for it.
  family: 4,

  // Connection-level socket inactivity. Kept above request scale on purpose
  // (see the note at the top) and strictly above every per-operation deadline,
  // so maxTimeMS is always the mechanism that fires rather than a blunt socket
  // close. Was 45s.
  socketTimeoutMS: int('MONGO_SOCKET_TIMEOUT_MS', 30000),

  // How long a request may wait for a pool connection.
  //
  // MUST be greater than connectTimeoutMS. A waiter is not only waiting for a
  // BUSY connection to free up — when the pool is below maxPoolSize it is
  // waiting for a NEW one to be established, which is allowed connectTimeoutMS
  // to complete. Setting this lower than that guarantees the waiter gives up
  // before the connection it is waiting for can possibly be ready.
  //
  // That inversion (3s wait vs 5s connect) is exactly what caused
  // "Timed out while checking out a connection from connection pool" at boot,
  // with the pool reporting only 4 of 10 connections in use — the pool was not
  // saturated, it simply had not finished growing.
  //
  // Sized so the two halves of a request add up to exactly the budget:
  //
  //     waitQueueTimeoutMS (3s) + QUERY_TIMEOUT_MS.read (7s) = REQUEST_DEADLINE_MS (10s)
  //
  // A request that waits the full pool budget and then runs a full-length query
  // consumes the deadline precisely, with nothing left unaccounted for. At 9s
  // the pool wait alone was 90% of the budget: a request could spend almost its
  // entire life queueing and then 503 without ever reaching MongoDB, which reads
  // to the user as "the server is slow" when the query had not started.
  //
  // Still above connectTimeoutMS (2.5s), so the boot-time failure that raising
  // this to 9s was fixing — a waiter giving up before a NEW connection could be
  // established — stays fixed. Both constraints hold only because connect came
  // down; see the note there.
  waitQueueTimeoutMS: int('MONGO_WAIT_QUEUE_MS', 3000),

  // Pool size deliberately UNCHANGED at 10. Total connections =
  // maxPoolSize x process count, and the PM2 topology
  // (../deploy/ecosystem.config.cjs) is not in this repo, so a larger value
  // cannot be justified yet. Raising it before the timeout fix would only let
  // more requests pile onto slow queries. Revisit with load-test data.
  maxPoolSize: int('MONGO_MAX_POOL_SIZE', 10),

  // Pre-warm enough connections that normal traffic never waits for the pool
  // to grow. At boot the demo-owner init, four cron registrations, the socket
  // server and the escalation job all hit the database at once; with only 2
  // ready connections the rest queued behind connection establishment. This is
  // the real fix for that burst — the timeout ordering above is the safety net.
  minPoolSize: int('MONGO_MIN_POOL_SIZE', 5),
  maxIdleTimeMS: int('MONGO_MAX_IDLE_MS', 30000),

  heartbeatFrequencyMS: int('MONGO_HEARTBEAT_MS', 10000),

  // Unchanged. retryWrites is safe (the driver only retries writes it knows
  // did not commit) and turning it off would change payment durability.
  retryWrites: true,
  w: 'majority',
};

// How long Mongoose buffers an operation while the connection is down before
// erroring. The 10s default silently consumed the entire request budget during
// a reconnect.
//
// Must clear connectTimeoutMS: at boot, code that queries before the pool is
// ready (initDemoOwner, the cron registrations) buffers its operation while the
// connection is still being established. At 3s those buffered calls expired
// first and reported "buffering timed out after 3000ms" even though the
// connection went on to succeed.
const MONGOOSE_BUFFER_TIMEOUT_MS = int('MONGOOSE_BUFFER_TIMEOUT_MS', 9000);

// ── Node HTTP server ─────────────────────────────────────────────────────────
// These are backstops for pathological sockets, NOT the request deadline.
// requestTimeout covers receiving the full request INCLUDING the body, so it
// must stay generous — uploads accept up to 15MB and a slow mobile connection
// legitimately needs time. Node's default is 300s; 120s still bounds it.
const HTTP = {
  requestTimeout: int('HTTP_REQUEST_TIMEOUT_MS', 120000),
  headersTimeout: int('HTTP_HEADERS_TIMEOUT_MS', 20000),
  // keepAliveTimeout intentionally left at the Node default. Behind a reverse
  // proxy this must exceed the proxy's keep-alive or clients see sporadic
  // 502s, and the proxy config is not in this repo.
};

// Route prefixes exempt from the request deadline. These do legitimate work
// beyond 10s and aborting them would be worse than waiting: payment calls are
// mid-flight against Cashfree (whose own axios timeouts are 10-15s), uploads
// stream to Cloudinary, webhooks must not be dropped, reports are slow by
// design, and SSE/chat are long-lived by nature.
const DEADLINE_EXEMPT_PREFIXES = [
  '/api/upload',
  // These two are uploads in everything but name: they take base64 data URLs
  // and stream them to Cloudinary, which is exactly why /api/upload is exempt.
  // Left deadlined, a single 4MB photo on a domestic uplink 503'd at 10.0s
  // while the upload was still in flight, and the handler ran on to Cloudinary's
  // own 60s timeout. Listed individually rather than exempting '/api/checkin',
  // because the rest of that router is ordinary bounded reads and writes.
  '/api/checkin/owner/documents',
  '/api/checkin/tenant/documents',
  '/api/checkin/tenant/agreement',
  '/api/cashfree',
  '/api/payment',
  '/api/payments',
  '/api/webhook',
  '/api/wallet/admin/withdraw-instant',
  '/api/reports',
  '/api/chat',
  '/api/sse',
  '/api/whatsapp',
];

module.exports = {
  CLIENT_TIMEOUT_MS,
  REQUEST_DEADLINE_MS,
  QUERY_TIMEOUT_MS,
  MONGO,
  MONGOOSE_BUFFER_TIMEOUT_MS,
  HTTP,
  DEADLINE_EXEMPT_PREFIXES,
};
