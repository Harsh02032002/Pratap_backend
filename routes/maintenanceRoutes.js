const express = require('express');
const router = express.Router();
const maintenanceController = require('../controllers/maintenanceController');
const { protect, authorize } = require('../middleware/authMiddleware');

// These routes previously had NO auth middleware at all: anyone could create,
// reassign or delete maintenance tasks for any owner just by knowing (or
// guessing) an ownerLoginId or task id.
router.use(protect);
router.use(authorize('owner', 'employee', 'manager', 'areamanager', 'superadmin'));

/**
 * Force the caller's own owner scope onto the request. An owner or their staff
 * can never reach another owner's maintenance data by changing a param — the
 * value is taken from the verified token, not the request.
 *
 * Mirrors scopeOwnerLoginId in routes/tenantAttendanceRoutes.js.
 */
function scopeOwnerLoginId(req, res, next) {
    if (req.user.role === 'owner') {
        req.effectiveOwnerLoginId = req.user.loginId;
    } else if (req.user.role === 'employee' || req.user.role === 'manager') {
        req.effectiveOwnerLoginId = req.user.parentLoginId;
    } else {
        // Area managers / superadmin keep cross-owner oversight, but must say
        // which owner explicitly.
        req.effectiveOwnerLoginId =
            req.query.ownerLoginId || req.body.ownerLoginId || req.params.ownerLoginId || null;
    }

    if (!req.effectiveOwnerLoginId) {
        return res.status(403).json({ success: false, message: 'No owner scope found for this account' });
    }

    req.effectiveOwnerLoginId = String(req.effectiveOwnerLoginId).trim().toUpperCase();
    next();
}

router.get('/owner/:ownerLoginId', scopeOwnerLoginId, maintenanceController.getOwnerTasks);
router.post('/', scopeOwnerLoginId, maintenanceController.createTask);
router.put('/:id/status', scopeOwnerLoginId, maintenanceController.updateTaskStatus);
router.patch('/:id/assign', scopeOwnerLoginId, maintenanceController.assignStaff);
router.delete('/:id', scopeOwnerLoginId, maintenanceController.deleteTask);

module.exports = router;
