const mongoose = require('mongoose');

/**
 * PaymentTransaction
 * ──────────────────
 * Created immediately after a successful Cashfree payment webhook.
 * Stores the complete commission breakdown locked at time of payment.
 * Past records are NEVER mutated — commission % is stored at point of capture.
 *
 * Wallet lifecycle:
 *   pending   → payment link created, not yet paid
 *   held      → payment received, move-in not yet happened
 *   available → move_in_date + 1 day has passed (cron releases held → available)
 *   withdrawn → owner has withdrawn this amount
 *   skipped   → cash / already_paid bookings (no wallet entry)
 */
const paymentTransactionSchema = new mongoose.Schema({
  // ─── CASHFREE PAYMENT GATEWAY ─────────────────────────────────────────────
  cf_order_id:        { type: String, unique: true, sparse: true, index: true },
  cf_payment_id:      { type: String, unique: true, sparse: true, index: true, default: null },
  cf_payment_link_id: { type: String, default: null },
  cf_payment_link:    { type: String, default: null },   // The actual URL sent to tenant
  cf_order_token:     { type: String, default: null },   // Short-lived token for JS SDK

  // ─── STATE MACHINE ────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: ['Created', 'Verified', 'Settled', 'Refunded', 'Failed'],
    default: 'Created',
    index: true
  },

  // ─── WALLET STATE ─────────────────────────────────────────────────────────
  wallet_status: {
    type: String,
    enum: ['pending', 'held', 'available', 'withdrawn', 'skipped'],
    default: 'pending',
    index: true
  },
  held_at:       { type: Date, default: null },
  available_at:  { type: Date, default: null },
  withdrawn_at:  { type: Date, default: null },

  // ─── BOOKING REFERENCE ────────────────────────────────────────────────────
  booking_id:     { type: String, required: true, index: true },
  property_id:    { type: String, required: true, index: true },
  property_name:  { type: String, default: '' },
  tenant_id:      { type: String, required: true, index: true },
  tenant_name:    { type: String, default: '' },
  owner_id:       { type: String, required: true, index: true },
  owner_name:     { type: String, default: '' },
  move_in_date:   { type: Date, default: null },     // From booking — used by cron

  // ─── COMMISSION BREAKDOWN (locked at time of payment) ─────────────────────
  booking_amount:        { type: Number, required: true },   // Full amount paid by tenant
  commission_percentage: { type: Number, required: true },   // e.g. 10
  commission_amount:     { type: Number, required: true },   // booking_amount * commission_percentage / 100
  gst_percentage:        { type: Number, default: 18 },      // e.g. 18
  gst_amount:            { type: Number, default: 0 },       // commission_amount * gst_percentage / 100
  owner_amount:          { type: Number, required: true },   // booking_amount - commission_amount - gst_amount

  // ─── PAYOUT STATUS ────────────────────────────────────────────────────────
  payout_status: {
    type: String,
    enum: ['Pending', 'Processing', 'Paid', 'Failed'],
    default: 'Pending',
    index: true
  },
  payout_reference:    { type: String, default: null },  // Cashfree transfer ID
  payout_date:         { type: Date, default: null },
  payout_initiated_by: { type: String, default: null },  // Admin loginId who clicked Withdraw

  // ─── OWNER BANK DETAILS (captured at time of payout) ─────────────────────
  payout_account_holder: { type: String, default: null },
  payout_account_number: { type: String, default: null },
  payout_ifsc_code:      { type: String, default: null },
  payout_bank_name:      { type: String, default: null },

  // ─── REFUND ───────────────────────────────────────────────────────────────
  refund_id:     { type: String, default: null },
  refund_amount: { type: Number, default: null },
  refund_status: { type: String, default: null },
  refund_date:   { type: Date, default: null },

  // ─── METADATA ─────────────────────────────────────────────────────────────
  payment_method: { type: String, default: 'cashfree' },  // 'cashfree' | 'cash' | 'already_paid'
  payment_date:   { type: Date, default: Date.now, index: true },
  notes:          { type: String, default: '' },
  raw_webhook:    { type: mongoose.Schema.Types.Mixed, default: null }, // Full webhook payload

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now }
}, { collection: 'payment_transactions' });

paymentTransactionSchema.index({ payment_date: -1 });
paymentTransactionSchema.index({ owner_id: 1, payout_status: 1 });
paymentTransactionSchema.index({ payout_status: 1, payment_date: -1 });
paymentTransactionSchema.index({ wallet_status: 1, move_in_date: 1 }); // for cron job

paymentTransactionSchema.pre('save', function(next) {
  this.updated_at = Date.now();
  if (!this.razorpay_payment_id) {
    this.razorpay_payment_id = 'cf_' + (this._id || new mongoose.Types.ObjectId());
  }
  next();
});

const PaymentTransaction = mongoose.models.PaymentTransaction ||
  mongoose.model('PaymentTransaction', paymentTransactionSchema);

try {
  PaymentTransaction.collection.dropIndex('razorpay_payment_id_1').catch(() => {});
} catch (_) {}

module.exports = PaymentTransaction;
