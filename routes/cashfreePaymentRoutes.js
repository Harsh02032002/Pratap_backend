'use strict';

/**
 * cashfreePaymentRoutes.js
 * ─────────────────────────
 * Mounted at: /api/payments/cashfree
 */

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/cashfreePaymentController');
const webhookCtrl = require('../controllers/cashfreePaymentWebhookController');
const { verifyCashfreeWebhook } = require('../middleware/cashfreeWebhookMiddleware');
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');

// ── Cashfree Payment Webhook Endpoint ──────────────────────────────────────
// Endpoint: POST /api/payments/cashfree/webhook
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body.toString('utf8');
      try { req.body = JSON.parse(req.rawBody); } catch (_) {}
    }
    next();
  },
  verifyCashfreeWebhook('payment'),
  webhookCtrl.handlePaymentWebhook
);

// ── Authenticated payment routes ────────────────────────────────────────────

// Create a Cashfree order (returns payment_session_id for JS SDK)
router.post('/create-order', ctrl.createOrder);

// Create a shareable Cashfree payment link
router.post('/create-link', ctrl.createPaymentLink);

// Get payment status for an order
router.get('/status/:orderId', ctrl.getPaymentStatus);

// Initiate a refund (superadmin only)
router.post('/refund', ctrl.initiateRefund);

// Payment history
router.get('/history', ctrl.getPaymentHistory);

module.exports = router;
