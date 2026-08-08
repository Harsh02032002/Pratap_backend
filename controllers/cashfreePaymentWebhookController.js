const Owner = require('../models/Owner');
const BookingRequest = require('../models/BookingRequest');
const RentInvoice = require('../models/RentInvoice');
const Rent = require('../models/Rent');
const PaymentTransaction = require('../models/PaymentTransaction');

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
      case 'ORDER_PAID': {
        console.log(`✅ [Cashfree Webhook] Payment Successful! OrderID: ${orderId}, PaymentID: ${cfPaymentId}, Amount: ₹${paymentAmount}`);

        // 1. Check & Update Booking Request
        let booking = null;
        if (orderId) {
          booking = await BookingRequest.findOne({
            $or: [{ cashfreeOrderId: orderId }, { _id: orderId.replace(/^ORD_/, '') }]
          }).catch(() => null);
        }

        if (booking) {
          booking.status = 'completed';
          booking.paymentStatus = 'PAID';
          booking.cashfreeOrderId = orderId;
          booking.cashfreePaymentId = cfPaymentId;
          booking.paymentMethod = paymentMethod;
          booking.paidAt = new Date();
          await booking.save();
        }

        // 2. Check & Update Rent / RentInvoice Record
        let rentInvoice = null;
        if (orderId) {
          rentInvoice = await RentInvoice.findOne({
            $or: [{ cashfreeOrderId: orderId }, { _id: orderId.replace(/^ORD_/, '') }]
          }).catch(() => null);
        }

        let rentRecord = null;
        if (orderId) {
          rentRecord = await Rent.findOne({
            $or: [{ cashfreeOrderId: orderId }, { _id: orderId.replace(/^ORD_/, '') }]
          }).catch(() => null);
        }

        const ownerLoginId = booking?.ownerLoginId || rentInvoice?.ownerLoginId || rentRecord?.ownerLoginId || '';
        const tenantLoginId = booking?.tenantLoginId || rentInvoice?.tenantLoginId || rentRecord?.tenantLoginId || '';

        // Calculate Commission & Owner Share
        const commissionRate = 0.05; // 5% platform commission
        const adminCommission = Math.round(paymentAmount * commissionRate);
        const ownerShare = Math.max(0, paymentAmount - adminCommission);

        // 3. Credit Owner's HELD BALANCE & Add Ledger Entry
        if (ownerLoginId) {
          const owner = await Owner.findOne({ loginId: ownerLoginId });
          if (owner) {
            owner.heldBalance = (owner.heldBalance || owner.pendingBalance || 0) + ownerShare;
            await owner.save();

            console.log(`💰 [Cashfree Webhook] Held balance updated for Owner ${ownerLoginId}: +₹${ownerShare}`);

            // Save Wallet Ledger / PaymentTransaction record
            await PaymentTransaction.create({
              booking_id: booking?._id || rentInvoice?._id || rentRecord?._id,
              owner_id: owner._id,
              owner_login_id: ownerLoginId,
              tenant_login_id: tenantLoginId,
              total_amount: paymentAmount,
              commission: adminCommission,
              owner_amount: ownerShare,
              payment_method: paymentMethod,
              wallet_status: 'held',
              held_at: new Date(),
              cf_order_id: orderId,
              cf_payment_id: cfPaymentId,
              transaction_id: cfPaymentId || orderId,
              notes: `Cashfree PG payment received for order ${orderId}`
            }).catch(err => console.warn('PaymentTransaction log warning:', err.message));
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
          await rentInvoice.save();
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
          await rentRecord.save();
        }
        break;
      }

      case 'PAYMENT_FAILED':
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
