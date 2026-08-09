'use strict';

/**
 * cashfreePaymentService.js
 * ─────────────────────────
 * Cashfree Payment Gateway (PG) integration.
 * Uses Cashfree REST API v2025-01-01 directly via axios (no SDK).
 *
 * SAFETY GUARANTEES:
 * 1. Never throws to caller — always returns { success, ... }
 * 2. Never modifies DB directly — that's the controller's job
 * 3. All secrets from env vars only
 *
 * Required ENV:
 *   CASHFREE_ENV          = TEST | PROD
 *   CASHFREE_APP_ID       = Payment Gateway Client ID
 *   CASHFREE_SECRET_KEY   = Payment Gateway Client Secret
 *   CASHFREE_WEBHOOK_SECRET = Webhook signature secret
 */

const axios = require('axios');
const crypto = require('crypto');

// ─── CONFIG ────────────────────────────────────────────────────────────────────

function getConfig() {
  const env = (process.env.CASHFREE_ENV || 'TEST').toUpperCase();
  const isSandbox = env !== 'PROD';
  return {
    isSandbox,
    appId:         process.env.CASHFREE_APP_ID || process.env.CASHFREE_CLIENT_ID || process.env.CF_APP_ID || '',
    secretKey:     process.env.CASHFREE_SECRET_KEY || process.env.CASHFREE_SECRET || process.env.CF_SECRET_KEY || '',
    webhookSecret: process.env.CASHFREE_WEBHOOK_SECRET || '',
    apiVersion:    '2025-01-01',
    baseUrl: isSandbox
      ? 'https://sandbox.cashfree.com/pg'
      : 'https://api.cashfree.com/pg',
  };
}

function getHeaders(config) {
  return {
    'x-client-id':     config.appId,
    'x-client-secret': config.secretKey,
    'x-api-version':   config.apiVersion,
    'Content-Type':    'application/json',
    'Accept':          'application/json',
  };
}

function sanitizeCustomerId(rawId) {
  if (!rawId) return `cust_${Date.now()}`;
  const sanitized = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  return sanitized || `cust_${Date.now()}`;
}

// ─── CREATE ORDER ──────────────────────────────────────────────────────────────

/**
 * createOrder(params)
 * Creates a Cashfree payment order.
 *
 * @param {Object} params
 * @param {string} params.orderId       - Unique order ID (e.g., booking_id + timestamp)
 * @param {number} params.amount        - Amount in INR (not paise)
 * @param {string} params.currency      - 'INR'
 * @param {Object} params.customerInfo  - { id, name, email, phone }
 * @param {Object} params.meta          - Any extra metadata
 * @returns {{ success, cf_order_id, order_token, payment_session_id, error }}
 */
async function createOrder({ orderId, amount, currency = 'INR', customerInfo = {}, meta = {} }) {
  const config = getConfig();

  if (!config.appId || !config.secretKey) {
    return { success: false, error: 'Cashfree credentials not configured (CASHFREE_APP_ID / CASHFREE_SECRET_KEY)' };
  }

  try {
    const payload = {
      order_id:       orderId,
      order_amount:   parseFloat(amount.toFixed(2)),
      order_currency: currency,
      customer_details: {
        customer_id:    sanitizeCustomerId(customerInfo.id),
        customer_name:  customerInfo.name || 'Tenant',
        customer_email: customerInfo.email || 'tenant@roomhy.com',
        customer_phone: customerInfo.phone || '9999999999',
      },
      order_meta: {
        return_url:  meta.return_url || `https://roomhy.com/payment-status?order_id={order_id}`,
        notify_url:  meta.notify_url || `${process.env.API_URL || 'https://api.roomhy.com'}/api/payments/cashfree/webhook`,
      },
      order_note: meta.note || 'Roomhy Booking Payment',
    };

    const { data } = await axios.post(`${config.baseUrl}/orders`, payload, {
      headers: getHeaders(config),
      timeout: 15000,
    });

    console.log(`[CashfreePayment] ✅ Order created: ${data.cf_order_id} | ₹${amount}`);

    return {
      success:            true,
      cf_order_id:        data.cf_order_id,
      order_id:           data.order_id,
      order_token:        data.order_token,       // Legacy field
      payment_session_id: data.payment_session_id, // v2025 field for JS SDK
      order_status:       data.order_status,
      isSandbox:          config.isSandbox,
    };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message || 'Unknown error';
    console.error('[CashfreePayment] ❌ createOrder failed:', errMsg);
    return { success: false, error: errMsg, details: err.response?.data };
  }
}

// ─── CREATE PAYMENT LINK ───────────────────────────────────────────────────────

/**
 * createPaymentLink(params)
 * Creates a Cashfree payment link (sharable URL, no SDK needed).
 *
 * @param {Object} params
 * @param {string} params.linkId        - Unique link ID
 * @param {number} params.amount        - Amount in INR
 * @param {string} params.description   - What the payment is for
 * @param {Object} params.customerInfo  - { name, email, phone }
 * @param {Date}   params.expiryDate    - Link expiry (default: 3 days)
 * @returns {{ success, link_id, link_url, link_expiry_time, error }}
 */
async function createPaymentLink({ linkId, amount, description = 'Roomhy Booking', customerInfo = {}, expiryDate }) {
  const config = getConfig();

  if (!config.appId || !config.secretKey) {
    return { success: false, error: 'Cashfree credentials not configured' };
  }

  try {
    const expiry = expiryDate || new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days default
    const expiryStr = expiry.toISOString(); // Valid ISO8601 string (e.g. 2026-08-13T01:04:40.000Z)

    const payload = {
      link_id:          linkId,
      link_amount:      parseFloat(amount.toFixed(2)),
      link_currency:    'INR',
      link_purpose:     description,
      link_partial_payments: false,
      customer_details: {
        customer_name:  customerInfo.name || 'Tenant',
        customer_email: customerInfo.email || 'tenant@roomhy.com',
        customer_phone: customerInfo.phone || '9999999999',
      },
      link_expiry_time: expiryStr,
      link_notify: {
        send_sms:   true,
        send_email: true,
      },
      link_meta: {
        return_url: `${process.env.FRONTEND_URL || 'https://roomhy.com'}/payment-status?link_id=${linkId}`,
        upi_intent: false,
      },
    };

    const { data } = await axios.post(`${config.baseUrl}/links`, payload, {
      headers: getHeaders(config),
      timeout: 15000,
    });

    console.log(`[CashfreePayment] ✅ Payment link created: ${data.link_id} | URL: ${data.link_url}`);

    return {
      success:          true,
      link_id:          data.link_id,
      link_url:         data.link_url,
      link_status:      data.link_status,
      link_expiry_time: data.link_expiry_time,
      isSandbox:        config.isSandbox,
    };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message || 'Unknown error';
    console.error('[CashfreePayment] ❌ createPaymentLink failed:', errMsg);
    return { success: false, error: errMsg, details: err.response?.data };
  }
}

// ─── GET LINK STATUS ───────────────────────────────────────────────────────────

/**
 * getLinkStatus(linkId)
 * Fetches live payment link status from Cashfree.
 * @returns {{ success, status, link, error }}
 */
async function getLinkStatus(linkId) {
  const config = getConfig();

  if (!config.appId || !config.secretKey) {
    return { success: false, error: 'Cashfree credentials not configured' };
  }

  try {
    const { data } = await axios.get(`${config.baseUrl}/links/${linkId}`, {
      headers: getHeaders(config),
      timeout: 10000,
    });

    return {
      success: true,
      link:    data,
      status:  data.link_status, // 'PAID' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED'
    };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    return { success: false, error: errMsg };
  }
}

// ─── GET ORDER STATUS ──────────────────────────────────────────────────────────

/**
 * getOrderStatus(cfOrderId)
 * Fetches live order status from Cashfree.
 * @returns {{ success, status, payments, order, error }}
 */
async function getOrderStatus(cfOrderId) {
  const config = getConfig();

  if (!config.appId || !config.secretKey) {
    return { success: false, error: 'Cashfree credentials not configured' };
  }

  try {
    const { data } = await axios.get(`${config.baseUrl}/orders/${cfOrderId}`, {
      headers: getHeaders(config),
      timeout: 10000,
    });

    return {
      success: true,
      order:   data,
      status:  data.order_status,  // 'ACTIVE' | 'PAID' | 'EXPIRED' | 'CANCELLED'
    };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    return { success: false, error: errMsg };
  }
}

// ─── GET PAYMENT DETAILS ───────────────────────────────────────────────────────

/**
 * getPaymentsByOrderId(cfOrderId)
 * Returns all payments for an order (there can be multiple attempts).
 */
async function getPaymentsByOrderId(cfOrderId) {
  const config = getConfig();
  try {
    const { data } = await axios.get(`${config.baseUrl}/orders/${cfOrderId}/payments`, {
      headers: getHeaders(config),
      timeout: 10000,
    });
    // Find the successful payment
    const payments = Array.isArray(data) ? data : [data];
    const success = payments.find(p => p.payment_status === 'SUCCESS');
    return { success: true, payments, successfulPayment: success };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
}

// ─── INITIATE REFUND ──────────────────────────────────────────────────────────

/**
 * initiateRefund(params)
 * @param {string} params.cfOrderId   - Cashfree order ID
 * @param {string} params.refundId    - Unique refund ID (idempotency key)
 * @param {number} params.amount      - Refund amount in INR
 * @param {string} params.reason      - Refund reason
 * @returns {{ success, refund_id, refund_status, error }}
 */
async function initiateRefund({ cfOrderId, refundId, amount, reason = 'Refund' }) {
  const config = getConfig();

  if (!config.appId || !config.secretKey) {
    return { success: false, error: 'Cashfree credentials not configured' };
  }

  try {
    const payload = {
      refund_amount: parseFloat(amount.toFixed(2)),
      refund_id:     refundId,
      refund_note:   reason,
    };

    const { data } = await axios.post(
      `${config.baseUrl}/orders/${cfOrderId}/refunds`,
      payload,
      { headers: getHeaders(config), timeout: 15000 }
    );

    console.log(`[CashfreePayment] ✅ Refund initiated: ${data.refund_id} | ₹${amount} | Status: ${data.refund_status}`);

    return {
      success:       true,
      refund_id:     data.refund_id,
      refund_status: data.refund_status,
      refund_amount: data.refund_amount,
      data,
    };
  } catch (err) {
    const errMsg = err.response?.data?.message || err.message;
    console.error('[CashfreePayment] ❌ initiateRefund failed:', errMsg);
    return { success: false, error: errMsg, details: err.response?.data };
  }
}

// ─── VERIFY WEBHOOK SIGNATURE ──────────────────────────────────────────────────

/**
 * verifyWebhookSignature(rawBody, signature, timestamp)
 * Cashfree v2 webhook signature:
 *   HMAC-SHA256(timestamp + rawBody, CASHFREE_WEBHOOK_SECRET)
 *   Compare with header: x-webhook-signature
 *
 * @param {string} rawBody   - Raw request body as string
 * @param {string} signature - Value of x-webhook-signature header
 * @param {string} timestamp - Value of x-webhook-timestamp header
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signature, timestamp) {
  try {
    const secret = process.env.CASHFREE_WEBHOOK_SECRET || '';
    if (!secret) {
      console.warn('[CashfreePayment] ⚠️ CASHFREE_WEBHOOK_SECRET not set — skipping signature check');
      return true; // Allow in dev; set secret in prod
    }

    const signedPayload = timestamp + rawBody;
    const computedSig = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('base64');

    return computedSig === signature;
  } catch (err) {
    console.error('[CashfreePayment] ❌ Webhook signature verification error:', err.message);
    return false;
  }
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  createOrder,
  createPaymentLink,
  getLinkStatus,
  getOrderStatus,
  getPaymentsByOrderId,
  initiateRefund,
  verifyWebhookSignature,
  getConfig,
};
