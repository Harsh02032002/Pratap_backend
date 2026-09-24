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

        const Tenant = require('../models/Tenant');
        const tenantController = require('./tenantController');

        const bookingIdStr = String(tx.booking_id || '');
        const isValidObjId = mongoose.Types.ObjectId.isValid(bookingIdStr);

        if (isValidObjId) {
          await BookingRequest.findByIdAndUpdate(tx.booking_id, { status: 'confirmed', payment_status: 'PAID' }).catch(() => null);
          await RentInvoice.findByIdAndUpdate(tx.booking_id, { status: 'PAID', paidAt: new Date(), paymentMethod: 'PayU' }).catch(() => null);
          await Rent.findByIdAndUpdate(tx.booking_id, { status: 'paid', paidAt: new Date(), paymentMethod: 'PayU' }).catch(() => null);
        }

        let tenant = null;
        if (tx.user_id) {
          tenant = await Tenant.findOne({ $or: [{ loginId: String(tx.user_id).toUpperCase() }, { loginId: tx.user_id }] }).catch(() => null);
        }
        if (!tenant && tx.user_email) {
          tenant = await Tenant.findOne({ email: tx.user_email }).catch(() => null);
        }

        if (tenant) {
          await Tenant.updateOne({ _id: tenant._id }, { $set: { paymentLinkStatus: 'paid', status: 'active', kycStatus: 'verified' } }).catch(() => null);
          await tenantController.finalizeOnboardingPayment(tenant.loginId, tx.booking_id).catch(() => null);
        }
      }
    }

    return res.status(200).json({ success: true, message: 'Webhook processed' });
  } catch (err) {
    console.error('❌ handlePaymentWebhook error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};
