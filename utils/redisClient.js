'use strict';

/**
 * redisClient.js — the ONE shared Redis connection for this process.
 *
 * Every Redis user (cache, OTP store, rate-limit store) goes through
 * getClient(); nothing else may call `new Redis()`.
 *
 * Failure model: Redis is an accelerator. enableOfflineQueue is off and
 * maxRetriesPerRequest is 1, so while Redis is down a command fails in
 * milliseconds instead of queueing behind the request deadline — callers
 * catch that and fall back (cache → MongoDB, rate limit → in-memory).
 * The connection itself keeps retrying in the background with backoff.
 *
 * Never log the URL or options: REDIS_URL carries the password.
 */

const Redis = require('ioredis');
const { getConfig } = require('../config/redis');

let client = null;
let lastErrorAt = 0;
let lastErrorLogAt = 0;
let infoSnapshot = { at: 0, data: null };

const ERROR_LOG_INTERVAL_MS = 30 * 1000;
const DEGRADED_WINDOW_MS = 60 * 1000;
const PING_SLOW_MS = 100;

let metricsRef;
function metrics() {
  if (metricsRef === undefined) {
    try { metricsRef = require('./prometheusMetrics').redis || null; } catch (_) { metricsRef = null; }
  }
  return metricsRef;
}

// INCR + set expiry on first hit, atomically. Returns [hits, pttl].
const RATE_INCR_LUA = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;

// DECR only an existing counter: a bare DECR on an already-expired key would
// create a new key with no TTL that never goes away.
const RATE_DECR_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

function getClient() {
  if (client) return client;
  const cfg = getConfig();
  if (!cfg.configured) return null;

  // rediss:// URLs switch TLS on inside ioredis; the password comes from the URL.
  client = new Redis(cfg.url, {
    connectionName: 'roomhy-backend',
    connectTimeout: cfg.connectTimeoutMs,
    commandTimeout: cfg.commandTimeoutMs,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // Reconnect forever, backing off to one attempt every 5s.
    retryStrategy: (times) => Math.min(times * 200, 5000),
  });

  client.defineCommand('rhRateIncr', { numberOfKeys: 1, lua: RATE_INCR_LUA });
  client.defineCommand('rhRateDecr', { numberOfKeys: 1, lua: RATE_DECR_LUA });

  client.on('ready', () => {
    metrics()?.up.set(1);
    console.log('✅ Redis connected');
  });
  client.on('end', () => metrics()?.up.set(0));
  client.on('close', () => metrics()?.up.set(0));
  client.on('error', (err) => {
    lastErrorAt = Date.now();
    metrics()?.connectionErrors.inc();
    // ioredis emits on every reconnect attempt — throttle so an outage is
    // a few log lines, not thousands. err.code, not the message, so no host
    // or credential detail can reach the logs.
    if (Date.now() - lastErrorLogAt > ERROR_LOG_INTERVAL_MS) {
      lastErrorLogAt = Date.now();
      console.warn(`⚠️ Redis error (${err.code || err.name || 'unknown'}) — cache bypassed, falling back`);
    }
  });

  return client;
}

/** The client if it can take a command right now, else null. Never waits. */
function readyClient() {
  const c = getClient();
  return c && c.status === 'ready' ? c : null;
}

/**
 * Wait (bounded) for the connection to come up. Only for state (OTP), where
 * a cold serverless instance should not fail the very first request; cache
 * reads never wait — they just bypass.
 */
function waitReady(timeoutMs = getConfig().connectTimeoutMs) {
  const c = getClient();
  if (!c) return Promise.resolve(null);
  if (c.status === 'ready') return Promise.resolve(c);
  if (c.status === 'end') return Promise.resolve(null);
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      c.off('ready', onReady);
      resolve(value);
    };
    const onReady = () => done(c);
    const timer = setTimeout(() => done(null), timeoutMs);
    c.once('ready', onReady);
  });
}

/** Run one Redis command and record its latency under a bounded `op` label. */
async function timed(op, fn) {
  const end = metrics()?.commandDuration.startTimer({ op });
  try {
    return await fn();
  } catch (err) {
    lastErrorAt = Date.now();
    throw err;
  } finally {
    if (end) end();
  }
}

/** Mark a command failure seen by a caller (feeds the "degraded" health state). */
function noteError() {
  lastErrorAt = Date.now();
}

/**
 * healthy | degraded | unavailable | disabled — deliberately nothing else.
 * No host, port, error text or version, so the public health endpoint cannot
 * leak infrastructure detail.
 */
async function health() {
  const cfg = getConfig();
  if (!cfg.configured) return { status: 'disabled' };
  const c = readyClient();
  if (!c) return { status: 'unavailable' };
  const started = Date.now();
  try {
    await c.ping();
  } catch (_) {
    noteError();
    return { status: 'unavailable' };
  }
  const latencyMs = Date.now() - started;
  const recentErrors = Date.now() - lastErrorAt < DEGRADED_WINDOW_MS;
  return {
    status: latencyMs > PING_SLOW_MS || recentErrors ? 'degraded' : 'healthy',
    latencyMs,
  };
}

/**
 * Memory/eviction figures from INFO, cached for 10s so a busy Prometheus
 * scrape cannot turn into a stream of INFO calls.
 */
async function getInfoSnapshot() {
  if (Date.now() - infoSnapshot.at < 10 * 1000) return infoSnapshot.data;
  const c = readyClient();
  if (!c) return null;
  try {
    const text = await c.info();
    const read = (field) => {
      const m = text.match(new RegExp(`^${field}:(.*)$`, 'm'));
      return m ? m[1].trim() : null;
    };
    infoSnapshot = {
      at: Date.now(),
      data: {
        usedMemoryBytes: Number(read('used_memory')) || 0,
        maxMemoryBytes: Number(read('maxmemory')) || 0,
        evictedKeys: Number(read('evicted_keys')) || 0,
        maxMemoryPolicy: read('maxmemory_policy') || '',
      },
    };
    return infoSnapshot.data;
  } catch (_) {
    return null;
  }
}

/** Clean shutdown: QUIT, but never hang process exit on a dead server. */
async function close(timeoutMs = 1000) {
  if (!client) return;
  const c = client;
  client = null;
  try {
    await Promise.race([
      c.quit(),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  } catch (_) { /* already closed */ }
  c.disconnect();
}

module.exports = { getClient, readyClient, waitReady, timed, noteError, health, getInfoSnapshot, close };
