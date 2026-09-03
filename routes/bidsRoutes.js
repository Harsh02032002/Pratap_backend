const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const { protect } = require('../middleware/authMiddleware');
const { applyEmployeeScope } = require('../middleware/employeeScope');

// Unified Bidding Endpoints - Create bid in DB & notify owner + superadmin
router.post('/create', bookingController.createBookingRequest);
router.post('/fast-bid', bookingController.createBookingRequest);
router.post('/', bookingController.createBookingRequest);

// Get bidding requests
router.get('/', protect, applyEmployeeScope, bookingController.getBookingRequests);
router.get('/requests', protect, applyEmployeeScope, bookingController.getBookingRequests);

module.exports = router;
