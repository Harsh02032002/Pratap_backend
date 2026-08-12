const express = require('express');
const router = express.Router();
const tenantKycRequestController = require('../controllers/tenantKycRequestController');

router.get('/', tenantKycRequestController.getRequests);
router.put('/:id/approve', tenantKycRequestController.approveRequest);
router.put('/:id/reject', tenantKycRequestController.rejectRequest);

module.exports = router;
