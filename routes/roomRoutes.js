const express = require('express');
const router = express.Router();
const roomController = require('../controllers/roomController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');

// Owners add rooms
router.post('/', protect, authorize('owner', 'propertyowner', 'manager', 'superadmin'), roomController.createRoom);
router.post('/bulk', protect, authorize('owner', 'propertyowner', 'manager', 'superadmin'), roomController.bulkCreateRooms);

// Get rooms by property
router.get('/property/:propertyId', roomController.getRoomsByProperty);

// Add electricity reading to a room
router.post('/:roomId/readings', roomController.addElectricityReading);

// Get electricity readings for a room
router.get('/:roomId/readings', roomController.getElectricityReadings);

// Get all rooms for an owner
router.get('/owner/:ownerLoginId', roomController.getRoomsByOwner);

// Get all rooms (Super Admin / Employee / Manager)
router.get('/all', protect, authorize('superadmin', 'employee', 'manager'), applyEmployeeScope, roomController.getAllRooms);

// Toggle promoted status
router.put('/:roomId/toggle-promoted', roomController.togglePromoted);

// Update a room
router.put('/:roomId', protect, authorize('owner', 'propertyowner', 'manager', 'superadmin'), roomController.updateRoom);

// Approve/reject/assign room pending changes
router.put('/:roomId/approve-changes', protect, authorize('superadmin', 'employee', 'manager'), roomController.approveRoomChanges);
router.put('/:roomId/reject-changes', protect, authorize('superadmin', 'employee', 'manager'), roomController.rejectRoomChanges);
router.put('/:roomId/assign-verification', protect, authorize('superadmin'), roomController.assignRoomVerification);

module.exports = router;