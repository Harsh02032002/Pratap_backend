const jwt = require('jsonwebtoken');
const User = require('../models/user');
const { revocationReason, tokenVersionMatches } = require('../utils/accountState');

// Every token this app issues is HS256. Pinning it means a token cannot ask to be
// verified under a different algorithm than the one we sign with.
// Deliberately NOT validating iss/aud: no token in circulation carries those
// claims, so requiring them would reject every existing session on deploy.
const VERIFY_OPTIONS = { algorithms: ['HS256'] };

const getJwtSecret = () => {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET environment variable is not set. Refusing to start with an insecure default.');
    }
    return process.env.JWT_SECRET;
};

// Verbose per-request auth logging. Was unconditional — three synchronous
// console writes on every API call. Set AUTH_DEBUG=true to bring it back.
const AUTH_DEBUG = String(process.env.AUTH_DEBUG || '').toLowerCase() === 'true';
const authDebug = (...args) => { if (AUTH_DEBUG) console.log(...args); };

// ── Account lookup chain ────────────────────────────────────────────────────
// Different login flows keep accounts in different collections, and a token's
// `id` is sometimes an ObjectId and sometimes a loginId. So an id is resolved
// by trying each collection in this fixed order — the ORDER MATTERS: the same
// loginId can exist in more than one collection (an owner can have both a User
// and an Owner record) and the first match wins.
//
// Each step reproduces the original inline block exactly: findById first; if
// the id is not a valid ObjectId (cast error) fall back to a loginId lookup;
// then the role post-processing that step always applied.
const LOOKUP_STEPS = [
    {
        name: 'User',
        async find(id) {
            // Try findById first — but safely catch BSONError (e.g. ROOMHY0000 as _id)
            try {
                return await User.findById(id).select('-password');
            } catch (bsonErr) {
                // _id is not a valid ObjectId — try loginId fallback
                authDebug(`[AUTH DEBUG] findById failed for "${id}", trying loginId fallback`);
                return User.findOne({ loginId: String(id).toUpperCase() }).select('-password');
            }
        },
        finish() {}
    },
    {
        name: 'AreaManager',
        async find(id) {
            const AreaManager = require('../models/AreaManager');
            try {
                return await AreaManager.findById(id).select('-password');
            } catch (_) {
                return AreaManager.findOne({ loginId: String(id).toUpperCase() }).select('-password');
            }
        },
        finish(user) { user.role = 'areamanager'; }
    },
    {
        name: 'Employee',
        async find(id) {
            const Employee = require('../models/Employee');
            try {
                return await Employee.findById(id).select('-password');
            } catch (_) {
                return Employee.findOne({ loginId: String(id).toUpperCase() }).select('-password');
            }
        },
        finish(user) {
            user.team = user.role;
            user.role = user.role && user.role.toLowerCase() === 'manager' ? 'manager' : 'employee';
        }
    },
    {
        name: 'Owner',
        async find(id) {
            const Owner = require('../models/Owner');
            try {
                return await Owner.findById(id).select('-password');
            } catch (_) {
                return Owner.findOne({ loginId: String(id).toUpperCase() }).select('-password');
            }
        },
        finish(user) { user.role = 'owner'; }
    },
    {
        name: 'Tenant',
        async find(id) {
            const Tenant = require('../models/Tenant');
            try {
                return await Tenant.findById(id).select('-password');
            } catch (_) {
                return Tenant.findOne({
                    $or: [
                        { loginId: String(id).toUpperCase() },
                        { email: String(id).toLowerCase() }
                    ]
                }).select('-password');
            }
        },
        finish(user) { user.role = 'tenant'; }
    }
];

// ── Which-collection hint cache ─────────────────────────────────────────────
// Walking the chain costs up to 5 sequential database round-trips per request
// (a tenant always paid all 5). This remembers WHICH step an id resolved to —
// never the account itself — so the next request tries that step first. The
// account document is still read from the database on every request, so a
// block, delete or profile change takes effect immediately. If the hinted step
// no longer finds the account, the full chain runs exactly as before.
//
// NO_MATCH remembers ids that matched no collection at all (website-user
// tokens), which otherwise paid 5 guaranteed misses on every call before
// falling through to the token-claims user in protect().
//
// Trade-off: if an account is newly created in an EARLIER collection of the
// chain, the previous resolution can be used until the hint expires.
const HINT_TTL_MS = 5 * 60 * 1000;
const NO_MATCH_TTL_MS = 60 * 1000;
const HINT_MAX_ENTRIES = 10000;
const NO_MATCH = -1;
const lookupHints = new Map(); // id -> { step, expiresAt }

const getHint = (id) => {
    const entry = lookupHints.get(id);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        lookupHints.delete(id);
        return undefined;
    }
    return entry.step;
};

const setHint = (id, step) => {
    if (lookupHints.size >= HINT_MAX_ENTRIES) lookupHints.clear();
    lookupHints.set(id, {
        step,
        expiresAt: Date.now() + (step === NO_MATCH ? NO_MATCH_TTL_MS : HINT_TTL_MS)
    });
};

async function resolveAccount(id) {
    const key = String(id);
    const hint = getHint(key);

    if (hint === NO_MATCH) return null;

    if (hint !== undefined) {
        const user = await LOOKUP_STEPS[hint].find(id);
        if (user) {
            LOOKUP_STEPS[hint].finish(user);
            return user;
        }
    }

    for (let i = 0; i < LOOKUP_STEPS.length; i += 1) {
        if (i === hint) continue; // already tried above and found nothing
        const user = await LOOKUP_STEPS[i].find(id);
        if (user) {
            LOOKUP_STEPS[i].finish(user);
            setHint(key, i);
            return user;
        }
    }

    setHint(key, NO_MATCH);
    return null;
}

/**
 * PropertyManager tokens are the one legitimate token shape with no `id` claim
 * (controllers/propertyManagerController.js mints { managerId, loginId,
 * propertyId }). They used to land in protect()'s token-claims fallback, which
 * checked nothing; this resolves the real record so the revocation gate applies
 * to them like every other account type.
 *
 * The resulting role stays 'website_user' because middleware/ownerAccess.js
 * keys its property-manager branch off exactly that value.
 */
async function resolvePropertyManager(decoded) {
    const PropertyManager = require('../models/PropertyManager');
    let pm = null;
    try {
        pm = await PropertyManager.findById(decoded.managerId).select('-password');
    } catch (_) {
        pm = null; // not a valid ObjectId
    }
    if (!pm && decoded.loginId) {
        pm = await PropertyManager.findOne({ loginId: String(decoded.loginId).trim() }).select('-password');
    }
    if (!pm) return null;

    pm.role = 'website_user';
    return pm;
}

/**
 * THE authentication decision for this application. HTTP (protect), the
 * Socket.IO handshake (socket/socketAuth.js) and the SSE stream guard all call
 * this, so there is exactly one implementation of "is this token good right
 * now" and one place to audit it. Transport-agnostic on purpose: it takes a raw
 * token string and returns a verdict, never touching req/res.
 *
 * @param {string} token
 * @returns {Promise<{ok:true,user:object,decoded:object}|{ok:false,status:number,body:object,reason:string}>}
 */
async function authenticateToken(token) {
    if (!token) {
        return { ok: false, status: 401, reason: 'missing', body: { message: 'Not authorized, token missing' } };
    }

    let decoded;
    try {
        decoded = jwt.verify(token, getJwtSecret(), VERIFY_OPTIONS);
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return { ok: false, status: 401, reason: 'expired', body: { message: 'Token expired, please log in again', expired: true } };
        }
        if (err.name !== 'JsonWebTokenError') console.warn('[AUTH WARN]', err.message);
        return { ok: false, status: 401, reason: 'invalid', body: { message: 'Not authorized, token invalid' } };
    }

    // User → AreaManager → Employee → Owner → Tenant, see LOOKUP_STEPS.
    let user = await resolveAccount(decoded.id);

    // A PropertyManager token carries { managerId, loginId, propertyId } and no
    // `id`, so the chain above cannot resolve it. It gets its own lookup rather
    // than the old blanket "trust the token's claims" fallback.
    if (!user && decoded.managerId) {
        user = await resolvePropertyManager(decoded);
    }

    if (!user) {
        // protect() used to fabricate a req.user out of the token's own claims,
        // including its `role`. That meant a validly signed token for a DELETED
        // account kept full access, and authorize() could be satisfied by a role
        // the token asserted about itself. A signed token is not evidence that the
        // account still exists, so this fails closed.
        authDebug(`[AUTH DEBUG] No account for token subject: ${decoded.id || decoded.loginId || decoded.managerId}`);
        return { ok: false, status: 401, reason: 'no_account', body: { message: 'Not authorized, user not found' } };
    }

    // ── The revocation gate ─────────────────────────────────────────────────
    // Everything above only proves the token was signed by us and names a real
    // account. These two checks are what make a valid, unexpired signature
    // insufficient on its own. Both answer identically so that a revoked account
    // and a stale token generation are indistinguishable from outside.
    const revoked = revocationReason(user);
    if (revoked || !tokenVersionMatches(user, decoded)) {
        authDebug(`[AUTH DEBUG] Session ended (${revoked || 'stale_generation'}) for ${user.loginId || user.email}`);
        return {
            ok: false,
            status: 401,
            reason: revoked || 'stale_generation',
            body: { message: 'Your session has ended. Please log in again.', sessionEnded: true }
        };
    }

    // Normalize 'propertyowner' → 'owner' so all role checks are consistent
    if (user.role === 'propertyowner') user.role = 'owner';
    return { ok: true, user, decoded };
}

exports.authenticateToken = authenticateToken;

/** Pulls the bearer token out of an Express request, or null. */
function bearerFromRequest(req) {
    const header = req.headers?.authorization;
    if (!header || !header.startsWith('Bearer')) return null;
    return header.split(' ')[1] || null;
}
exports.bearerFromRequest = bearerFromRequest;

exports.protect = async (req, res, next) => {
    const token = bearerFromRequest(req);
    if (!token) return res.status(401).json({ message: 'Not authorized, token missing' });

    authDebug(`[AUTH DEBUG] Request URL: ${req.method} ${req.originalUrl}`);

    const verdict = await authenticateToken(token);
    if (!verdict.ok) return res.status(verdict.status).json(verdict.body);

    authDebug(`[AUTH DEBUG] Resolved User: ${verdict.user.loginId || verdict.user.email}, Final Role: ${verdict.user.role}`);
    req.user = verdict.user;
    next();
};

// ── Role gates: authorize / authorizeStrict / authorizeAdminOnly ────────────
//
// Three gates, differing in exactly one respect — whether naming 'superadmin'
// or 'admin' ALSO silently admits staff:
//
//   authorize(...)           PERMISSIVE / LEGACY. Naming 'superadmin' or
//                            'admin' also admits employee, areamanager,
//                            manager, staff, field_executive and
//                            verification_officer. 310 call sites across 41
//                            routers rely on this, because every /employee/*
//                            panel screen mirrors a /superadmin/* route — so
//                            it is still the default. It must NEVER be the
//                            only guard on a password, a bank account, a raw
//                            Aadhaar, or a bulk delete.
//   authorizeStrict(...)     Admits exactly the roles named, plus the
//                            superadmin/admin tier pairing and the
//                            owner/propertyowner spelling synonyms. Nothing
//                            else. Prefer this in new routes. Softened by
//                            AUTHZ_MODE=report during rollout.
//   authorizeAdminOnly(...)  Same as authorizeStrict, but never softened by
//                            AUTHZ_MODE=report — for routes where a staff
//                            account getting through is an account takeover
//                            or a mass-PII dump.
//
// WHY THE STRICT GATES EXIST: the expansion below is invisible at the call
// site, so a route written for "superadmin, areamanager, owner" also admitted
// any field employee — and the handlers whose own ownership check reads
// `if (req.user.role === 'owner') { … }` were walked straight past by one.
// Making authorizeStrict the default would mean re-deciding all 310 call
// sites, which belongs with the route manifest rather than here. Until then
// the dangerous routes name a strict gate explicitly.

const STAFF_ROLES = [
    'employee', 'areamanager', 'area_manager', 'area_admin',
    'manager', 'staff', 'field_executive', 'verification_officer'
];

// 'admin' and 'superadmin' are the same tier throughout this codebase (see
// requirePlatformAdmin below), so naming either admits both. A tier pairing,
// not a staff expansion.
const ADMIN_ROLES = ['superadmin', 'admin'];

// Three spellings of one role, all of which appear in stored accounts.
const OWNER_ROLES = ['owner', 'property_owner', 'propertyowner'];

const normalizeRole = (role) => {
    const r = String(role || '').toLowerCase().trim();
    return (r === 'propertyowner' || r === 'property_owner') ? 'owner' : r;
};
exports.normalizeRole = normalizeRole;

// AUTHZ_MODE=report logs what the strict gate WOULD have denied and lets the
// request through, so a staff screen that legitimately needed the old
// expansion shows up in the logs instead of 403ing a real user. Anything else
// (including unset) enforces.
const isAuthzReportMode = () => String(process.env.AUTHZ_MODE || 'enforce').toLowerCase() === 'report';

function buildAllowedRoles(roles, includeStaff) {
    const allowed = new Set(roles.map(normalizeRole));
    if (allowed.has('superadmin') || allowed.has('admin')) {
        ADMIN_ROLES.forEach(r => allowed.add(r));
        if (includeStaff) STAFF_ROLES.forEach(r => allowed.add(r));
    }
    if (allowed.has('owner')) OWNER_ROLES.forEach(r => allowed.add(r));
    return allowed;
}

function makeRoleGate(roles, { includeStaff, alwaysEnforce = false }) {
    const allowed = buildAllowedRoles(roles, includeStaff);
    // What the permissive gate would have allowed. Used only to tell an
    // ordinary role mismatch apart from a denial the strict gate introduced,
    // so AUTHZ_MODE=report can soften the latter without softening the former.
    const legacyAllowed = includeStaff ? allowed : buildAllowedRoles(roles, true);

    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ message: 'Not authenticated' });

        const userRole = normalizeRole(req.user.role);
        authDebug(`[AUTH DEBUG] Path: ${req.method} ${req.originalUrl} | Required: ${roles.join(',')} | User Role: ${userRole}`);
        if (allowed.has(userRole)) return next();

        // True when the caller is staff and ONLY the staff expansion would
        // have admitted them — i.e. a denial the strict gate is responsible
        // for, as opposed to a caller who was never allowed here anyway.
        const newlyDenied = !includeStaff && legacyAllowed.has(userRole);
        const who = req.user.loginId || req.user.email || req.user._id || 'unknown';

        if (newlyDenied && !alwaysEnforce && isAuthzReportMode()) {
            console.warn(`[AUTHZ] would deny ${userRole} ${who} -> ${req.method} ${req.originalUrl} (requires ${roles.join(',')})`);
            return next();
        }
        if (newlyDenied) {
            console.warn(`[AUTHZ] denied ${userRole} ${who} -> ${req.method} ${req.originalUrl} (requires ${roles.join(',')})`);
        }

        // The 403 body used to echo the whole expanded role list, handing a
        // caller the exact set of roles that would have worked.
        return res.status(403).json({ message: 'Forbidden: insufficient role' });
    };
}

// authorize() keeps the legacy staff expansion so that the 310 existing call
// sites across 41 routers behave exactly as they did before this split — every
// /employee/* panel screen mirrors a /superadmin/* route and depends on it.
// Making strict the default means re-deciding all 310, which belongs with the
// route manifest. Until then, dangerous routes name a strict gate explicitly.
exports.authorize = (...roles) => makeRoleGate(roles, { includeStaff: true });
exports.authorizeStrict = (...roles) => makeRoleGate(roles, { includeStaff: false });
exports.authorizeAdminOnly = (...roles) => makeRoleGate(roles, { includeStaff: false, alwaysEnforce: true });

// Validates a short-lived password-reset token issued at login (purpose: 'password_reset').
// Sets req.resetLoginId so the route can confirm the token matches the target employee.
exports.protectPasswordReset = (req, res, next) => {
    let token = null;
    if (req.headers.authorization) {
        token = req.headers.authorization.replace(/^Bearer\s+/i, '').trim();
    }
    if (!token) return res.status(401).json({ message: 'Not authorized, token missing' });
    try {
        const decoded = jwt.verify(token, getJwtSecret(), VERIFY_OPTIONS);
        // Without this, a 7-day SESSION token satisfied this middleware, so a
        // deactivated employee could reset their own password on the route below
        // and be handed a brand-new valid session token — a complete bypass of
        // the revocation gate in protect(). Only the short-lived token minted at
        // login for a forced reset carries this purpose.
        if (decoded.purpose !== 'password_reset') {
            return res.status(401).json({ message: 'Not authorized, token invalid or expired' });
        }
        req.resetLoginId = decoded.loginId || decoded.id;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Not authorized, token invalid or expired' });
    }
};

exports.optionalProtect = async (req, res, next) => {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return next();
    try {
        const decoded = jwt.verify(token, getJwtSecret(), VERIFY_OPTIONS);
        let user = null;
        try {
            user = await User.findById(decoded.id).select('-password');
        } catch (_) {
            user = await User.findOne({ loginId: String(decoded.id).toUpperCase() }).select('-password');
        }
        if (!user) {
            const Owner = require('../models/Owner');
            try {
                user = await Owner.findById(decoded.id).select('-password');
            } catch (_) {
                user = await Owner.findOne({ loginId: String(decoded.id).toUpperCase() }).select('-password');
            }
            if (user) user.role = 'owner';
        }
        // Optional auth, so a revoked account is treated as simply anonymous
        // rather than rejected — but it must never be attached as req.user,
        // which downstream scope middleware would read as an identity.
        if (user && !revocationReason(user) && tokenVersionMatches(user, decoded)) {
            req.user = user;
        }
    } catch (_) {}
    next();
};


/**
 * Strict platform-admin gate, for money movement and platform-wide data.
 *
 * WHY THIS EXISTS: authorize('superadmin') is deliberately permissive — it
 * expands the allowed set to include employee, areamanager, manager, staff,
 * field_executive and verification_officer (see the expansion above). That is
 * fine for ordinary admin screens, but it means authorize('superadmin') alone
 * must NEVER be the only guard on a withdrawal, a refund, or platform-wide
 * financial data: any staff account would satisfy it.
 *
 * Use as: protect, requirePlatformAdmin
 */
exports.requirePlatformAdmin = (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Not authenticated' });

    const role = String(req.user.role || '').toLowerCase().trim();
    const isAdminRole = role === 'superadmin' || role === 'admin';

    // An employee-scoped request is a staff member, even if their role string
    // reads 'admin' — req.employeeScope is set by applyEmployeeScope when the
    // caller resolved to an Employee record.
    const isStaff = req.employeeScope?.isEmployee === true;

    if (!isAdminRole || isStaff) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
    }
    return next();
};
