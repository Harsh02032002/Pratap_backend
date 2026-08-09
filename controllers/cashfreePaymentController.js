'use strict';

/**
 * cashfreePaymentController.js
 * ─────────────────────────────
 * Handles all Cashfree Payment Gateway API endpoints.
 *
 * Routes:
 *   POST /api/payments/cashfree/create-order
 *   POST /api/payments/cashfree/create-link
 *   POST /api/payments/cashfree/webhook         ← raw body
 *   POST /api/payments/cashfree/refund
 *   GET  /api/payments/cashfree/status/:orderId
 *   GET  /api/payments/cashfree/history
 */

const mongoose           = require('mongoose');
const PaymentTransaction = require('../models/PaymentTransaction');
const BookingRequest     = require('../models/BookingRequest');
const Owner              = require('../models/Owner');
const Notification       = require('../models/Notification');
const SystemSettings     = require('../models/SystemSettings');
const cfPay = require('../services/cashfreePaymentService');

// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function getCommissionSettings() {
  try {
    const s = await SystemSettings.findOne().lean();
    return {
      commission: s?.commissionPercentage ?? 10,
      gst:        s?.gstPercentage ?? 18,
    };
  } catch {
    return { commission: 10, gst: 18 };
  }
}

function calcBreakdown(amount, commissionPct, gstPct) {
  const commissionAmount = parseFloat(((amount * commissionPct) / 100).toFixed(2));
  const gstAmount        = parseFloat(((commissionAmount * gstPct) / 100).toFixed(2));
  const ownerAmount      = parseFloat((amount - commissionAmount - gstAmount).toFixed(2));
  return { commissionAmount, gstAmount, ownerAmount };
}

// ─── CREATE ORDER ──────────────────────────────────────────────────────────────

/**
 * POST /api/payments/cashfree/create-order
 * Body: { bookingId, amount, customerInfo: { name, email, phone } }
 */
exports.createOrder = async (req, res) => {
  try {
    const { bookingId, amount, customerInfo = {} } = req.body;

    if (!bookingId || !amount) {
      return res.status(400).json({ success: false, message: 'bookingId and amount are required' });
    }

    let booking = null;
    const isValidObjectId = mongoose.Types.ObjectId.isValid(bookingId);
    
    if (isValidObjectId) {
      booking = await BookingRequest.findById(bookingId).lean();
    }
    if (!booking) {
      booking = await BookingRequest.findOne({ booking_id: bookingId }).lean();
    }
    if (!booking && isValidObjectId) {
      const Rent = require('../models/Rent');
      const rentDoc = await Rent.findById(bookingId).lean();
      if (rentDoc) {
        booking = {
          _id: rentDoc._id,
          user_id: rentDoc.tenantLoginId || rentDoc.tenantId || 'tenant_user',
          name: rentDoc.tenantName || 'Tenant',
          email: rentDoc.tenantEmail || '',
          phone: rentDoc.tenantPhone || '',
          owner_id: rentDoc.ownerLoginId || 'OWNER',
          owner_name: rentDoc.ownerName || '',
          property_id: rentDoc.propertyId || '',
          property_name: rentDoc.propertyName || 'RoomHy Property',
          check_in_date: rentDoc.createdAt
        };
      }
    }
    if (!booking && isValidObjectId) {
      const Tenant = require('../models/Tenant');
      const tenantDoc = await Tenant.findById(bookingId).lean();
      if (tenantDoc) {
        booking = {
          _id: tenantDoc._id,
          user_id: tenantDoc.loginId || 'tenant_user',
          name: tenantDoc.name || 'Tenant',
          email: tenantDoc.email || '',
          phone: tenantDoc.phone || '',
          owner_id: tenantDoc.ownerLoginId || 'OWNER',
          owner_name: tenantDoc.ownerName || '',
          property_id: tenantDoc.propertyId || '',
          property_name: tenantDoc.propertyTitle || 'RoomHy Property',
          check_in_date: tenantDoc.moveInDate
        };
      }
    }
    if (!booking) {
      // Fallback synthetic booking object if ID is not found in database
      booking = {
        _id: bookingId,
        user_id: customerInfo.email || customerInfo.name || 'guest_user',
        name: customerInfo.name || 'Guest',
        email: customerInfo.email || '',
        phone: customerInfo.phone || '',
        owner_id: 'OWNER',
        owner_name: 'Owner',
        property_id: 'PROP',
        property_name: 'RoomHy Property'
      };
    }

    const orderId = `RMH_${bookingId}_${Date.now()}`;

    const orderResult = await cfPay.createOrder({
      orderId,
      amount,
      customerInfo: {
        id:    booking.user_id,
        name:  customerInfo.name  || booking.name,
        email: customerInfo.email || booking.email,
        phone: customerInfo.phone || booking.phone,
      },
      meta: {
        note: `Booking #${bookingId}`,
        return_url: `https://roomhy.com/payment-status?order_id=${orderId}`
      },
    });

    if (!orderResult.success) {
      return res.status(502).json({ success: false, message: orderResult.error });
    }

    // Create pending PaymentTransaction
    const settings = await getCommissionSettings();
    const { commissionAmount, gstAmount, ownerAmount } = calcBreakdown(amount, settings.commission, settings.gst);

    await PaymentTransaction.create({
      cf_order_id:           orderResult.cf_order_id,
      cf_order_token:        orderResult.order_token,
      booking_id:            bookingId,
      property_id:           booking.property_id,
      property_name:         booking.property_name || '',
      tenant_id:             booking.user_id,
      tenant_name:           booking.name || '',
      owner_id:              booking.owner_id,
      owner_name:            booking.owner_name || '',
      move_in_date:          booking.check_in_date || booking.checkInDate || null,
      booking_amount:        amount,
      commission_percentage: settings.commission,
      commission_amount:     commissionAmount,
      gst_percentage:        settings.gst,
      gst_amount:            gstAmount,
      owner_amount:          ownerAmount,
      status:                'Created',
      wallet_status:         'pending',
      payment_method:        'cashfree',
    });

    return res.json({
      success:            true,
      cf_order_id:        orderResult.cf_order_id,
      order_id:           orderResult.order_id,
      payment_session_id: orderResult.payment_session_id,
      order_token:        orderResult.order_token,
      amount,
    });

  } catch (err) {
    console.error('[CashfreePaymentCtrl] createOrder error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── CREATE PAYMENT LINK ───────────────────────────────────────────────────────

/**
 * POST /api/payments/cashfree/create-link
 * Body: { bookingId, amount, customerInfo: { name, email, phone }, expiryHours }
 * Auth: owner or superadmin
 */
exports.createPaymentLink = async (req, res) => {
  try {
    const { bookingId, amount, customerInfo = {}, expiryHours = 72 } = req.body;
    const user = req.user;

    if (!bookingId || !amount) {
      return res.status(400).json({ success: false, message: 'bookingId and amount are required' });
    }

    const booking = await BookingRequest.findById(bookingId).lean();
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    // Authorization: only the booking's owner or superadmin can send link
    if (user && user.role === 'owner' &&
        String(booking.owner_id).toUpperCase() !== String(user.loginId || '').toUpperCase()) {
      return res.status(403).json({ success: false, message: 'You do not own this booking' });
    }

    const linkId = `RMHLINK_${bookingId}_${Date.now()}`;
    const expiry = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

    const linkResult = await cfPay.createPaymentLink({
      linkId,
      amount,
      description: `Booking Payment — ${booking.property_name || 'Roomhy'}`,
      customerInfo: {
        name:  customerInfo.name  || booking.name  || 'Tenant',
        email: customerInfo.email || booking.email || 'tenant@roomhy.com',
        phone: customerInfo.phone || booking.phone || '9999999999',
      },
      expiryDate: expiry,
    });

    if (!linkResult.success) {
      return res.status(502).json({ success: false, message: linkResult.error });
    }

    // Upsert PaymentTransaction with link info
    const settings = await getCommissionSettings();
    const { commissionAmount, gstAmount, ownerAmount } = calcBreakdown(amount, settings.commission, settings.gst);

    await PaymentTransaction.findOneAndUpdate(
      { booking_id: bookingId, wallet_status: 'pending' },
      {
        $set: {
          cf_payment_link_id: linkResult.link_id,
          cf_payment_link:    linkResult.link_url,
          booking_amount:     amount,
          commission_percentage: settings.commission,
          commission_amount:  commissionAmount,
          gst_percentage:     settings.gst,
          gst_amount:         gstAmount,
          owner_amount:       ownerAmount,
          property_id:        booking.property_id,
          property_name:      booking.property_name || '',
          tenant_id:          booking.user_id,
          tenant_name:        booking.name || '',
          owner_id:           booking.owner_id,
          owner_name:         booking.owner_name || '',
          move_in_date:       booking.check_in_date || booking.checkInDate || null,
          payment_method:     'cashfree',
        },
        $setOnInsert: {
          status:       'Created',
          wallet_status:'pending',
        }
      },
      { upsert: true, new: true }
    );

    // Update booking — link sent
    await BookingRequest.findByIdAndUpdate(bookingId, {
      $set: {
        payment_link_sent_at: new Date(),
        payment_id:           linkResult.link_id,
      }
    });

    // Notify superadmins
    try {
      const User = require('../models/user');
      const admins = await User.find({ role: 'superadmin' }).lean();
      await Promise.all(admins.map(a =>
        Notification.create({
          toRole:    'superadmin',
          toLoginId: a.loginId || '',
          from:      String(user?.loginId || booking.owner_id),
          type:      'payment_link_generated',
          title:     '💳 Payment Link Sent',
          message:   `Owner ${booking.owner_name || ''} sent a payment link of ₹${amount} for booking #${bookingId}`,
          meta:      { bookingId, amount, linkUrl: linkResult.link_url }
        })
      ));
    } catch (notifErr) {
      console.warn('[CashfreePaymentCtrl] Notification failed:', notifErr.message);
    }

    return res.json({
      success:  true,
      link_id:  linkResult.link_id,
      link_url: linkResult.link_url,
      link_expiry_time: linkResult.link_expiry_time,
      amount,
    });

  } catch (err) {
    console.error('[CashfreePaymentCtrl] createPaymentLink error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

/**
 * POST /api/payments/cashfree/webhook
 * Raw body must be captured before JSON parsing.
 * Cashfree sends: order_id, cf_payment_id, payment_status, order_amount, etc.
 */
exports.handleWebhook = async (req, res) => {
  try {
    const rawBody  = req.rawBody || JSON.stringify(req.body);
    const sig      = req.headers['x-webhook-signature'] || '';
    const ts       = req.headers['x-webhook-timestamp'] || '';

    // Verify signature
    const valid = cfPay.verifyWebhookSignature(rawBody, sig, ts);
    if (!valid) {
      console.warn('[CashfreePaymentCtrl] ❌ Invalid webhook signature');
      return res.status(401).json({ success: false, message: 'Invalid signature' });
    }

    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const eventType = event.type || '';
    const data = event.data || {};

    console.log(`[CashfreePaymentCtrl] Webhook: ${eventType}`);

    // ── PAYMENT SUCCESS ──────────────────────────────────────────────────────
    if (eventType === 'PAYMENT_SUCCESS_WEBHOOK') {
      const { order, payment } = data;
      const orderId    = order?.order_id;
      const cfOrderId  = order?.cf_order_id;
      const cfPaymentId = payment?.cf_payment_id;
      const paymentAmount = payment?.payment_amount || order?.order_amount || 0;
      const paymentMethod = payment?.payment_method || 'cashfree';

      if (!cfPaymentId) {
        return res.status(200).json({ success: true, message: 'No cf_payment_id — ignored' });
      }

      // Find or create PaymentTransaction
      let tx = await PaymentTransaction.findOne({
        $or: [
          { cf_order_id: cfOrderId },
          { cf_payment_link_id: orderId },
        ]
      });

      if (!tx) {
        console.warn(`[CashfreePaymentCtrl] No tx found for order ${cfOrderId || orderId}`);
        return res.status(200).json({ success: true, message: 'Transaction not found' });
      }

      // Already processed?
      if (tx.status === 'Verified') {
        return res.json({ success: true, message: 'Already processed' });
      }

      // Determine wallet status
      // Cash / Already Paid bookings skip wallet
      const isCashPayment = paymentMethod === 'cash' || paymentMethod === 'already_paid';
      const newWalletStatus = isCashPayment ? 'skipped' : 'held';

      // Update transaction
      tx.cf_payment_id   = String(cfPaymentId);
      tx.status          = 'Verified';
      tx.wallet_status   = newWalletStatus;
      tx.payment_date    = new Date();
      tx.raw_webhook     = event;
      if (newWalletStatus === 'held') tx.held_at = new Date();
      await tx.save();

      // Update booking status
      if (tx.booking_id) {
        await BookingRequest.findByIdAndUpdate(tx.booking_id, {
          $set: {
            payment_status:       'completed',
            payment_completed_at: new Date(),
            booking_confirmed_at: new Date(),
            booking_status:       'confirmed',
          }
        });
      }

      // Update Owner heldBalance (skip for cash payments)
      if (!isCashPayment && tx.owner_id) {
        await Owner.findOneAndUpdate(
          { loginId: tx.owner_id },
          { $inc: { heldBalance: tx.owner_amount, walletBalance: 0 } }
        );

        // Notify owner
        try {
          await Notification.create({
            toRole:    'owner',
            toLoginId: String(tx.owner_id),
            from:      'system',
            type:      'payment_received',
            title:     '💰 Payment Received',
            message:   `Tenant paid ₹${tx.booking_amount}. Your share ₹${tx.owner_amount} is held until move-in date.`,
            meta:      { bookingId: tx.booking_id, amount: tx.owner_amount }
          });
        } catch (notifErr) {
          console.warn('[CashfreePaymentCtrl] Owner notification failed:', notifErr.message);
        }
      }

      console.log(`[CashfreePaymentCtrl] ✅ Payment processed: ₹${paymentAmount} | Booking: ${tx.booking_id} | WalletStatus: ${newWalletStatus}`);
    }

    // ── PAYMENT FAILED ───────────────────────────────────────────────────────
    if (eventType === 'PAYMENT_FAILED_WEBHOOK') {
      const { order } = data;
      const cfOrderId = order?.cf_order_id;
      if (cfOrderId) {
        await PaymentTransaction.findOneAndUpdate(
          { cf_order_id: cfOrderId, status: 'Created' },
          { $set: { status: 'Failed', raw_webhook: event } }
        );
      }
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[CashfreePaymentCtrl] webhook error:', err);
    // Always return 200 to Cashfree to prevent retries on server errors
    return res.status(200).json({ success: false, message: err.message });
  }
};

// ─── GET PAYMENT STATUS ────────────────────────────────────────────────────────

/**
 * GET /api/payments/cashfree/status/:orderId
 * orderId = cf_order_id
 */
exports.getPaymentStatus = async (req, res) => {
  try {
    const { orderId } = req.params;

    const [tx, cfStatus] = await Promise.all([
      PaymentTransaction.findOne({ cf_order_id: orderId }).lean(),
      cfPay.getOrderStatus(orderId),
    ]);

    return res.json({
      success:    true,
      db_status:  tx?.status,
      cf_status:  cfStatus.status,
      wallet_status: tx?.wallet_status,
      transaction: tx,
      cashfree:   cfStatus.order,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── INITIATE REFUND ──────────────────────────────────────────────────────────

/**
 * POST /api/payments/cashfree/refund
 * Body: { transactionId, amount, reason }
 * Auth: superadmin
 */
exports.initiateRefund = async (req, res) => {
  try {
    const { transactionId, amount, reason = 'Refund request' } = req.body;

    if (!transactionId) {
      return res.status(400).json({ success: false, message: 'transactionId is required' });
    }

    const tx = await PaymentTransaction.findById(transactionId);
    if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });

    if (tx.status !== 'Verified') {
      return res.status(400).json({ success: false, message: 'Can only refund verified/paid transactions' });
    }

    const refundAmount = amount || tx.booking_amount;
    const refundId = `REFUND_${transactionId}_${Date.now()}`;

    const refundResult = await cfPay.initiateRefund({
      cfOrderId: tx.cf_order_id,
      refundId,
      amount: refundAmount,
      reason,
    });

    if (!refundResult.success) {
      return res.status(502).json({ success: false, message: refundResult.error });
    }

    // Update transaction
    tx.refund_id     = refundResult.refund_id;
    tx.refund_amount = refundAmount;
    tx.refund_status = refundResult.refund_status;
    tx.refund_date   = new Date();
    tx.status        = 'Refunded';
    tx.wallet_status = 'skipped';
    await tx.save();

    // Reverse owner held balance if applicable
    if (tx.owner_id) {
      await Owner.findOneAndUpdate(
        { loginId: tx.owner_id },
        { $inc: { heldBalance: -tx.owner_amount } }
      );
    }

    return res.json({
      success:       true,
      refund_id:     refundResult.refund_id,
      refund_status: refundResult.refund_status,
      refund_amount: refundAmount,
    });

  } catch (err) {
    console.error('[CashfreePaymentCtrl] initiateRefund error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─── PAYMENT HISTORY ──────────────────────────────────────────────────────────

/**
 * GET /api/payments/cashfree/history
 * Query: ?page=1&limit=20&owner_id=&wallet_status=&status=
 */
exports.getPaymentHistory = async (req, res) => {
  try {
    const { page = 1, limit = 20, owner_id, wallet_status, status } = req.query;
    const filter = {};

    if (owner_id)       filter.owner_id       = owner_id;
    if (wallet_status)  filter.wallet_status   = wallet_status;
    if (status)         filter.status          = status;

    // Owners can only see their own transactions
    const user = req.user;
    if (user && user.role === 'owner') {
      filter.owner_id = user.loginId;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [transactions, total] = await Promise.all([
      PaymentTransaction.find(filter)
        .sort({ created_at: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      PaymentTransaction.countDocuments(filter),
    ]);

    const summary = {
      totalAmount:     0,
      heldAmount:      0,
      availableAmount: 0,
      withdrawnAmount: 0,
    };

    transactions.forEach(tx => {
      summary.totalAmount += tx.booking_amount || 0;
      if (tx.wallet_status === 'held')      summary.heldAmount      += tx.owner_amount || 0;
      if (tx.wallet_status === 'available') summary.availableAmount  += tx.owner_amount || 0;
      if (tx.wallet_status === 'withdrawn') summary.withdrawnAmount  += tx.owner_amount || 0;
    });

    return res.json({
      success: true,
      transactions,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
      summary,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
