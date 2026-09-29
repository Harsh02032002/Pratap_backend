const express = require('express');
const router = express.Router();
const propertyManagerController = require('../controllers/propertyManagerController');
const { authLimiter, authIpLimiter } = require('../middleware/security');
const { protect, authorize } = require('../middleware/authMiddleware');

// Login
router.post('/login', authIpLimiter, authLimiter, propertyManagerController.loginPropertyManager);

// Create property manager
router.post('/', protect, authorize('owner', 'superadmin'), propertyManagerController.createPropertyManager);

// Get all managers for an owner
router.get('/owner/:ownerLoginId', protect, authorize('owner', 'superadmin'), propertyManagerController.getManagersByOwner);

// Get single manager
router.get('/:managerId', protect, authorize('owner', 'superadmin'), propertyManagerController.getManagerById);

// Update manager
router.put('/:managerId', protect, authorize('owner', 'superadmin'), propertyManagerController.updatePropertyManager);

// Delete manager
router.delete('/:managerId', protect, authorize('owner', 'superadmin'), propertyManagerController.deletePropertyManager);

// Deactivate manager
router.post('/:managerId/deactivate', protect, authorize('owner', 'superadmin'), propertyManagerController.deactivatePropertyManager);

// Reactivate manager
router.post('/:managerId/reactivate', protect, authorize('owner', 'superadmin'), propertyManagerController.reactivatePropertyManager);

// Reset manager password
router.post('/:managerId/reset-password', protect, authorize('owner', 'superadmin'), propertyManagerController.resetManagerPassword);

// Reset initial password from frontend (proves identity via old password, not a session — intentionally unauthenticated)
router.post('/reset-initial-password', authIpLimiter, authLimiter, propertyManagerController.resetInitialPassword);

// Add tenant to property manager's assigned property
router.post('/:managerId/tenants', protect, authorize('owner', 'superadmin', 'manager'), propertyManagerController.addTenantToProperty);

// Get tenants for property manager's assigned property
router.get('/:managerId/tenants', protect, authorize('owner', 'superadmin', 'manager'), propertyManagerController.getPropertyManagerTenants);

module.exports = router;
