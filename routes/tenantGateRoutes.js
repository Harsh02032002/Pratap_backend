const express = require('express');
const router = express.Router();
const tenantGateController = require('../controllers/tenantGateController');
const { protect, authorize } = require('../middleware/authMiddleware');

// All four routes were unauthenticated: anyone could issue a visitor pass
// (physical building access) or read any tenant's visitor and leave history by
// tenantId. The only frontend callers are the two POSTs on the tenant
// dashboard, which is behind TenantProtectedRoute and already sends a token;
// the two GETs have no caller at all.
//
// The :tenantId in the GETs is still not checked against the caller — that is
// the object-scope guard's job.
router.use(protect, authorize('tenant', 'owner', 'superadmin'));

router.post('/visitor-pass', tenantGateController.createVisitorPass);
router.get('/visitor-pass/:tenantId', tenantGateController.getVisitorPasses);

router.post('/leave-request', tenantGateController.createLeaveRequest);
router.get('/leave-request/:tenantId', tenantGateController.getLeaveRequests);

module.exports = router;
