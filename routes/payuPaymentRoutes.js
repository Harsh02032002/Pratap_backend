'use strict';

/**
 * payuPaymentRoutes.js
 * ────────────────────
 * Mounted at: /api/payments/payu AND /api/payments
 *
 * SECURITY NOTE — this router previously had NO auth middleware on 8 of its 9
 * routes, including POST /refund and GET /history. The three tiers below are
 * deliberate; the comments say why each route is where it is, because moving one
 * up a tier breaks a live payment flow and moving one down re-opens a hole.
 *
 * TIER 1 — externally called, must stay unauthenticated:
 *   /webhook   PayU server-to-server; authenticated by HMAC signature instead.
 *   /response  PayU redirects the customer's BROWSER here by form POST, so no
 *              Authorization header can exist.
 *
 * TIER 2 — reachable without a session BY NECESSITY, hardened in the handler:
 *   /create-order, /create-link, /status/:orderId, /verify-rent-payment
 *   The onboarding payment page (/payment/gateway?token=…) is opened from an
 *   EMAILED LINK and is authorized by a purpose-scoped 'onboarding_payment' JWT
 *   in the URL, not by a panel session; the public website checkout can likewise
 *   be an anonymous visitor. Requiring protect here would stop tenants' payments
 *   from being recorded after they have already paid. optionalProtect attaches
 *   an identity when one is present without rejecting callers that have none,
 *   and /verify-rent-payment's real authorization is its server-side
 *   verification against PayU, which a caller cannot forge.
 *
 * TIER 3 — privileged, now fully locked:
 *   /refund    requirePlatformAdmin, not authorize('superadmin') alone, because
 *              that helper also admits employee/staff/manager roles.
 *   /history   returns EVERY transaction on the platform; admin only.
 */

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/payuPaymentController');
const webhookCtrl = require('../controllers/payuPaymentWebhookController');
const { verifyPayUWebhook } = require('../middleware/payuWebhookMiddleware');
const { protect, optionalProtect, requirePlatformAdmin } = require('../middleware/authMiddleware');
const { formLimiter, refundLimiter } = require('../middleware/security');

// ── TIER 1 ──────────────────────────────────────────────────────────────────
// PayU Webhook / Notification Callback
router.post('/webhook', verifyPayUWebhook('payment'), webhookCtrl.handlePaymentWebhook);

// PayU surl / furl response handler (Form POST redirect from PayU checkout)
router.post('/response', ctrl.handlePaymentResponse);
router.get('/response', ctrl.handlePaymentResponse);

// ── TIER 2 ──────────────────────────────────────────────────────────────────
// Create a PayU order / form parameters
router.post('/create-order', optionalProtect, formLimiter, ctrl.createOrder);

// Create a shareable payment link / initiation
router.post('/create-link', optionalProtect, formLimiter, ctrl.createPaymentLink);

// Get status for an order / txnid
router.get('/status/:orderId', optionalProtect, ctrl.getPaymentStatus);

// Verify rent payment — authorization is the server-side PayU verification
router.post('/verify-rent-payment', optionalProtect, formLimiter, ctrl.verifyRentPayment);

// ── TIER 3 ──────────────────────────────────────────────────────────────────
// Initiate refund (platform admin only)
router.post('/refund', protect, requirePlatformAdmin, refundLimiter, ctrl.initiateRefund);

// Payment history (platform-wide; platform admin only)
router.get('/history', protect, requirePlatformAdmin, ctrl.getPaymentHistory);

module.exports = router;
