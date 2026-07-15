const express = require('express');
const router = express.Router();
const hrController = require('../controllers/hrController');
const { protect, authorize } = require('../middleware/authMiddleware');

// ─── Scope guards ───────────────────────────────────────────────────────────
// Same pattern already used in routes/employeeRoutes.js and routes/tenantRoutes.js:
// owner/employee callers are pinned to their own data; areamanager/superadmin pass through.

// Owner-scoped URL param (:ownerLoginId) — an owner may only read/write their own records.
const ownerMatchGuard = (paramKey) => (req, res, next) => {
    if (req.user.role !== 'owner') return next();
    const requested = String(req.params[paramKey] || '').toUpperCase();
    const caller = String(req.user.loginId || '').toUpperCase();
    if (requested && requested !== caller) {
        return res.status(403).json({ success: false, error: 'Forbidden: cannot access another owner\'s records' });
    }
    next();
};

// Employee-scoped URL param (:staffLoginId) — an employee may only read their own attendance.
// Owner may read it too, but only for staff that belongs to them.
const staffSelfOrOwnerGuard = (paramKey) => async (req, res, next) => {
    const requested = String(req.params[paramKey] || '').toUpperCase();
    if (req.user.role === 'employee' || req.user.role === 'manager') {
        if (requested !== String(req.user.loginId || '').toUpperCase()) {
            return res.status(403).json({ success: false, error: 'Forbidden: cannot view another staff member\'s attendance' });
        }
        return next();
    }
    if (req.user.role === 'owner') {
        const Employee = require('../models/Employee');
        const emp = await Employee.findOne({ loginId: requested }).select('parentLoginId');
        if (!emp || String(emp.parentLoginId || '').toUpperCase() !== String(req.user.loginId || '').toUpperCase()) {
            return res.status(403).json({ success: false, error: 'Forbidden: not your staff member' });
        }
        return next();
    }
    next(); // areamanager / superadmin
};

// ─── Attendance — Owner view ────────────────────────────────────────────────
router.get(
    '/attendance/:ownerLoginId',
    protect,
    authorize('owner', 'areamanager', 'superadmin'),
    ownerMatchGuard('ownerLoginId'),
    hrController.getAttendance
);

// Owner marks/edits a staff member's attendance, OR a staff member submits their own
// leave request. Force the identity fields to the caller's own login where applicable
// so neither role can write into someone else's record via the request body.
router.post(
    '/attendance',
    protect,
    authorize('owner', 'employee', 'manager', 'areamanager', 'superadmin'),
    (req, res, next) => {
        if (req.user.role === 'owner') {
            req.body.ownerLoginId = req.user.loginId;
        } else if (req.user.role === 'employee' || req.user.role === 'manager') {
            req.body.employeeLoginId = req.user.loginId;
            req.body.ownerLoginId = req.user.parentLoginId || req.body.ownerLoginId;
        }
        next();
    },
    hrController.markAttendance
);

// Today's attendance summary for owner
router.get(
    '/attendance-today/:ownerLoginId',
    protect,
    authorize('owner', 'areamanager', 'superadmin'),
    ownerMatchGuard('ownerLoginId'),
    async (req, res) => {
        try {
            const StaffAttendance = require('../models/StaffAttendance');
            const Employee = require('../models/Employee');
            const { ownerLoginId } = req.params;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const allStaff = await Employee.find({ parentLoginId: ownerLoginId, isActive: true, isDeleted: { $ne: true } });
            const records = await StaffAttendance.find({
                ownerLoginId,
                date: { $gte: today, $lt: tomorrow }
            }).populate('employeeId', 'name role photoDataUrl');

            res.json({ success: true, data: records, totalStaff: allStaff.length });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
);

// Staff self check-in — staffLoginId is always forced to the authenticated caller,
// so an employee can never check in on behalf of another employee.
router.post(
    '/checkin',
    protect,
    authorize('employee', 'manager'),
    async (req, res) => {
        try {
            const StaffAttendance = require('../models/StaffAttendance');
            const Employee = require('../models/Employee');
            const staffLoginId = req.user.loginId;

            const emp = await Employee.findOne({ loginId: staffLoginId });
            if (!emp) return res.status(404).json({ success: false, error: 'Staff not found' });

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const now = new Date();
            const checkInTime = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

            let record = await StaffAttendance.findOne({ employeeId: emp._id, date: { $gte: today, $lt: tomorrow } });
            if (record) {
                record.checkIn = checkInTime;
                record.updatedAt = new Date();
                await record.save();
            } else {
                record = await StaffAttendance.create({
                    employeeId: emp._id,
                    employeeLoginId: staffLoginId,
                    ownerLoginId: emp.parentLoginId,
                    date: today,
                    status: 'Present',
                    checkIn: checkInTime
                });
            }
            res.json({ success: true, data: record, checkInTime });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
);

// Staff self check-out — same self-only guarantee as check-in.
router.post(
    '/checkout',
    protect,
    authorize('employee', 'manager'),
    async (req, res) => {
        try {
            const StaffAttendance = require('../models/StaffAttendance');
            const Employee = require('../models/Employee');
            const staffLoginId = req.user.loginId;

            const emp = await Employee.findOne({ loginId: staffLoginId });
            if (!emp) return res.status(404).json({ success: false, error: 'Staff not found' });

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const now = new Date();
            const checkOutTime = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

            let record = await StaffAttendance.findOne({ employeeId: emp._id, date: { $gte: today, $lt: tomorrow } });
            if (record) {
                record.checkOut = checkOutTime;
                record.updatedAt = new Date();
                await record.save();
            } else {
                record = await StaffAttendance.create({
                    employeeId: emp._id,
                    employeeLoginId: staffLoginId,
                    ownerLoginId: emp.parentLoginId,
                    date: today,
                    status: 'Present',
                    checkOut: checkOutTime
                });
            }
            res.json({ success: true, data: record, checkOutTime });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
);

// Get staff's own attendance history (owner may view it for their own staff).
router.get(
    '/my-attendance/:staffLoginId',
    protect,
    authorize('employee', 'manager', 'owner', 'areamanager', 'superadmin'),
    staffSelfOrOwnerGuard('staffLoginId'),
    async (req, res) => {
        try {
            const StaffAttendance = require('../models/StaffAttendance');
            const Employee = require('../models/Employee');
            const { staffLoginId } = req.params;
            const { month, year } = req.query;

            const emp = await Employee.findOne({ loginId: staffLoginId });
            if (!emp) return res.status(404).json({ success: false, error: 'Staff not found' });

            let dateFilter = {};
            if (month && year) {
                const start = new Date(parseInt(year), parseInt(month) - 1, 1);
                const end = new Date(parseInt(year), parseInt(month), 1);
                dateFilter = { date: { $gte: start, $lt: end } };
            }

            const records = await StaffAttendance.find({ employeeId: emp._id, ...dateFilter }).sort({ date: -1 });
            res.json({ success: true, data: records });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }
);

// ─── Salaries ────────────────────────────────────────────────────────────────
router.get(
    '/salaries/:ownerLoginId',
    protect,
    authorize('owner', 'areamanager', 'superadmin'),
    ownerMatchGuard('ownerLoginId'),
    hrController.getSalaries
);
router.post(
    '/salaries',
    protect,
    authorize('owner', 'areamanager', 'superadmin'),
    (req, res, next) => {
        if (req.user.role === 'owner') req.body.ownerLoginId = req.user.loginId;
        next();
    },
    hrController.processSalary
);

// ─── Shifts ──────────────────────────────────────────────────────────────────
router.get(
    '/shifts/:ownerLoginId',
    protect,
    authorize('owner', 'areamanager', 'superadmin'),
    ownerMatchGuard('ownerLoginId'),
    hrController.getShifts
);
router.post(
    '/shifts',
    protect,
    authorize('owner', 'areamanager', 'superadmin'),
    (req, res, next) => {
        if (req.user.role === 'owner') req.body.ownerLoginId = req.user.loginId;
        next();
    },
    hrController.saveShift
);

module.exports = router;
