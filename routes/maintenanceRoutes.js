const express = require('express');
const router = express.Router();
const maintenanceController = require('../controllers/maintenanceController');

router.get('/owner/:ownerLoginId', maintenanceController.getOwnerTasks);
router.post('/', maintenanceController.createTask);
router.put('/:id/status', maintenanceController.updateTaskStatus);
router.patch('/:id/assign', maintenanceController.assignStaff);
router.delete('/:id', maintenanceController.deleteTask);

module.exports = router;
