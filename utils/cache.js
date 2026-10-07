'use strict';

/**
 * cache.js — the disposable read cache. Application → this → Redis.
 *
 * FAIL-OPEN, ALWAYS. No function here throws. Redis down, slow, full or
 * returning garbage all look like a cache miss to the caller, which then reads
 * MongoDB exactly as it did before this cache existed. Redis is never the
 * source of truth for anything stored through this module.
 *
 * Keys come from utils/cacheKeys.js only; a null key means "bypass".
 * Switched off entirely by CACHE_ENABLED=false (the default).
 */

const { getConfig } = require('../config/redis');
const redis = require('./redisClient');
const { panelPattern, labelsFromKey } = require('./cacheKeys');

let metricsRef;
function metrics() {
  if (metricsRef === undefined) {
    try { metricsRef = require('./prometheusMetrics').cache || null; } catch (_) { metricsRef = null; }
  }
  return metricsRef;
}

/** Is this resource switched on (CACHE_ENABLED + optional CACHE_RESOURCES allow-list)? */
function isResourceEnabled(resource) {
  const cfg = getConfig();
  if (!cfg.cacheEnabled || !cfg.configured) return false;
  return cfg.resources.length === 0 || cfg.resources.includes('*') || cfg.resources.includes(resource);
}

function recordBypass(panel, resource, reason) {
  metrics()?.bypass.inc({ panel, resource, reason });
}

function recordError(key, op) {
  redis.noteError();
  metrics()?.errors.inc({ panel: labelsFromKey(key).panel, op });
}

/** ±10% so entries written together do not all expire in the same second. */
function jitter(ttlSeconds) {
  const ttl = Math.max(1, Math.floor(ttlSeconds));
  return ttl + Math.floor(Math.random() * Math.max(1, Math.ceil(ttl * 0.1)));
}

/** @returns {Promise<any|undefined>} the cached value, or undefined on miss/bypass/error. */
async function get(key) {
  if (!key) return undefined;
  const { panel, resource } = labelsFromKey(key);
  const c = redis.readyClient();
  if (!c) {
    recordBypass(panel, resource, 'redis_unavailable');
    return undefined;
  }
  let raw;
  try {
    raw = await redis.timed('get', () => c.get(key));
  } catch (_) {
    recordError(key, 'get');
    return undefined;
  }
  if (raw === null || raw === undefined) {
    metrics()?.misses.inc({ panel, resource });
    return undefined;
  }
  try {
    const value = JSON.parse(raw);
    metrics()?.hits.inc({ panel, resource });
    return value;
  } catch (_) {
    // Corrupt entry: drop it so the next request repopulates from MongoDB.
    recordError(key, 'parse');
    del(key);
    return undefined;
  }
}

/** @returns {Promise<boolean>} whether the value was stored. */
async function set(key, value, ttlSeconds) {
  if (!key || value === undefined || value === null) return false;
  const { panel, resource } = labelsFromKey(key);
  const c = redis.readyClient();
  if (!c) return false;
  let json;
  try {
    json = JSON.stringify(value);
  } catch (_) {
    recordError(key, 'serialize');
    return false;
  }
  if (Buffer.byteLength(json) > getConfig().maxPayloadBytes) {
    recordBypass(panel, resource, 'too_large');
    return false;
  }
  try {
    await redis.timed('set', () => c.set(key, json, 'EX', jitter(ttlSeconds)));
    return true;
  } catch (_) {
    recordError(key, 'set');
    return false;
  }
}

/** Exact-key invalidation. UNLINK frees memory off the main Redis thread. */
async function del(...keys) {
  const list = keys.flat().filter(Boolean);
  if (!list.length) return 0;
  const c = redis.readyClient();
  if (!c) return 0;
  try {
    return await redis.timed('del', () => c.unlink(...list));
  } catch (_) {
    recordError(list[0], 'del');
    return 0;
  }
}

async function exists(key) {
  if (!key) return false;
  const c = redis.readyClient();
  if (!c) return false;
  try {
    return (await redis.timed('exists', () => c.exists(key))) === 1;
  } catch (_) {
    recordError(key, 'exists');
    return false;
  }
}

/**
 * Read-through: cached value, or fetchFn() stored for ttlSeconds.
 * A null key (scope missing) or a disabled resource goes straight to fetchFn.
 * Errors from fetchFn propagate unchanged — they are the caller's, not ours.
 */
async function wrap(key, ttlSeconds, fetchFn, { panel = 'unknown', resource = 'unknown' } = {}) {
  if (!isResourceEnabled(resource)) {
    recordBypass(panel, resource, 'disabled');
    return fetchFn();
  }
  if (!key) {
    recordBypass(panel, resource, 'no_scope');
    return fetchFn();
  }
  const cached = await get(key);
  if (cached !== undefined) return cached;
  const fresh = await fetchFn();
  // Not awaited: a slow SET must never add latency to the response.
  set(key, fresh, ttlSeconds);
  return fresh;
}

/**
 * Drop a whole panel namespace (current version only). SCAN, never KEYS:
 * KEYS blocks Redis for the full keyspace walk. For the superadmin
 * clear-cache action — not for per-request invalidation.
 */
async function clearPanel(panel) {
  const pattern = panelPattern(panel);
  const c = redis.readyClient();
  if (!pattern || !c) return 0;
  let cursor = '0';
  let removed = 0;
  try {
    do {
      const [next, batch] = await c.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (batch.length) removed += await c.unlink(...batch);
    } while (cursor !== '0');
  } catch (_) {
    recordError(`rh:x:${panel}:x:x:x:x`, 'clear');
  }
  return removed;
}

/**
 * Express middleware: cache a GET handler's successful JSON body.
 *
 *   keyFor(req) → key from utils/cacheKeys.js, or null to bypass.
 *
 * Only 200 responses whose body is not `success: false` are stored. The
 * handler itself is untouched; on a miss it runs exactly as before.
 */
function cacheJsonResponse({ panel, resource, ttlSeconds, keyFor }) {
  return async function cachedResponse(req, res, next) {
    if (req.method !== 'GET') return next();
    if (!isResourceEnabled(resource)) {
      recordBypass(panel, resource, 'disabled');
      return next();
    }
    let key = null;
    try { key = keyFor(req); } catch (_) { key = null; }
    if (!key) {
      recordBypass(panel, resource, 'no_scope');
      res.setHeader('X-Cache', 'BYPASS');
      return next();
    }

    const cached = await get(key);
    if (cached !== undefined) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }

    res.setHeader('X-Cache', 'MISS');
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200 && body && typeof body === 'object' && body.success !== false) {
        set(key, body, ttlSeconds);
      }
      return originalJson(body);
    };
    return next();
  };
}

module.exports = { get, set, del, exists, wrap, clearPanel, cacheJsonResponse, isResourceEnabled };
