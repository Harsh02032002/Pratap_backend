'use strict';

/**
 * Identifier normalization helpers.
 *
 * Every login identifier in this system is generated uppercase
 * (see utils/generateOwnerId.js → "ROOMHY1234", utils/generateTenantId.js →
 * "ROOMHYTNT1234", Employee/Manager IDs likewise). Because the canonical form
 * is uppercase, an exact equality match is always sufficient — and unlike a
 * case-insensitive regex it can use a normal B-tree index.
 *
 * A case-insensitive regex such as /^ROOMHY1234$/i CANNOT use an index, even
 * when anchored, so queries written that way fall back to a full collection
 * scan (COLLSCAN). The fields involved (ownerLoginId, loginId, tenantLoginId,
 * …) are already indexed, so the fix is to stop defeating those indexes.
 *
 * Use normalizeLoginId() at the boundary where an identifier enters the system
 * (route params, query strings, request bodies, JWT payloads) and then query
 * with plain equality.
 *
 * Defence in depth: the identifier paths on the affected schemas also declare
 * `uppercase: true, trim: true`. Mongoose 8 applies schema setters to query
 * filters at cast time (verified for equality, $in, $or and findOne), so a
 * caller that forgets to normalize still produces a normalized — and therefore
 * index-eligible — query. That safety net does NOT apply to aggregation
 * pipelines or raw driver calls, which must normalize explicitly.
 */

/**
 * Canonical form of a login identifier: trimmed and uppercased.
 * Non-string input is returned untouched so callers can pass through
 * ObjectIds, null and undefined without special-casing.
 *
 * @param {*} loginId
 * @returns {*} the normalized string, or the original value if not a string
 */
const normalizeLoginId = (loginId) => {
  if (typeof loginId !== 'string') return loginId;
  return loginId.trim().toUpperCase();
};

/**
 * Normalize a list of identifiers, dropping empties and de-duplicating.
 * Useful for building `{ field: { $in: [...] } }` filters, which are
 * index-eligible — an $in of regexes is not.
 *
 * @param {Array<*>} values
 * @returns {string[]}
 */
const normalizeLoginIdList = (values) => {
  if (!Array.isArray(values)) return [];
  const out = new Set();
  for (const value of values) {
    const normalized = normalizeLoginId(value);
    if (typeof normalized === 'string' && normalized) out.add(normalized);
  }
  return [...out];
};

/**
 * Escape a string for safe literal use inside a RegExp.
 *
 * Only for the places where a regex is genuinely required (partial search,
 * suffix matching). Never build a query regex from user input without this —
 * unescaped metacharacters allow both incorrect matches and ReDoS.
 *
 * @param {*} value
 * @returns {string}
 */
const escapeRegex = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  normalizeLoginId,
  normalizeLoginIdList,
  escapeRegex,
};
