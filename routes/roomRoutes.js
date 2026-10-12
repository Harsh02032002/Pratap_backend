const express = require('express');
const router = express.Router();
const roomController = require('../controllers/roomController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');

// Owners add rooms
router.post('/', protect, authorize('owner', 'propertyowner', 'manager', 'superadmin'), roomController.createRoom);
router.post('/bulk', protect, authorize('owner', 'propertyowner', 'manager', 'superadmin'), roomController.bulkCreateRooms);
router.post('/bulk-delete', protect, authorize('owner', 'propertyowner', 'manager', 'superadmin'), roomController.bulkDeleteRooms);
router.post('/bulk-status', protect, authorize('owner', 'propertyowner', 'manager', 'superadmin'), roomController.bulkToggleRoomStatus);
router.post('/bulk-clear-tenants', protect, authorize('owner', 'propertyowner', 'manager', 'superadmin'), roomController.bulkClearTenants);


// DELIBERATELY PUBLIC — these two feed the public property pages. The website
// renders room inventory for anonymous visitors (PropertyDetailsPage,
// PropertyRoomsPage), and on a website route getScopedAuthToken() reads only
// website_token, which an anonymous visitor does not have. Adding protect here
// would blank out the main SEO property pages. If these ever need to stop
// exposing a field, fix the projection, not the authentication.
router.get('/property/:propertyId', roomController.getRoomsByProperty);
router.get('/owner/:ownerLoginId', roomController.getRoomsByOwner);

// Add electricity reading to a room.
// Was unauthenticated — anyone could write a meter reading onto any room,
// which is what the tenant's electricity bill is computed from. The owner
// panel is the only caller and sends a token.
router.post('/:roomId/readings', protect, authorize('owner', 'superadmin'), roomController.addElectricityReading);

// Get electricity readings for a room. Was unauthenticated.
router.get('/:roomId/readings', protect, authorize('owner', 'tenant', 'superadmin'), roomController.getElectricityReadings);

// Get all rooms (Super Admin / Employee / Manager)
router.get('/all', protect, authorize('superadmin', 'employee', 'manager'), applyEmployeeScope, roomController.getAllRooms);

// Toggle promoted status. Was unauthenticated — anyone could promote or
// demote any room in the public search results. Caller is the owner panel's
// vacancy-promotion page, which sends a token.
router.put('/:roomId/toggle-promoted', protect, authorize('owner', 'superadmin'), roomController.togglePromoted);

// Update a room
router.put('/:roomId', protect, authorize('owner', 'propertyowner', 'manager', 'superadmin'), roomController.updateRoom);

// Approve/reject/assign room pending changes
router.put('/:roomId/approve-changes', protect, authorize('superadmin', 'employee', 'manager'), roomController.approveRoomChanges);
router.put('/:roomId/reject-changes', protect, authorize('superadmin', 'employee', 'manager'), roomController.rejectRoomChanges);
router.put('/:roomId/assign-verification', protect, authorize('superadmin'), roomController.assignRoomVerification);

module.exports = router;