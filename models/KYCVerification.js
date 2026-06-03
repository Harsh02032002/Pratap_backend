const mongoose = require('mongoose');

const kycVerificationSchema = new mongoose.Schema({
    // Basic User Info
    id: { type: String, unique: true, sparse: true, index: true },
    loginId: { type: String, unique: true, sparse: true },
    
    firstName: { type: String, required: true },
    lastName: { type: String },
    email: { type: String, required: true, index: true },
    phone: { type: String, required: true, index: true },
    password: { type: String, required: true },
    
    // Role
    role: {
        type: String,
        enum: ['propertyowner', 'tenant', 'admin'],
        default: 'tenant'
    },
    
    // KYC Status
    kycStatus: {
        type: String,
        enum: ['pending', 'verified', 'rejected', 'expired'],
        default: 'pending'
    },
    status: {
        type: String,
        enum: ['pending', 'verified', 'rejected', 'active', 'inactive', 'blocked'],
        default: 'pending'
    },
    
    // Verification Documents
    aadhaarNumber: { type: String, sparse: true },
    panNumber: { type: String, sparse: true },
    documents: [{
        type: String,
        url: String,
        uploadedAt: { type: Date, default: Date.now }
    }],
    
    // Area/Location Info
    area: { type: String, index: true },
    locationCode: { type: String },
    
    // Verification Details
    verifiedAt: { type: Date },
    verificationNotes: { type: String },
    
    // Timestamps
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now }
});

// Update updatedAt before saving
kycVerificationSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.model('KYCVerification', kycVerificationSchema);
