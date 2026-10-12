const express = require('express');
const router = express.Router();
const leaveRequestController = require('../controllers/leaveRequestController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Owner panel — get all leave requests for an owner.
// Was unauthenticated: any ownerLoginId returned that owner's tenants' leave
// history. The only caller is the owner panel's leave-requests page, which
// sends a token via apiFetch. The :ownerLoginId is still not checked against
// the caller — that is the object-scope guard's job.
router.get('/owner/:ownerLoginId', protect, authorize('owner', 'superadmin'), leaveRequestController.getOwnerLeaveRequests);

// Tenant self-service — get own leave history (auth + ownership enforced in controller)
router.get('/tenant/:loginId', protect, authorize('tenant', 'superadmin', 'areamanager'), leaveRequestController.getTenantLeaveHistory);

// Tenant submits a leave request — identity resolved from JWT, never from body
router.post('/', protect, authorize('tenant'), leaveRequestController.createLeaveRequest);

// Owner/admin updates status.
// Was unauthenticated, so anyone could approve or reject any tenant's leave
// request. Same caller and the same remaining per-object gap as above.
router.patch('/:id/status', protect, authorize('owner', 'superadmin'), leaveRequestController.updateLeaveRequestStatus);

module.exports = router;
