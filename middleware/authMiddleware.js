const jwt = require('jsonwebtoken');
const User = require('../models/user');

const getJwtSecret = () => process.env.JWT_SECRET || 'roomhy_default_jwt_secret_key_2026';

exports.protect = async (req, res, next) => {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ message: 'Not authorized, token missing' });

    try {
        const decoded = jwt.verify(token, getJwtSecret());

        console.log(`[AUTH DEBUG] Request URL: ${req.method} ${req.originalUrl}`);
        console.log(`[AUTH DEBUG] Decoded ID: ${decoded.id}, Role from token: ${decoded.role}`);

        let user = null;

        // Try findById first — but safely catch BSONError (e.g. ROOMHY0000 as _id)
        try {
            user = await User.findById(decoded.id).select('-password');
        } catch (bsonErr) {
            // _id is not a valid ObjectId — try loginId fallback
            console.warn(`[AUTH DEBUG] findById failed for "${decoded.id}", trying loginId fallback`);
            user = await User.findOne({ loginId: String(decoded.id).toUpperCase() }).select('-password');
        }

        if (!user) {
            const AreaManager = require('../models/AreaManager');
            try {
                user = await AreaManager.findById(decoded.id).select('-password');
            } catch (_) {
                user = await AreaManager.findOne({ loginId: String(decoded.id).toUpperCase() }).select('-password');
            }
            if (user) user.role = 'areamanager';
        }

        if (!user) {
            const Employee = require('../models/Employee');
            try {
                user = await Employee.findById(decoded.id).select('-password');
            } catch (_) {
                user = await Employee.findOne({ loginId: String(decoded.id).toUpperCase() }).select('-password');
            }
            if (user) {
                user.team = user.role;
                user.role = user.role && user.role.toLowerCase() === 'manager' ? 'manager' : 'employee';
            }
        }

        if (!user) {
            console.log(`[AUTH DEBUG] User not found for ID: ${decoded.id}`);
            return res.status(401).json({ message: 'Not authorized, user not found' });
        }
        
        // Normalize 'propertyowner' → 'owner' so all role checks are consistent
        if (user.role === 'propertyowner') user.role = 'owner';
        console.log(`[AUTH DEBUG] Resolved User: ${user.loginId || user.email}, Final Role: ${user.role}`);
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
        const expanded = roles.includes('superadmin') 
            ? [...roles, 'admin', 'employee', 'areamanager', 'manager'] 
            : roles.includes('admin')
            ? [...roles, 'superadmin', 'employee', 'areamanager', 'manager']
            : roles;
        console.log(`[AUTH DEBUG] Path: ${req.method} ${req.originalUrl} | Required: ${roles.join(',')} | User Role: ${req.user.role}`);
        if (!expanded.includes(req.user.role)) {
            console.log(`[AUTH DEBUG] Forbidden: User role ${req.user.role} not in expanded roles [${expanded.join(',')}]`);
            return res.status(403).json({ message: 'Forbidden' });
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
