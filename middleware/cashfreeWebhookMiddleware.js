const crypto = require('crypto');

/**
 * Express middleware for verifying Cashfree Webhook Signatures
 *
 * @param {'payment' | 'payout'} webhookType - Type of webhook to verify
 */
function verifyCashfreeWebhook(webhookType = 'payment') {
  return (req, res, next) => {
    const cfEnv = String(process.env.CASHFREE_ENV || process.env.CASHFREE_PAYOUT_ENV || 'TEST').toUpperCase();
    const isTestMode = cfEnv === 'SANDBOX' || cfEnv === 'TEST';

    const secret = webhookType === 'payout'
      ? process.env.CASHFREE_PAYOUT_WEBHOOK_SECRET
      : process.env.CASHFREE_WEBHOOK_SECRET;

    // Rule: If CASHFREE_ENV=TEST (or SANDBOX), skip verification even if secret is missing
    if (isTestMode) {
      console.log(`[Cashfree Webhook] Cashfree TEST mode: webhook signature verification skipped.`);
      return next();
    }

    // Rule: If CASHFREE_ENV=PROD, require secret & signature verification
    if (!secret) {
      console.error(`[Cashfree Webhook Error] CASHFREE_${webhookType.toUpperCase()}_WEBHOOK_SECRET is missing in Cashfree PROD mode.`);
      return res.status(500).json({ success: false, message: 'Server webhook secret misconfiguration in production mode.' });
    }

    const signature = req.headers['x-webhook-signature'] || req.headers['x-cashfree-signature'];
    const timestamp = req.headers['x-webhook-timestamp'] || req.headers['x-cashfree-timestamp'] || '';

    if (!signature) {
      return res.status(400).json({ success: false, message: 'Missing x-webhook-signature header.' });
    }

    try {
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
      const dataToSign = timestamp ? `${timestamp}${rawBody}` : rawBody;
      const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(dataToSign)
        .digest('base64');

      if (signature !== expectedSignature) {
        // Fallback check: rawBody only
        const fallbackSignature = crypto
          .createHmac('sha256', secret)
          .update(rawBody)
          .digest('base64');

        if (signature !== fallbackSignature) {
          console.error(`[Cashfree Webhook Error] Signature mismatch for ${webhookType}. Header: ${signature}, Expected: ${expectedSignature}`);
          return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
        }
      }

      next();
    } catch (err) {
      console.error('[Cashfree Webhook Exception]', err.message);
      return res.status(500).json({ success: false, message: 'Signature verification failed' });
    }
  };
}

module.exports = {
  verifyCashfreeWebhook
};
