const express = require('express');
const router = express.Router();
const visitorController = require('../controllers/visitorController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Owner panel — get all visitor logs for an owner
router.get('/owner/:ownerLoginId', visitorController.getOwnerVisitors);

// Tenant self-service — get own visitor history (auth + ownership enforced in controller)
router.get('/tenant/:loginId', protect, authorize('tenant', 'superadmin', 'areamanager'), visitorController.getTenantVisitorHistory);

// Tenant creates a visitor pass — identity resolved from JWT, never from body
router.post('/', protect, authorize('tenant'), visitorController.createVisitor);

// Owner/admin updates visitor status
router.patch('/:id/status', visitorController.updateVisitorStatus);

module.exports = router;
