const express = require('express');
const router = express.Router();
const hrController = require('../controllers/hrController');

// Attendance
router.get('/attendance/:ownerLoginId', hrController.getAttendance);
router.post('/attendance', hrController.markAttendance);

// Salaries
router.get('/salaries/:ownerLoginId', hrController.getSalaries);
router.post('/salaries', hrController.processSalary);

// Shifts
router.get('/shifts/:ownerLoginId', hrController.getShifts);
router.post('/shifts', hrController.saveShift);

module.exports = router;
