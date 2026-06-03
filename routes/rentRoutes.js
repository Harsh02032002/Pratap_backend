const express = require('express');
const router = express.Router();
const rentController = require('../controllers/rentController');

// Test email delivery route
router.post('/test-tenant-email', rentController.testTenantEmail);

// Create new rent record
router.post('/', rentController.createRent);

// Get all rents (superadmin view)
router.get('/', rentController.getAllRents);

// Get rents for specific owner
router.get('/owner/:ownerLoginId', rentController.getRentsByOwner);
router.get('/tenant/:tenantLoginId', rentController.getRentsByTenant);

// Send rent reminders (normal 10-15th period) - BEFORE parameterized routes
router.post('/reminders/send', rentController.sendRentReminder);

// Send delayed payment reminders (3x daily after 15th) - BEFORE parameterized routes
router.post('/reminders/delayed', rentController.sendDelayedPaymentReminder);
router.post('/reminders/start-unpaid', rentController.startManualUnpaidReminders);

// Create Razorpay order for rent payment - BEFORE parameterized routes
router.post('/create-order', rentController.createRazorpayOrder);

// Record payment by tenant (for Razorpay callback) - BEFORE parameterized routes
router.post('/record-payment', rentController.recordPaymentByTenant);
router.post('/record-payment-by-tenant', rentController.recordPaymentByTenant);
router.post('/verify-payment', rentController.verifyRazorpayPayment);
router.post('/cash/request', rentController.requestCashPayment);
router.post('/cash/owner-received', rentController.markCashReceivedByOwner);
router.post('/cash/verify-otp', rentController.verifyCashPaymentOtp);
router.post('/platform/payout', rentController.processOwnerPayout);
router.get('/platform/summary', rentController.getPlatformPayoutSummary);

// Get single rent
router.get('/:rentId', rentController.getRent);

// Record payment after Razorpay success
router.post('/:rentId/payment', rentController.recordPayment);

// Update rent details
router.patch('/:rentId', rentController.updateRent);

// Delete rent record
router.delete('/:rentId', rentController.deleteRent);

module.exports = router;
