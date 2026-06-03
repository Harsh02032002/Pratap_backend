const express = require('express');
const router = express.Router();
const gateController = require('../controllers/gateController');

// Get all gates for an owner
router.get('/owner/:ownerLoginId', gateController.getGatesByOwner);

// Create a new gate
router.post('/', gateController.createGate);

// Toggle gate status
router.put('/:id/toggle', gateController.toggleGateStatus);

// Delete a gate
router.delete('/:id', gateController.deleteGate);

module.exports = router;
