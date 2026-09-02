// ── Ex-tenant outbound communication guard ───────────────────────────────────
//
// Once a tenant's move-out completes, no further email / WhatsApp / SMS / in-app
// notification may reach them. The check is deliberately a LIVE lookup rather
// than a stored blocklist, because of two properties the client needs:
//
//   1. The same phone/email is shared by several tenants in production (one
//      guardian's number across multiple residents). Blocking the raw address
//      would silence tenants who are still living there. So an address is
//      suppressed only when NOBODY reachable at it is still an active tenant,
//      owner, or staff member.
//
//   2. If the owner later re-adds that same person through Add Tenant, every
//      channel — including login OTP — must start working again with no manual
//      un-blocking step. A live lookup does that for free: the new active
//      tenancy makes the address deliverable again on the next send.
//
// Results are cached briefly so this does not add a DB round-trip to every
// individual email in a bulk send.

const CACHE_TTL_MS = 60 * 1000;
const _cache = new Map();

const _norm = (v) => String(v || '').trim().toLowerCase();

// Last 10 digits, so +91-87977 26488 and 8797726488 compare equal.
const _normPhone = (v) => {
    const digits = String(v || '').replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
};

const _getCached = (key) => {
    const hit = _cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts > CACHE_TTL_MS) { _cache.delete(key); return undefined; }
    return hit.value;
};

const _setCached = (key, value) => {
    // Bounded so a long-running process cannot grow this without limit.
    if (_cache.size > 5000) _cache.clear();
    _cache.set(key, { value, ts: Date.now() });
};

/** Drops every cached decision. Call after changing a tenant's active state. */
const clearCommsGuardCache = () => _cache.clear();

/**
 * True when outbound communication to this recipient must be suppressed.
 *
 * Fails OPEN: any lookup error allows the send. A transient DB blip must never
 * silently swallow a rent reminder or an OTP.
 */
async function isRecipientSuppressed({ email, phone, loginId } = {}) {
    const e = _norm(email);
    const p = _normPhone(phone);
    const l = _norm(loginId);
    if (!e && !p && !l) return false;

    const key = `${e}|${p}|${l}`;
    const cached = _getCached(key);
    if (cached !== undefined) return cached;

    try {
        const Tenant = require('../models/Tenant');
        const User = require('../models/user');

        // Build the recipient match once; phone is matched on the last 10 digits
        // so stored formatting variations still line up.
        const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const or = [];
        if (e) or.push({ email: new RegExp(`^${esc(e)}$`, 'i') });
        if (p) or.push({ phone: new RegExp(`${esc(p)}$`) });
        if (l) or.push({ loginId: new RegExp(`^${esc(l)}$`, 'i') });
        if (!or.length) { _setCached(key, false); return false; }

        // Is this recipient a completed ex-tenant at all? If no tenant record
        // matches, this is an owner/lead/staff/visitor address — never suppress.
        const exTenant = await Tenant.findOne({
            $or: or,
            'moveoutRequest.completedAt': { $exists: true, $ne: null }
        }).select('_id').lean();

        if (!exTenant) { _setCached(key, false); return false; }

        // They ARE an ex-tenant. Suppress only if nothing else keeps the address
        // reachable — no current tenancy anywhere, and no owner/staff account.
        const activeTenancy = await Tenant.findOne({
            $or: or,
            status: { $ne: 'inactive' },
            isDeleted: { $ne: true }
        }).select('_id').lean();

        if (activeTenancy) { _setCached(key, false); return false; }

        const nonTenantAccount = await User.findOne({
            $or: or,
            role: { $ne: 'tenant' },
            isActive: { $ne: false }
        }).select('_id').lean();

        const suppressed = !nonTenantAccount;
        _setCached(key, suppressed);
        return suppressed;
    } catch (err) {
        console.error('[commsGuard] lookup failed, allowing send:', err.message);
        return false;
    }
}

module.exports = { isRecipientSuppressed, clearCommsGuardCache };
