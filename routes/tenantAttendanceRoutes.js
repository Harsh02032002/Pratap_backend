const express = require('express');
const router = express.Router();
const tenantAttendanceController = require('../controllers/tenantAttendanceController');

router.get('/owner/:ownerLoginId', tenantAttendanceController.getOwnerTenantAttendance);
router.post('/update', tenantAttendanceController.updateTenantStatus);
router.post('/sync', tenantAttendanceController.syncTenantAttendance);

module.exports = router;
