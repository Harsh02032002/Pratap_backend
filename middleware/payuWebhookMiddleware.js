'use strict';

/**
 * payuWebhookMiddleware.js
 * ──────────────────────────
 * Middleware to verify incoming PayU Webhook / IPN signature server-side.
 */

const payuService = require('../services/payuPaymentService');

function verifyPayUWebhook(type = 'payment') {
  return (req, res, next) => {
    try {
      const payload = req.body || {};

      // If signature / hash verification fails in production, block request
      if (process.env.NODE_ENV === 'production') {
        const isValid = payuService.verifyResponseHash(payload);
        if (!isValid) {
          console.error('[PayUWebhook] ❌ Webhook verification failed: Invalid Hash Signature');
          return res.status(400).json({ success: false, message: 'Invalid webhook signature' });
        }
      }

      next();
    } catch (err) {
      console.error('[PayUWebhook] ❌ Webhook verification error:', err.message);
      return res.status(500).json({ success: false, message: 'Webhook security verification failed' });
    }
  };
}

module.exports = {
  verifyPayUWebhook
};
