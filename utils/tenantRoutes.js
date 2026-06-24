const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { auditTrail } = require('../middleware/auditTrail');

// POST /api/tenants/assign — kept open (owner panel does not send JWT)
router.post('/assign', auditTrail('tenants'), tenantController.assignTenant);

// GET /api/tenants/me — tenant self-service, JWT identity only
router.get('/me', protect, authorize('tenant'), tenantController.getMyProfile);

// GET /api/tenants — admin only
router.get('/', protect, authorize('superadmin', 'areamanager'), tenantController.getAllTenants);

// GET /api/tenants/owner/:ownerId — owner-scoped
router.get('/owner/:ownerId', protect, authorize('superadmin', 'areamanager', 'owner'), tenantController.getTenantsByOwner);

// GET /api/tenants/:tenantId — admin/owner only; /:id must come after named routes
router.get('/:tenantId', protect, authorize('superadmin', 'areamanager', 'owner'), tenantController.getTenant);

// POST /api/tenants/:tenantId/verify — admin only
router.post('/:tenantId/verify', protect, authorize('superadmin', 'areamanager'), auditTrail('tenants'), tenantController.verifyTenant);

// POST /api/tenants/:tenantId/kyc — admin only (owner panel KYC update flow)
router.post('/:tenantId/kyc', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), tenantController.updateTenantKyc);

module.exports = router;
