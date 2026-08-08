'use strict';

/**
 * cashfreePaymentRoutes.js
 * ─────────────────────────
 * All Cashfree Payment Gateway endpoints.
 * Mounted at: /api/payments/cashfree
 */

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/cashfreePaymentController');
const { authMiddleware, requireRole } = require('../middleware/authMiddleware');

// ── Raw body capture for webhook signature verification ─────────────────────
// Must be registered BEFORE the global JSON body parser hits this route.
// In server.js we mount this route with express.raw() applied selectively.
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    // Store raw body string for signature verification
    if (Buffer.isBuffer(req.body)) {
      req.rawBody = req.body.toString('utf8');
      try { req.body = JSON.parse(req.rawBody); } catch (_) {}
    }
    next();
  },
  ctrl.handleWebhook
);

// ── Authenticated payment routes ────────────────────────────────────────────

// Create a Cashfree order (returns payment_session_id for JS SDK)
// Auth: owner or superadmin
router.post(
  '/create-order',
  authMiddleware,
  ctrl.createOrder
);

// Create a shareable Cashfree payment link
// Auth: owner or superadmin
router.post(
  '/create-link',
  authMiddleware,
  ctrl.createPaymentLink
);

// Get payment status for an order
// Auth: any authenticated user
router.get(
  '/status/:orderId',
  authMiddleware,
  ctrl.getPaymentStatus
);

// Initiate a refund (superadmin only)
router.post(
  '/refund',
  authMiddleware,
  requireRole('superadmin'),
  ctrl.initiateRefund
);

// Payment history
// Auth: owner (sees own) | superadmin (sees all with ?owner_id=)
router.get(
  '/history',
  authMiddleware,
  ctrl.getPaymentHistory
);

module.exports = router;
