const mongoose = require('mongoose');

/**
 * PayoutLog
 * ─────────
 * Immutable audit trail for every Cashfree Payout API attempt.
 * ADDITIVE ONLY — never modifies PaymentTransaction, Owner, BookingRequest, etc.
 *
 * A failed payout creates a log entry with status='failed'.
 * It does NOT roll back any balance or booking record.
 */
const payoutLogSchema = new mongoose.Schema({
  // ─── REFERENCE ──────────────────────────────────────────────────────────────
  transaction_id:  { type: String, required: true, index: true }, // PaymentTransaction _id
  owner_id:        { type: String, required: true, index: true }, // Owner loginId
  owner_name:      { type: String, default: '' },
  amount:          { type: Number, required: true },              // owner_amount from PaymentTransaction

  // ─── PAYOUT MODE ────────────────────────────────────────────────────────────
  mode: {
    type: String,
    enum: ['bank', 'upi'],
    default: 'bank'
  },

  // ─── CASHFREE IDs (filled on success) ───────────────────────────────────────
  cf_beneficiary_id: { type: String, default: null },  // Cashfree Beneficiary ID
  cf_transfer_id:    { type: String, default: null },  // Cashfree Transfer ID
  cf_reference_id:   { type: String, default: null },  // Our internal reference

  // ─── STATUS ─────────────────────────────────────────────────────────────────
  status: {
    type: String,
    enum: [
      'initiated',             // payout flow started
      'beneficiary_added',     // Cashfree beneficiary created/found
      'queued',                // transfer request accepted by Cashfree
      'processing',            // Cashfree is processing
      'processed',             // payout completed successfully
      'failed',                // payout failed at any step
      'reversed',              // Cashfree reversed the payout
      'sandbox_success',       // sandbox test — simulated success
      'sandbox_failed'         // sandbox test — simulated failure
    ],
    default: 'initiated',
    index: true
  },

  // ─── SANDBOX FLAG ────────────────────────────────────────────────────────────
  is_sandbox: { type: Boolean, default: true },

  // ─── BANK / UPI DETAILS (snapshot at payout time) ───────────────────────────
  account_holder:  { type: String, default: null },
  account_number:  { type: String, default: null },
  ifsc_code:       { type: String, default: null },
  bank_name:       { type: String, default: null },
  upi_id:          { type: String, default: null },

  // ─── FULL REQUEST / RESPONSE LOGS ───────────────────────────────────────────
  cf_beneficiary_request:  { type: mongoose.Schema.Types.Mixed, default: null },
  cf_beneficiary_response: { type: mongoose.Schema.Types.Mixed, default: null },
  cf_transfer_request:     { type: mongoose.Schema.Types.Mixed, default: null },
  cf_transfer_response:    { type: mongoose.Schema.Types.Mixed, default: null },

  // ─── ERROR DETAIL ────────────────────────────────────────────────────────────
  error_step:    { type: String, default: null },
  error_message: { type: String, default: null },
  error_code:    { type: String, default: null },

  // ─── METADATA ────────────────────────────────────────────────────────────────
  initiated_by: { type: String, default: 'superadmin' },
  created_at:   { type: Date, default: Date.now, index: true }
}, {
  collection: 'payout_logs'
});

payoutLogSchema.index({ transaction_id: 1, created_at: -1 });
payoutLogSchema.index({ owner_id: 1, status: 1 });
payoutLogSchema.index({ cf_transfer_id: 1 }, { sparse: true });
payoutLogSchema.index({ cf_beneficiary_id: 1 }, { sparse: true });

module.exports = mongoose.models.PayoutLog || mongoose.model('PayoutLog', payoutLogSchema);
