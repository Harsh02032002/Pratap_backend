'use strict';

/**
 * payuPaymentRoutes.js
 * ────────────────────
 * Mounted at: /api/payments/payu AND /api/payments
 */

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/payuPaymentController');
const webhookCtrl = require('../controllers/payuPaymentWebhookController');
const { verifyPayUWebhook } = require('../middleware/payuWebhookMiddleware');

// PayU Webhook / Notification Callback
router.post('/webhook', verifyPayUWebhook('payment'), webhookCtrl.handlePaymentWebhook);

// PayU surl / furl response handler (Form POST redirect from PayU checkout)
router.post('/response', ctrl.handlePaymentResponse);
router.get('/response', ctrl.handlePaymentResponse);

// Create a PayU order / form parameters
router.post('/create-order', ctrl.createOrder);

// Create a shareable payment link / initiation
router.post('/create-link', ctrl.createPaymentLink);

// Get status for an order / txnid
router.get('/status/:orderId', ctrl.getPaymentStatus);

// Initiate refund (superadmin)
router.post('/refund', ctrl.initiateRefund);

// Payment history
router.get('/history', ctrl.getPaymentHistory);

// Verify rent payment
router.post('/verify-rent-payment', ctrl.verifyRentPayment);

module.exports = router;
