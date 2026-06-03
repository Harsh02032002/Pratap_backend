const jwt = require('jsonwebtoken');
const User = require('../models/user');

exports.protect = async (req, res, next) => {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ message: 'Not authorized, token missing' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        let user = await User.findById(decoded.id).select('-password');
        
        if (!user) {
            const AreaManager = require('../models/AreaManager');
            user = await AreaManager.findById(decoded.id).select('-password');
            if (user) user.role = 'areamanager';
        }

        if (!user) {
            const Employee = require('../models/Employee');
            user = await Employee.findById(decoded.id).select('-password');
            if (user) {
                user.team = user.role;
                user.role = user.role && user.role.toLowerCase() === 'manager' ? 'manager' : 'employee';
            }
        }

        if (!user) return res.status(401).json({ message: 'Not authorized, user not found' });
        // Normalize 'propertyowner' → 'owner' so all role checks are consistent
        if (user.role === 'propertyowner') user.role = 'owner';
        req.user = user;
        next();
    } catch (err) {
        console.error(err);
        return res.status(401).json({ message: 'Not authorized, token invalid' });
    }
};

exports.authorize = (...roles) => {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
        if (!roles.includes(req.user.role)) return res.status(403).json({ message: 'Forbidden' });
        next();
    };
};
