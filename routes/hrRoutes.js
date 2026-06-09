const express = require('express');
const router = express.Router();
const hrController = require('../controllers/hrController');

// Attendance - Owner view
router.get('/attendance/:ownerLoginId', hrController.getAttendance);
router.post('/attendance', hrController.markAttendance);

// Today's attendance summary for owner
router.get('/attendance-today/:ownerLoginId', async (req, res) => {
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
});

// Staff self check-in
router.post('/checkin', async (req, res) => {
    try {
        const StaffAttendance = require('../models/StaffAttendance');
        const Employee = require('../models/Employee');
        const { staffLoginId } = req.body;
        
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
});

// Staff self check-out
router.post('/checkout', async (req, res) => {
    try {
        const StaffAttendance = require('../models/StaffAttendance');
        const Employee = require('../models/Employee');
        const { staffLoginId } = req.body;

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
});

// Get staff's own attendance history
router.get('/my-attendance/:staffLoginId', async (req, res) => {
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
});

// Salaries
router.get('/salaries/:ownerLoginId', hrController.getSalaries);
router.post('/salaries', hrController.processSalary);

// Shifts
router.get('/shifts/:ownerLoginId', hrController.getShifts);
router.post('/shifts', hrController.saveShift);

module.exports = router;

