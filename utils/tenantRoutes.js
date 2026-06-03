const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');

// POST /api/tenants/assign - Assign tenant (Owner)
router.post('/assign', tenantController.assignTenant);

// GET /api/tenants - Get all tenants (Super Admin)
router.get('/', tenantController.getAllTenants);

// GET /api/tenants/owner/:ownerId - Get tenants for owner
router.get('/owner/:ownerId', tenantController.getTenantsByOwner);

// GET /api/tenants/:tenantId - Get single tenant
router.get('/:tenantId', tenantController.getTenant);

// POST /api/tenants/:tenantId/verify - Verify tenant (Super Admin)
router.post('/:tenantId/verify', tenantController.verifyTenant);

// POST /api/tenants/:tenantId/kyc - Update tenant KYC
router.post('/:tenantId/kyc', tenantController.updateTenantKyc);

module.exports = router;
