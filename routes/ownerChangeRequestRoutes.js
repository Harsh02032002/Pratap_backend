const express = require('express');
const router = express.Router();
const ownerChangeRequestController = require('../controllers/ownerChangeRequestController');

router.post('/submit', ownerChangeRequestController.submitRequest);
router.get('/', ownerChangeRequestController.getRequests);
router.put('/:id/approve', ownerChangeRequestController.approveRequest);
router.put('/:id/reject', ownerChangeRequestController.rejectRequest);

module.exports = router;
