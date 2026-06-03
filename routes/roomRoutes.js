const express = require('express');
const router = express.Router();
const roomController = require('../controllers/roomController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Owners add rooms
router.post('/', protect, authorize('owner'), roomController.createRoom);

// Get rooms by property
router.get('/property/:propertyId', roomController.getRoomsByProperty);

// Add electricity reading to a room
router.post('/:roomId/readings', roomController.addElectricityReading);

// Get electricity readings for a room
router.get('/:roomId/readings', roomController.getElectricityReadings);

// Get all rooms for an owner
router.get('/owner/:ownerLoginId', roomController.getRoomsByOwner);

// Toggle promoted status
router.put('/:roomId/toggle-promoted', roomController.togglePromoted);

// Update a room
router.put('/:roomId', protect, authorize('owner', 'superadmin'), roomController.updateRoom);

// Delete a room
router.delete('/:roomId', protect, authorize('owner', 'superadmin'), roomController.deleteRoom);

module.exports = router;