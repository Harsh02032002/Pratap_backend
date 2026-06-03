const mongoose = require('mongoose');

const refundRequestSchema = new mongoose.Schema({
    booking_id: { type: String, required: true, index: true },
    user_id: { type: String, required: true, index: true },
    payment_id: { type: String, required: true },
    
    // User request details
    user_name: { type: String, required: true },
    user_phone: { type: String, required: true },
    user_email: { type: String, default: '' },
    
    // Request type
    request_type: { 
        type: String, 
        enum: ['refund', 'alternative_property'], 
        required: true 
    },
    
    // Refund payment details (for refund requests)
    refund_method: { 
        type: String, 
        enum: ['upi', 'bank', 'other'],
        default: null,
        sparse: true
    },
    upi_id: { type: String, sparse: true },
    bank_account_holder: { type: String, sparse: true },
    bank_account_number: { type: String, sparse: true },
    bank_ifsc_code: { type: String, sparse: true },
    bank_name: { type: String, sparse: true },
    other_details: { type: String, sparse: true },
    
    // Refund status
    refund_status: { 
        type: String, 
        enum: ['pending', 'approved', 'rejected', 'processed'], 
        default: 'pending' 
    },
    refund_amount: { type: Number, default: 500 }, // ₹500
    refund_date: { type: Date, sparse: true },
    refund_transaction_id: { type: String, sparse: true },
    
    // Razorpay Payment Details
    razorpay_order_id: { type: String, sparse: true },
    razorpay_payment_id: { type: String, sparse: true },
    razorpay_signature: { type: String, sparse: true },
    
    // Alternative property preference (for alternative property requests)
    preferred_area: { type: String, sparse: true },
    property_requirements: { type: String, sparse: true },
    
    // Admin notes
    admin_notes: { type: String, sparse: true },
    processed_by: { type: String, sparse: true }, // Admin user ID
    
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now }
});

// Middleware to update the updated_at timestamp
refundRequestSchema.pre('save', function(next) {
    this.updated_at = Date.now();
    next();
});

module.exports = mongoose.model('RefundRequest', refundRequestSchema);
