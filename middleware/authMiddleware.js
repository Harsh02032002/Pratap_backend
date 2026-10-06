const jwt = require('jsonwebtoken');
const User = require('../models/user');

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

exports.protect = async (req, res, next) => {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ message: 'Not authorized, token missing' });

    try {
        const decoded = jwt.verify(token, getJwtSecret());

        authDebug(`[AUTH DEBUG] Request URL: ${req.method} ${req.originalUrl}`);
        authDebug(`[AUTH DEBUG] Decoded ID: ${decoded.id}, Role from token: ${decoded.role}`);

        // User → AreaManager → Employee → Owner → Tenant, see LOOKUP_STEPS.
        let user = await resolveAccount(decoded.id);

        if (!user && (decoded.email || decoded.loginId || decoded.id)) {
            user = {
                _id: decoded.id || decoded.userId || 'web_user',
                id: decoded.id || decoded.userId || 'web_user',
                email: decoded.email || '',
                loginId: decoded.loginId || decoded.email || decoded.id || '',
                name: decoded.name || decoded.email || 'Website User',
                role: decoded.role || 'website_user'
            };
        }

        if (!user) {
            authDebug(`[AUTH DEBUG] User not found for ID: ${decoded.id}`);
            return res.status(401).json({ message: 'Not authorized, user not found' });
        }
        
        // Normalize 'propertyowner' → 'owner' so all role checks are consistent
        if (user.role === 'propertyowner') user.role = 'owner';
        authDebug(`[AUTH DEBUG] Resolved User: ${user.loginId || user.email}, Final Role: ${user.role}`);
        req.user = user;
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ message: 'Token expired, please log in again', expired: true });
        }
        if (err.name === 'JsonWebTokenError') {
            return res.status(401).json({ message: 'Not authorized, token invalid' });
        }
        console.warn('[AUTH PROTECT WARN]', err.message);
        return res.status(401).json({ message: 'Not authorized, token invalid' });
    }
};

exports.authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
        
        let userRole = req.user.role ? String(req.user.role).toLowerCase().trim() : '';
        if (userRole === 'propertyowner' || userRole === 'property_owner') userRole = 'owner';

        const expanded = new Set(roles.map(r => String(r).toLowerCase().trim()));
        
        if (expanded.has('superadmin') || expanded.has('admin')) {
            ['superadmin', 'admin', 'employee', 'areamanager', 'area_manager', 'area_admin', 'manager', 'staff', 'field_executive', 'verification_officer'].forEach(r => expanded.add(r));
        }

        if (expanded.has('owner') || expanded.has('property_owner') || expanded.has('propertyowner')) {
            expanded.add('owner');
            expanded.add('property_owner');
            expanded.add('propertyowner');
        }

        const expandedArray = Array.from(expanded);
        authDebug(`[AUTH DEBUG] Path: ${req.method} ${req.originalUrl} | Required: ${roles.join(',')} | User Role: ${userRole}`);
        
        if (!expanded.has(userRole) && !expanded.has(req.user.role)) {
            authDebug(`[AUTH DEBUG] Forbidden: User role ${req.user.role} not in expanded roles [${expandedArray.join(',')}]`);
            return res.status(403).json({ message: `Forbidden: User role ${req.user.role} not in expanded roles [${expandedArray.join(',')}]` });
        }
        next();
    };
};

// Validates a short-lived password-reset token issued at login (purpose: 'password_reset').
// Sets req.resetLoginId so the route can confirm the token matches the target employee.
exports.protectPasswordReset = (req, res, next) => {
    let token = null;
    if (req.headers.authorization) {
        token = req.headers.authorization.replace(/^Bearer\s+/i, '').trim();
    }
    if (!token) return res.status(401).json({ message: 'Not authorized, token missing' });
    try {
        const decoded = jwt.verify(token, getJwtSecret());
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
        const decoded = jwt.verify(token, getJwtSecret());
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
        if (user) req.user = user;
    } catch (_) {}
    next();
};

