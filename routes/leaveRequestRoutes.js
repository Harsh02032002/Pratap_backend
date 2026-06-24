const express = require('express');
const router = express.Router();
const leaveRequestController = require('../controllers/leaveRequestController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Owner panel — get all leave requests for an owner
router.get('/owner/:ownerLoginId', leaveRequestController.getOwnerLeaveRequests);

// Tenant self-service — get own leave history (auth + ownership enforced in controller)
router.get('/tenant/:loginId', protect, authorize('tenant', 'superadmin', 'areamanager'), leaveRequestController.getTenantLeaveHistory);

// Tenant submits a leave request — identity resolved from JWT, never from body
router.post('/', protect, authorize('tenant'), leaveRequestController.createLeaveRequest);

// Owner/admin updates status
router.patch('/:id/status', leaveRequestController.updateLeaveRequestStatus);

module.exports = router;
