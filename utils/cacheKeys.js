'use strict';

/**
 * cacheKeys.js — the ONLY place a cache key may be built.
 *
 *   rh:{version}:{panel}:{scopeType}:{scopeId}:{resource}:{paramsHash}
 *
 *   rh:v1:staff:employee:65f0c1…:visit-scope:9b1e…
 *   rh:v1:sa:global:all:reports-overview:0
 *
 * SECURITY BOUNDARY. buildCacheKey returns null — never a weaker key — when
 * anything needed to isolate the entry is missing or malformed. Callers treat
 * null as "bypass the cache and read MongoDB". There is no code path that
 * turns a missing owner/employee id into `owner:undefined` or a global key.
 *
 * Each panel may only use its own scope type, so an owner-scoped resource can
 * never be written under the SA global namespace and vice versa. The scopeId
 * must come from server-side auth context (req.user / req.employeeScope),
 * never from req.params / req.query / req.body.
 */

const crypto = require('crypto');
const { getConfig } = require('../config/redis');

const PANEL_SCOPE_TYPES = Object.freeze({
  owner: ['owner'],
  staff: ['employee'],
  sa: ['global'],
});

// ':' can never appear, so no segment can forge another segment.
const SCOPE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RESOURCE_RE = /^[a-z0-9-]{1,48}$/;
// String(undefined) and friends pass the charset test; reject them explicitly.
const PLACEHOLDER_IDS = new Set(['undefined', 'null', 'nan', 'true', 'false', 'global', 'all', '0']);

/** JSON with sorted object keys, so {a,b} and {b,a} hash the same. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashParams(params) {
  if (params === undefined || params === null) return '0';
  if (typeof params === 'object' && Object.keys(params).length === 0) return '0';
  return crypto.createHash('sha256').update(stableStringify(params)).digest('hex').slice(0, 16);
}

function normalizeScopeId(scopeId) {
  if (scopeId === undefined || scopeId === null) return null;
  // Strings, numbers and ObjectIds only — a plain object would stringify to
  // "[object Object]" and collapse every caller onto one key.
  if (typeof scopeId === 'object' && typeof scopeId.toHexString !== 'function') return null;
  const id = String(scopeId).trim();
  if (!SCOPE_ID_RE.test(id) || PLACEHOLDER_IDS.has(id.toLowerCase())) return null;
  return id;
}

/**
 * @returns {string|null} the key, or null meaning "do not cache this request".
 */
function buildCacheKey({ panel, scopeType, scopeId, resource, params } = {}) {
  const allowed = PANEL_SCOPE_TYPES[panel];
  if (!allowed || !allowed.includes(scopeType)) return null;
  if (!RESOURCE_RE.test(String(resource || ''))) return null;

  let id;
  if (scopeType === 'global') {
    // A global key must not silently absorb a scope id that was meant to isolate it.
    if (scopeId !== undefined && scopeId !== null) return null;
    id = 'all';
  } else {
    id = normalizeScopeId(scopeId);
    if (!id) return null;
  }

  return `rh:${getConfig().version}:${panel}:${scopeType}:${id}:${resource}:${hashParams(params)}`;
}

/** SCAN pattern for one panel's namespace in the current version. */
function panelPattern(panel) {
  if (!PANEL_SCOPE_TYPES[panel]) return null;
  return `rh:${getConfig().version}:${panel}:*`;
}

/**
 * Bounded metric labels recovered from a key built above. Never the scope
 * id or the hash — those are unbounded and would explode label cardinality.
 */
function labelsFromKey(key) {
  const parts = String(key || '').split(':');
  if (parts.length !== 7 || parts[0] !== 'rh') return { panel: 'unknown', resource: 'unknown' };
  return { panel: parts[2], resource: parts[5] };
}

const OWNER_ROLES = new Set(['owner', 'propertyowner', 'property_owner']);

/**
 * Owner-panel key for an owner reading THEIR OWN data, else null (bypass).
 *
 * The scope id is req.user.loginId — resolved from the DB by protect() —
 * and it must equal the owner the route is serving. Superadmin, staff and
 * managers who are allowed to view an owner's page still get null: they
 * read MongoDB directly and never touch the owner namespace.
 */
function ownerSelfCacheKey(req, targetOwnerLoginId, resource, params) {
  const role = String(req.user?.role || '').toLowerCase();
  if (!OWNER_ROLES.has(role)) return null;
  const self = String(req.user?.loginId || '').trim().toUpperCase();
  const target = String(targetOwnerLoginId || '').trim().toUpperCase();
  if (!self || self !== target) return null;
  return buildCacheKey({ panel: 'owner', scopeType: 'owner', scopeId: self, resource, params });
}

module.exports = { buildCacheKey, ownerSelfCacheKey, panelPattern, labelsFromKey, hashParams, stableStringify };
