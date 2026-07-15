const express = require('express');
const router = express.Router();
const visitorController = require('../controllers/visitorController');
const { protect, authorize } = require('../middleware/authMiddleware');

// PUBLIC — gate staff / anyone scans the pass QR; resolves token → verification.
// Must be declared before the auth-protected routes below.
router.get('/verify/:token', visitorController.verifyByToken);

// Owner panel — get all visitor logs for an owner
router.get('/owner/:ownerLoginId', visitorController.getOwnerVisitors);

// Tenant self-service — get own visitor history (auth + ownership enforced in controller)
router.get('/tenant/:loginId', protect, authorize('tenant', 'superadmin', 'areamanager'), visitorController.getTenantVisitorHistory);

// Tenant creates a visitor pass — identity resolved from JWT, never from body.
// Created as Pending until the owner approves.
router.post('/', protect, authorize('tenant'), visitorController.createVisitor);

// Owner approves / rejects a pending visitor pass
router.patch('/:id/approve', visitorController.approveVisitor);
router.patch('/:id/reject',  visitorController.rejectVisitor);

// Owner/admin updates visitor status (gate flows: Inside/Exited/Cancelled)
router.patch('/:id/status', visitorController.updateVisitorStatus);

module.exports = router;
