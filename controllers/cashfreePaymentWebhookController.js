const Owner = require('../models/Owner');
const BookingRequest = require('../models/BookingRequest');
const RentInvoice = require('../models/RentInvoice');
const Rent = require('../models/Rent');
const PaymentTransaction = require('../models/PaymentTransaction');
const RentPayment = require('../models/RentPayment');
const User = require('../models/user');

/**
 * Cashfree PG Payment Webhook Controller
 * POST /api/payments/cashfree/webhook
 */
exports.handlePaymentWebhook = async (req, res) => {
  console.log('🔔 [Cashfree Payment Webhook Received]', JSON.stringify(req.body || {}).slice(0, 300));

  try {
    const payload = req.body || {};
    const eventType = payload.type || payload.event || (payload.data?.payment?.payment_status === 'SUCCESS' ? 'PAYMENT_SUCCESS' : 'UNKNOWN');

    console.log(`[Cashfree PG Webhook Event]: ${eventType}`);

    const data = payload.data || {};
    const order = data.order || payload.order || {};
    const payment = data.payment || payload.payment || {};
    const customer = data.customer_details || order.customer_details || {};

    const orderId = order.order_id || payload.order_id || '';
    const cfPaymentId = String(payment.cf_payment_id || payment.payment_id || payload.cf_payment_id || '');
    const paymentAmount = parseFloat(payment.payment_amount || order.order_amount || 0);
    const paymentStatus = (payment.payment_status || order.order_status || '').toUpperCase();
    const paymentMethod = payment.payment_group || payment.payment_method || 'cashfree_pg';

    switch (eventType) {
      case 'PAYMENT_SUCCESS':
      case 'PAYMENT_SUCCESS_WEBHOOK':
      case 'PAYMENT_LINK_PAID_WEBHOOK':
      case 'PAYMENT_LINK_EVENT':
      case 'ORDER_PAID': {
        console.log(`✅ [Cashfree Webhook] Payment Successful! Event: ${eventType}, OrderID: ${orderId}, PaymentID: ${cfPaymentId}, Amount: ₹${paymentAmount}`);

        // Extract raw Mongo ObjectId if present in orderId (e.g. RMHLINK_6a78d05... or ORD_6a78d05...)
        let extractedId = '';
        if (orderId) {
          const parts = String(orderId).split('_');
          for (const p of parts) {
            if (p.length === 24 && /^[0-9a-fA-F]{24}$/.test(p)) {
              extractedId = p;
              break;
            }
          }
        }

        // 1. Check & Update Booking Request
        let booking = null;
        if (orderId) {
          const query = [
            { cashfreeOrderId: orderId },
            { booking_id: orderId }
          ];
          if (extractedId) query.push({ _id: extractedId });
          booking = await BookingRequest.findOne({ $or: query }).catch(() => null);
        }

        if (booking) {
          booking.status = 'completed';
          booking.paymentStatus = 'PAID';
          booking.cashfreeOrderId = orderId;
          booking.cashfreePaymentId = cfPaymentId;
          booking.paymentMethod = paymentMethod;
          booking.paidAt = new Date();
          await booking.save().catch(() => {});
        }

        // Also update PaymentTransaction to Verified
        const txQuery = [
          { cf_order_id: orderId },
          { cf_payment_link_id: orderId }
        ];
        if (booking?._id) txQuery.push({ booking_id: booking._id });
        if (extractedId) txQuery.push({ booking_id: extractedId });

        let tx = await PaymentTransaction.findOne({ $or: txQuery }).catch(() => null);
        if (tx) {
          tx.status = 'Verified';
          tx.wallet_status = 'held';
          tx.held_at = new Date();
          if (cfPaymentId) tx.cf_payment_id = cfPaymentId;
          await tx.save().catch(() => {});
        }

        // 2. Check & Update Rent / RentInvoice Record
        let rentInvoice = null;
        if (orderId) {
          const rQuery = [{ cashfreeOrderId: orderId }];
          if (extractedId) rQuery.push({ _id: extractedId });
          rentInvoice = await RentInvoice.findOne({ $or: rQuery }).catch(() => null);
        }

        let rentRecord = null;
        if (orderId) {
          const rrQuery = [{ cashfreeOrderId: orderId }];
          if (extractedId) rrQuery.push({ _id: extractedId });
          rentRecord = await Rent.findOne({ $or: rrQuery }).catch(() => null);
        }

        const ownerLoginId = booking?.ownerLoginId || rentInvoice?.ownerLoginId || rentRecord?.ownerLoginId || tx?.owner_login_id || '';
        const tenantLoginId = booking?.tenantLoginId || rentInvoice?.tenantLoginId || rentRecord?.tenantLoginId || tx?.tenant_login_id || '';

        // Calculate Commission & Owner Share
        const commissionRate = 0.05; // 5% platform commission
        const adminCommission = Math.round(paymentAmount * commissionRate);
        const ownerShare = Math.max(0, paymentAmount - adminCommission);

        // 3. Credit Owner's HELD BALANCE & Add Ledger Entry
        if (ownerLoginId) {
          const owner = await Owner.findOne({ loginId: ownerLoginId });
          if (owner) {
            owner.heldBalance = (owner.heldBalance || owner.pendingBalance || 0) + ownerShare;
            await owner.save().catch(() => {});

            console.log(`💰 [Cashfree Webhook] Held balance updated for Owner ${ownerLoginId}: +₹${ownerShare}`);

            // Save Wallet Ledger / PaymentTransaction record if not already created
            if (!tx) {
              await PaymentTransaction.create({
                booking_id: booking?._id || rentInvoice?._id || rentRecord?._id || extractedId,
                owner_id: owner._id,
                owner_login_id: ownerLoginId,
                tenant_login_id: tenantLoginId,
                total_amount: paymentAmount,
                commission: adminCommission,
                owner_amount: ownerShare,
                payment_method: paymentMethod,
                status: 'Verified',
                wallet_status: 'held',
                held_at: new Date(),
                cf_order_id: orderId,
                cf_payment_id: cfPaymentId,
                transaction_id: cfPaymentId || orderId,
                notes: `Cashfree PG payment received for order ${orderId}`
              }).catch(err => console.warn('PaymentTransaction log warning:', err.message));
            }
          }
        }

        // 4. Save Complete Payment History Record on Rent/Invoice
        if (rentInvoice) {
          rentInvoice.paymentStatus = 'PAID';
          rentInvoice.paidAmount = paymentAmount;
          rentInvoice.cashfreeOrderId = orderId;
          rentInvoice.cashfreePaymentId = cfPaymentId;
          if (!Array.isArray(rentInvoice.payments)) rentInvoice.payments = [];
          rentInvoice.payments.push({
            amount: paymentAmount,
            paidAt: new Date(),
            paymentMethod: paymentMethod,
            transactionId: cfPaymentId || orderId,
            cf_order_id: orderId,
            cf_payment_id: cfPaymentId,
            notes: 'Paid via Cashfree PG'
          });
          await rentInvoice.save().catch(() => {});

          // Create RentPayment record so this payment shows up in the owner's Issued Receipts list.
          // NOTE: RentPayment.ownerId must be the owner's User-account _id (models/user.js) —
          // the Issued Receipts query filters by req.user._id, which resolves from User, not
          // from whatever ownerId convention rentInvoice.ownerId happens to use.
          const ownerUserAccount = ownerLoginId
            ? await User.findOne({ loginId: String(ownerLoginId).toUpperCase() }).select('_id').lean().catch(() => null)
            : null;
          if (ownerUserAccount?._id && rentInvoice.tenantId && rentInvoice.propertyId) {
            const cfTxnId = cfPaymentId || orderId;
            const existingReceipt = cfTxnId
              ? await RentPayment.findOne({ transactionId: cfTxnId }).catch(() => null)
              : null;
            if (!existingReceipt) {
              await RentPayment.create({
                invoiceId: rentInvoice._id,
                tenantId: rentInvoice.tenantId,
                propertyId: rentInvoice.propertyId,
                ownerId: ownerUserAccount._id,
                amount: paymentAmount,
                paymentMethod: 'online',
                transactionId: cfTxnId || String(Date.now()),
                isPartial: false,
                remainingAfter: 0,
                rentPaidAmount: paymentAmount,
                penaltyPaidAmount: 0,
                paymentDate: new Date(),
                recordedBy: tenantLoginId || 'system',
                notes: 'Paid via Cashfree PG',
              }).catch(err => console.warn('[Cashfree Webhook] RentPayment (receipt) creation failed:', err.message));
            }
          }
        }

        if (rentRecord) {
          rentRecord.paymentStatus = 'PAID';
          rentRecord.paidAmount = paymentAmount;
          rentRecord.cashfreeOrderId = orderId;
          rentRecord.cashfreePaymentId = cfPaymentId;
          if (!Array.isArray(rentRecord.payments)) rentRecord.payments = [];
          rentRecord.payments.push({
            amount: paymentAmount,
            paidAt: new Date(),
            paymentMethod: paymentMethod,
            transactionId: cfPaymentId || orderId,
            cf_order_id: orderId,
            cf_payment_id: cfPaymentId,
            notes: 'Paid via Cashfree PG'
          });
          await rentRecord.save().catch(() => {});
        }
        break;
      }

      case 'PAYMENT_FAILED':
      case 'PAYMENT_FAILED_WEBHOOK':
      case 'PAYMENT_USER_DROPPED_WEBHOOK':
      case 'USER_DROPPED': {
        console.warn(`⚠️ [Cashfree Webhook] Payment ${eventType} for OrderID: ${orderId}`);
        if (orderId) {
          await BookingRequest.updateOne(
            { cashfreeOrderId: orderId },
            { $set: { paymentStatus: 'FAILED', status: 'cancelled' } }
          ).catch(() => {});
        }
        break;
      }

      case 'REFUND_STATUS': {
        console.log(`ℹ️ [Cashfree Webhook] Refund event for OrderID: ${orderId}`);
        break;
      }

      default:
        console.log(`ℹ️ [Cashfree Webhook] Unhandled event type: ${eventType}`);
        break;
    }

    // Return HTTP 200 immediately
    return res.status(200).json({ success: true, message: 'Webhook processed successfully' });
  } catch (err) {
    console.error('❌ [Cashfree Payment Webhook Error]', err);
    // Still return HTTP 200 to acknowledge receipt to Cashfree
    return res.status(200).json({ success: false, message: 'Error processing webhook: ' + err.message });
  }
};
