const express = require('express');
const router = express.Router();
const complaintController = require('../controllers/complaintController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Tenant reads their own complaints.
// Owner/admin may also query by tenantId from their management panels.
router.get(
  '/tenant/:tenantId',
  protect,
  authorize('tenant', 'superadmin', 'areamanager', 'owner'),
  complaintController.getTenantComplaints
);

// Owner/admin reads complaints for a specific owner's properties.
router.get(
  '/owner/:ownerLoginId',
  protect,
  authorize('superadmin', 'areamanager', 'owner', 'employee'),
  complaintController.getOwnerComplaints
);

// Only authenticated tenants can raise a complaint.
router.post(
  '/',
  protect,
  authorize('tenant'),
  complaintController.createComplaint
);

// Owner/admin updates complaint status (Resolved, In Progress, etc.).
// Employee (area admin panel) also uses this to manage complaints.
router.put(
  '/:id/status',
  protect,
  authorize('superadmin', 'areamanager', 'owner', 'employee'),
  complaintController.updateComplaintStatus
);

// Owner/admin assigns a staff member to a complaint.
router.patch(
  '/:id/assign',
  protect,
  authorize('superadmin', 'areamanager', 'owner'),
  complaintController.assignStaff
);

// All complaints list — superadmin/areamanager (no filter) or owner (with ?ownerLoginId= query).
router.get(
  '/',
  protect,
  authorize('superadmin', 'areamanager', 'owner', 'employee'),
  complaintController.getAllComplaints
);

// Delete a complaint — restricted to admin roles only; owners must not delete complaints.
router.delete(
  '/:id',
  protect,
  authorize('superadmin', 'areamanager'),
  complaintController.deleteComplaint
);

// Owner/admin posts a response visible to the tenant.
router.put(
  '/:id/response',
  protect,
  authorize('superadmin', 'areamanager', 'owner'),
  complaintController.updateOwnerResponse
);

module.exports = router;
