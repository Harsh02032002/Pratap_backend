'use strict';

/**
 * Redis cache / OTP / rate-limit tests against a REAL redis-server on a
 * throwaway port (skipped when redis-server is not installed).
 *
 *   node --test tests/redisCache.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const path = require('node:path');

const HAS_REDIS = spawnSync('redis-server', ['--version']).status === 0;
const PORT = 6391;
const URL = `redis://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

const { resetConfig } = require('../config/redis');
const redis = require('../utils/redisClient');
const cache = require('../utils/cache');
const { buildCacheKey, ownerSelfCacheKey } = require('../utils/cacheKeys');
const { createOtpStore } = require('../utils/otpStore');
const { createRateLimitStore } = require('../middleware/rateLimitStore');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null;

function startRedis() {
  server = spawn('redis-server', ['--port', String(PORT), '--save', '', '--appendonly', 'no', '--enable-debug-command', 'yes'], { stdio: 'ignore' });
}
async function stopRedis() {
  if (!server) return;
  const s = server;
  server = null;
  s.kill('SIGKILL');
  await new Promise((r) => s.once('exit', r));
}
function cli(...args) {
  return execFileSync('redis-cli', ['-p', String(PORT), ...args]).toString().trim();
}

async function useEnv(env) {
  for (const k of ['REDIS_URL', 'CACHE_ENABLED', 'REDIS_STATE_ENABLED', 'CACHE_VERSION', 'CACHE_RESOURCES', 'REDIS_COMMAND_TIMEOUT_MS']) delete process.env[k];
  Object.assign(process.env, env);
  resetConfig();
  await redis.close();
}
async function connected() {
  const c = await redis.waitReady(3000);
  assert.ok(c, 'redis should become ready');
  return c;
}

// ── Key builder: pure, no Redis needed ───────────────────────────────────────
test('key builder isolates tenants and refuses to build unsafe keys', async () => {
  await useEnv({});
  const a = buildCacheKey({ panel: 'owner', scopeType: 'owner', scopeId: 'ROOMHY001', resource: 'dashboard' });
  const b = buildCacheKey({ panel: 'owner', scopeType: 'owner', scopeId: 'ROOMHY002', resource: 'dashboard' });
  assert.match(a, /^rh:v1:owner:owner:ROOMHY001:dashboard:0$/);
  assert.notStrictEqual(a, b, 'owner A and owner B never share a key');

  // Missing / placeholder scope → null (bypass), never a weaker key.
  for (const scopeId of [undefined, null, '', 'undefined', 'null', '  ', {}, 'a:b', 'x'.repeat(65)]) {
    assert.strictEqual(buildCacheKey({ panel: 'owner', scopeType: 'owner', scopeId, resource: 'dashboard' }), null, String(scopeId));
  }
  // Panels cannot borrow each other's scope types.
  assert.strictEqual(buildCacheKey({ panel: 'staff', scopeType: 'global', resource: 'x' }), null);
  assert.strictEqual(buildCacheKey({ panel: 'owner', scopeType: 'global', resource: 'x' }), null);
  assert.strictEqual(buildCacheKey({ panel: 'sa', scopeType: 'owner', scopeId: 'ROOMHY001', resource: 'x' }), null);
  assert.strictEqual(buildCacheKey({ panel: 'sa', scopeType: 'global', scopeId: 'ROOMHY001', resource: 'x' }), null);
  assert.strictEqual(buildCacheKey({ panel: 'admin', scopeType: 'global', resource: 'x' }), null);
  // Staff and SA namespaces never overlap.
  const staff = buildCacheKey({ panel: 'staff', scopeType: 'employee', scopeId: '65f0c1aa65f0c1aa65f0c1aa', resource: 'r' });
  const sa = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'r' });
  assert.ok(staff.startsWith('rh:v1:staff:') && sa.startsWith('rh:v1:sa:'));
  // Param order does not matter; param values do.
  const p1 = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'r', params: { a: 1, b: 2 } });
  const p2 = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'r', params: { b: 2, a: 1 } });
  const p3 = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'r', params: { a: 1, b: 3 } });
  assert.strictEqual(p1, p2);
  assert.notStrictEqual(p1, p3);
  // Version is part of every key.
  await useEnv({ CACHE_VERSION: 'v2' });
  assert.match(buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'r' }), /^rh:v2:sa:/);
});

test('owner key only for an owner reading their own data, scoped by auth not URL', async () => {
  await useEnv({});
  const owner = (loginId, role = 'owner') => ({ user: { role, loginId } });
  assert.match(ownerSelfCacheKey(owner('roomhy001'), 'ROOMHY001', 'owner-demand'), /^rh:v1:owner:owner:ROOMHY001:owner-demand:0$/);
  assert.match(ownerSelfCacheKey(owner('ROOMHY001', 'property_owner'), 'roomhy001 ', 'owner-demand'), /:ROOMHY001:/);
  assert.strictEqual(ownerSelfCacheKey(owner('ROOMHY001'), 'ROOMHY002', 'owner-demand'), null, 'A asking for B');
  assert.strictEqual(ownerSelfCacheKey(owner('ROOMHY001', 'superadmin'), 'ROOMHY001', 'owner-demand'), null, 'SA bypasses');
  assert.strictEqual(ownerSelfCacheKey(owner('ROOMHY001', 'employee'), 'ROOMHY001', 'owner-demand'), null, 'staff bypasses');
  assert.strictEqual(ownerSelfCacheKey(owner('', 'owner'), '', 'owner-demand'), null, 'no identity');
  assert.strictEqual(ownerSelfCacheKey({}, 'ROOMHY001', 'owner-demand'), null, 'no req.user');
});

test('cache is fully bypassed when disabled or unconfigured', async () => {
  await useEnv({ CACHE_ENABLED: 'false', REDIS_URL: URL });
  let calls = 0;
  const v = await cache.wrap('rh:v1:sa:global:all:r:0', 60, async () => ++calls, { panel: 'sa', resource: 'r' });
  assert.strictEqual(v, 1);
  await useEnv({ CACHE_ENABLED: 'true' }); // no REDIS_URL
  assert.strictEqual(cache.isResourceEnabled('r'), false);
  assert.strictEqual(redis.getClient(), null);
});

test('redis-backed behaviour', { skip: !HAS_REDIS && 'redis-server not installed' }, async (t) => {
  startRedis();
  t.after(async () => { await redis.close(); await stopRedis(); });

  await t.test('get / set / del / exists / TTL', async () => {
    await useEnv({ REDIS_URL: URL, CACHE_ENABLED: 'true' });
    await connected();
    cli('FLUSHALL');
    const key = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'r' });
    assert.strictEqual(await cache.get(key), undefined, 'miss');
    assert.strictEqual(await cache.set(key, { n: 1 }, 30), true);
    assert.deepStrictEqual(await cache.get(key), { n: 1 }, 'hit');
    assert.strictEqual(await cache.exists(key), true);
    const ttl = Number(cli('TTL', key));
    assert.ok(ttl >= 30 && ttl <= 33, `ttl with jitter, got ${ttl}`);
    await cache.del(key);
    assert.strictEqual(await cache.exists(key), false);
  });

  await t.test('owner A cannot read owner B; wrong scope misses', async () => {
    const keyA = buildCacheKey({ panel: 'owner', scopeType: 'owner', scopeId: 'ROOMHY001', resource: 'd' });
    const keyB = buildCacheKey({ panel: 'owner', scopeType: 'owner', scopeId: 'ROOMHY002', resource: 'd' });
    await cache.set(keyA, { secret: 'A' }, 30);
    assert.strictEqual(await cache.get(keyB), undefined);
    const staffKey = buildCacheKey({ panel: 'staff', scopeType: 'employee', scopeId: 'ROOMHY001', resource: 'd' });
    assert.strictEqual(await cache.get(staffKey), undefined, 'staff namespace cannot see owner entry');
  });

  await t.test('wrap: miss → fetch → stored; hit skips fetch; null key bypasses', async () => {
    const key = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'w' });
    let calls = 0;
    const fetch = async () => ({ calls: ++calls });
    assert.deepStrictEqual(await cache.wrap(key, 30, fetch, { panel: 'sa', resource: 'w' }), { calls: 1 });
    await sleep(50); // SET is fire-and-forget
    assert.deepStrictEqual(await cache.wrap(key, 30, fetch, { panel: 'sa', resource: 'w' }), { calls: 1 });
    assert.deepStrictEqual(await cache.wrap(null, 30, fetch, { panel: 'sa', resource: 'w' }), { calls: 2 });
  });

  await t.test('version bump orphans old entries', async () => {
    const v1 = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'ver' });
    await cache.set(v1, { old: true }, 30);
    await useEnv({ REDIS_URL: URL, CACHE_ENABLED: 'true', CACHE_VERSION: 'v2' });
    await connected();
    const v2 = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'ver' });
    assert.notStrictEqual(v1, v2);
    assert.strictEqual(await cache.get(v2), undefined);
    await useEnv({ REDIS_URL: URL, CACHE_ENABLED: 'true' });
    await connected();
  });

  await t.test('clearPanel uses SCAN and only touches that panel', async () => {
    const sa = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'c' });
    const staff = buildCacheKey({ panel: 'staff', scopeType: 'employee', scopeId: 'E1', resource: 'c' });
    await cache.set(sa, { a: 1 }, 30);
    await cache.set(staff, { a: 1 }, 30);
    assert.ok((await cache.clearPanel('sa')) >= 1);
    assert.strictEqual(await cache.exists(sa), false);
    assert.strictEqual(await cache.exists(staff), true);
  });

  await t.test('payload over the size limit is not stored', async () => {
    process.env.CACHE_MAX_PAYLOAD_BYTES = '100';
    resetConfig();
    const key = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'big' });
    assert.strictEqual(await cache.set(key, { s: 'x'.repeat(500) }, 30), false);
    delete process.env.CACHE_MAX_PAYLOAD_BYTES;
    resetConfig();
  });

  await t.test('malformed cached value → miss and entry dropped', async () => {
    const key = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'bad' });
    cli('SET', key, '{not json');
    assert.strictEqual(await cache.get(key), undefined);
    await sleep(50);
    assert.strictEqual(cli('EXISTS', key), '0');
  });

  await t.test('Redis timeout → bounded fail-open', async () => {
    await useEnv({ REDIS_URL: URL, CACHE_ENABLED: 'true', REDIS_COMMAND_TIMEOUT_MS: '200' });
    await connected();
    const key = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'slow' });
    const sleeper = spawn('redis-cli', ['-p', String(PORT), 'DEBUG', 'SLEEP', '1'], { stdio: 'ignore' });
    const sleeperExit = new Promise((r) => sleeper.once('exit', r));
    await sleep(100);
    const started = Date.now();
    let calls = 0;
    const v = await cache.wrap(key, 30, async () => ++calls, { panel: 'sa', resource: 'slow' });
    const took = Date.now() - started;
    assert.strictEqual(v, 1, 'fell through to the DB fetch');
    assert.ok(took < 800, `gave up quickly (${took}ms), not after the full 1s stall`);
    await sleeperExit;
  });

  await t.test('HTTP: SA response cached for superadmin only; staff always bypass', async () => {
    await useEnv({ REDIS_URL: URL, CACHE_ENABLED: 'true' });
    await connected();
    cli('FLUSHALL');
    const express = require('express');
    const app = express();
    let handlerRuns = 0;
    app.use((req, _res, next) => { req.user = { role: req.headers['x-test-role'] }; next(); });
    app.get('/report', cache.cacheJsonResponse({
      panel: 'sa', resource: 'sa-test', ttlSeconds: 30,
      keyFor: (req) => (req.user.role === 'superadmin'
        ? buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'sa-test' }) : null),
    }), (_req, res) => res.json({ success: true, run: ++handlerRuns }));
    const srv = app.listen(0);
    const base = `http://127.0.0.1:${srv.address().port}/report`;
    const call = async (role) => {
      const r = await fetch(base, { headers: { 'x-test-role': role } });
      return { x: r.headers.get('x-cache'), body: await r.json() };
    };
    try {
      const first = await call('superadmin');
      assert.strictEqual(first.x, 'MISS');
      await sleep(50);
      const second = await call('superadmin');
      assert.strictEqual(second.x, 'HIT');
      assert.deepStrictEqual(second.body, first.body, 'identical payload');
      const staff = await call('employee');
      assert.strictEqual(staff.x, 'BYPASS');
      assert.strictEqual(staff.body.run, 2, 'staff ran the real handler, never read the SA entry');
    } finally {
      srv.close();
    }
  });

  await t.test('HTTP: owner demand cached per owner; SA bypasses', async () => {
    await useEnv({ REDIS_URL: URL, CACHE_ENABLED: 'true' });
    await connected();
    const express = require('express');
    const app = express();
    app.use((req, _res, next) => {
      req.user = { role: req.headers['x-role'], loginId: req.headers['x-login'] };
      next();
    });
    app.get('/demand/:ownerLoginId', cache.cacheJsonResponse({
      panel: 'owner', resource: 'owner-demand', ttlSeconds: 30,
      keyFor: (req) => ownerSelfCacheKey(req, req.params.ownerLoginId, 'owner-demand'),
    }), (req, res) => res.json({ success: true, owner: req.params.ownerLoginId, at: Math.random() }));
    const srv = app.listen(0);
    const call = async (id, role, login) => {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/demand/${id}`, { headers: { 'x-role': role, 'x-login': login } });
      return { x: r.headers.get('x-cache'), body: await r.json() };
    };
    try {
      const a1 = await call('ROOMHY001', 'owner', 'ROOMHY001');
      await sleep(50);
      const a2 = await call('ROOMHY001', 'owner', 'ROOMHY001');
      assert.deepStrictEqual([a1.x, a2.x], ['MISS', 'HIT']);
      assert.strictEqual(a2.body.at, a1.body.at);
      const b = await call('ROOMHY002', 'owner', 'ROOMHY002');
      assert.strictEqual(b.x, 'MISS', 'owner B never gets owner A entry');
      assert.strictEqual(b.body.owner, 'ROOMHY002');
      const sa = await call('ROOMHY001', 'superadmin', 'SA1');
      assert.strictEqual(sa.x, 'BYPASS');
      assert.notStrictEqual(sa.body.at, a1.body.at, 'SA ran the handler itself');
    } finally {
      srv.close();
    }
  });

  // ── OTP ────────────────────────────────────────────────────────────────────
  await t.test('OTP: create, verify, wrong code, expiry, purpose separation', async () => {
    await useEnv({ REDIS_URL: URL, REDIS_STATE_ENABLED: 'true' });
    await connected();
    const auth = createOtpStore('auth');
    const kyc = createOtpStore('kyc-login');
    await auth.set('a@b.com', { otp: '123456', expiryTime: Date.now() + 10 * 60 * 1000 });
    const got = await auth.get('a@b.com');
    assert.strictEqual(got.otp, '123456');
    assert.notStrictEqual(got.otp, '000000', 'a wrong code does not match');
    assert.strictEqual(await kyc.get('a@b.com'), undefined, 'other purpose cannot see it');
    // Raw identifier never appears in Redis keys.
    assert.strictEqual(cli('--scan', '--pattern', '*a@b.com*'), '');
    const ttl = Number(cli('PTTL', cli('--scan', '--pattern', 'rh:state:otp:auth:*')));
    assert.ok(ttl > 10 * 60 * 1000 && ttl <= 11 * 60 * 1000, 'TTL = expiry + grace');
    // Attempt counter survives a round trip (routes re-set after incrementing).
    got.attempts = 3;
    await auth.set('a@b.com', got);
    assert.strictEqual((await auth.get('a@b.com')).attempts, 3);
    await auth.delete('a@b.com');
    assert.strictEqual(await auth.get('a@b.com'), undefined);
    // Already-expired entry still disappears on its own.
    await auth.set('x', { otp: '1', expiryTime: Date.now() - 120000 });
    await sleep(1100);
    assert.strictEqual(await auth.get('x'), undefined);
  });

  await t.test('OTP attempts are counted atomically under concurrency; new OTP resets them', async () => {
    const store = createOtpStore('auth');
    const value = { otp: '111111', expiryTime: Date.now() + 60000 };
    await store.set('c@d.com', value);
    const counts = await Promise.all(Array.from({ length: 10 }, () => store.countAttempt('c@d.com', value)));
    assert.deepStrictEqual(counts.sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'no two guesses share a count');
    await store.set('c@d.com', { otp: '222222', expiryTime: Date.now() + 60000 });
    assert.strictEqual(await store.countAttempt('c@d.com', value), 1, 'fresh OTP, fresh count');
    await store.delete('c@d.com');
    assert.strictEqual(cli('--scan', '--pattern', 'rh:state:otp:auth:*attempts'), '', 'delete removes the counter');
  });

  await t.test('OTP set in one process verifies in another process', async () => {
    const child = `
      process.env.REDIS_URL=${JSON.stringify(URL)}; process.env.REDIS_STATE_ENABLED='true';
      const { createOtpStore } = require('./utils/otpStore');
      const redis = require('./utils/redisClient');
      (async () => {
        await createOtpStore('checkin').set('owner:R1:1234', { otp: '654321', expiresAt: Date.now() + 60000 });
        await redis.close();
      })();`;
    execFileSync(process.execPath, ['-e', child], { cwd: ROOT });
    const entry = await createOtpStore('checkin').get('owner:R1:1234');
    assert.strictEqual(entry.otp, '654321');
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  await t.test('rate limit counters are shared across store instances and expire', async () => {
    cli('FLUSHALL');
    const a = createRateLimitStore('otp');
    const b = createRateLimitStore('otp'); // a second process, in effect
    a.init({ windowMs: 400 });
    b.init({ windowMs: 400 });
    assert.strictEqual((await a.increment('user:1')).totalHits, 1);
    assert.strictEqual((await b.increment('user:1')).totalHits, 2);
    assert.strictEqual((await a.increment('user:2')).totalHits, 1, 'keys independent');
    await a.decrement('user:never-seen');
    assert.strictEqual(cli('--scan', '--pattern', 'rh:state:rl:*').split('\n').length, 2, 'decrement on a missing key creates nothing');
    await b.decrement('user:1');
    assert.strictEqual((await a.increment('user:1')).totalHits, 2);
    await sleep(500);
    assert.strictEqual((await a.increment('user:1')).totalHits, 1, 'window expired');
    await a.resetKey('user:1');
    assert.strictEqual((await b.increment('user:1')).totalHits, 1);
    a.shutdown(); b.shutdown();
  });

  await t.test('rate limit shared with a separate OS process', async () => {
    const child = `
      process.env.REDIS_URL=${JSON.stringify(URL)}; process.env.REDIS_STATE_ENABLED='true';
      const { createRateLimitStore } = require('./middleware/rateLimitStore');
      const redis = require('./utils/redisClient');
      (async () => {
        await redis.waitReady(3000);
        const s = createRateLimitStore('auth'); s.init({ windowMs: 60000 });
        for (let i = 0; i < 3; i++) await s.increment('ip:9.9.9.9');
        s.shutdown(); await redis.close();
      })();`;
    execFileSync(process.execPath, ['-e', child], { cwd: ROOT });
    const s = createRateLimitStore('auth');
    s.init({ windowMs: 60000 });
    assert.strictEqual((await s.increment('ip:9.9.9.9')).totalHits, 4);
    s.shutdown();
  });

  // ── Outage + reconnect (must run last: kills the server) ──────────────────
  await t.test('Redis down: cache falls back, rate limit falls back, OTP fails closed; then reconnects', async () => {
    await useEnv({ REDIS_URL: URL, CACHE_ENABLED: 'true', REDIS_STATE_ENABLED: 'true' });
    await connected();
    await stopRedis();
    await sleep(200);

    let calls = 0;
    const key = buildCacheKey({ panel: 'sa', scopeType: 'global', resource: 'down' });
    assert.strictEqual(await cache.wrap(key, 30, async () => ++calls, { panel: 'sa', resource: 'down' }), 1);
    assert.strictEqual(await cache.set(key, { a: 1 }, 30), false);
    assert.strictEqual((await redis.health()).status, 'unavailable');

    const rl = createRateLimitStore('global');
    rl.init({ windowMs: 60000 });
    assert.strictEqual((await rl.increment('k')).totalHits, 1, 'counted in memory');
    assert.strictEqual((await rl.increment('k')).totalHits, 2);
    rl.shutdown();

    process.env.REDIS_CONNECT_TIMEOUT_MS = '300';
    resetConfig();
    await assert.rejects(createOtpStore('auth').get('a@b.com'), /OTP store unavailable/);
    delete process.env.REDIS_CONNECT_TIMEOUT_MS;
    resetConfig();

    startRedis();
    const c = await redis.waitReady(8000);
    assert.ok(c, 'client reconnected on its own');
    assert.ok(['healthy', 'degraded'].includes((await redis.health()).status));
    assert.strictEqual(await cache.set(key, { a: 1 }, 30), true);
  });
});

test('OTP and rate limit keep in-memory behaviour when state is disabled', async () => {
  await useEnv({ REDIS_STATE_ENABLED: 'false' });
  const store = createOtpStore('kyc-signup');
  const v = { otp: '1', expiresAt: Date.now() + 60000 };
  await store.set('e', v);
  assert.strictEqual(await store.get('e'), v, 'same object, like the old Map');
  assert.strictEqual(await store.countAttempt('e', v), 1);
  assert.strictEqual(v.attempts, 1, 'memory mode mutates in place, as before');
  await store.delete('e');
  assert.strictEqual(await store.get('e'), undefined);
  const rl = createRateLimitStore('form');
  rl.init({ windowMs: 60000 });
  assert.strictEqual((await rl.increment('k')).totalHits, 1);
  rl.shutdown();
});
