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

/**
 * Fulfill complete onboarding & rent payment lifecycle when PayU payment is confirmed PAID
 */
async function fulfillPayUPayment(tx) {
  if (!tx) return;
  try {
    const BookingRequest = require('../models/BookingRequest');
    const RentInvoice = require('../models/RentInvoice');
    const Rent = require('../models/Rent');
    const Tenant = require('../models/Tenant');
    const Owner = require('../models/Owner');
    const Property = require('../models/Property');
    const RentPayment = require('../models/RentPayment');
    const tenantController = require('./tenantController');

    const txnid = tx.order_id || tx.cf_order_id;
    const paymentId = tx.cf_payment_id || `PAYU_${Date.now()}`;
    const bookingIdStr = String(tx.booking_id || '').trim();
    const isValidObjId = mongoose.Types.ObjectId.isValid(bookingIdStr);

    console.log(`[PayUFulfillment] ⚡ Fulfilling payment for txnid: ${txnid}, bookingId: ${bookingIdStr}, tenant: ${tx.tenant_id}`);

    // 1. Update BookingRequest if exists
    let bookingReq = null;
    if (bookingIdStr) {
      if (isValidObjId) {
        bookingReq = await BookingRequest.findById(bookingIdStr).catch(() => null);
      }
      if (!bookingReq) {
        bookingReq = await BookingRequest.findOne({ booking_id: bookingIdStr }).catch(() => null);
      }
      if (bookingReq) {
        bookingReq.status = 'confirmed';
        bookingReq.payment_status = 'PAID';
        bookingReq.cf_order_id = txnid;
        bookingReq.cf_payment_id = paymentId;
        await bookingReq.save().catch(() => null);
      } else if (isValidObjId) {
        await BookingRequest.updateMany(
          { _id: bookingIdStr },
          { $set: { status: 'confirmed', payment_status: 'PAID', cf_order_id: txnid, cf_payment_id: paymentId } }
        ).catch(() => null);
      }
    }

    // 2. Find Rent & RentInvoice
    let rent = null;
    let rentInvoice = null;

    if (isValidObjId) {
      rent = await Rent.findById(bookingIdStr).catch(() => null);
      rentInvoice = await RentInvoice.findById(bookingIdStr).catch(() => null);
    }

    // Fallback must be scoped to the billing month being paid. Taking the tenant's
    // most recent Rent of ANY month marked a different month paid — e.g. a September
    // rent-only payment overwrote the August move-in Rent (rent + advance) with
    // paidAmount 3000 / payu, and the receipt email then read that August record.
    // With no known month there is nothing safe to match, so leave rent unresolved.
    if (!rent && tx.tenant_id && rentInvoice?.billingMonth) {
      rent = await Rent.findOne({
        $or: [
          { tenantLoginId: String(tx.tenant_id).toUpperCase() },
          { tenantLoginId: tx.tenant_id }
        ],
        collectionMonth: rentInvoice.billingMonth
      }).sort({ createdAt: -1 }).catch(() => null);
    }

    if (rent) {
      rent.paymentStatus = 'paid';
      rent.paidAt = new Date();
      // Rent.paymentMethod's enum is ['cash','payu','razorpay','bank_transfer','other'] —
      // 'online' isn't one of them. That mismatch made every save() here throw a
      // validation error, silently swallowed below, so paymentStatus/paidAmount never
      // actually persisted and the tenant dashboard kept showing the invoice as unpaid
      // even after a real, successful PayU payment.
      rent.paymentMethod = 'payu';
      rent.payuTxnid = txnid;
      rent.payuPaymentId = paymentId;
      if (tx.booking_amount) rent.paidAmount = tx.booking_amount;
      await rent.save().catch(err => console.error('[PayUFulfillment] ❌ Rent.save() failed:', err.message));
    }

    // RentInvoice stores tenantId, not tenantLoginId — querying tenantLoginId never matched.
    if (!rentInvoice && rent?.tenantId) {
      rentInvoice = await RentInvoice.findOne({
        tenantId: rent.tenantId,
        billingMonth: rent.collectionMonth
      }).catch(() => null);
    }

    if (rentInvoice) {
      rentInvoice.status = 'PAID';
      rentInvoice.paidAt = new Date();
      // Set the paid amount here too: the receipt email is sent (step 3) before step 4
      // writes it, so without this the email read the invoice's pre-payment paidAmount.
      rentInvoice.paidAmount = Number(tx.booking_amount) || rentInvoice.totalDue;
      rentInvoice.outstandingAmount = 0;
      rentInvoice.paymentMethod = 'online';
      rentInvoice.payuTxnid = txnid;
      rentInvoice.payuPaymentId = paymentId;
      await rentInvoice.save().catch(() => null);
    }

    // 3. Find Tenant & trigger finalizeOnboardingPayment
    let tenant = null;
    if (rent && rent.tenantLoginId) {
      tenant = await Tenant.findOne({
        $or: [
          { loginId: String(rent.tenantLoginId).toUpperCase() },
          { loginId: rent.tenantLoginId }
        ]
      }).catch(() => null);
    }

    if (!tenant && tx.tenant_id) {
      tenant = await Tenant.findOne({
        $or: [
          { loginId: String(tx.tenant_id).toUpperCase() },
          { loginId: tx.tenant_id }
        ]
      }).catch(() => null);
    }

    if (tenant) {
      console.log(`[PayUFulfillment] 🟢 Triggering finalizeOnboardingPayment for tenant: ${tenant.loginId}`);
      await Tenant.updateOne({ _id: tenant._id }, { $set: { paymentLinkStatus: 'paid', status: 'active', kycStatus: 'verified' } }).catch(() => null);
      await tenantController.finalizeOnboardingPayment(tenant.loginId, rent?._id || bookingIdStr).catch(err => {
        console.error('[PayUFulfillment] finalizeOnboardingPayment error:', err.message);
      });
    }

    // 4. Auto-create RentPayment Record for Receipt tab (Online mode)
    try {
      let existingRentPayment = await RentPayment.findOne({
        $or: [{ transactionId: txnid }, { transactionId: paymentId }]
      }).catch(() => null);

      if (!existingRentPayment) {
        // Fallback resolution for Tenant ID
        let tenantDoc = tenant;
        if (!tenantDoc && tx.tenant_id) {
          // tx.tenant_id holds a loginId (see createOrder) — no email/phone field
          // exists on PaymentTransaction to fall back to. An $or clause built with
          // undefined values here used to silently match every tenant in the
          // collection (Mongoose drops undefined keys, leaving bare {} in $or),
          // so this is deliberately a single direct lookup, not a broader $or.
          tenantDoc = await Tenant.findOne({
            $or: [
              { loginId: String(tx.tenant_id).toUpperCase() },
              { loginId: tx.tenant_id }
            ]
          }).catch(() => null);
        }

        // Fallback resolution for Owner ID
        //
        // The owner's ID used everywhere else (req.user._id from the auth middleware,
        // and the ownerId already stored on every other RentPayment/RentInvoice) is the
        // User collection's _id, not the Owner collection's — the same loginId can exist
        // as two separate documents with two different _ids. Looking this up against
        // Owner instead of User silently wrote a payment record the owner's own session
        // could never query back (a real payment that became invisible on their Issued
        // Receipts page). User is tried first to match that established convention;
        // Owner is only a fallback for accounts that genuinely have no User record.
        const User = require('../models/user');
        let ownerDoc = null;
        const ownerSearch = tenantDoc?.ownerLoginId || rent?.ownerLoginId || tx.owner_id || bookingReq?.owner_id;
        if (ownerSearch) {
          ownerDoc = await User.findOne({
            role: 'owner',
            $or: [
              { loginId: String(ownerSearch).toUpperCase() },
              { loginId: ownerSearch },
              { email: ownerSearch }
            ]
          }).catch(() => null);
          if (!ownerDoc) {
            ownerDoc = await Owner.findOne({
              $or: [
                { loginId: String(ownerSearch).toUpperCase() },
                { loginId: ownerSearch },
                { email: ownerSearch }
              ]
            }).catch(() => null);
          }
        }

        // Try via tenant's property if still not resolved
        if (!ownerDoc && tenantDoc?.property) {
          const propForOwner = await Property.findById(tenantDoc.property).lean().catch(() => null);
          if (propForOwner?.ownerLoginId) {
            ownerDoc = await User.findOne({ role: 'owner', loginId: String(propForOwner.ownerLoginId).toUpperCase() }).catch(() => null);
            if (!ownerDoc) {
              ownerDoc = await Owner.findOne({ loginId: String(propForOwner.ownerLoginId).toUpperCase() }).catch(() => null);
            }
          }
        }
        if (!ownerDoc) {
          console.warn(`[PayUFulfillment] ⚠️ Owner not resolved — using first owner as fallback`);
          ownerDoc = await User.findOne({ role: 'owner' }).sort({ createdAt: 1 }).catch(() => null);
          if (!ownerDoc) {
            ownerDoc = await Owner.findOne().sort({ createdAt: 1 }).catch(() => null);
          }
        }

        // Fallback resolution for Property ID
        let propId = rent?.propertyId || tenantDoc?.propertyId || tenantDoc?.property || tx.property_id || bookingReq?.property_id;
        let propertyDoc = null;
        if (propId) {
          if (mongoose.Types.ObjectId.isValid(String(propId))) {
            propertyDoc = await Property.findById(propId).catch(() => null);
          }
          if (!propertyDoc) {
            propertyDoc = await Property.findOne({ $or: [{ visitId: String(propId) }, { propertyId: String(propId) }, { title: String(propId) }] }).catch(() => null);
          }
        }
        if (!propertyDoc) {
          propertyDoc = await Property.findOne().sort({ createdAt: 1 }).catch(() => null);
        }

        const validTenantId = tenantDoc?._id || (isValidObjId ? bookingIdStr : new mongoose.Types.ObjectId());
        const validOwnerId = ownerDoc?._id || new mongoose.Types.ObjectId();
        const validPropId = propertyDoc?._id || new mongoose.Types.ObjectId();
        const billingMonth = rent?.collectionMonth || new Date().toISOString().slice(0, 7);
        // amountPaid is the TOTAL actually charged via PayU — now correctly rent + advance
        // combined (see createOrder below). It must NOT be dumped whole into rentAmount:
        // that mislabels the advance portion as rent, so a receipt for e.g. rent ₹3,000 +
        // move-in ₹10,000 showed "Original Rent ₹13,000" plus a *second* ₹10,000 Move In
        // line, double-counting the advance into a fake ₹23,000 "Total Rent Due" against
        // an actual ₹13,000 paid. Split it back into its real components from `rent`.
        const amountPaid = Number(tx.booking_amount || rent?.rentAmount || tenantDoc?.agreedRent || 500);
        // When the tenant paid a RentInvoice directly, that invoice holds the real split
        // (rent vs late fee, persisted by createOrder) — prefer it over the Rent record.
        const baseRentAmount = Number(rentInvoice?.rentAmount ?? rent?.rentAmount ?? tenantDoc?.agreedRent ?? amountPaid);
        const advanceChargeAmt = Number(rent?.advanceChargeAmount || 0);
        let penaltyPaid = Number(rentInvoice?.totalPenalty || 0);
        // dueDate is REQUIRED in RentInvoice schema — derive from billingMonth
        const [_dy, _dm] = billingMonth.split('-').map(Number);
        const dueDate = new Date(_dy, _dm - 1, 1); // 1st of billing month

        let invId = rentInvoice?._id;
        if (!invId) {
          // Search for existing invoice by tenantId + billingMonth
          let invDoc = await RentInvoice.findOne({ tenantId: validTenantId, billingMonth }).catch(() => null);

          if (invDoc) {
            // Existing invoice found — update to PAID + online
            penaltyPaid = Number(invDoc.totalPenalty || 0);
            await RentInvoice.findByIdAndUpdate(invDoc._id, {
              $set: {
                status: 'PAID',
                paidAmount: amountPaid,
                rentPaidAmount: Number(invDoc.rentAmount ?? baseRentAmount),
                penaltyPaidAmount: penaltyPaid,
                outstandingAmount: 0,
                paymentMethod: 'online',
                payuTxnid: txnid,
                payuPaymentId: paymentId,
              }
            }).catch(err => console.error('[PayUFulfillment] RentInvoice update error:', err.message));
            invId = invDoc._id;
            console.log(`[PayUFulfillment] ✅ Existing RentInvoice ${invDoc.invoiceNumber} updated to PAID (online)`);
          } else {
            // Create new invoice — include ALL required schema fields
            const invoiceNumber = `INV-${billingMonth}-${String(validTenantId).slice(-6)}-${Date.now().toString(36).toUpperCase()}`;
            invDoc = await RentInvoice.create({
              invoiceNumber,
              tenantId: validTenantId,
              propertyId: validPropId,
              ownerId: validOwnerId,
              tenantName: tenantDoc?.name || tx.user_name || 'Guest',
              tenantEmail: tenantDoc?.email || tx.user_email || '',
              tenantPhone: tenantDoc?.phone || tx.user_phone || '',
              billingMonth,
              rentAmount: baseRentAmount,
              advanceChargeAmount: advanceChargeAmt,
              dueDate,              // ← REQUIRED field — was missing, causing silent failure!
              totalDue: amountPaid,
              paidAmount: amountPaid,
              rentPaidAmount: baseRentAmount,
              penaltyPaidAmount: 0,
              outstandingAmount: 0,
              status: 'PAID',
              paymentMethod: 'online',
              payuTxnid: txnid,
              payuPaymentId: paymentId,
            }).catch(err => {
              console.error('[PayUFulfillment] ❌ RentInvoice.create failed:', err.message,
                '| fields:', JSON.stringify({ invoiceNumber, billingMonth, dueDate, ownerId: String(validOwnerId), tenantId: String(validTenantId) }));
              return null;
            });
            if (invDoc) console.log(`[PayUFulfillment] ✅ New RentInvoice created: ${invDoc.invoiceNumber} for ${tenantDoc?.name || tx.user_name}`);
            invId = invDoc?._id;
          }
        } else {
          // rentInvoice was already resolved above — ensure it is PAID + online
          await RentInvoice.findByIdAndUpdate(invId, {
            $set: {
              status: 'PAID',
              paidAmount: amountPaid,
              rentPaidAmount: baseRentAmount,
              penaltyPaidAmount: penaltyPaid,
              outstandingAmount: 0,
              paymentMethod: 'online',
              payuTxnid: txnid,
              payuPaymentId: paymentId,
            }
          }).catch(err => console.error('[PayUFulfillment] RentInvoice update (pre-resolved) error:', err.message));
          console.log(`[PayUFulfillment] ✅ Pre-resolved rentInvoice ${invId} updated — PAID (online)`);
        }

        if (invId) {
          await RentPayment.create({
            invoiceId: invId,
            tenantId: validTenantId,
            propertyId: validPropId,
            ownerId: validOwnerId,
            amount: amountPaid,
            paymentMethod: 'online',
            transactionId: txnid,
            isPartial: false,
            remainingAfter: 0,
            rentPaidAmount: baseRentAmount,
            penaltyPaidAmount: penaltyPaid,
            paymentDate: new Date(),
            recordedBy: 'PayU PG',
            notes: `Online Payment via PayU PG (Txn: ${txnid})`
          }).catch(err => console.error('[PayUFulfillment] RentPayment create error:', err.message));

          console.log(`[PayUFulfillment] ✅ RentPayment receipt issued (online) for txn: ${txnid}`);
        } else {
          console.error(`[PayUFulfillment] ❌ Cannot create RentPayment — no invId resolved for txn: ${txnid}`);
        }
      } else {
        console.log(`[PayUFulfillment] ⏭ RentPayment already exists for txn: ${txnid}, skipping duplicate.`);
      }
    } catch (rpErr) {
      console.error('[PayUFulfillment] ❌ Receipt auto-creation failed:', rpErr.message);
    }

    notifyOwnerOnPayment(tx);
  } catch (err) {
    console.error('❌ fulfillPayUPayment error:', err);
  }
}

// ─── CREATE ORDER ──────────────────────────────────────────────────────────────
/**
 * POST /api/payments/payu/create-order
 * Body: { bookingId, amount, customerInfo: { name, email, phone } }
 */
exports.createOrder = async (req, res) => {
  try {
    const { bookingId: requestedBookingId, amount: requestedAmount, customerInfo = {}, paymentSource } = req.body;
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
        const Tenant = require('../models/Tenant');
        const User = require('../models/user');

        // RentInvoice has no tenantLoginId field at all — it only carries tenantId
        // (a real ObjectId reference). Resolving through that to the actual Tenant
        // doc is the only reliable way to get a loginId; the previous code fell back
        // to the tenant's display NAME as if it were a login ID, which never matches
        // anything, so Rent never resolved and the tenant fell through every lookup
        // downstream in fulfillPayUPayment — no receipt email, no RentPayment record.
        const tenantDoc = rentInvoiceDoc.tenantId
          ? await Tenant.findById(rentInvoiceDoc.tenantId).lean().catch(() => null)
          : null;

        rentDoc = tenantDoc
          ? await Rent.findOne({ tenantLoginId: tenantDoc.loginId, collectionMonth: rentInvoiceDoc.billingMonth }).catch(() => null)
          : null;

        // Same owner-collection mismatch fixed elsewhere: the authenticated owner
        // session (and every other payment record) uses the User collection's _id,
        // not Owner's — try that first.
        let ownerDoc = await User.findOne({ _id: rentInvoiceDoc.ownerId, role: 'owner' }).lean().catch(() => null);
        if (!ownerDoc) ownerDoc = await Owner.findById(rentInvoiceDoc.ownerId).lean().catch(() => null);

        // Late fees are computed live (evaluateInvoice) and only persisted by the nightly
        // job, so the stored totalDue can lag what the tenant dashboard shows — charging
        // it billed rent ₹3,000 while the dashboard said ₹8,700 (rent + ₹5,700 late fee).
        // Evaluate and persist here exactly like dailyRentEvaluator does, so the charge,
        // the invoice, and every receipt/email built from it agree.
        let liveInvoice = rentInvoiceDoc;
        if (!['PAID', 'WAIVED', 'CANCELLED'].includes(String(rentInvoiceDoc.status || '').toUpperCase())) {
          try {
            const { evaluateInvoice } = require('../services/invoiceService');
            const { updates, newPenalties, phaseHistoryAddition } = await evaluateInvoice(rentInvoiceDoc);
            const updateDoc = { $set: updates };
            const push = {};
            if (newPenalties.length) push.penaltyHistory = { $each: newPenalties };
            if (phaseHistoryAddition.length) push.phaseHistory = { $each: phaseHistoryAddition };
            if (Object.keys(push).length) updateDoc.$push = push;
            await RentInvoice.updateOne({ _id: rentInvoiceDoc._id }, updateDoc);
            liveInvoice = { ...rentInvoiceDoc, ...updates };
          } catch (evalErr) {
            console.error('[PayU createOrder] evaluateInvoice failed, charging stored total:', evalErr.message);
          }
        }

        booking = {
          _id: rentInvoiceDoc._id,
          user_id: tenantDoc?.loginId || String(rentInvoiceDoc.tenantId),
          name: tenantDoc?.name || rentInvoiceDoc.tenantName || 'Tenant',
          email: tenantDoc?.email || rentInvoiceDoc.tenantEmail || '',
          phone: tenantDoc?.phone || rentInvoiceDoc.tenantPhone || '',
          owner_id: ownerDoc?.loginId || rentDoc?.ownerLoginId || 'OWNER',
          owner_name: ownerDoc?.name || rentDoc?.ownerName || '',
          property_id: String(rentInvoiceDoc.propertyId || 'N/A'),
          property_name: rentDoc?.propertyName || 'RoomHy Property',
          check_in_date: rentInvoiceDoc.createdAt,
          amount: liveInvoice.outstandingAmount > 0 ? liveInvoice.outstandingAmount : liveInvoice.totalDue
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
          amount: rentDoc.totalDue || rentDoc.rentAmount
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
      // PaymentTransaction's schema field is tenant_id/tenant_name — there is no
      // user_id/user_name/user_email/user_phone field at all, so writing those (as
      // this used to) got silently dropped by Mongoose on save. fulfillPayUPayment's
      // tenant-resolution fallback (tx.user_id) then always read undefined, and for
      // any payment whose booking_id doesn't resolve straight to a Rent record with
      // its own tenantLoginId, the tenant — and the receipt email — never resolved.
      tenant_id: booking?.user_id || customerEmail,
      tenant_name: customerName,
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
    // udf2 encodes the payment source so the response handler knows where to redirect:
    //   'rent_onboarding'  → email-link rent payment  → redirect to tenant dashboard
    //   'rent_dashboard'   → in-app rent payment      → redirect to tenant dashboard
    //   'booking_payment'  → booking amount payment   → redirect to payment-success page
    const resolvedUdf2 = paymentSource || 'booking_payment';
    const payuOrder = payuService.preparePaymentOrder({
      txnid,
      amount: payableAmount,
      productinfo: `Booking Payment for ${tx.property_name}`,
      firstname: customerName,
      email: customerEmail,
      phone: customerPhone,
      udf1: String(bookingId),
      udf2: resolvedUdf2
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

          await fulfillPayUPayment(tx);
        }
      }

      // Determine redirect based on payment source stored in udf2
      const paymentSourceField = String(payload.udf2 || tx?.udf2 || '').trim();
      const isRentPayment = paymentSourceField === 'rent_onboarding' || paymentSourceField === 'rent_dashboard';

      let targetRedirect;
      if (isRentPayment) {
        // Rent payment (email link or dashboard) → straight to Tenant Dashboard
        targetRedirect = `${frontendUrl}/tenant/tenantdashboard?payment=success&order_id=${encodeURIComponent(txnid)}&amount=${encodeURIComponent(tx?.booking_amount || tx?.amount || '')}`;
      } else {
        // Booking payment → show Payment Success page
        targetRedirect = `${frontendUrl}/website/payment-success?order_id=${encodeURIComponent(txnid)}&status=success&amount=${encodeURIComponent(tx?.booking_amount || tx?.amount || '')}`;
      }
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

    if (remoteVerify && remoteVerify.isSuccess) {
      if (tx) {
        if (tx.status !== 'PAID') {
          tx.status = 'PAID';
          tx.cf_payment_id = remoteVerify.mihpayid || `PAYU_${Date.now()}`;
          await tx.save();
        }
        await fulfillPayUPayment(tx);
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
