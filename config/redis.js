'use strict';

/**
 * redis.js — every Redis/cache setting in one place, read from the environment.
 *
 * Two independent switches, so each can be rolled back on its own:
 *
 *   CACHE_ENABLED        disposable read cache (staff visit-scope, SA reports,
 *                        owner demand report).
 *                        false → every cached route goes straight to MongoDB.
 *   REDIS_STATE_ENABLED  OTPs and rate-limit counters. false → the original
 *                        per-process in-memory behaviour.
 *
 * Both default to false: setting REDIS_URL alone changes no request
 * behaviour (only /api/health starts reporting Redis status).
 * Nothing here is ever logged — REDIS_URL carries the password.
 *
 * Read lazily on first use, NOT at require time: server.js requires
 * middleware/security.js (and through it this file) before dotenv.config()
 * runs, so a require-time read would silently see an empty environment.
 */

const bool = (name, fallback = false) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return String(raw).trim().toLowerCase() === 'true';
};

const int = (name, fallback) => {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

function load() {
  const url = String(process.env.REDIS_URL || '').trim();
  const version = String(process.env.CACHE_VERSION || 'v1').trim();

  return Object.freeze({
    url,
    configured: url.length > 0,
    cacheEnabled: bool('CACHE_ENABLED'),
    stateEnabled: bool('REDIS_STATE_ENABLED'),
    // Bumping this (v1 → v2) orphans every old cache entry; they expire on TTL.
    // Restricted to a safe charset because it is embedded in every key.
    version: /^[a-z0-9]{1,8}$/i.test(version) ? version : 'v1',
    // Comma list of cache resources to switch on, for gradual rollout.
    // Empty = every wired resource. Example: CACHE_RESOURCES=sa-reports-overview
    resources: String(process.env.CACHE_RESOURCES || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // Redis must give up long before the 10s request deadline in timeouts.js.
    connectTimeoutMs: int('REDIS_CONNECT_TIMEOUT_MS', 2000),
    commandTimeoutMs: int('REDIS_COMMAND_TIMEOUT_MS', 500),
    // Cache entries larger than this are not stored (the request still succeeds).
    maxPayloadBytes: int('CACHE_MAX_PAYLOAD_BYTES', 512 * 1024),
  });
}

let cached = null;
const getConfig = () => cached || (cached = load());

// Tests only: re-read the environment.
const resetConfig = () => { cached = null; };

module.exports = { getConfig, resetConfig };
