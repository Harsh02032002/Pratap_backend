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

// The public onboarding page historically sent its signed payment-link JWT in
// `bookingId`. Resolve it before it is used in a Cashfree order ID; JWTs are
// considerably longer than Cashfree's 130-character order_id limit.
async function resolveBookingReference(bookingId) {
  const reference = String(bookingId || '').trim();
  if (!reference.includes('.')) return reference;

  const jwt = require('jsonwebtoken');
  let decoded;
  try {
    decoded = jwt.verify(reference, process.env.JWT_SECRET);
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
 * bookingId may be a Rent._id, RentInvoice._id, or BookingRequest._id
 */
exports.createOrder = async (req, res) => {
  try {
    const { bookingId: requestedBookingId, amount, customerInfo = {} } = req.body;

    if (!requestedBookingId || !amount) {
      return res.status(400).json({ success: false, message: 'bookingId and amount are required' });
    }

    const bookingId = await resolveBookingReference(requestedBookingId);

    let booking = null;
    const isValidObjectId = mongoose.Types.ObjectId.isValid(bookingId);

    // Track the actual Rent / RentInvoice docs for cashfreeOrderId stamping
    let rentDoc = null;
    let rentInvoiceDoc = null;
    
    if (isValidObjectId) {
      booking = await BookingRequest.findById(bookingId).lean();
    }
    if (!booking) {
      booking = await BookingRequest.findOne({ booking_id: bookingId }).lean();
    }

    // ── Check RentInvoice first (preferred for rent payments) ──────────────────
    if (!booking && isValidObjectId) {
      const RentInvoice = require('../models/RentInvoice');
      rentInvoiceDoc = await RentInvoice.findById(bookingId).lean();
      if (rentInvoiceDoc) {
        // Try to find associated Rent doc for ownerLoginId
        const Rent = require('../models/Rent');
        rentDoc = await Rent.findOne({
          tenantLoginId: rentInvoiceDoc.tenantLoginId || rentInvoiceDoc.tenantName,
          collectionMonth: rentInvoiceDoc.billingMonth
        }).catch(() => null);

        // Resolve ownerLoginId from Owner model
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
        };
      }
    }

    // ── Check Rent model ────────────────────────────────────────────────────────
    if (!booking && isValidObjectId) {
      const Rent = require('../models/Rent');
      rentDoc = await Rent.findById(bookingId).lean();
      if (rentDoc) {
        // Try to find associated RentInvoice
        const RentInvoice = require('../models/RentInvoice');
        if (rentDoc.tenantLoginId && rentDoc.collectionMonth) {
          const Tenant = require('../models/Tenant');
          const tenantForInvoice = await Tenant.findOne({ loginId: rentDoc.tenantLoginId }).lean().catch(() => null);
          if (tenantForInvoice) {
            rentInvoiceDoc = await RentInvoice.findOne({
              tenantId: tenantForInvoice._id,
              billingMonth: rentDoc.collectionMonth
            }).catch(() => null);
          }
        }
        booking = {
          _id: rentDoc._id,
          user_id: rentDoc.tenantLoginId || rentDoc.tenantId || 'tenant_user',
          name: rentDoc.tenantName || 'Tenant',
          email: rentDoc.tenantEmail || '',
          phone: rentDoc.tenantPhone || '',
          owner_id: rentDoc.ownerLoginId || 'OWNER',
          owner_name: rentDoc.ownerName || '',
          property_id: String(rentDoc.propertyId || 'N/A'),
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
          property_id: String(tenantDoc.propertyId || 'N/A'),
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

    // Generate short order_id to stay within Cashfree's 130 character limit
    const timestamp = Date.now();
    const shortId = bookingId.slice(0, 20); // Use first 20 chars of bookingId
    const orderId = `RMH_${shortId}_${timestamp}`;

    // Build return URL — include rent context for post-payment verification
    const returnBaseUrl = process.env.FRONTEND_URL || 'https://app.roomhy.com';
    const returnUrl = `${returnBaseUrl}/tenant/tenantdashboard?order_id=${orderId}&rent_id=${bookingId}&amount=${amount}`;

    const orderResult = await cfPay.createOrder({
      orderId,
      amount,
      customerInfo: {
        id:    sanitizeId(booking.user_id),
        name:  customerInfo.name  || booking.name,
        email: customerInfo.email || booking.email,
        phone: customerInfo.phone || booking.phone,
      },
      meta: {
        note: `Rent Payment — ${booking.property_name}`,
        return_url: returnUrl,
      },
    });

    if (!orderResult.success) {
      return res.status(502).json({ success: false, message: orderResult.error });
    }

    // ── Stamp cashfreeOrderId on Rent & RentInvoice so webhook can find them ───
    try {
      const Rent = require('../models/Rent');
      const RentInvoice = require('../models/RentInvoice');
      if (rentDoc?._id) {
        await Rent.findByIdAndUpdate(rentDoc._id, {
          $set: { cashfreeOrderId: orderResult.cf_order_id }
        }).catch(() => {});
      }
      if (rentInvoiceDoc?._id) {
        await RentInvoice.findByIdAndUpdate(rentInvoiceDoc._id, {
          $set: { cashfreeOrderId: orderResult.cf_order_id }
        }).catch(() => {});
      }
      // If bookingId itself is a RentInvoice (common case), stamp it directly
      if (!rentInvoiceDoc && isValidObjectId) {
        await RentInvoice.findByIdAndUpdate(bookingId, {
          $set: { cashfreeOrderId: orderResult.cf_order_id }
        }).catch(() => {});
        // Also stamp the corresponding Rent doc
        await Rent.findByIdAndUpdate(bookingId, {
          $set: { cashfreeOrderId: orderResult.cf_order_id }
        }).catch(() => {});
      }
    } catch (stampErr) {
      console.warn('[CashfreePaymentCtrl] cashfreeOrderId stamp warning:', stampErr.message);
    }

    // Create pending PaymentTransaction
    const settings = await getCommissionSettings();
    const { commissionAmount, gstAmount, ownerAmount } = calcBreakdown(amount, settings.commission, settings.gst);

    await PaymentTransaction.create({
      cf_order_id:           orderResult.cf_order_id,
      cf_order_token:        orderResult.order_token,
      booking_id:            bookingId || 'N/A',
      rent_id:               rentDoc?._id ? String(rentDoc._id) : (isValidObjectId ? bookingId : null),
      invoice_id:            rentInvoiceDoc?._id ? String(rentInvoiceDoc._id) : null,
      property_id:           (booking.property_id || booking.propertyId || 'N/A').toString().trim() || 'N/A',
      property_name:         booking.property_name || booking.propertyName || booking.propertyTitle || '',
      tenant_id:             booking.user_id || booking.tenantId || 'tenant_user',
      tenant_name:           booking.name || booking.tenantName || '',
      owner_id:              booking.owner_id || booking.ownerId || 'OWNER',
      owner_login_id:        booking.owner_id || booking.ownerId || 'OWNER',
      owner_name:            booking.owner_name || booking.ownerName || '',
      move_in_date:          booking.check_in_date || booking.checkInDate || null,
      booking_amount:        amount,
      commission_percentage: settings.commission,
      commission_amount:     commissionAmount,
      gst_percentage:        settings.gst,
      gst_amount:            gstAmount,
      owner_amount:          ownerAmount,
      status:                'Created',
      payout_status:         'Pending',
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
      return_url:         returnUrl,
      isSandbox:          orderResult.isSandbox,
    });

  } catch (err) {
    console.error('[CashfreePaymentCtrl] createOrder error:', err);
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

// Helper — sanitise customer_id for Cashfree (only alphanum, _ -)
function sanitizeId(rawId) {
  if (!rawId) return `cust_${Date.now()}`;
  return String(rawId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50) || `cust_${Date.now()}`;
}



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
          property_id:        (booking.property_id || booking.propertyId || 'N/A').toString().trim() || 'N/A',
          property_name:      booking.property_name || booking.propertyName || booking.propertyTitle || '',
          tenant_id:          booking.user_id || booking.tenantId || 'tenant_user',
          tenant_name:        booking.name || booking.tenantName || '',
          owner_id:           booking.owner_id || booking.ownerId || 'OWNER',
          owner_name:         booking.owner_name || booking.ownerName || '',
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

      // Update Owner wallet balance directly (no hold)
      if (!isCashPayment && tx.owner_id) {
        await Owner.findOneAndUpdate(
          { loginId: tx.owner_id },
          { $inc: { walletBalance: tx.owner_amount, availableBalance: tx.owner_amount } }
        );

        // Notify owner
        try {
          await Notification.create({
            toRole:    'owner',
            toLoginId: String(tx.owner_id),
            from:      'system',
            type:      'payment_received',
            title:     '💰 Payment Received',
            message:   `Tenant paid ₹${tx.booking_amount}. Your share ₹${tx.owner_amount} is now available in your wallet.`,
            meta:      { bookingId: tx.booking_id, amount: tx.owner_amount }
          });
        } catch (notifErr) {
          console.warn('[CashfreePaymentCtrl] Owner notification failed:', notifErr.message);
        }
      }
      console.log(`[CashfreePaymentCtrl] ✅ Payment processed: ₹${paymentAmount} | Booking: ${tx.booking_id} | WalletStatus: ${newWalletStatus}`);

      // ── TRIGGER ONBOARDING FINALIZATION (Activate tenant, send receipt & credentials email) ──
      try {
        const tenantController = require('./tenantController');
        const Tenant = require('../models/Tenant');
        const Rent = require('../models/Rent');

        const tenantLoginId = tx.tenant_id;
        const rentRecordId = tx.rent_id || tx.invoice_id || tx.booking_id;

        let tenantDoc = null;
        if (tenantLoginId && tenantLoginId !== 'tenant_user') {
          tenantDoc = await Tenant.findOne({
            $or: [
              { loginId: String(tenantLoginId).toUpperCase() },
              { loginId: tenantLoginId }
            ]
          }).catch(() => null);
        }
        if (!tenantDoc && rentRecordId && mongoose.Types.ObjectId.isValid(rentRecordId)) {
          tenantDoc = await Tenant.findOne({ onboardingRentId: rentRecordId }).catch(() => null);
          if (!tenantDoc) {
            const rentDoc = await Rent.findById(rentRecordId).catch(() => null);
            if (rentDoc?.tenantLoginId) {
              tenantDoc = await Tenant.findOne({
                $or: [
                  { loginId: String(rentDoc.tenantLoginId).toUpperCase() },
                  { loginId: rentDoc.tenantLoginId }
                ]
              }).catch(() => null);
            }
          }
        }

        if (tenantDoc && tenantDoc.paymentLinkStatus !== 'paid') {
          console.log(`[CASHFREE WEBHOOK] Triggering onboarding finalization for tenant ${tenantDoc.loginId}`);
          await tenantController.finalizeOnboardingPayment(tenantDoc.loginId, rentRecordId);
        }
      } catch (onboardingWebhookErr) {
        console.error('[CASHFREE WEBHOOK ONBOARDING FINALIZATION ERROR]:', onboardingWebhookErr.message);
      }
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

    const tx = await PaymentTransaction.findOne({
      $or: [
        { cf_order_id: orderId },
        { cf_payment_link_id: orderId },
        { booking_id: orderId }
      ]
    }).lean();

    let cfStatus = null;
    if (orderId && (orderId.startsWith('RMHLINK_') || orderId.includes('LINK'))) {
      const linkRes = await cfPay.getLinkStatus(orderId).catch(() => null);
      if (linkRes && linkRes.success) {
        cfStatus = { status: linkRes.status, link: linkRes.link };
      }
    }
    if (!cfStatus) {
      cfStatus = await cfPay.getOrderStatus(orderId).catch(() => null);
    }

    const rawCfStatus = String(cfStatus?.status || cfStatus?.link?.link_status || '').toUpperCase();
    const isPaid = (tx && (tx.status === 'Verified' || tx.status === 'Settled')) ||
                   rawCfStatus === 'PAID' || rawCfStatus === 'SUCCESS' || rawCfStatus === 'PAID_SUCCESSFULLY';

    if (isPaid && tx && tx._id && tx.status !== 'Verified' && tx.status !== 'Settled') {
      await PaymentTransaction.updateOne(
        { _id: tx._id },
        { $set: { status: 'Verified', payout_status: 'Pending', wallet_status: 'held', held_at: new Date() } }
      ).catch(() => {});
    }

    return res.json({
      success:    true,
      status:     isPaid ? 'PAID' : (rawCfStatus || tx?.status || 'PENDING'),
      db_status:  tx?.status,
      cf_status:  rawCfStatus,
      wallet_status: tx?.wallet_status,
      transaction: tx,
      cashfree:   cfStatus?.order || cfStatus?.link || null,
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

    // Reverse owner wallet balance if applicable
    if (tx.owner_id) {
      await Owner.findOneAndUpdate(
        { loginId: tx.owner_id },
        { $inc: { walletBalance: -tx.owner_amount, availableBalance: -tx.owner_amount } }
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
const VERIFIED_STATUSES = ['Verified', 'Settled', 'PAID', 'SUCCESS', 'COMPLETED'];

exports.getPaymentHistory = async (req, res) => {
  try {
    const { page = 1, limit = 20, owner_id, wallet_status, status } = req.query;
    const filter = {};

    if (owner_id)       filter.owner_id       = owner_id;
    if (wallet_status)  filter.wallet_status   = wallet_status;
    if (status && status !== 'all') {
      filter.status = status;
    } else if (!status) {
      filter.status = { $in: VERIFIED_STATUSES };
    }

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

// ─── VERIFY RENT PAYMENT (called from frontend after Cashfree redirect) ────────

/**
 * POST /api/payments/cashfree/verify-rent-payment
 * Body: { orderId, rentId, amount }
 * Called by tenant dashboard after Cashfree redirects back.
 * Verifies payment with Cashfree, marks Rent+RentInvoice PAID, creates receipt,
 * notifies owner via in-app notification and email.
 */
exports.verifyRentPayment = async (req, res) => {
  try {
    const { orderId, rentId, amount } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId is required' });

    // 1. Check Cashfree payment status
    const cfStatus = await cfPay.getOrderStatus(orderId).catch(() => null);
    const rawStatus = String(cfStatus?.status || cfStatus?.order_status || '').toUpperCase();
    const isPaid = rawStatus === 'PAID' || rawStatus === 'SUCCESS' || rawStatus === 'ACTIVE';

    // Also check DB PaymentTransaction
    const tx = await PaymentTransaction.findOne({
      $or: [
        { cf_order_id: orderId },
        { booking_id: rentId }
      ]
    }).catch(() => null);

    const txPaid = tx && (tx.status === 'Verified' || tx.status === 'Settled');

    if (!isPaid && !txPaid) {
      return res.json({
        success: false,
        status: 'PENDING',
        message: 'Payment not yet confirmed by Cashfree. Please wait a moment and refresh.',
      });
    }

    const Rent = require('../models/Rent');
    const RentInvoice = require('../models/RentInvoice');
    const RentPayment = require('../models/RentPayment');
    const User = require('../models/user');
    const isValidObjectId = mongoose.Types.ObjectId.isValid(rentId);

    // 2. Find Rent document
    let rentDoc = null;
    let rentInvoiceDoc = null;

    if (isValidObjectId) {
      // Try by ID (rentId might be Rent._id or RentInvoice._id)
      rentDoc = await Rent.findOne({
        $or: [
          { _id: rentId },
          { cashfreeOrderId: orderId }
        ]
      }).catch(() => null);

      rentInvoiceDoc = await RentInvoice.findOne({
        $or: [
          { _id: rentId },
          { cashfreeOrderId: orderId }
        ]
      }).catch(() => null);
    }

    // Also try by orderId on PaymentTransaction
    if (!rentDoc && tx?.rent_id && mongoose.Types.ObjectId.isValid(tx.rent_id)) {
      rentDoc = await Rent.findById(tx.rent_id).catch(() => null);
    }
    if (!rentInvoiceDoc && tx?.invoice_id && mongoose.Types.ObjectId.isValid(tx.invoice_id)) {
      rentInvoiceDoc = await RentInvoice.findById(tx.invoice_id).catch(() => null);
    }

    // 3. Mark Rent as PAID
    let ownerLoginId = tx?.owner_login_id || tx?.owner_id || '';
    let paidAmount = amount || tx?.booking_amount || 0;
    const cfPaymentId = tx?.cf_payment_id || orderId;

    if (rentDoc) {
      // Avoid double-marking
      if (rentDoc.paymentStatus !== 'paid' && rentDoc.paymentStatus !== 'completed') {
        await Rent.findByIdAndUpdate(rentDoc._id, {
          $set: {
            paymentStatus: 'paid',
            paidAmount: paidAmount,
            paymentDate: new Date(),
            paymentMethod: 'cashfree',
            cashfreeOrderId: orderId,
            cashfreePaymentId: cfPaymentId,
          }
        }).catch(() => {});
      }
      ownerLoginId = ownerLoginId || rentDoc.ownerLoginId;
      paidAmount = paidAmount || rentDoc.totalDue || rentDoc.rentAmount;
    }

    // 4. Mark RentInvoice as PAID
    if (rentInvoiceDoc) {
      if (rentInvoiceDoc.status !== 'PAID') {
        await RentInvoice.findByIdAndUpdate(rentInvoiceDoc._id, {
          $set: {
            status: 'PAID',
            paymentStatus: 'PAID',
            paidAmount: paidAmount,
            rentPaidAmount: paidAmount,
            outstandingAmount: 0,
            paymentMethod: 'online',
            cashfreeOrderId: orderId,
            cashfreePaymentId: cfPaymentId,
          }
        }).catch(() => {});
      }

      // 5. Create RentPayment receipt (for owner's Rent Collection view)
      const ownerDoc = rentInvoiceDoc.ownerId
        ? await Owner.findById(rentInvoiceDoc.ownerId).lean().catch(() => null)
        : null;
      const ownerUserAccount = ownerLoginId
        ? await User.findOne({ loginId: String(ownerLoginId).toUpperCase() }).select('_id email name').lean().catch(() => null)
        : null;

      const receiptOwnerId = ownerDoc?._id || ownerUserAccount?._id || rentInvoiceDoc.ownerId;
      if (receiptOwnerId && rentInvoiceDoc.tenantId && rentInvoiceDoc.propertyId) {
        const existingReceipt = cfPaymentId
          ? await RentPayment.findOne({ transactionId: cfPaymentId }).catch(() => null)
          : null;
        if (!existingReceipt) {
          await RentPayment.create({
            invoiceId: rentInvoiceDoc._id,
            tenantId: rentInvoiceDoc.tenantId,
            propertyId: rentInvoiceDoc.propertyId,
            ownerId: receiptOwnerId,
            amount: paidAmount,
            paymentMethod: 'online',
            transactionId: cfPaymentId || String(Date.now()),
            isPartial: false,
            remainingAfter: 0,
            rentPaidAmount: paidAmount,
            penaltyPaidAmount: 0,
            paymentDate: new Date(),
            recordedBy: tx?.tenant_id || 'tenant_cashfree',
            notes: `Paid via Cashfree PG — order ${orderId}`,
          }).catch(err => console.warn('[verifyRentPayment] RentPayment create warning:', err.message));
        }
      }
    }

    // 6. Update PaymentTransaction
    if (tx && tx.status !== 'Verified') {
      await PaymentTransaction.findByIdAndUpdate(tx._id, {
        $set: { status: 'Verified', wallet_status: 'held', held_at: new Date() }
      }).catch(() => {});
    }

    // 7. Notify owner — in-app notification + email
    if (ownerLoginId) {
      const tenantName = tx?.tenant_name || rentInvoiceDoc?.tenantName || rentDoc?.tenantName || 'Tenant';
      const propertyName = tx?.property_name || rentDoc?.propertyName || 'your property';
      const monthLabel = rentInvoiceDoc?.billingMonth || rentDoc?.collectionMonth || '';

      // In-app notification
      await Notification.create({
        toRole: 'owner',
        toLoginId: String(ownerLoginId).toUpperCase(),
        from: 'system',
        type: 'rent_paid_online',
        title: '💰 Rent Payment Received',
        message: `${tenantName} paid ₹${paidAmount.toLocaleString('en-IN')} rent online via Cashfree for ${monthLabel || propertyName}. Please confirm receipt.`,
        meta: { orderId, rentId, amount: paidAmount, tenantName, propertyName, monthLabel }
      }).catch(err => console.warn('[verifyRentPayment] Notification warn:', err.message));

      // Email notification to owner
      try {
        const ownerUserForEmail = await User.findOne({ loginId: String(ownerLoginId).toUpperCase() }).lean().catch(() => null);
        if (ownerUserForEmail?.email) {
          const { sendMail } = require('../utils/mailer');
          const html = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #4f46e5;">💰 Rent Payment Received</h2>
              <p>Dear ${ownerUserForEmail.name || 'Owner'},</p>
              <p><strong>${tenantName}</strong> has paid rent of <strong>₹${paidAmount.toLocaleString('en-IN')}</strong> online via Cashfree for <strong>${monthLabel || propertyName}</strong>.</p>
              <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
                <tr><td style="padding: 8px; background: #f9fafb; border: 1px solid #e5e7eb;"><strong>Tenant:</strong></td><td style="padding: 8px; border: 1px solid #e5e7eb;">${tenantName}</td></tr>
                <tr><td style="padding: 8px; background: #f9fafb; border: 1px solid #e5e7eb;"><strong>Amount:</strong></td><td style="padding: 8px; border: 1px solid #e5e7eb;">₹${paidAmount.toLocaleString('en-IN')}</td></tr>
                <tr><td style="padding: 8px; background: #f9fafb; border: 1px solid #e5e7eb;"><strong>Month:</strong></td><td style="padding: 8px; border: 1px solid #e5e7eb;">${monthLabel || '-'}</td></tr>
                <tr><td style="padding: 8px; background: #f9fafb; border: 1px solid #e5e7eb;"><strong>Transaction ID:</strong></td><td style="padding: 8px; border: 1px solid #e5e7eb;">${orderId}</td></tr>
              </table>
              <p style="color: #6b7280; font-size: 13px;">The payment has been recorded automatically. You can view it in your Rent Collection dashboard.</p>
            </div>
          `;
          await sendMail(ownerUserForEmail.email, `Rent Payment Received — ${tenantName}`, `Rent payment of ₹${paidAmount} received from ${tenantName}`, html).catch(() => {});
        }
      } catch (emailErr) {
        console.warn('[verifyRentPayment] Email warn:', emailErr.message);
      }
    }
    try {
      const Tenant = require('../models/Tenant');
      const tenantLoginId = rentDoc?.tenantLoginId || tx?.tenant_id;
      const rentRecordId = rentDoc?._id || rentInvoiceDoc?._id || tx?.rent_id || rentId;

      let tenantDoc = null;
      if (tenantLoginId && tenantLoginId !== 'tenant_user') {
        tenantDoc = await Tenant.findOne({
          $or: [
            { loginId: String(tenantLoginId).toUpperCase() },
            { loginId: tenantLoginId }
          ]
        }).catch(() => null);
      }
      if (!tenantDoc && rentRecordId && mongoose.Types.ObjectId.isValid(rentRecordId)) {
        tenantDoc = await Tenant.findOne({ onboardingRentId: rentRecordId }).catch(() => null);
      }

      if (tenantDoc && tenantDoc.paymentLinkStatus !== 'paid') {
        const tenantController = require('./tenantController');
        console.log(`[CASHFREE VERIFY] Triggering onboarding finalization for tenant ${tenantDoc.loginId}`);
        await tenantController.finalizeOnboardingPayment(tenantDoc.loginId, rentRecordId);
      }
    } catch (onboardingFinalizeErr) {
      console.error('[CASHFREE VERIFY ONBOARDING FINALIZATION ERROR]:', onboardingFinalizeErr.message);
    }

    return res.json({
      success: true,
      status: 'PAID',
      message: 'Payment verified successfully! Your rent has been recorded as paid.',
    });

  } catch (err) {
    console.error('[CashfreePaymentCtrl] verifyRentPayment error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

