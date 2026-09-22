'use strict';

/**
 * payuPaymentController.js
 * ─────────────────────────
 * Handles PayU Payment Gateway endpoints.
 *
 * Routes:
 *   POST /api/payments/payu/create-order
 *   POST /api/payments/payu/create-link
 *   POST /api/payments/payu/response         ← PayU surl / furl callback
 *   POST /api/payments/payu/verify-rent-payment
 *   GET  /api/payments/payu/status/:orderId
 *   GET  /api/payments/payu/history
 *   POST /api/payments/payu/refund
 */

const mongoose = require('mongoose');
const PaymentTransaction = require('../models/PaymentTransaction');
const BookingRequest = require('../models/BookingRequest');
const Owner = require('../models/Owner');
const Notification = require('../models/Notification');
const SystemSettings = require('../models/SystemSettings');
const payuService = require('../services/payuPaymentService');

// Resolve JWT token references if sent as bookingId
async function resolveBookingReference(bookingId) {
  const reference = String(bookingId || '').trim();
  if (!reference.includes('.')) return reference;

  const jwt = require('jsonwebtoken');
  let decoded;
  try {
    decoded = jwt.verify(reference, process.env.JWT_SECRET || 'secret');
  } catch (err) {
    const error = new Error('Invalid or expired onboarding payment link');
    error.statusCode = err.name === 'TokenExpiredError' ? 410 : 401;
    throw error;
  }

  if (decoded?.purpose !== 'onboarding_payment' || !mongoose.Types.ObjectId.isValid(decoded.rentRecordId)) {
    const error = new Error('Invalid onboarding payment link');
    error.statusCode = 401;
    throw error;
  }

  return String(decoded.rentRecordId);
}

async function getCommissionSettings() {
  try {
    const s = await SystemSettings.findOne().lean();
    return {
      commission: s?.commissionPercentage ?? s?.commission_percentage ?? 10,
      gst: s?.gstPercentage ?? s?.gst_percentage ?? 18,
      defaultBookingAmount: s?.defaultBookingAmount ?? 500
    };
  } catch {
    return { commission: 10, gst: 18, defaultBookingAmount: 500 };
  }
}

function calcBreakdown(amount, commissionPct, gstPct) {
  const commissionAmount = parseFloat(((amount * commissionPct) / 100).toFixed(2));
  const gstAmount = parseFloat(((commissionAmount * gstPct) / 100).toFixed(2));
  const ownerAmount = parseFloat((amount - commissionAmount - gstAmount).toFixed(2));
  return { commissionAmount, gstAmount, ownerAmount };
}

/**
 * Helper to notify owner on payment received
 */
async function notifyOwnerOnPayment(booking) {
  try {
    if (!booking?.owner_id) return;
    const owner = await Owner.findOne({ loginId: booking.owner_id }).lean();
    if (!owner) return;

    await Notification.create({
      recipientLoginId: owner.loginId,
      recipientRole: 'owner',
      title: 'Payment Received',
      message: `Payment of ₹${booking.amount || booking.total_amount || 0} received for property "${booking.property_name || 'Roomhy Stay'}".`,
      type: 'payment',
      read: false
    });
  } catch (err) {
    console.warn('[PayUController] Owner notification warning:', err.message);
  }
}

// ─── CREATE ORDER ──────────────────────────────────────────────────────────────
/**
 * POST /api/payments/payu/create-order
 * Body: { bookingId, amount, customerInfo: { name, email, phone } }
 */
exports.createOrder = async (req, res) => {
  try {
    const { bookingId: requestedBookingId, amount: requestedAmount, customerInfo = {} } = req.body;
    const rawId = (requestedBookingId && String(requestedBookingId).trim()) || `PAY_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const bookingId = rawId.includes('.') ? await resolveBookingReference(rawId) : rawId;
    const isValidObjectId = mongoose.Types.ObjectId.isValid(bookingId);

    let booking = null;
    let rentDoc = null;
    let rentInvoiceDoc = null;

    if (isValidObjectId) {
      booking = await BookingRequest.findById(bookingId).lean();
    }
    if (!booking) {
      booking = await BookingRequest.findOne({ booking_id: bookingId }).lean();
    }

    // ── Check RentInvoice model ────────────────────────────────────────────────
    if (!booking && isValidObjectId) {
      const RentInvoice = require('../models/RentInvoice');
      rentInvoiceDoc = await RentInvoice.findById(bookingId).lean();
      if (rentInvoiceDoc) {
        const Rent = require('../models/Rent');
        rentDoc = await Rent.findOne({
          tenantLoginId: rentInvoiceDoc.tenantLoginId || rentInvoiceDoc.tenantName,
          collectionMonth: rentInvoiceDoc.billingMonth
        }).catch(() => null);

        const ownerDoc = await Owner.findById(rentInvoiceDoc.ownerId).lean().catch(() => null);
        booking = {
          _id: rentInvoiceDoc._id,
          user_id: rentInvoiceDoc.tenantLoginId || String(rentInvoiceDoc.tenantId),
          name: rentInvoiceDoc.tenantName || 'Tenant',
          email: rentInvoiceDoc.tenantEmail || '',
          phone: rentInvoiceDoc.tenantPhone || '',
          owner_id: ownerDoc?.loginId || rentDoc?.ownerLoginId || 'OWNER',
          owner_name: ownerDoc?.name || ownerDoc?.profile?.name || rentDoc?.ownerName || '',
          property_id: String(rentInvoiceDoc.propertyId || 'N/A'),
          property_name: rentDoc?.propertyName || 'RoomHy Property',
          check_in_date: rentInvoiceDoc.createdAt,
          amount: rentInvoiceDoc.payableAmount || rentInvoiceDoc.totalAmount
        };
      }
    }

    // ── Check Rent model ────────────────────────────────────────────────────────
    if (!booking && isValidObjectId) {
      const Rent = require('../models/Rent');
      rentDoc = await Rent.findById(bookingId).lean();
      if (rentDoc) {
        booking = {
          _id: rentDoc._id,
          user_id: rentDoc.tenantLoginId || rentDoc.tenantName || 'Tenant',
          name: rentDoc.tenantName || 'Tenant',
          email: customerInfo.email || '',
          phone: customerInfo.phone || '',
          owner_id: rentDoc.ownerLoginId || 'OWNER',
          owner_name: rentDoc.ownerName || '',
          property_id: String(rentDoc.propertyId || 'N/A'),
          property_name: rentDoc.propertyName || 'RoomHy Property',
          check_in_date: rentDoc.createdAt,
          amount: rentDoc.dueAmount || rentDoc.rentAmount
        };
      }
    }

    const { commission, gst, defaultBookingAmount } = await getCommissionSettings();

    // Server-side Amount Validation: Prefer amount from DB, fallback to validated requested amount, or system default booking amount
    let payableAmount = 0;
    if (booking) {
      payableAmount = Number(booking.total_amount || booking.booking_amount || booking.amount || requestedAmount || 0);
    } else {
      payableAmount = Number(requestedAmount || 0);
    }

    if (payableAmount <= 0) {
      payableAmount = Number(defaultBookingAmount || 500);
    }

    // Generate unique transaction ID for PayU
    const txnid = `RMH_PAYU_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    const breakdown = calcBreakdown(payableAmount, commission, gst);

    const customerName = customerInfo.name || booking?.name || 'Guest';
    const customerEmail = customerInfo.email || booking?.email || 'guest@roomhy.com';
    const customerPhone = customerInfo.phone || booking?.phone || '9999999999';

    // Store PENDING transaction in DB
    const tx = new PaymentTransaction({
      cf_order_id: txnid, // maintain compatibility with existing fields
      order_id: txnid,
      booking_id: bookingId,
      user_id: booking?.user_id || customerEmail,
      user_name: customerName,
      user_email: customerEmail,
      user_phone: customerPhone,
      owner_id: booking?.owner_id || 'OWNER',
      owner_name: booking?.owner_name || '',
      property_id: booking?.property_id || 'N/A',
      property_name: booking?.property_name || 'Roomhy Stay',
      booking_amount: payableAmount,
      commission_percentage: commission,
      commission_amount: breakdown.commissionAmount,
      gst_percentage: gst,
      gst_amount: breakdown.gstAmount,
      owner_amount: breakdown.ownerAmount,
      status: 'PENDING',
      payment_gateway: 'payu',
      cf_order_token: null
    });
    await tx.save();

    // Prepare PayU parameters
    const payuOrder = payuService.preparePaymentOrder({
      txnid,
      amount: payableAmount,
      productinfo: `Booking Payment for ${tx.property_name}`,
      firstname: customerName,
      email: customerEmail,
      phone: customerPhone,
      udf1: String(bookingId),
      udf2: 'booking_rent_payment'
    });

    return res.json({
      success: true,
      actionUrl: payuOrder.actionUrl,
      params: payuOrder.params,
      txnid,
      order_id: txnid,
      amount: payableAmount,
      isSandbox: payuOrder.isSandbox
    });

  } catch (err) {
    console.error('❌ PayU createOrder error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Failed to initialize PayU payment' });
  }
};

// ─── CREATE LINK ───────────────────────────────────────────────────────────────
/**
 * POST /api/payments/payu/create-link
 */
exports.createPaymentLink = async (req, res) => {
  // PayU form submission is uniform; map create-link directly to createOrder
  return exports.createOrder(req, res);
};

// ─── PAYU CALLBACK / RESPONSE HANDLER ──────────────────────────────────────────
/**
 * POST /api/payments/payu/response
 * Endpoint for PayU surl / furl browser POST redirect
 */
exports.handlePaymentResponse = async (req, res) => {
  try {
    const payload = req.body || {};
    const txnid = String(payload.txnid || payload.order_id || req.query.txnid || '').trim();
    const status = String(payload.status || req.query.status || '').toLowerCase();
    const mihpayid = String(payload.mihpayid || payload.payuMoneyId || '').trim();
    const bankRefNum = String(payload.bank_ref_num || '').trim();
    const errorMsg = String(payload.error_Message || payload.field9 || '').trim();

    console.log(`[PayUCallback] 📥 Received callback for txnid: ${txnid} | Status: ${status} | MihPayID: ${mihpayid}`);

    const isSandbox = (process.env.PAYU_ENV || 'sandbox').toLowerCase() === 'sandbox';
    const frontendUrl = isSandbox 
      ? 'http://localhost:5173'
      : (process.env.FRONTEND_URL || process.env.CLIENT_URL || 'https://roomhy.com').replace(/\/+$/, '');

    if (!txnid) {
      return res.redirect(`${frontendUrl}/website/pay?status=failed&error=Missing+transaction+ID`);
    }

    // Server-Side Hash Verification (Only enforce strictly in production environment)
    const isHashValid = payuService.verifyResponseHash(payload);
    if (!isHashValid && !isSandbox && process.env.NODE_ENV === 'production') {
      console.error(`[PayUCallback] ❌ SHA-512 Hash Mismatch for txnid: ${txnid}`);
      return res.redirect(`${frontendUrl}/website/pay?order_id=${encodeURIComponent(txnid)}&status=failed&error=Invalid+payment+signature`);
    }

    // Verify directly with PayU API
    const remoteVerify = await payuService.verifyPaymentWithPayU(txnid);

    // Find transaction record in DB
    let tx = await PaymentTransaction.findOne({
      $or: [{ cf_order_id: txnid }, { order_id: txnid }, { _id: mongoose.Types.ObjectId.isValid(txnid) ? txnid : null }]
    });

    const isSuccess = (status === 'success' || remoteVerify.success) && status !== 'failure';

    if (isSuccess) {
      if (tx) {
        // Prevent duplicate processing
        if (tx.status === 'PAID') {
          console.log(`[PayUCallback] ℹ️ Transaction ${txnid} was already marked PAID.`);
        } else {
          tx.status = 'PAID';
          tx.cf_payment_id = mihpayid || remoteVerify.mihpayid || `PAYU_${Date.now()}`;
          tx.payout_reference = bankRefNum || remoteVerify.bank_ref_num || null;
          tx.paidAt = new Date();
          await tx.save();

          // Mark BookingRequest / Rent / RentInvoice as PAID
          if (tx.booking_id && mongoose.Types.ObjectId.isValid(tx.booking_id)) {
            const BookingRequest = require('../models/BookingRequest');
            await BookingRequest.findByIdAndUpdate(tx.booking_id, {
              status: 'confirmed',
              payment_status: 'PAID',
              cf_order_id: txnid,
              cf_payment_id: tx.cf_payment_id
            }).catch(() => null);

            const RentInvoice = require('../models/RentInvoice');
            await RentInvoice.findByIdAndUpdate(tx.booking_id, {
              status: 'PAID',
              paidAt: new Date(),
              paymentMethod: 'PayU',
              payuTxnid: txnid,
              payuPaymentId: tx.cf_payment_id
            }).catch(() => null);

            const Rent = require('../models/Rent');
            await Rent.findByIdAndUpdate(tx.booking_id, {
              status: 'paid',
              paidAt: new Date(),
              paymentMethod: 'payu',
              payuTxnid: txnid,
              payuPaymentId: tx.cf_payment_id
            }).catch(() => null);
          }

          notifyOwnerOnPayment(tx);
        }
      }

      const targetRedirect = `${frontendUrl}/website/payment-success?order_id=${encodeURIComponent(txnid)}&status=success&amount=${encodeURIComponent(tx?.booking_amount || tx?.amount || '')}`;
      return res.redirect(targetRedirect);
    } else {
      // Payment Failed or Cancelled
      if (tx && tx.status !== 'PAID') {
        tx.status = 'FAILED';
        tx.failure_reason = errorMsg || 'Payment cancelled or failed at PayU';
        await tx.save();
      }

      return res.redirect(`${frontendUrl}/website/pay?order_id=${encodeURIComponent(txnid)}&status=failed&error=${encodeURIComponent(errorMsg || 'Payment failed')}`);
    }

  } catch (err) {
    console.error('❌ handlePaymentResponse error:', err);
    const isSandbox = (process.env.PAYU_ENV || 'sandbox').toLowerCase() === 'sandbox';
    const frontendUrl = isSandbox ? 'http://localhost:5173' : (process.env.FRONTEND_URL || 'https://roomhy.com').replace(/\/+$/, '');
    return res.redirect(`${frontendUrl}/website/pay?status=failed&error=${encodeURIComponent(err.message)}`);
  }
};

// ─── VERIFY RENT PAYMENT ──────────────────────────────────────────────────────
/**
 * POST /api/payments/payu/verify-rent-payment
 * Body: { orderId / txnid, rentId, amount, tenantLoginId }
 */
exports.verifyRentPayment = async (req, res) => {
  try {
    const { orderId, rentId, tenantLoginId } = req.body;
    const txnid = String(orderId || rentId || '').trim();

    if (!txnid) {
      return res.status(400).json({ success: false, message: 'orderId/txnid is required' });
    }

    let tx = await PaymentTransaction.findOne({
      $or: [{ cf_order_id: txnid }, { order_id: txnid }, { _id: mongoose.Types.ObjectId.isValid(txnid) ? txnid : null }]
    });

    // Run server verification check with PayU
    const remoteVerify = await payuService.verifyPaymentWithPayU(txnid);

    if (tx?.status === 'PAID' || remoteVerify.success) {
      if (tx && tx.status !== 'PAID') {
        tx.status = 'PAID';
        tx.cf_payment_id = remoteVerify.mihpayid || `PAYU_${Date.now()}`;
        await tx.save();
      }

      return res.json({
        success: true,
        message: 'Payment verified successfully',
        status: 'PAID',
        transaction: tx
      });
    }

    return res.json({
      success: false,
      message: 'Payment pending or not verified',
      status: tx?.status || 'PENDING'
    });

  } catch (err) {
    console.error('❌ verifyRentPayment error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── GET PAYMENT STATUS ────────────────────────────────────────────────────────
/**
 * GET /api/payments/payu/status/:orderId
 */
exports.getPaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId parameter is required' });
    }

    let tx = await PaymentTransaction.findOne({
      $or: [{ cf_order_id: orderId }, { order_id: orderId }, { _id: mongoose.Types.ObjectId.isValid(orderId) ? orderId : null }]
    }).lean();

    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transaction record not found' });
    }

    return res.json({
      success: true,
      orderId,
      status: tx.status,
      transaction: tx
    });
  } catch (err) {
    console.error('❌ getPaymentStatus error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PAYMENT HISTORY ──────────────────────────────────────────────────────────
/**
 * GET /api/payments/payu/history
 */
exports.getPaymentHistory = async (req, res) => {
  try {
    const transactions = await PaymentTransaction.find()
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.json({ success: true, count: transactions.length, transactions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── REFUND ───────────────────────────────────────────────────────────────────
/**
 * POST /api/payments/payu/refund
 */
exports.initiateRefund = async (req, res) => {
  try {
    const { orderId, amount, reason } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });

    let tx = await PaymentTransaction.findOne({
      $or: [{ cf_order_id: orderId }, { order_id: orderId }]
    });

    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });

    tx.status = 'REFUNDED';
    tx.refund_reason = reason || 'Admin initiated refund';
    await tx.save();

    return res.json({ success: true, message: 'Refund marked successfully', transaction: tx });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
