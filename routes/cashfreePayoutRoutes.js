'use strict';

/**
 * cashfreePayoutRoutes.js
 * ─────────────────────────
 * Mounted at: /api/payouts/cashfree
 */

const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/cashfreePayoutController');
const webhookCtrl = require('../controllers/cashfreePayoutWebhookController');
const { verifyCashfreeWebhook } = require('../middleware/cashfreeWebhookMiddleware');

// ── Cashfree Payout Webhook Endpoint ───────────────────────────────────────
// Endpoint: POST /api/payouts/cashfree/webhook
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
  verifyCashfreeWebhook('payout'),
  webhookCtrl.handlePayoutWebhook
);

// ── Authenticated Payout routes ───────────────────────────────────────────

// Withdraw available balance to bank
router.post('/withdraw', ctrl.initiatePayout);

// Register bank beneficiary
router.post('/beneficiary', ctrl.addBeneficiary);

// Transfer status
router.get('/status/:transferId', ctrl.getPayoutStatus);

module.exports = router;
