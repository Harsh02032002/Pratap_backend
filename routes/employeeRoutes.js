const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const jwt = require('jsonwebtoken');
const { protect, authorize, protectPasswordReset } = require('../middleware/authMiddleware');
const { ROLES_REQUIRING_ASSIGNED_PROPERTIES, DEFAULT_RESTRICTED_MODULES } = require('../utils/permissionKeys');

/**
 * POST /api/employees/login
 * Staff login — checks loginId + password
 */
router.post('/login', async (req, res) => {
    try {
        const { loginId, password } = req.body;
        if (!loginId || !password) return res.status(400).json({ success: false, error: 'loginId and password required' });

        const trimmedId = String(loginId).trim();
        // Staff IDs are issued uppercase; match case-insensitively so a staff
        // member typing their ID in a different case isn't locked out.
        let emp = await Employee.findOne({ loginId: trimmedId.toUpperCase(), isDeleted: { $ne: true } })
            .populate('assignedProperties', 'title name city');
        if (!emp) {
            emp = await Employee.findOne({ loginId: trimmedId, isDeleted: { $ne: true } })
                .populate('assignedProperties', 'title name city');
        }
        if (!emp) return res.status(401).json({ success: false, error: 'Invalid Staff ID or Password' });
        if (!emp.isActive) return res.status(403).json({ success: false, error: 'Your account is inactive. Contact your manager.' });

        // Password check (plain or hashed)
        let passwordMatch = false;
        if (emp.password === password) {
            passwordMatch = true;
        } else {
            try {
                const bcrypt = require('bcryptjs');
                passwordMatch = await bcrypt.compare(password, emp.password);
            } catch (_) { }
        }
        if (!passwordMatch) return res.status(401).json({ success: false, error: 'Invalid Staff ID or Password' });

        const requirePasswordReset = emp.requirePasswordReset === true;
        const responsePayload = {
            success: true,
            requirePasswordReset,
            data: {
                _id: emp._id,
                loginId: emp.loginId,
                name: emp.name,
                role: emp.role,
                parentLoginId: emp.parentLoginId,
                permissions: emp.permissions || [],
                restrictedModules: emp.restrictedModules || [],
                employeeType: emp.employeeType || 'Field Executive',
                assignedProperties: emp.assignedProperties || [],
                assignedOwners: emp.assignedOwners || [],
                city: emp.city || '',
                area: emp.area || '',
                areaCode: emp.areaCode || '',
                cityId: emp.cityId || null,
                areaId: emp.areaId || null,
                // assignedProperties is populated above, so [0] is a Property doc, not just an id.
                assignedPropertyName: emp.assignedProperties?.[0]?.title || emp.assignedProperties?.[0]?.name || '',
                photoDataUrl: emp.photoDataUrl || '',
                requirePasswordReset,
            }
        };

        if (requirePasswordReset) {
            responsePayload.resetToken = jwt.sign(
                { loginId: emp.loginId, purpose: 'password_reset' },
                process.env.JWT_SECRET,
                { expiresIn: '15m' }
            );
        } else {
            // Auth token for protect-guarded routes (e.g. /api/tenants/owner, /api/complaints/owner).
            // protect() looks up the user by decoded.id and derives role from the DB record,
            // so the payload only needs the employee's _id.
            responsePayload.token = jwt.sign(
                { id: emp._id },
                process.env.JWT_SECRET,
                { expiresIn: '7d' }
            );
        }

        return res.json(responsePayload);
    } catch (err) {
        console.error('Staff login error:', err);
        return res.status(500).json({ success: false, error: 'Login failed' });
    }
});

/**
 * POST /api/employees/:loginId/reset-password
 * Staff one-time password reset
 */
router.post('/:loginId/reset-password', protectPasswordReset, async (req, res) => {
    try {
        const { loginId } = req.params;
        const { newPassword } = req.body;
        if (!newPassword) return res.status(400).json({ success: false, error: 'newPassword required' });

        const cleanLoginId = String(loginId || '').trim();
        const cleanResetId = String(req.resetLoginId || '').trim();

        // Find staff/employee record by loginId or reset token ID
        let emp = await Employee.findOne({
            $or: [
                { loginId: cleanLoginId },
                { loginId: cleanLoginId.toUpperCase() },
                { loginId: cleanLoginId.toLowerCase() },
                { loginId: cleanResetId },
                { loginId: cleanResetId.toUpperCase() }
            ]
        });

        if (!emp && mongoose.Types.ObjectId.isValid(cleanResetId)) {
            emp = await Employee.findById(cleanResetId);
        }

        if (!emp) {
            return res.status(404).json({ success: false, error: 'Staff account not found' });
        }

        emp.password = newPassword;
        emp.requirePasswordReset = false;
        await emp.save();

        const token = jwt.sign({ id: emp._id }, process.env.JWT_SECRET, { expiresIn: '7d' });

        return res.json({ success: true, message: 'Password reset successfully', token });
    } catch (err) {
        console.error('Reset password error:', err);
        return res.status(500).json({ success: false, error: 'Reset failed' });
    }
});



/**
 * GET /api/employees
 * Get all employees cleanly from Employee and User collections (excluding soft-deleted)
 */
router.get('/', protect, authorize('superadmin', 'areamanager', 'owner', 'manager', 'employee'), async (req, res) => {
    try {
        const { area, role, isActive, parentLoginId } = req.query;
        const isOwner = req.user.role === 'owner';
        const isAreaManager = req.user.role === 'areamanager';

        const empFilter = { isDeleted: { $ne: true } };
        if (area) empFilter.area = area;
        if (role) empFilter.role = role;
        if (typeof isActive !== 'undefined') empFilter.isActive = isActive === 'true';

        if (isOwner || isAreaManager) {
            const ownerId = String(req.user.loginId || '').trim();
            empFilter.$or = [
                { parentLoginId: ownerId },
                { parentLoginId: ownerId.toUpperCase() },
                { parentLoginId: ownerId.toLowerCase() }
            ];
        } else if (parentLoginId) {
            const pId = String(parentLoginId).trim();
            empFilter.$or = [
                { parentLoginId: pId },
                { parentLoginId: pId.toUpperCase() },
                { parentLoginId: pId.toLowerCase() }
            ];
        }

        // 1. Fetch active documents in Employee collection
        const empDocs = await Employee.find(empFilter).select('-password')
            .populate('assignedProperties', 'title name city')
            .sort({ createdAt: -1 }).lean();

        // 2. Fetch active documents in User collection with staff/employee roles
        const User = require('../models/user');
        const userFilter = isOwner 
            ? { role: 'staff', isDeleted: { $ne: true } } 
            : { role: { $in: ['employee', 'areamanager', 'manager', 'staff'] }, isDeleted: { $ne: true } };
            
        const userDocs = await User.find(userFilter).select('-password').sort({ _id: -1 }).lean();

        const seenKeys = new Set();
        const mergedEmployees = [];

        // Add records from Employee collection first (using _id / loginId)
        for (const e of empDocs) {
            const idKey = String(e._id || e.loginId || e.email).toUpperCase().trim();
            if (idKey && !seenKeys.has(idKey)) {
                seenKeys.add(idKey);
                if (e.email) seenKeys.add(String(e.email).toUpperCase().trim());
                if (e.loginId) seenKeys.add(String(e.loginId).toUpperCase().trim());
                mergedEmployees.push({
                    ...e,
                    role: e.role || 'Marketing Team',
                    isActive: e.isActive !== false
                });
            }
        }

        // Add records from User collection if not already in Employee collection
        for (const u of userDocs) {
            const idKey = String(u._id || u.loginId || u.email).toUpperCase().trim();
            const emailKey = u.email ? String(u.email).toUpperCase().trim() : '';
            const loginKey = u.loginId ? String(u.loginId).toUpperCase().trim() : '';

            if (idKey && !seenKeys.has(idKey) && (!emailKey || !seenKeys.has(emailKey)) && (!loginKey || !seenKeys.has(loginKey))) {
                seenKeys.add(idKey);
                if (emailKey) seenKeys.add(emailKey);
                if (loginKey) seenKeys.add(loginKey);

                mergedEmployees.push({
                    _id: u._id,
                    id: u._id,
                    name: u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || 'Staff Member',
                    loginId: u.loginId || `EMP${String(u._id).slice(-4)}`,
                    email: u.email || '',
                    phone: u.phone || '',
                    role: u.role === 'employee' ? 'Marketing Team' : (u.role === 'staff' ? 'Staff' : u.role),
                    city: u.city || '',
                    area: u.area || '',
                    isActive: u.isActive !== false,
                    permissions: u.permissions || [],
                    restrictedModules: u.restrictedModules || [],
                    createdAt: u.createdAt || new Date()
                });
            }
        }

        mergedEmployees.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

        return res.status(200).json({ success: true, data: mergedEmployees, count: mergedEmployees.length });
    } catch (err) {
        console.error('Get employees error:', err);
        return res.status(500).json({ error: 'Failed to fetch employees', details: err.message });
    }
});

/**
 * GET /api/employees/generate-staff-id/:ownerLoginId
 * Generate next sequential STAFF ID for this owner
 */
const buildUniqueStaffLoginId = async (ownerLoginId, preferredLoginId = null) => {
    const preferred = String(preferredLoginId || '').trim();
    if (preferred) {
        const existing = await Employee.findOne({ loginId: preferred }).lean();
        if (!existing) return preferred;
    }

    const allStaff = await Employee.find({ parentLoginId: ownerLoginId, loginId: /^STAFF/i }).select('loginId').lean();
    const usedNumbers = allStaff
        .map(s => parseInt(String(s.loginId || '').replace(/^STAFF/i, ''), 10))
        .filter(n => Number.isInteger(n) && n >= 1);

    let nextNum = 1;
    while (usedNumbers.includes(nextNum)) {
        nextNum += 1;
    }

    return `STAFF${String(nextNum).padStart(4, '0')}`;
};

router.get('/generate-staff-id/:ownerLoginId', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { ownerLoginId } = req.params;

        // Owner can only generate IDs within their own staff pool
        if (req.user.role === 'owner') {
            const userLoginId = String(req.user.loginId || '').toUpperCase();
            if (userLoginId !== String(ownerLoginId || '').toUpperCase()) {
                return res.status(403).json({ error: 'Forbidden: You can only generate staff IDs for your own employees' });
            }
        }
        // To avoid global unique constraint violations on loginId,
        // we must find the absolute highest STAFFxxxx number across ALL owners globally.
        const allStaff = await Employee.find({ loginId: /^STAFF\d+$/i }).select('loginId').lean();
        const nums = allStaff
            .map(s => parseInt((s.loginId || '').toUpperCase().replace('STAFF', ''), 10))
            .filter(n => !isNaN(n));

        const maxNum = nums.length > 0 ? Math.max(...nums) : 0;
        const nextId = `STAFF${String(maxNum + 1).padStart(4, '0')}`;

        return res.status(200).json({ success: true, staffId: nextId });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to generate staff ID', details: err.message });
    }
});

/**
 * GET /api/employees/stats/:ownerLoginId
 * Returns staff counts: total, active, inactive for an owner
 */
router.get('/stats/:ownerLoginId', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { ownerLoginId } = req.params;

        // Owner can only view stats for their own staff
        if (req.user.role === 'owner') {
            const userLoginId = String(req.user.loginId || '').toUpperCase();
            if (userLoginId !== String(ownerLoginId || '').toUpperCase()) {
                return res.status(403).json({ error: 'Forbidden: You can only view stats for your own employees' });
            }
        }
        const StaffAttendance = require('../models/StaffAttendance');
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const [total, active, inactive, presentToday, absentToday, onLeaveToday, lateToday] = await Promise.all([
            Employee.countDocuments({ parentLoginId: ownerLoginId, isDeleted: { $ne: true } }),
            Employee.countDocuments({ parentLoginId: ownerLoginId, isActive: true, isDeleted: { $ne: true } }),
            Employee.countDocuments({ parentLoginId: ownerLoginId, isActive: false, isDeleted: { $ne: true } }),
            StaffAttendance.countDocuments({ ownerLoginId, date: { $gte: today, $lt: tomorrow }, status: 'Present' }),
            StaffAttendance.countDocuments({ ownerLoginId, date: { $gte: today, $lt: tomorrow }, status: 'Absent' }),
            StaffAttendance.countDocuments({ ownerLoginId, date: { $gte: today, $lt: tomorrow }, status: 'Leave' }),
            StaffAttendance.countDocuments({ ownerLoginId, date: { $gte: today, $lt: tomorrow }, status: 'Late' }),
        ]);

        return res.status(200).json({
            success: true,
            data: { total, active, inactive, presentToday, absentToday, onLeaveToday, lateToday }
        });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch staff stats', details: err.message });
    }
});

/**
 * POST /api/employees/clear
 * Delete all employees (dangerous - requires confirm=true)
 */
router.post('/clear', protect, authorize('superadmin'), async (req, res) => {
    try {
        const confirm = String(req.query.confirm || req.body.confirm || '').toLowerCase();
        if (confirm !== 'true') {
            return res.status(400).json({ error: 'Confirmation required. Pass confirm=true.' });
        }
        const result = await Employee.deleteMany({});
        return res.status(200).json({ success: true, deleted: result.deletedCount || 0 });
    } catch (err) {
        console.error('Clear employees error:', err);
        return res.status(500).json({ error: 'Failed to clear employees', details: err.message });
    }
});

/**
 * GET /api/employees/:loginId
 * Get a specific employee by loginId
 */
router.get('/:loginId', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { loginId } = req.params;
        const employee = await Employee.findOne({ loginId }).select('-password');
        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        // Areamanager/Owner scope check: can only view employees under their management
        if (req.user.role === 'areamanager' || req.user.role === 'owner') {
            const userLoginId = String(req.user.loginId || '').toUpperCase();
            const empParent = String(employee.parentLoginId || '').toUpperCase();
            if (!userLoginId || empParent !== userLoginId) {
                return res.status(403).json({ error: 'Forbidden: You can only view employees under your management' });
            }
        }

        return res.status(200).json({ success: true, data: employee });
    } catch (err) {
        console.error('Get employee error:', err);
        return res.status(500).json({ error: 'Failed to fetch employee', details: err.message });
    }
});

/**
 * POST /api/employees
 * Create a new employee
 * Body: { name, loginId, email, phone, password, role, area, areaCode, city, locationCode, permissions, parentLoginId }
 */
router.post('/', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const {
            name, loginId, email, phone, password, role, area, areaCode, city,
            locationCode, permissions = [], parentLoginId, photoDataUrl,
            // ── New scope fields ────────────────────────────────────────────
            employeeType = 'Field Executive',
            assignedProperties = [],
            assignedOwners = [],
            restrictedModules,          // if not provided → use full default list
            cityId, areaId,
        } = req.body;

        if (!name || !loginId) return res.status(400).json({ error: 'Missing required fields: name, loginId' });



        // Area managers/owners cannot create superadmin or areamanager/owner accounts
        if (req.user.role === 'areamanager' || req.user.role === 'owner') {
            const requestedRole = String(role || '').toLowerCase();
            if (requestedRole === 'superadmin' || requestedRole === 'areamanager' || requestedRole === 'owner') {
                return res.status(403).json({ error: 'Forbidden: You cannot create accounts with elevated roles' });
            }
        }

        // Areamanager/owner scope: force parentLoginId to caller's own loginId — prevents scope planting
        const effectiveParentLoginId = (req.user.role === 'areamanager' || req.user.role === 'owner')
            ? String(req.user.loginId || '').toUpperCase()
            : parentLoginId;

        console.log('Creating employee:', { name, loginId, email, role });

        const normalizedEmail = email ? String(email).toLowerCase() : '';
        let finalLoginId = String(loginId || '').trim().toUpperCase();

        // ── Helper: send credentials email ──
        const sendStaffEmail = async (empEmail, empLoginId, empPassword, empRole) => {
            if (!empEmail) return { attempted: false, sent: false };
            try {
                const mailer = require('../utils/mailer');
                let originUrl = req.headers.origin || '';
                if (!originUrl && req.headers.referer) {
                    try { originUrl = new URL(req.headers.referer).origin; } catch (e) { }
                }
                console.log('📧 Sending staff credentials to', empEmail, '| ID:', empLoginId);
                const sent = await mailer.sendCredentials(empEmail, empLoginId, empPassword, empRole, originUrl);
                console.log(sent ? '✅ Staff email sent' : '❌ Staff email failed', empEmail);
                return { attempted: true, sent };
            } catch (e) {
                console.warn('❌ Mailer error:', e.message);
                return { attempted: true, sent: false, error: e.message };
            }
        };

        // Check loginId exists
        const exists = await Employee.findOne({ loginId: finalLoginId });
        if (exists) {
            if (exists.isActive === false || exists.isDeleted) {
                exists.set({ name, loginId: finalLoginId, email: normalizedEmail || undefined, phone, password, role, area, areaCode, city, locationCode, permissions, parentLoginId: effectiveParentLoginId, photoDataUrl, isActive: true, isDeleted: false, updatedAt: new Date() });
                const updated = await exists.save();
                const emailResult = await sendStaffEmail(email, finalLoginId, password, role);
                return res.status(201).json({ success: true, data: updated, reused: true, email: emailResult });
            }
            finalLoginId = await buildUniqueStaffLoginId(effectiveParentLoginId, finalLoginId);
        }

        // Check email/phone duplicates
        let inactiveByEmail = null;
        let inactiveByPhone = null;
        if (normalizedEmail) {
            const found = await Employee.findOne({ email: normalizedEmail });
            if (found && (found.isActive === false || found.isDeleted)) inactiveByEmail = found;
            if (found && found.isActive !== false && !found.isDeleted) return res.status(409).json({ error: 'Duplicate email', details: 'Email already in use' });
        }
        if (phone) {
            const found = await Employee.findOne({ phone });
            if (found && (found.isActive === false || found.isDeleted)) inactiveByPhone = found;
            if (found && found.isActive !== false && !found.isDeleted) return res.status(409).json({ error: 'Duplicate phone', details: 'Phone already in use' });
        }

        // Reuse inactive by email/phone
        const reuseTarget = inactiveByEmail || inactiveByPhone;
        if (reuseTarget) {
            const loginConflict = await Employee.findOne({ loginId: finalLoginId });
            if (loginConflict && String(loginConflict._id) !== String(reuseTarget._id)) {
                finalLoginId = await buildUniqueStaffLoginId(effectiveParentLoginId, finalLoginId);
            }
            reuseTarget.set({
                name, loginId: finalLoginId, email: normalizedEmail || undefined, phone, password,
                role, area, areaCode, city, locationCode, permissions,
                parentLoginId: effectiveParentLoginId, photoDataUrl, isActive: true, isDeleted: false,
                employeeType:      employeeType       || 'Field Executive',
                assignedProperties: assignedProperties || [],
                assignedOwners:     assignedOwners     || [],
                restrictedModules:  restrictedModules !== undefined ? restrictedModules : DEFAULT_RESTRICTED_MODULES,
                cityId:  cityId  || undefined,
                areaId:  areaId  || undefined,
                updatedAt: new Date()
            });
            const updated = await reuseTarget.save();
            const emailResult = await sendStaffEmail(email, finalLoginId, password, role);
            return res.status(201).json({ success: true, data: updated, reused: true, email: emailResult });
        }

        // Create fresh employee
        let employee;
        try {
            employee = await Employee.create({
                name,
                loginId:            finalLoginId,
                email:              normalizedEmail || undefined,
                phone,
                password,
                role,
                area,
                areaCode,
                city,
                locationCode,
                permissions,
                parentLoginId:      effectiveParentLoginId,
                photoDataUrl,
                requirePasswordReset: true,
                // ── New scope fields ─────────────────────────────────────────
                employeeType:       employeeType || 'Field Executive',
                assignedProperties: assignedProperties || [],
                assignedOwners:     assignedOwners     || [],
                restrictedModules:  restrictedModules !== undefined ? restrictedModules : DEFAULT_RESTRICTED_MODULES,
                cityId:             cityId   || undefined,
                areaId:             areaId   || undefined,
            });
        } catch (dbErr) {
            if (dbErr && dbErr.code === 11000) {
                const dupField = dbErr.keyPattern ? Object.keys(dbErr.keyPattern)[0] : 'field';
                return res.status(409).json({ error: `Duplicate ${dupField}`, details: dbErr.message });
            }
            throw dbErr;
        }

        try {
            const User = require('../models/user');
            await User.findOneAndUpdate(
                { loginId: finalLoginId },
                {
                    name,
                    loginId: finalLoginId,
                    email: normalizedEmail || undefined,
                    phone: phone || '0000000000',
                    password: password || '123456',
                    role: 'employee',
                    city: city || '',
                    isActive: true,
                    isDeleted: false
                },
                { upsert: true, new: true }
            );
        } catch (uErr) {
            console.warn('[employeeRoutes] Sync to User collection failed:', uErr.message);
        }

        const emailResult = await sendStaffEmail(email, finalLoginId, password, role);
        return res.status(201).json({ success: true, data: employee, email: emailResult });

    } catch (err) {
        console.error('Create employee error:', err);
        return res.status(500).json({ error: 'Failed to create employee', details: err.message });
    }
});

/**
 * PATCH /api/employees/:loginId
 * Update an employee
 * Body: { name, email, phone, password, role, area, areaCode, city, permissions, isActive }
 */
router.patch('/:loginId', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { loginId } = req.params;

        // Block role/permissions modification for areamanager entirely
        if (req.user.role === 'areamanager') {
            if (req.body.role !== undefined || req.body.permissions !== undefined) {
                return res.status(403).json({ error: 'Forbidden: Area managers cannot modify role or permissions' });
            }
        }

        // Areamanager/Owner scope check: can only update employees they manage
        if (req.user.role === 'areamanager' || req.user.role === 'owner') {
            const userLoginId = String(req.user.loginId || '').toUpperCase();
            const target = await Employee.findOne({ loginId, isDeleted: { $ne: true } });
            if (!target) return res.status(404).json({ error: 'Employee not found' });
            const empParent = String(target.parentLoginId || '').toUpperCase();
            if (!userLoginId || empParent !== userLoginId) {
                return res.status(403).json({ error: 'Forbidden: You can only update employees under your management' });
            }
        }

        // Explicit field whitelist — prevents full req.body passthrough
        const COMMON_FIELDS = ['name', 'email', 'phone', 'status', 'department',
            'isActive', 'area', 'areaCode', 'city', 'locationCode',
            'password', 'photoDataUrl'];
        // Superadmin-only writable fields
        const SUPERADMIN_FIELDS = [
            'role', 'permissions', 'parentLoginId',
            // ── New scope fields (superadmin only) ──────────────────────────
            'employeeType', 'assignedProperties', 'assignedOwners',
            'restrictedModules', 'cityId', 'areaId',
        ];
        // Owners must be able to (re)assign which of their own properties a
        // staff member is scoped to — this is what the property switcher and
        // the owner-data endpoints use to restrict a staff member's access.
        const OWNER_FIELDS = ['role', 'permissions', 'assignedProperties'];

        let allowedFields;
        if (req.user.role === 'superadmin') {
            allowedFields = [...COMMON_FIELDS, ...SUPERADMIN_FIELDS];
        } else if (req.user.role === 'owner') {
            allowedFields = [...COMMON_FIELDS, ...OWNER_FIELDS];
        } else {
            allowedFields = COMMON_FIELDS;
        }

        const updates = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined) updates[field] = req.body[field];
        }

        if (updates.password) {
            updates.requirePasswordReset = true;
        }

        const employee = await Employee.findOneAndUpdate(
            { loginId },
            { ...updates, updatedAt: new Date() },
            { new: true, runValidators: true }
        );

        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        return res.status(200).json({ success: true, data: employee });
    } catch (err) {
        console.error('Update employee error:', err);
        return res.status(500).json({ error: 'Failed to update employee', details: err.message });
    }
});

/**
 * POST /api/employees/:loginId/deactivate
 * Deactivate an employee without removing the cached credential shell on the client
 */
router.post('/:loginId/deactivate', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { loginId } = req.params;

        if (req.user.role === 'areamanager' || req.user.role === 'owner') {
            const userLoginId = String(req.user.loginId || '').toUpperCase();
            const target = await Employee.findOne({ loginId, isDeleted: { $ne: true } });
            if (!target) return res.status(404).json({ error: 'Employee not found' });
            if (target.role === 'superadmin' || target.role === 'areamanager' || target.role === 'owner') {
                return res.status(403).json({ error: 'Forbidden: You cannot deactivate accounts with elevated roles' });
            }
            const empParent = String(target.parentLoginId || '').toUpperCase();
            if (!userLoginId || empParent !== userLoginId) {
                return res.status(403).json({ error: 'Forbidden: You can only deactivate employees under your management' });
            }
        }

        const employee = await Employee.findOneAndUpdate(
            { loginId },
            { $set: { isActive: false, updatedAt: new Date() } },
            { new: true }
        );

        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        return res.status(200).json({ success: true, data: employee });
    } catch (err) {
        console.error('Deactivate employee error:', err);
        return res.status(500).json({ error: 'Failed to deactivate employee', details: err.message });
    }
});

/**
 * DELETE /api/employees/:loginId
 * Delete an employee (Soft Delete in both Employee & User collections)
 */
router.delete('/:loginId', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { loginId } = req.params;
        const targetStr = decodeURIComponent(loginId).trim();
        const isValidId = mongoose.Types.ObjectId.isValid(targetStr);

        const filterCond = {
            $or: [
                { loginId: targetStr },
                { email: targetStr.toLowerCase() },
                ...(isValidId ? [{ _id: targetStr }] : [])
            ]
        };

        const employee = await Employee.findOneAndUpdate(
            filterCond,
            { $set: { isDeleted: true, isActive: false, updatedAt: new Date() } },
            { new: true }
        );

        const User = require('../models/user');
        await User.updateMany(
            filterCond,
            { $set: { isDeleted: true, isActive: false } }
        );

        return res.status(200).json({ 
            success: true, 
            message: 'Employee soft deleted successfully', 
            data: employee || { loginId: targetStr } 
        });
    } catch (err) {
        console.error('Delete employee error:', err);
        return res.status(500).json({ error: 'Failed to delete employee', details: err.message });
    }
});

/**
 * POST /api/employees/:loginId/reactivate
 * Reactivate a deactivated employee
 */
router.post('/:loginId/reactivate', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { loginId } = req.params;

        if (req.user.role === 'areamanager' || req.user.role === 'owner') {
            const userLoginId = String(req.user.loginId || '').toUpperCase();
            const target = await Employee.findOne({ loginId, isDeleted: { $ne: true } });
            if (!target) return res.status(404).json({ error: 'Employee not found' });
            if (target.role === 'superadmin' || target.role === 'areamanager' || target.role === 'owner') {
                return res.status(403).json({ error: 'Forbidden: You cannot reactivate accounts with elevated roles' });
            }
            const empParent = String(target.parentLoginId || '').toUpperCase();
            if (!userLoginId || empParent !== userLoginId) {
                return res.status(403).json({ error: 'Forbidden: You can only reactivate employees under your management' });
            }
        }

        const employee = await Employee.findOneAndUpdate(
            { loginId },
            { isActive: true, updatedAt: new Date() },
            { new: true }
        );

        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        return res.status(200).json({ success: true, data: employee });
    } catch (err) {
        console.error('Reactivate employee error:', err);
        return res.status(500).json({ error: 'Failed to reactivate employee', details: err.message });
    }
});

module.exports = router;
