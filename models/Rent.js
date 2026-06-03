const mongoose = require('mongoose');

const rentSchema = new mongoose.Schema({
    // Property & Owner Info
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
    propertyName: String,
    ownerLoginId: String,
    ownerName: String,
    
    // Tenant Info
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    tenantLoginId: String, // Store tenant login ID as string for query flexibility
    tenantName: String,
    tenantEmail: String,
    tenantPhone: String,
    roomNumber: String,
    area: String, // Room area in sq. ft
    
    // Rent Details
    rentAmount: Number,
    deposit: Number,
    totalDue: Number, // rent + any additional charges
    
    // Collection Period
    collectionMonth: { type: String, default: new Date().toISOString().slice(0, 7) }, // YYYY-MM
    collectionStartDate: { type: Number, default: 10 }, // 10th of month
    collectionEndDate: { type: Number, default: 15 }, // 15th of month
    
    // Payment Status
    paymentStatus: { 
        type: String, 
        enum: ['pending', 'partially_paid', 'paid', 'completed', 'overdue', 'defaulted'],
        default: 'pending'
    },
    paidAmount: { type: Number, default: 0 },
    paymentDate: Date,
    paymentMethod: { type: String, enum: ['cash', 'razorpay', 'bank_transfer', 'other'] },
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    // Owner payout tracking (platform -> owner transfer)
    ownerPayoutStatus: {
        type: String,
        enum: ['pending', 'processing', 'paid', 'failed'],
        default: 'pending'
    },
    ownerPayoutAmount: { type: Number, default: 0 },
    ownerPayoutAt: Date,
    ownerPayoutRef: String,
    ownerPayoutNote: String,

    // Cash collection workflow
    cashRequestStatus: {
        type: String,
        enum: ['none', 'requested', 'received', 'otp_sent', 'paid'],
        default: 'none'
    },
    cashRequestedAt: Date,
    cashReceivedAt: Date,
    cashOtpCode: String,
    cashOtpExpiry: Date,
    cashOtpSentAt: Date,
    
    // Reminder Tracking
    reminders: [
        {
            sentAt: Date,
            type: { type: String, enum: ['initial', 'delayed_1', 'delayed_2', 'delayed_3', 'auto_daily'] },
            status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
            message: String
        }
    ],

    // Auto reminder control (enabled manually from rent collection panel)
    autoReminderEnabled: { type: Boolean, default: false },
    autoReminderStartedAt: Date,
    autoReminderLastSentAt: Date,
    
    // Timestamps
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    overdueStartDate: Date // When it became overdue
}, { timestamps: true });

// Index for efficient queries
rentSchema.index({ ownerLoginId: 1, collectionMonth: 1 });
rentSchema.index({ tenantId: 1, collectionMonth: 1 });
rentSchema.index({ paymentStatus: 1, overdueStartDate: 1 });

module.exports = mongoose.model('Rent', rentSchema);
