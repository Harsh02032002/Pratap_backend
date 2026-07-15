const express = require('express');
const router = express.Router();
const rentController = require('../controllers/rentController');
// new added 
const rentCollectionController = require('../controllers/rentCollectionController');
const { protect, authorize } = require('../middleware/authMiddleware');

// Secure all endpoints with authentication
router.use(protect);

// Staff-only endpoints
router.post('/test-tenant-email', authorize('superadmin'), rentController.testTenantEmail);
router.post('/', authorize('superadmin', 'areamanager', 'employee'), rentController.createRent);
router.get('/', authorize('superadmin', 'areamanager', 'employee'), rentController.getAllRents);
router.post('/reminders/send', authorize('superadmin', 'areamanager', 'employee'), rentController.sendRentReminder);
router.post('/reminders/delayed', authorize('superadmin', 'areamanager', 'employee'), rentController.sendDelayedPaymentReminder);
router.post('/reminders/start-unpaid', authorize('superadmin', 'areamanager', 'employee'), rentController.startManualUnpaidReminders);
router.post('/platform/payout', authorize('superadmin'), rentController.processOwnerPayout);
router.get('/platform/summary', authorize('superadmin'), rentController.getPlatformPayoutSummary);
router.patch('/:rentId', authorize('superadmin', 'areamanager', 'employee'), rentController.updateRent);
router.delete('/:rentId', authorize('superadmin'), rentController.deleteRent);

// Owner-only or staff endpoints
router.get('/owner/:ownerLoginId', authorize('superadmin', 'areamanager', 'employee', 'owner'), rentController.getRentsByOwner);
router.get('/cash/requests', authorize('superadmin', 'areamanager', 'employee', 'owner'), rentController.listCashRequests);
router.post('/cash/:requestId/approve', authorize('superadmin', 'areamanager', 'employee', 'owner'), rentController.approveCashRequest);
router.post('/cash/:requestId/reject', authorize('superadmin', 'areamanager', 'employee', 'owner'), rentController.rejectCashRequest);
router.post('/cash/owner-received', authorize('superadmin', 'areamanager', 'employee', 'owner'), rentController.approveCashRequest);
router.post('/cash/verify-otp', authorize('superadmin', 'areamanager', 'employee', 'tenant', 'owner'), rentController.verifyCashPaymentOtp);

// Tenant, Owner, or Staff endpoints
// router.get('/tenant/me', authorize('tenant'), rentController.getTenantInvoiceSummary);
router.get('/tenant/me', authorize('tenant'), rentCollectionController.getTenantInvoiceSummary);
router.get('/tenant/:tenantLoginId', authorize('superadmin', 'areamanager', 'employee', 'tenant', 'owner'), rentController.getRentsByTenant);
router.post('/create-order', authorize('superadmin', 'areamanager', 'employee', 'tenant'), rentController.createRazorpayOrder);
router.post('/record-payment', authorize('superadmin', 'areamanager', 'employee', 'tenant', 'owner'), rentController.recordPaymentByTenant);
router.post('/record-payment-by-tenant', authorize('superadmin', 'areamanager', 'employee', 'tenant'), rentController.recordPaymentByTenant);
router.post('/verify-payment', authorize('superadmin', 'areamanager', 'employee', 'tenant'), rentController.verifyRazorpayPayment);
router.post('/cash/request', authorize('superadmin', 'areamanager', 'employee', 'tenant'), rentController.requestCashPayment);

// Parameterized routes (placed at the end to avoid matching conflicts)
router.get('/:rentId', authorize('superadmin', 'areamanager', 'employee', 'tenant', 'owner'), rentController.getRent);
router.post('/:rentId/payment', authorize('superadmin', 'areamanager', 'employee', 'tenant', 'owner'), rentController.recordPayment);

module.exports = router;
