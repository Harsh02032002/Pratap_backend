const express = require('express');
const router = express.Router();
const propertyManagerController = require('../controllers/propertyManagerController');

// Login
router.post('/login', propertyManagerController.loginPropertyManager);

// Create property manager
router.post('/', propertyManagerController.createPropertyManager);

// Get all managers for an owner
router.get('/owner/:ownerLoginId', propertyManagerController.getManagersByOwner);

// Get single manager
router.get('/:managerId', propertyManagerController.getManagerById);

// Update manager
router.put('/:managerId', propertyManagerController.updatePropertyManager);

// Delete manager
router.delete('/:managerId', propertyManagerController.deletePropertyManager);

// Reset manager password
router.post('/:managerId/reset-password', propertyManagerController.resetManagerPassword);

// Reset initial password from frontend
router.post('/reset-initial-password', propertyManagerController.resetInitialPassword);

// Add tenant to property manager's assigned property
router.post('/:managerId/tenants', propertyManagerController.addTenantToProperty);

// Get tenants for property manager's assigned property
router.get('/:managerId/tenants', propertyManagerController.getPropertyManagerTenants);

module.exports = router;
