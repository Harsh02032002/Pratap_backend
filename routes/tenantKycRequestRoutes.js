const express = require('express');
const router = express.Router();
const tenantKycRequestController = require('../controllers/tenantKycRequestController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.get('/', protect, authorize('owner', 'tenant', 'superadmin'), tenantKycRequestController.getRequests);
router.put('/:id/approve', protect, authorize('superadmin'), tenantKycRequestController.approveRequest);
router.put('/:id/reject', protect, authorize('superadmin'), tenantKycRequestController.rejectRequest);

module.exports = router;
