const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');
const { protect, authorize } = require('../middleware/authMiddleware');

/**
 * POST /api/employees/login
 * Staff login — checks loginId + password
 */
router.post('/login', async (req, res) => {
    try {
        const { loginId, password } = req.body;
        if (!loginId || !password) return res.status(400).json({ success: false, error: 'loginId and password required' });

        const emp = await Employee.findOne({ loginId, isDeleted: { $ne: true } });
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
            } catch (_) {}
        }
        if (!passwordMatch) return res.status(401).json({ success: false, error: 'Invalid Staff ID or Password' });

        return res.json({
            success: true,
            requirePasswordReset: emp.requirePasswordReset === true,
            data: {
                loginId: emp.loginId,
                name: emp.name,
                role: emp.role,
                parentLoginId: emp.parentLoginId,
                permissions: emp.permissions || [],
                assignedPropertyName: emp.assignedPropertyName || '',
                photoDataUrl: emp.photoDataUrl || '',
                requirePasswordReset: emp.requirePasswordReset === true,
            }
        });
    } catch (err) {
        console.error('Staff login error:', err);
        return res.status(500).json({ success: false, error: 'Login failed' });
    }
});

/**
 * POST /api/employees/:loginId/reset-password
 * Staff one-time password reset
 */
router.post('/:loginId/reset-password', protect, authorize('superadmin', 'areamanager'), async (req, res) => {
    try {
        const { loginId } = req.params;
        const { newPassword, currentPassword } = req.body;
        if (!newPassword) return res.status(400).json({ success: false, error: 'newPassword required' });

        const emp = await Employee.findOne({ loginId });
        if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });

        // Areamanager scope check: can only reset passwords for employees they manage
        if (req.user.role === 'areamanager') {
            const areaManagerLoginId = String(req.user.loginId || '').toUpperCase();
            const empParent = String(emp.parentLoginId || '').toUpperCase();
            if (!areaManagerLoginId || empParent !== areaManagerLoginId) {
                return res.status(403).json({ success: false, error: 'Forbidden: You can only reset passwords for employees under your management' });
            }
        }

        // Verify current password
        let currentMatch = false;
        if (emp.password === currentPassword) {
            currentMatch = true;
        } else {
            try {
                const bcrypt = require('bcryptjs');
                currentMatch = await bcrypt.compare(currentPassword, emp.password);
            } catch (_) {}
        }
        if (!currentMatch) return res.status(401).json({ success: false, error: 'Current password incorrect' });

        emp.password = newPassword; // Model may hash on save
        emp.requirePasswordReset = false;
        await emp.save();

        return res.json({ success: true, message: 'Password reset successfully' });
    } catch (err) {
        console.error('Reset password error:', err);
        return res.status(500).json({ success: false, error: 'Reset failed' });
    }
});

/**
 * GET /api/employees
 * Get all employees (with optional filters)
 * Query params: area, role, isActive (true/false)
 */
router.get('/', protect, authorize('superadmin', 'areamanager'), async (req, res) => {
    try {
        const { area, role, isActive } = req.query;
        const filter = { isDeleted: { $ne: true } };
        if (area) filter.area = area;
        if (role) filter.role = role;
        if (typeof isActive !== 'undefined') filter.isActive = isActive === 'true';

        // Areamanager scope: restrict to employees they manage; ignore any client-supplied parentLoginId
        if (req.user.role === 'areamanager') {
            filter.parentLoginId = String(req.user.loginId || '').toUpperCase();
        } else if (req.query.parentLoginId) {
            filter.parentLoginId = req.query.parentLoginId;
        }

        const employees = await Employee.find(filter).select('-password').sort({ createdAt: -1 });
        return res.status(200).json({ success: true, data: employees, count: employees.length });
    } catch (err) {
        console.error('Get employees error:', err);
        return res.status(500).json({ error: 'Failed to fetch employees', details: err.message });
    }
});

/**
 * GET /api/employees/generate-staff-id/:ownerLoginId
 * Generate next sequential STAFF ID for this owner
 */
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
        // Count all staff (including inactive/deleted) for this owner to get next number
        const count = await Employee.countDocuments({ parentLoginId: ownerLoginId });
        const nextNum = String(count + 1).padStart(4, '0');
        const staffId = `STAFF${nextNum}`;
        // Double-check it doesn't already exist
        const exists = await Employee.findOne({ loginId: staffId });
        if (exists) {
            // Find the highest STAFF number and increment
            const allStaff = await Employee.find({ parentLoginId: ownerLoginId, loginId: /^STAFF/ }).select('loginId');
            const nums = allStaff
                .map(s => parseInt((s.loginId || '').replace('STAFF', ''), 10))
                .filter(n => !isNaN(n));
            const maxNum = nums.length > 0 ? Math.max(...nums) : 0;
            const safeId = `STAFF${String(maxNum + 1).padStart(4, '0')}`;
            return res.status(200).json({ success: true, staffId: safeId });
        }
        return res.status(200).json({ success: true, staffId });
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
router.get('/:loginId', protect, authorize('superadmin', 'areamanager'), async (req, res) => {
    try {
        const { loginId } = req.params;
        const employee = await Employee.findOne({ loginId }).select('-password');
        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        // Areamanager scope check: can only view employees under their management
        if (req.user.role === 'areamanager') {
            const areaManagerLoginId = String(req.user.loginId || '').toUpperCase();
            const empParent = String(employee.parentLoginId || '').toUpperCase();
            if (!areaManagerLoginId || empParent !== areaManagerLoginId) {
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
router.post('/', protect, authorize('superadmin', 'areamanager'), async (req, res) => {
    try {
        const { name, loginId, email, phone, password, role, area, areaCode, city, locationCode, permissions = [], parentLoginId, photoDataUrl } = req.body;
        if (!name || !loginId) return res.status(400).json({ error: 'Missing required fields: name, loginId' });

        // Area managers cannot create superadmin or areamanager accounts
        if (req.user.role === 'areamanager') {
            const requestedRole = String(role || '').toLowerCase();
            if (requestedRole === 'superadmin' || requestedRole === 'areamanager') {
                return res.status(403).json({ error: 'Forbidden: Area managers cannot create accounts with elevated roles' });
            }
        }

        // Areamanager scope: force parentLoginId to caller's own loginId — prevents scope planting
        const effectiveParentLoginId = req.user.role === 'areamanager'
            ? String(req.user.loginId || '').toUpperCase()
            : parentLoginId;

        console.log('Creating employee:', { name, loginId, email, role });

        const normalizedEmail = email ? String(email).toLowerCase() : '';

        // ── Helper: send credentials email ──
        const sendStaffEmail = async (empEmail, empLoginId, empPassword, empRole) => {
            if (!empEmail) return { attempted: false, sent: false };
            try {
                const mailer = require('../utils/mailer');
                let originUrl = req.headers.origin || '';
                if (!originUrl && req.headers.referer) {
                    try { originUrl = new URL(req.headers.referer).origin; } catch(e){}
                }
                console.log('📧 Sending staff credentials to', empEmail, '| ID:', empLoginId);
                const sent = await mailer.sendCredentials(empEmail, empLoginId, empPassword, empRole, originUrl);
                console.log(sent ? '✅ Staff email sent' : '❌ Staff email failed', empEmail);
                return { attempted: true, sent };
            } catch(e) {
                console.warn('❌ Mailer error:', e.message);
                return { attempted: true, sent: false, error: e.message };
            }
        };

        // Check loginId exists
        const exists = await Employee.findOne({ loginId });
        if (exists) {
            if (exists.isActive === false) {
                exists.set({ name, loginId, email: normalizedEmail || undefined, phone, password, role, area, areaCode, city, locationCode, permissions, parentLoginId: effectiveParentLoginId, photoDataUrl, isActive: true, updatedAt: new Date() });
                const updated = await exists.save();
                const emailResult = await sendStaffEmail(email, loginId, password, role);
                return res.status(201).json({ success: true, data: updated, reused: true, email: emailResult });
            }
            return res.status(409).json({ error: 'Employee with this loginId already exists' });
        }

        // Check email/phone duplicates
        let inactiveByEmail = null;
        let inactiveByPhone = null;
        if (normalizedEmail) {
            const found = await Employee.findOne({ email: normalizedEmail });
            if (found && found.isActive === false) inactiveByEmail = found;
            if (found && found.isActive !== false) return res.status(409).json({ error: 'Duplicate email', details: 'Email already in use' });
        }
        if (phone) {
            const found = await Employee.findOne({ phone });
            if (found && found.isActive === false) inactiveByPhone = found;
            if (found && found.isActive !== false) return res.status(409).json({ error: 'Duplicate phone', details: 'Phone already in use' });
        }

        // Reuse inactive by email/phone
        const reuseTarget = inactiveByEmail || inactiveByPhone;
        if (reuseTarget) {
            const loginConflict = await Employee.findOne({ loginId });
            if (loginConflict && String(loginConflict._id) !== String(reuseTarget._id)) {
                return res.status(409).json({ error: 'Employee with this loginId already exists' });
            }
            reuseTarget.set({ name, loginId, email: normalizedEmail || undefined, phone, password, role, area, areaCode, city, locationCode, permissions, parentLoginId: effectiveParentLoginId, photoDataUrl, isActive: true, updatedAt: new Date() });
            const updated = await reuseTarget.save();
            const emailResult = await sendStaffEmail(email, loginId, password, role);
            return res.status(201).json({ success: true, data: updated, reused: true, email: emailResult });
        }

        // Create fresh employee
        let employee;
        try {
            employee = await Employee.create({ name, loginId, email: normalizedEmail || undefined, phone, password, role, area, areaCode, city, locationCode, permissions, parentLoginId: effectiveParentLoginId, photoDataUrl, requirePasswordReset: true });
        } catch (dbErr) {
            if (dbErr && dbErr.code === 11000) {
                const dupField = dbErr.keyPattern ? Object.keys(dbErr.keyPattern)[0] : 'field';
                return res.status(409).json({ error: `Duplicate ${dupField}`, details: dbErr.message });
            }
            throw dbErr;
        }

        const emailResult = await sendStaffEmail(email, loginId, password, role);
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
router.patch('/:loginId', protect, authorize('superadmin', 'areamanager'), async (req, res) => {
    try {
        const { loginId } = req.params;

        // Block role/permissions modification for areamanager entirely
        if (req.user.role === 'areamanager') {
            if (req.body.role !== undefined || req.body.permissions !== undefined) {
                return res.status(403).json({ error: 'Forbidden: Area managers cannot modify role or permissions' });
            }
        }

        // Areamanager scope check: can only update employees they manage
        if (req.user.role === 'areamanager') {
            const areaManagerLoginId = String(req.user.loginId || '').toUpperCase();
            const target = await Employee.findOne({ loginId, isDeleted: { $ne: true } });
            if (!target) return res.status(404).json({ error: 'Employee not found' });
            const empParent = String(target.parentLoginId || '').toUpperCase();
            if (!areaManagerLoginId || empParent !== areaManagerLoginId) {
                return res.status(403).json({ error: 'Forbidden: You can only update employees under your management' });
            }
        }

        // Explicit field whitelist — prevents full req.body passthrough
        const COMMON_FIELDS = ['name', 'email', 'phone', 'status', 'department',
            'isActive', 'area', 'areaCode', 'city', 'locationCode',
            'password', 'photoDataUrl'];
        // parentLoginId is superadmin-only: areamanager must not overwrite the scope enforcement field
        const SUPERADMIN_FIELDS = ['role', 'permissions', 'parentLoginId'];
        const allowedFields = req.user.role === 'superadmin'
            ? [...COMMON_FIELDS, ...SUPERADMIN_FIELDS]
            : COMMON_FIELDS;

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
router.post('/:loginId/deactivate', protect, authorize('superadmin', 'areamanager'), async (req, res) => {
    try {
        const { loginId } = req.params;

        if (req.user.role === 'areamanager') {
            const areaManagerLoginId = String(req.user.loginId || '').toUpperCase();
            const target = await Employee.findOne({ loginId, isDeleted: { $ne: true } });
            if (!target) return res.status(404).json({ error: 'Employee not found' });
            if (target.role === 'superadmin' || target.role === 'areamanager') {
                return res.status(403).json({ error: 'Forbidden: Area managers cannot deactivate accounts with elevated roles' });
            }
            const empParent = String(target.parentLoginId || '').toUpperCase();
            if (!areaManagerLoginId || empParent !== areaManagerLoginId) {
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
 * Delete an employee (Soft Delete)
 */
router.delete('/:loginId', protect, authorize('superadmin'), async (req, res) => {
    try {
        const { loginId } = req.params;
        const employee = await Employee.findOneAndUpdate(
            { loginId },
            { $set: { isDeleted: true, isActive: false, updatedAt: new Date() } },
            { new: true }
        );

        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        return res.status(200).json({ success: true, message: 'Employee soft deleted successfully', data: employee });
    } catch (err) {
        console.error('Delete employee error:', err);
        return res.status(500).json({ error: 'Failed to delete employee', details: err.message });
    }
});

/**
 * POST /api/employees/:loginId/reactivate
 * Reactivate a deactivated employee
 */
router.post('/:loginId/reactivate', protect, authorize('superadmin', 'areamanager'), async (req, res) => {
    try {
        const { loginId } = req.params;

        if (req.user.role === 'areamanager') {
            const areaManagerLoginId = String(req.user.loginId || '').toUpperCase();
            const target = await Employee.findOne({ loginId, isDeleted: { $ne: true } });
            if (!target) return res.status(404).json({ error: 'Employee not found' });
            if (target.role === 'superadmin' || target.role === 'areamanager') {
                return res.status(403).json({ error: 'Forbidden: Area managers cannot reactivate accounts with elevated roles' });
            }
            const empParent = String(target.parentLoginId || '').toUpperCase();
            if (!areaManagerLoginId || empParent !== areaManagerLoginId) {
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
