'use strict';

/**
 * checkinAccessService.js — the proof that unlocks a tenant's sensitive
 * check-in data, issued only after that tenant's KYC OTP verifies.
 *
 * WHY: the digital check-in flow is anonymous by design (emailed ?loginId=
 * links, no session), and a loginId is guessable, so a loginId alone must not
 * unlock anything sensitive. The KYC OTP is the one step that proves control
 * of the tenant: it is emailed to the address ALREADY ON FILE for that tenant
 * (never one the caller supplies), and the OTP entry is keyed by that
 * tenant's loginId, so an OTP issued for tenant A cannot verify as tenant B.
 *
 * DESIGN
 *   • The proof is an opaque 256-bit random string, not a JWT. It therefore
 *     cannot be mistaken for — or verified as — a session token by protect(),
 *     and carries no claims a client could edit.
 *   • Only sha256(proof) is stored, so a dump of Redis/memory yields nothing
 *     usable. It lives in the shared OTP store (purpose 'checkin-access'), so
 *     it behaves across processes exactly like the OTP that issued it.
 *   • Bound to the tenant's _id AND loginId at issue time, both taken from the
 *     database record, never from the request. Verification re-checks both
 *     against the tenant being requested, so it cannot be replayed against a
 *     different loginId.
 *   • 30-minute lifetime (one check-in session). Multi-use within that window
 *     on purpose: the flow reads the profile from several steps.
 *   • One live proof per tenant: issuing a new one revokes the previous one,
 *     and revokeCheckinAccess() ends it explicitly.
 *   • Never logged. Nothing here writes the proof, its hash, or the OTP to any
 *     log line.
 */

const crypto = require('crypto');
const { createOtpStore } = require('../utils/otpStore');

const store = createOtpStore('checkin-access');

const ACCESS_TTL_MS = 30 * 60 * 1000;
// Header the check-in frontend sends the proof in. Lower-case: Node lower-cases
// incoming header names.
const CHECKIN_ACCESS_HEADER = 'x-checkin-access';

const norm = (v) => String(v ?? '').trim().toUpperCase();
const hashProof = (proof) => crypto.createHash('sha256').update(String(proof)).digest('hex');
const proofKey = (hash) => `proof:${hash}`;
const currentKey = (tenantId) => `current:${tenantId}`;

/**
 * Issues a proof for `tenant` (a document loaded from the DB by the caller).
 * Revokes any proof previously issued for the same tenant.
 * @returns {{ token: string, expiresAt: number }}
 */
async function issueCheckinAccess(tenant) {
    if (!tenant || !tenant._id || !tenant.loginId) throw new Error('issueCheckinAccess: tenant required');
    const tenantId = String(tenant._id);
    const loginId = norm(tenant.loginId);

    const token = crypto.randomBytes(32).toString('base64url');
    const hash = hashProof(token);
    const expiresAt = Date.now() + ACCESS_TTL_MS;

    const previous = await store.get(currentKey(tenantId));
    if (previous && previous.hash) await store.delete(proofKey(previous.hash));

    await store.set(proofKey(hash), { tenantId, loginId, expiresAt });
    await store.set(currentKey(tenantId), { hash, expiresAt });
    return { token, expiresAt };
}

/**
 * Checks `token` against the tenant actually being requested.
 * @returns {{ ok: true, expiresAt: number } | { ok: false, reason: string }}
 *   reason ∈ missing | malformed | unknown | expired | revoked | mismatch
 */
async function verifyCheckinAccess(token, tenant) {
    if (token === undefined || token === null || token === '') return { ok: false, reason: 'missing' };
    // A real proof is 43 base64url characters; anything far off is not one,
    // and is rejected before it costs a store round trip.
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(token)) {
        return { ok: false, reason: 'malformed' };
    }
    if (!tenant || !tenant._id) return { ok: false, reason: 'mismatch' };

    const hash = hashProof(token);
    const entry = await store.get(proofKey(hash));
    if (!entry) return { ok: false, reason: 'unknown' };

    if (Date.now() > Number(entry.expiresAt)) {
        await store.delete(proofKey(hash));
        return { ok: false, reason: 'expired' };
    }

    // Superseded by a newer proof for the same tenant, or explicitly revoked.
    const current = await store.get(currentKey(entry.tenantId));
    if (!current || current.hash !== hash) return { ok: false, reason: 'revoked' };

    // The proof must belong to the tenant being asked for — by _id AND loginId,
    // both read from the database by the route, never from the request.
    if (entry.tenantId !== String(tenant._id) || entry.loginId !== norm(tenant.loginId)) {
        return { ok: false, reason: 'mismatch' };
    }
    return { ok: true, expiresAt: Number(entry.expiresAt) };
}

/** Ends any live proof for this tenant (e.g. when the check-in completes). */
async function revokeCheckinAccess(tenantId) {
    if (!tenantId) return;
    const current = await store.get(currentKey(String(tenantId)));
    if (current && current.hash) await store.delete(proofKey(current.hash));
    await store.delete(currentKey(String(tenantId)));
}

/** Reads the proof from a request. Header only — never the query string, so it
 *  stays out of URLs, browser history and access logs. */
function checkinAccessFromRequest(req) {
    const value = req && req.headers ? req.headers[CHECKIN_ACCESS_HEADER] : undefined;
    return typeof value === 'string' ? value.trim() : value;
}

module.exports = {
    issueCheckinAccess,
    verifyCheckinAccess,
    revokeCheckinAccess,
    checkinAccessFromRequest,
    CHECKIN_ACCESS_HEADER,
    ACCESS_TTL_MS,
};
