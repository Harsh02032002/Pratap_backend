const express = require('express');
const router = express.Router();
const electricityController = require('../controllers/electricityController');
const { protect } = require('../middleware/authMiddleware');

// Update reading for a specific tenant and month
router.post('/update-reading', protect, electricityController.updateMeterReading);

// Bulk update readings (Warden one-shot entry for all rooms)
router.post('/bulk-update', protect, electricityController.bulkUpdateReadings);

// Get meter history for a tenant
router.get('/history/:tenantId', protect, electricityController.getMeterHistory);

// Get readings for an owner's tenants
router.get('/owner/:ownerLoginId', protect, electricityController.getOwnerReadings);

// Delete a meter reading
router.delete('/:id', protect, electricityController.deleteMeterReading);

module.exports = router;
