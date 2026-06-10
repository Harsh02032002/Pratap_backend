const jwt = require('jsonwebtoken');
const User = require('../models/user');

exports.protect = async (req, res, next) => {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        token = req.headers.authorization.split(' ')[1];
    }
    if (!token) return res.status(401).json({ message: 'Not authorized, token missing' });

    // Support local offline testing tokens
    if (token === 'superadmin_token') {
        let user = await User.findOne({ role: 'superadmin' }).select('-password');
        if (!user) {
            user = await User.findOne({ email: 'roomhyadmin@gmail.com' }).select('-password');
        }
        if (!user) {
            user = {
                _id: '60c72b2f9b1d8b2bad000001',
                name: 'Super Admin',
                email: 'roomhyadmin@gmail.com',
                phone: '1234567890',
                role: 'superadmin'
            };
        }
        req.user = user;
        return next();
    }

    if (token === 'manager_token' || token === 'areamanager_token') {
        const AreaManager = require('../models/AreaManager');
        let user = await AreaManager.findOne().select('-password');
        if (!user) {
            user = {
                _id: '60c72b2f9b1d8b2bad000002',
                name: 'Area Manager',
                role: 'areamanager'
            };
        } else {
            user.role = 'areamanager';
        }
        req.user = user;
        return next();
    }

    if (token === 'employee_token') {
        const Employee = require('../models/Employee');
        let user = await Employee.findOne().select('-password');
        if (!user) {
            user = {
                _id: '60c72b2f9b1d8b2bad000003',
                name: 'Employee',
                role: 'employee'
            };
        } else {
            user.team = user.role;
            user.role = user.role && user.role.toLowerCase() === 'manager' ? 'manager' : 'employee';
        }
        req.user = user;
        return next();
    }

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
