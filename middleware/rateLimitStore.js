'use strict';

/**
 * rateLimitStore.js — express-rate-limit store shared across processes.
 *
 * With the default MemoryStore every PM2 worker / serverless instance keeps
 * its own counters, so N processes quietly allow N × the configured limit.
 * This store counts in Redis instead when REDIS_STATE_ENABLED=true.
 *
 * Fallback: whenever Redis is off, not yet connected, or a command fails,
 * the request is counted in a per-process MemoryStore — i.e. exactly the
 * old behaviour. Limits get looser during an outage; they never disappear
 * and a Redis outage never turns into a wall of 429s or 500s.
 *
 * Keys: `rh:state:rl:{limiter}:{sha256}` — the raw key can be an email or
 * user id, and `state` keeps counters apart from disposable cache keys.
 */

const crypto = require('crypto');
const { MemoryStore } = require('express-rate-limit');
const { getConfig } = require('../config/redis');
const redis = require('../utils/redisClient');

let metricsRef;
function metrics() {
  if (metricsRef === undefined) {
    try { metricsRef = require('../utils/prometheusMetrics').redis || null; } catch (_) { metricsRef = null; }
  }
  return metricsRef;
}

class SharedRateLimitStore {
  constructor(name) {
    if (!/^[a-z0-9-]{1,32}$/.test(name)) throw new Error(`invalid rate limiter name: ${name}`);
    this.name = name;
    this.prefix = `rh:state:rl:${name}:`;
    this.memory = new MemoryStore();
    // Counters live outside this process whenever Redis is in use.
    this.localKeys = false;
  }

  init(options) {
    this.windowMs = options.windowMs;
    this.memory.init(options);
  }

  _client() {
    // Read per call, not in init(): init runs at require time, before .env loads.
    return getConfig().stateEnabled ? redis.readyClient() : null;
  }

  _key(key) {
    return this.prefix + crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 32);
  }

  _fallback(op) {
    redis.noteError();
    metrics()?.rateLimitFallback.inc({ limiter: this.name, op });
  }

  async increment(key) {
    const c = this._client();
    if (c) {
      try {
        const [hits, ttl] = await redis.timed('rl_incr', () => c.rhRateIncr(this._key(key), this.windowMs));
        return { totalHits: Number(hits), resetTime: new Date(Date.now() + Number(ttl)) };
      } catch (_) {
        this._fallback('increment');
      }
    }
    return this.memory.increment(key);
  }

  async decrement(key) {
    const c = this._client();
    if (c) {
      try {
        await redis.timed('rl_decr', () => c.rhRateDecr(this._key(key)));
        return;
      } catch (_) {
        this._fallback('decrement');
      }
    }
    await this.memory.decrement(key);
  }

  async resetKey(key) {
    const c = this._client();
    if (c) {
      try { await redis.timed('rl_reset', () => c.del(this._key(key))); } catch (_) { this._fallback('reset'); }
    }
    await this.memory.resetKey(key);
  }

  shutdown() {
    this.memory.shutdown();
  }
}

const createRateLimitStore = (name) => new SharedRateLimitStore(name);

module.exports = { createRateLimitStore, SharedRateLimitStore };
