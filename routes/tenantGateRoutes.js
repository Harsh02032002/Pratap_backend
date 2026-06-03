const express = require('express');
const router = express.Router();
const tenantGateController = require('../controllers/tenantGateController');

router.post('/visitor-pass', tenantGateController.createVisitorPass);
router.get('/visitor-pass/:tenantId', tenantGateController.getVisitorPasses);

router.post('/leave-request', tenantGateController.createLeaveRequest);
router.get('/leave-request/:tenantId', tenantGateController.getLeaveRequests);

module.exports = router;
