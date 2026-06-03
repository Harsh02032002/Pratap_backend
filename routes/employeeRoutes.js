const express = require('express');
const router = express.Router();
const Employee = require('../models/Employee');

/**
 * GET /api/employees
 * Get all employees (with optional filters)
 * Query params: area, role, isActive (true/false)
 */
router.get('/', async (req, res) => {
    try {
        const { area, role, isActive } = req.query;
        const filter = {};
        if (area) filter.area = area;
        if (role) filter.role = role;
        if (typeof isActive !== 'undefined') filter.isActive = isActive === 'true';

        const employees = await Employee.find(filter).sort({ createdAt: -1 });
        return res.status(200).json({ success: true, data: employees, count: employees.length });
    } catch (err) {
        console.error('Get employees error:', err);
        return res.status(500).json({ error: 'Failed to fetch employees', details: err.message });
    }
});

/**
 * POST /api/employees/clear
 * Delete all employees (dangerous - requires confirm=true)
 */
router.post('/clear', async (req, res) => {
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
router.get('/:loginId', async (req, res) => {
    try {
        const { loginId } = req.params;
        const employee = await Employee.findOne({ loginId });
        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
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
router.post('/', async (req, res) => {
    try {
        const { name, loginId, email, phone, password, role, area, areaCode, city, locationCode, permissions = [], parentLoginId, photoDataUrl } = req.body;

        console.log('Creating employee:', { name, loginId, email, role });

        if (!name || !loginId) {
            return res.status(400).json({ error: 'Missing required fields: name, loginId' });
        }

        const normalizedEmail = email ? String(email).toLowerCase() : '';

        // Check if loginId already exists
        const exists = await Employee.findOne({ loginId });
        if (exists) {
            if (exists.isActive === false) {
                // If loginId exists but inactive, reuse by updating that record
                exists.set({
                    name,
                    loginId,
                    email: normalizedEmail || undefined,
                    phone,
                    password,
                    role,
                    area,
                    areaCode,
                    city,
                    locationCode,
                    permissions,
                    parentLoginId,
                    photoDataUrl,
                    isActive: true,
                    updatedAt: new Date()
                });
                const updated = await exists.save();
                return res.status(201).json({ success: true, data: updated, reused: true });
            }
            return res.status(409).json({ error: 'Employee with this loginId already exists' });
        }

        // If email/phone already exists on an inactive employee, reuse that record
        let inactiveByEmail = null;
        let inactiveByPhone = null;
        if (normalizedEmail) {
            const found = await Employee.findOne({ email: normalizedEmail });
            if (found && found.isActive === false) inactiveByEmail = found;
            if (found && found.isActive !== false) {
                return res.status(409).json({ error: 'Duplicate email', details: 'Email already in use' });
            }
        }
        if (phone) {
            const found = await Employee.findOne({ phone });
            if (found && found.isActive === false) inactiveByPhone = found;
            if (found && found.isActive !== false) {
                return res.status(409).json({ error: 'Duplicate phone', details: 'Phone already in use' });
            }
        }
        if (inactiveByEmail && inactiveByPhone && inactiveByEmail.id !== inactiveByPhone.id) {
            return res.status(409).json({ error: 'Conflicting inactive records for email and phone' });
        }
        const reuseTarget = inactiveByEmail || inactiveByPhone;
        if (reuseTarget) {
            // Ensure loginId is not used by someone else
            const loginConflict = await Employee.findOne({ loginId });
            if (loginConflict && String(loginConflict._id) !== String(reuseTarget._id)) {
                return res.status(409).json({ error: 'Employee with this loginId already exists' });
            }
            reuseTarget.set({
                name,
                loginId,
                email: normalizedEmail || undefined,
                phone,
                password,
                role,
                area,
                areaCode,
                city,
                locationCode,
                permissions,
                parentLoginId,
                photoDataUrl,
                isActive: true,
                updatedAt: new Date()
            });
            const updated = await reuseTarget.save();
            return res.status(201).json({ success: true, data: updated, reused: true });
        }

        let employee;
        try {
            employee = await Employee.create({
                name,
                loginId,
                email: normalizedEmail || undefined,
                phone,
                password,
                role,
                area,
                areaCode,
                city,
                locationCode,
                permissions,
                parentLoginId,
                photoDataUrl,
                requirePasswordReset: true
            });
        } catch (dbErr) {
            if (dbErr && dbErr.code === 11000) {
                const dupField = dbErr.keyPattern ? Object.keys(dbErr.keyPattern)[0] : 'field';
                return res.status(409).json({ error: `Duplicate ${dupField}`, details: dbErr.message });
            }
            throw dbErr;
        }

        // Send credentials email if email provided
        let emailAttempted = false;
        let emailSent = false;
        let emailError = '';
        try {
            const mailer = require('../utils/mailer');
            if (email) {
                let originUrl = req.headers.origin || '';
                if (!originUrl && req.headers.referer) {
                    try { originUrl = new URL(req.headers.referer).origin; } catch(e){}
                }
                emailAttempted = true;
                console.log('Sending email to', email, 'with loginId', loginId, 'password length', password ? password.length : 0);
                emailSent = await mailer.sendCredentials(
                    email,
                    loginId,
                    password,
                    role === 'areamanager' ? 'Area Manager' : 'Employee',
                    originUrl
                );
                if (!emailSent) {
                    emailError = 'Credential email delivery failed (Mailjet not configured or provider rejected request)';
                    console.warn('Mail send failed for employee:', loginId, email);
                }
            } else {
                console.log('No email provided for employee', name);
            }
        } catch (e) {
            emailError = e && e.message ? e.message : 'Unknown mailer error';
            console.warn('Mailer init/send failed:', emailError);
        }

        return res.status(201).json({
            success: true,
            data: employee,
            email: {
                attempted: emailAttempted,
                sent: emailSent,
                error: emailError || undefined
            }
        });
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
router.patch('/:loginId', async (req, res) => {
    try {
        const { loginId } = req.params;
        const updates = req.body;

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
router.post('/:loginId/deactivate', async (req, res) => {
    try {
        const { loginId } = req.params;
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
 * Delete an employee permanently
 */
router.delete('/:loginId', async (req, res) => {
    try {
        const { loginId } = req.params;
        const employee = await Employee.findOneAndDelete({ loginId });

        if (!employee) {
            return res.status(404).json({ error: 'Employee not found' });
        }

        return res.status(200).json({ success: true, message: 'Employee permanently deleted', data: employee });
    } catch (err) {
        console.error('Delete employee error:', err);
        return res.status(500).json({ error: 'Failed to delete employee', details: err.message });
    }
});

/**
 * POST /api/employees/:loginId/reactivate
 * Reactivate a deactivated employee
 */
router.post('/:loginId/reactivate', async (req, res) => {
    try {
        const { loginId } = req.params;
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
