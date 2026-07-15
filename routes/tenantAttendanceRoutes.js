const express = require('express');
const router = express.Router();
const tenantAttendanceController = require('../controllers/tenantAttendanceController');
const { protect, authorize } = require('../middleware/authMiddleware');

router.use(protect);
router.use(authorize('owner', 'employee', 'manager', 'areamanager', 'superadmin'));

// Resolves the caller's own owner scope and forces it onto the request —
// an owner or their staff can never read/write another owner's tenant
// attendance by changing a query/body param. Area managers and superadmin
// keep cross-owner oversight via an explicit ownerLoginId.
function scopeOwnerLoginId(req, res, next) {
    if (req.user.role === 'owner') {
        req.effectiveOwnerLoginId = req.user.loginId;
    } else if (req.user.role === 'employee' || req.user.role === 'manager') {
        req.effectiveOwnerLoginId = req.user.parentLoginId;
    } else {
        req.effectiveOwnerLoginId = req.query.ownerLoginId || req.body.ownerLoginId || req.params.ownerLoginId || null;
    }

    if (!req.effectiveOwnerLoginId) {
        return res.status(403).json({ success: false, message: 'No owner scope found for this account' });
    }
    next();
}

router.get('/', scopeOwnerLoginId, tenantAttendanceController.getOwnerTenantAttendance);
router.post('/', scopeOwnerLoginId, tenantAttendanceController.updateTenantStatus);
router.get('/owner/:ownerLoginId', scopeOwnerLoginId, tenantAttendanceController.getOwnerTenantAttendance);
router.post('/update', scopeOwnerLoginId, tenantAttendanceController.updateTenantStatus);
router.post('/sync', scopeOwnerLoginId, tenantAttendanceController.syncTenantAttendance);

module.exports = router;
