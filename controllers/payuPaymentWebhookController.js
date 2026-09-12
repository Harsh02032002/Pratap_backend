'use strict';

/**
 * payuPaymentWebhookController.js
 * ─────────────────────────────────
 * Handles PayU server-to-server webhook notifications.
 */

const PaymentTransaction = require('../models/PaymentTransaction');
const BookingRequest = require('../models/BookingRequest');
const RentInvoice = require('../models/RentInvoice');
const Rent = require('../models/Rent');

exports.handlePaymentWebhook = async (req, res) => {
  try {
    const payload = req.body || {};
    const txnid = String(payload.txnid || payload.order_id || '').trim();
    const status = String(payload.status || '').toLowerCase();
    const mihpayid = String(payload.mihpayid || payload.payuMoneyId || '').trim();

    console.log(`[PayUWebhook] ⚡ Processing Webhook Event for txnid: ${txnid} | Status: ${status}`);

    if (!txnid) {
      return res.status(200).json({ success: true, message: 'Ignored empty txnid' });
    }

    if (status === 'success') {
      let tx = await PaymentTransaction.findOne({
        $or: [{ cf_order_id: txnid }, { order_id: txnid }]
      });

      if (tx && tx.status !== 'PAID') {
        tx.status = 'PAID';
        tx.cf_payment_id = mihpayid || `PAYU_${Date.now()}`;
        tx.paidAt = new Date();
        await tx.save();

        if (tx.booking_id) {
          await BookingRequest.findByIdAndUpdate(tx.booking_id, {
            status: 'confirmed',
            payment_status: 'PAID'
          }).catch(() => null);

          await RentInvoice.findByIdAndUpdate(tx.booking_id, {
            status: 'PAID',
            paidAt: new Date()
          }).catch(() => null);

          await Rent.findByIdAndUpdate(tx.booking_id, {
            status: 'paid',
            paidAt: new Date()
          }).catch(() => null);
        }
      }
    }

    return res.status(200).json({ success: true, message: 'Webhook processed' });
  } catch (err) {
    console.error('❌ handlePaymentWebhook error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
