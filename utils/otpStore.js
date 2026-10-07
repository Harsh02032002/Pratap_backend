'use strict';

/**
 * otpStore.js — OTP / reset-session state shared by every backend process.
 *
 * Drop-in for the per-file `new Map()` stores it replaces: same get/set/delete
 * names and the same stored objects, but async. Each entry's lifetime comes
 * from its own `expiryTime` / `expiresAt` field, so Redis expires it on time
 * even if nobody reads it again.
 *
 * Backend:
 *   REDIS_STATE_ENABLED=true + REDIS_URL → Redis. An OTP sent by one process
 *     verifies on any other (PM2 cluster, several instances, serverless).
 *   otherwise → in-process Map, i.e. exactly the previous behaviour.
 *
 * In Redis mode this FAILS CLOSED: if Redis cannot be reached the call throws
 * and the route's existing catch returns an error. Falling back to process
 * memory would issue OTPs that the next process cannot verify.
 *
 * Keys are hashed (`rh:state:otp:{purpose}:{sha256}`) because the raw keys
 * hold emails, login ids and Aadhaar numbers. The `state` prefix keeps these
 * apart from disposable cache keys and from CACHE_VERSION bumps.
 */

const crypto = require('crypto');
const { getConfig } = require('../config/redis');
const redis = require('./redisClient');

const DEFAULT_TTL_MS = 15 * 60 * 1000;
// Kept a minute past the entry's own expiry so the routes' explicit
// "has expired" checks still fire with their specific message.
const EXPIRY_GRACE_MS = 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const PURPOSE_RE = /^[a-z0-9-]{1,32}$/;

function ttlMsFor(value) {
  const expiry = Number(value && (value.expiryTime || value.expiresAt));
  const ms = Number.isFinite(expiry) && expiry > 0 ? expiry - Date.now() + EXPIRY_GRACE_MS : DEFAULT_TTL_MS;
  return Math.min(Math.max(ms, 1000), MAX_TTL_MS);
}

function useRedis() {
  const cfg = getConfig();
  return cfg.stateEnabled && cfg.configured;
}

async function stateClient() {
  const c = await redis.waitReady();
  if (!c) throw new Error('OTP store unavailable');
  return c;
}

function createOtpStore(purpose) {
  if (!PURPOSE_RE.test(purpose)) throw new Error(`invalid OTP store purpose: ${purpose}`);
  const prefix = `rh:state:otp:${purpose}:`;
  const keyFor = (key) => prefix + crypto.createHash('sha256').update(String(key)).digest('hex');

  // Memory backend: entries carry their own deadline; swept lazily on read
  // and every 5 minutes so abandoned OTPs cannot pile up.
  const memory = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of memory) if (entry.deadline <= now) memory.delete(k);
  }, 5 * 60 * 1000).unref();

  return {
    async get(key) {
      if (useRedis()) {
        const c = await stateClient();
        const raw = await redis.timed('otp_get', () => c.get(keyFor(key)));
        return raw ? JSON.parse(raw) : undefined;
      }
      const entry = memory.get(String(key));
      if (!entry) return undefined;
      if (entry.deadline <= Date.now()) {
        memory.delete(String(key));
        return undefined;
      }
      // Same object reference as the old Map returned.
      return entry.value;
    },

    async set(key, value) {
      const ttlMs = ttlMsFor(value);
      if (useRedis()) {
        const c = await stateClient();
        // A fresh OTP starts a fresh attempt count.
        await redis.timed('otp_set', () => c.multi()
          .set(keyFor(key), JSON.stringify(value), 'PX', ttlMs)
          .del(keyFor(key) + ':attempts')
          .exec());
        return;
      }
      memory.set(String(key), { value, deadline: Date.now() + ttlMs });
    },

    async delete(key) {
      if (useRedis()) {
        const c = await stateClient();
        await redis.timed('otp_del', () => c.del(keyFor(key), keyFor(key) + ':attempts'));
        return;
      }
      memory.delete(String(key));
    },

    /**
     * Record one verification attempt and return the running total.
     * Redis: INCR on a sibling key, so N concurrent requests get N distinct
     * counts (a get → attempts++ → set round trip would let them all read the
     * same value). Memory: the old in-place `value.attempts++`.
     */
    async countAttempt(key, value) {
      if (useRedis()) {
        const c = await stateClient();
        const attemptsKey = keyFor(key) + ':attempts';
        const [[err, count]] = await redis.timed('otp_attempt', () =>
          c.multi().incr(attemptsKey).pexpire(attemptsKey, ttlMsFor(value)).exec());
        // Never let a failed INCR read as "0 attempts" (NaN > 5 is false).
        if (err || !Number.isFinite(Number(count))) throw err || new Error('OTP attempt count failed');
        return Number(count);
      }
      value.attempts = (value.attempts || 0) + 1;
      return value.attempts;
    },
  };
}

module.exports = { createOtpStore };
