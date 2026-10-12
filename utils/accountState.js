'use strict';

/**
 * accountState.js — the ONE answer to "may this account authenticate right now?"
 *
 * Every authentication entry point (protect, optionalProtect, applyEmployeeScope,
 * the inline jwt.verify helpers) asks this module, so there is a single place to
 * change the policy and a single place to audit it.
 *
 * WHY A NEGATIVE CHECK, NOT A POSITIVE ONE
 * ----------------------------------------
 * `status` defaults to 'pending' on both User (models/user.js) and Tenant
 * (models/Tenant.js), and plenty of live accounts never leave 'pending'. So this
 * must reject explicitly-revoked states and let everything else through.
 * Requiring status === 'active' would lock out a large part of the real user base
 * — that is a availability outage, not a security fix.
 *
 * Field coverage differs per collection and that is deliberate, not an oversight:
 *   User            isActive, isDeleted, status
 *   Employee        isActive, isDeleted
 *   Owner           isActive, isDeleted
 *   Tenant          isDeleted, status          (no isActive field at all)
 *   AreaManager     isActive
 *   PropertyManager isDeleted, status
 * A field that does not exist on a schema reads as `undefined`, which is NOT a
 * revoked state — only an explicit `false` / `true` / revoked status string is.
 *
 * Nothing here does I/O, so it is cheap to call on every request and can be
 * unit-tested without a database.
 */

// Only values that actually appear in the schema enums. Keeping this tight means
// a typo'd status can never silently revoke a whole collection.
const REVOKED_STATUSES = new Set(['inactive', 'blocked', 'suspended']);

/**
 * @param {object|null} account a loaded account document (or lean object)
 * @returns {string|null} a short machine reason, or null when the account may authenticate
 */
function revocationReason(account) {
    if (!account) return 'no_account';
    if (account.isDeleted === true) return 'deleted';
    if (account.isActive === false) return 'inactive';

    const status = typeof account.status === 'string' ? account.status.trim().toLowerCase() : '';
    if (status && REVOKED_STATUSES.has(status)) return `status_${status}`;

    return null;
}

/** Convenience inverse of revocationReason(). */
const isAuthenticatable = (account) => revocationReason(account) === null;

/**
 * Token-generation check — this is what makes force-logout work, and what makes
 * revocation survive REACTIVATION.
 *
 * A token carries the account's tokenVersion at issue time as `tv`. Deactivating
 * (or force-logging-out) increments the stored tokenVersion, so every token
 * minted before that moment no longer matches and stays dead even if the account
 * is later set active again.
 *
 * Missing on either side reads as 0, so tokens issued BEFORE this feature shipped
 * keep working against an un-revoked account. That is intentional: the status
 * check above already covers deactivation for those tokens, and treating absent
 * as "mismatch" would sign out every existing session on deploy.
 */
function tokenVersionMatches(account, decoded) {
    const current = Number.isFinite(account?.tokenVersion) ? account.tokenVersion : 0;
    const presented = Number.isFinite(decoded?.tv) ? decoded.tv : 0;
    return presented === current;
}

/** The claim value to embed when minting a token for this account. */
const tokenVersionClaim = (account) =>
    (Number.isFinite(account?.tokenVersion) ? account.tokenVersion : 0);

module.exports = {
    REVOKED_STATUSES,
    revocationReason,
    isAuthenticatable,
    tokenVersionMatches,
    tokenVersionClaim,
};
