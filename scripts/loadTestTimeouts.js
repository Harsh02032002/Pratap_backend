'use strict';

/**
 * loadTestTimeouts.js — controlled concurrency test for pool saturation.
 *
 *   node scripts/loadTestTimeouts.js http://localhost:5001 ROOMHY3259 [concurrency] [rounds]
 *
 * Fires N concurrent requests at a bounded endpoint and reports the latency
 * distribution, status mix and — crucially — whether the server failed FAST
 * (503 inside the deadline) or slowly (client-side timeout).
 *
 * WHAT "PASS" LOOKS LIKE AFTER THIS FIX
 * ─────────────────────────────────────
 * Under saturation the server should return 503 in roughly waitQueueTimeoutMS
 * (~3s), not hang until the client's 12s abort. p99 should sit under the 10s
 * request deadline. Any response slower than 12s means something is still
 * escaping the hierarchy.
 *
 * Before/after comparison is the point: run it against the old build and the
 * new one. It reports measured numbers only — nothing is inferred.
 */

const BASE = process.argv[2] || 'http://localhost:5001';
const OWNER = process.argv[3] || '';
const CONCURRENCY = Number.parseInt(process.argv[4], 10) || 30;
const ROUNDS = Number.parseInt(process.argv[5], 10) || 3;
const CLIENT_TIMEOUT_MS = 12000; // mirrors src/utils/api.js

if (!OWNER) {
  console.error('Usage: node scripts/loadTestTimeouts.js <baseUrl> <OWNER_LOGIN_ID> [concurrency] [rounds]');
  process.exit(1);
}

const TARGET = `/api/dashboard/${OWNER}`;

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

async function one() {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${TARGET}`, { signal: controller.signal });
    const body = await res.text();
    let reason = null;
    try { reason = JSON.parse(body).reason || null; } catch (_) { /* not json */ }
    return { ms: Date.now() - started, status: res.status, reason };
  } catch (err) {
    return {
      ms: Date.now() - started,
      status: err.name === 'AbortError' ? 'CLIENT_TIMEOUT' : 'NETWORK_ERROR',
      reason: err.name,
    };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log(`Target      : ${BASE}${TARGET}`);
  console.log(`Concurrency : ${CONCURRENCY}  Rounds: ${ROUNDS}  Client timeout: ${CLIENT_TIMEOUT_MS}ms\n`);

  const all = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const roundStart = Date.now();
    const results = await Promise.all(Array.from({ length: CONCURRENCY }, one));
    all.push(...results);

    const times = results.map((x) => x.ms).sort((a, b) => a - b);
    const byStatus = results.reduce((acc, x) => {
      acc[x.status] = (acc[x.status] || 0) + 1;
      return acc;
    }, {});

    console.log(`Round ${r}  (wall ${Date.now() - roundStart}ms)`);
    console.log(`  p50=${pct(times, 0.5)}ms  p95=${pct(times, 0.95)}ms  p99=${pct(times, 0.99)}ms  max=${times.at(-1)}ms`);
    console.log(`  status: ${JSON.stringify(byStatus)}`);
    const reasons = results.filter((x) => x.reason).reduce((a, x) => {
      a[x.reason] = (a[x.reason] || 0) + 1; return a;
    }, {});
    if (Object.keys(reasons).length) console.log(`  reasons: ${JSON.stringify(reasons)}`);
    console.log('');
  }

  const times = all.map((x) => x.ms).sort((a, b) => a - b);
  const clientTimeouts = all.filter((x) => x.status === 'CLIENT_TIMEOUT').length;
  const serverSheds = all.filter((x) => x.status === 503).length;
  const ok = all.filter((x) => x.status === 200).length;

  console.log('─'.repeat(70));
  console.log(`total=${all.length}  ok=${ok}  server-shed(503)=${serverSheds}  client-timeout=${clientTimeouts}`);
  console.log(`p50=${pct(times, 0.5)}ms  p95=${pct(times, 0.95)}ms  p99=${pct(times, 0.99)}ms  max=${times.at(-1)}ms`);
  console.log('');
  console.log('Interpretation:');
  console.log('  • 503s arriving in ~3s  → pool wait is failing fast. Correct.');
  console.log('  • responses at ~10s     → request deadline fired. Correct backstop.');
  console.log('  • CLIENT_TIMEOUT at 12s → something escaped the hierarchy. Investigate.');
  console.log('');
  console.log(`Now check pool counters:  curl -s ${BASE}/api/health | jq '.pool, .timeouts'`);

  process.exit(clientTimeouts > 0 ? 1 : 0);
})().catch((err) => { console.error('load test failed:', err); process.exit(1); });
