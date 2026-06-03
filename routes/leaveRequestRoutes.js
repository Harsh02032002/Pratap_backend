const express = require('express');
const router = express.Router();
const leaveRequestController = require('../controllers/leaveRequestController');

router.get('/owner/:ownerLoginId', leaveRequestController.getOwnerLeaveRequests);
router.post('/', leaveRequestController.createLeaveRequest);
router.patch('/:id/status', leaveRequestController.updateLeaveRequestStatus);

module.exports = router;
