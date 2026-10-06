'use strict';

/**
 * ownerAccess.js — "may this caller read/act on owner X?"
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner-panel endpoints are addressed by an owner loginId in the URL
 * (/api/owners/:loginId/...). Several of them used to run with no auth at all,
 * so anyone who knew (or guessed) a loginId could pull that owner's tenants —
 * including Aadhaar images and signatures — plus revenue and rent figures.
 * The ones that did use `protect` only stopped scoped *employees*; an owner
 * token for owner A was still accepted for owner B.
 *
 * Allowed callers for owner X:
 *   • superadmin / admin
 *   • owner X themself (token loginId === X)
 *   • X's own staff (Employee.parentLoginId === X) — the owner-panel "staff
 *     proxy" mode sends the staff member's own token
 *   • X's property manager (PropertyManager.ownerLoginId === X) — managers log
 *     into the owner panel masquerading as the owner, with their own token
 *   • a platform employee / area manager whose scope includes X (same rule as
 *     requireOwnerInScope)
 * Everyone else — other owners, tenants, website users — gets 403.
 */

const { protect } = require('./authMiddleware');
const { applyEmployeeScope } = require('./employeeScope');
const { applyOwnerScope } = require('../utils/scopeHelpers');

const SUPER_ROLES = new Set(['superadmin', 'admin']);
const OWNER_ROLES = new Set(['owner', 'propertyowner', 'property_owner']);
const NEVER_ROLES = new Set(['tenant']);

const norm = (v) => String(v ?? '').trim().toUpperCase();

const deny = (res) =>
    res.status(403).json({ success: false, message: 'Forbidden: you do not have access to this owner' });

// Staff signed in via /api/employees/login resolve to the Employee doc (which
// carries parentLoginId). Staff signed in via the unified /api/auth/login
// resolve to the User mirror, which does not — so look the Employee up.
async function staffParentLoginId(user) {
    if (user.parentLoginId) {
        if (user.isDeleted || user.isActive === false) return '';
        return norm(user.parentLoginId);
    }
    const loginId = norm(user.loginId);
    if (!loginId) return '';
    const Employee = require('../models/Employee');
    const emp = await Employee.findOne({ loginId, isDeleted: { $ne: true } })
        .select('parentLoginId isActive')
        .lean();
    if (!emp || emp.isActive === false) return '';
    return norm(emp.parentLoginId);
}

// PropertyManager tokens carry { managerId, loginId } and no `id`, so protect()
// falls through to its token-claims user with role 'website_user'.
async function propertyManagerOwnerLoginId(user) {
    const loginId = String(user.loginId || '').trim();
    if (!loginId) return '';
    const PropertyManager = require('../models/PropertyManager');
    const pm = await PropertyManager.findOne({ loginId, isDeleted: { $ne: true }, status: 'active' })
        .select('ownerLoginId')
        .lean();
    return pm ? norm(pm.ownerLoginId) : '';
}

/**
 * @param {object} req      must already have req.user (protect) and
 *                          req.employeeScope (applyEmployeeScope)
 * @param {string} target   owner loginId (any casing)
 * @param {object} [opts]
 * @param {boolean} [opts.matchContact] also accept the owner's email/phone as
 *                          the identifier (subscription-status accepts those)
 */
async function canAccessOwner(req, target, { matchContact = false } = {}) {
    const user = req.user;
    const wanted = norm(target);
    if (!user || !wanted) return false;

    const role = String(user.role || '').toLowerCase();
    if (SUPER_ROLES.has(role)) return true;

    if (OWNER_ROLES.has(role)) {
        const ids = [user.loginId];
        if (matchContact) ids.push(user.email, user.phone, user.profile?.phone);
        return ids.map(norm).filter(Boolean).includes(wanted);
    }

    if (NEVER_ROLES.has(role)) return false;

    if (role === 'website_user') {
        return (await propertyManagerOwnerLoginId(user)) === wanted;
    }

    // Staff, platform employees, area managers.
    const parent = await staffParentLoginId(user);
    if (parent && parent === wanted) return true;

    if (req.employeeScope?.isEmployee) {
        const Owner = require('../models/Owner');
        const found = await Owner.findOne(applyOwnerScope(req, { loginId: wanted, isDeleted: { $ne: true } }))
            .select('_id')
            .lean();
        return !!found;
    }

    return false;
}

/**
 * Route guard: [protect, applyEmployeeScope, check].
 *
 * @param {string|Function} getTarget  route param name, or (req) => loginId
 * @param {object} [opts]              forwarded to canAccessOwner
 */
function requireOwnerAccess(getTarget = 'loginId', opts = {}) {
    const resolveTarget = typeof getTarget === 'function'
        ? getTarget
        : (req) => req.params[getTarget];

    async function ownerAccessCheck(req, res, next) {
        try {
            const target = norm(resolveTarget(req));
            // No identifier → nothing to leak; the handler answers its own 400.
            if (!target) return next();
            if (await canAccessOwner(req, target, opts)) return next();
            return deny(res);
        } catch (err) {
            console.error('[ownerAccess] check failed:', err.message);
            // err.message so dbTimeoutResponseNormalizer can map pool/DB
            // timeouts to a retryable 503, same as every other handler.
            return res.status(500).json({ success: false, message: err.message });
        }
    }

    return [protect, applyEmployeeScope, ownerAccessCheck];
}

/**
 * EventSource cannot send an Authorization header, so the SSE stream accepts
 * the same JWT as ?token= and this lifts it into the header protect() reads.
 * Only mount this on the stream route.
 */
function sseTokenFromQuery(req, res, next) {
    const token = req.query && typeof req.query.token === 'string' ? req.query.token.trim() : '';
    if (!req.headers.authorization && token) {
        req.headers.authorization = `Bearer ${token}`;
    }
    next();
}

module.exports = {
    requireOwnerAccess,
    canAccessOwner,
    sseTokenFromQuery,
};
