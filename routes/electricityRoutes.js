const express = require('express');
const router = express.Router();
const electricityController = require('../controllers/electricityController');

// Update reading for a specific tenant and month
router.post('/update-reading', electricityController.updateMeterReading);

// Bulk update readings (Warden one-shot entry for all rooms)
router.post('/bulk-update', electricityController.bulkUpdateReadings);

// Get meter history for a tenant
router.get('/history/:tenantId', electricityController.getMeterHistory);

// Get readings for an owner's tenants
router.get('/owner/:ownerLoginId', electricityController.getOwnerReadings);

// Delete a meter reading
router.delete('/:id', electricityController.deleteMeterReading);

module.exports = router;
