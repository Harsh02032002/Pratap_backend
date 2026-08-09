const mongoose = require('mongoose');

/**
 * PayoutRequest
 * ─────────────
 * Tracks instant & scheduled direct cashfree bank payouts for Owners & Admin.
 */
const payoutRequestSchema = new mongoose.Schema({
  user_type: {
    type: String,
    enum: ['owner', 'admin'],
    default: 'owner',
    index: true
  },
  login_id: { type: String, required: true, index: true },
  user_name: { type: String, default: '' },
  amount: { type: Number, required: true },
  
  // Cashfree Payout Reference
  cf_transfer_id: { type: String, index: true },
  cf_reference_id: { type: String, default: null }, // UTR
  
  bank_details: {
    accountNumber:     { type: String, default: null },
    ifsc:              { type: String, default: null },
    bankName:          { type: String, default: null },
    accountHolderName: { type: String, default: null },
    upiId:             { type: String, default: null }
  },
  
  status: {
    type: String,
    enum: ['SUCCESS', 'PENDING', 'PROCESSING', 'FAILED', 'REJECTED'],
    default: 'PENDING',
    index: true
  },
  
  failure_reason: { type: String, default: null },
  requested_at: { type: Date, default: Date.now },
  completed_at: { type: Date, default: null }
}, {
  timestamps: true
});

module.exports = mongoose.model('PayoutRequest', payoutRequestSchema);
