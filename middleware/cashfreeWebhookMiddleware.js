const crypto = require('crypto');

/**
 * Express middleware for verifying Cashfree Webhook Signatures
 *
 * @param {'payment' | 'payout'} webhookType - Type of webhook to verify
 */
function verifyCashfreeWebhook(webhookType = 'payment') {
  return (req, res, next) => {
    const isProd = process.env.NODE_ENV === 'production';
    const secret = webhookType === 'payout'
      ? process.env.CASHFREE_PAYOUT_WEBHOOK_SECRET
      : process.env.CASHFREE_WEBHOOK_SECRET;

    // Skip signature check in test environment if secret is empty
    if (!secret && !isProd) {
      console.warn(`[Cashfree Webhook] Skipping signature verification in non-production mode for ${webhookType}.`);
      return next();
    }

    if (!secret && isProd) {
      console.error(`[Cashfree Webhook Error] CASHFREE_${webhookType.toUpperCase()}_WEBHOOK_SECRET is missing in production.`);
      return res.status(500).json({ success: false, message: 'Server webhook secret misconfiguration.' });
    }

    const signature = req.headers['x-webhook-signature'] || req.headers['x-cashfree-signature'];
    const timestamp = req.headers['x-webhook-timestamp'] || req.headers['x-cashfree-timestamp'] || '';

    if (!signature) {
      if (!isProd) {
        console.warn(`[Cashfree Webhook] Header signature missing, proceeding in test mode.`);
        return next();
      }
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
          if (isProd) {
            return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
          }
        }
      }

      next();
    } catch (err) {
      console.error('[Cashfree Webhook Exception]', err.message);
      if (isProd) {
        return res.status(500).json({ success: false, message: 'Signature verification failed' });
      }
      next();
    }
  };
}

module.exports = {
  verifyCashfreeWebhook
};
