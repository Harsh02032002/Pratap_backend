const mongoose = require('mongoose');

const TenantSchema = new mongoose.Schema({
    // Basic Information
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String },
    dob: { type: String },
    gender: { type: String },
    guardianNumber: { type: String },
    
    // Reference to assigned property & room
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
    roomNo: { type: String }, // Store room number for quick reference
    building: { type: String },
    floor: { type: String },
    bedNo: { type: String }, // Specific bed in room (e.g., "A", "B")
    
    // Rental Details
    moveInDate: { type: Date },
    agreedRent: { type: Number },
    rentAgreementType: { type: String },
    paymentFrequency: { type: String },
    
    // Tenant Photo
    photo: { type: mongoose.Schema.Types.Mixed },

    // Additional Details
    occupation: { type: String },
    company: { type: String },
    emergencyContact: {
        name: { type: String },
        phone: { type: String },
        relationship: { type: String }
    },
    remarks: { type: String },
    
    // Login Credentials (generated during assignment)
    loginId: { type: String, unique: true, sparse: true }, // e.g., ROOMHYTNT4821
    tempPassword: { type: String }, // Stored temporarily; user will set own password
    ownerLoginId: { type: String },
    propertyTitle: { type: String },

    // Financial Details for Assignment
    securityDepositTotal: { type: Number, default: 0 },
    securityDepositPaid: { type: Number, default: 0 },
    securityDepositBalance: { type: Number, default: 0 },
    electricityCharge: { type: Number, default: 0 },
    maintenanceCharge: { type: Number, default: 0 },
    
    // User Reference
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    
    // KYC Information
    kyc: {
        aadhar: { type: String },
        aadhaarNumber: { type: String },
        aadhaarLinkedPhone: { type: String },
        aadharFile: { type: String }, // Data URL or file path
        aadhaarFront: { type: mongoose.Schema.Types.Mixed },
        aadhaarBack: { type: mongoose.Schema.Types.Mixed },
        otpVerified: { type: Boolean, default: false },
        otpVerifiedAt: { type: Date },
        idProof: { type: String },
        idProofFile: { type: String },
        addressProof: { type: String },
        addressProofFile: { type: String },
        uploadedAt: { type: Date }
    },
    
    // Rental Agreement
    agreementSigned: { type: Boolean, default: false },
    agreementSignedAt: { type: Date },
    agreementESignName: { type: String },
    agreementRequestId: { type: String },
    agreementStatus: { type: String },

    // Tenant Digital Check-In (owner flow parity)
    digitalCheckin: {
        profile: {
            name: { type: String },
            dob: { type: String },
            guardianNumber: { type: String },
            moveInDate: { type: String },
            email: { type: String },
            propertyName: { type: String },
            roomNo: { type: String },
            agreedRent: { type: Number },
            submittedAt: { type: Date }
        },
        allotment: {
            securityDepositTotal: { type: Number, default: 0 },
            securityDepositPaid: { type: Number, default: 0 },
            securityDepositBalance: { type: Number, default: 0 },
            electricityCharge: { type: Number, default: 0 },
            maintenanceCharge: { type: Number, default: 0 },
            submittedAt: { type: Date }
        },
        kyc: {
            aadhaarLinkedPhone: { type: String },
            aadhaarNumber: { type: String },
            aadhaarFront: { type: mongoose.Schema.Types.Mixed },
            aadhaarBack: { type: mongoose.Schema.Types.Mixed },
            otpVerified: { type: Boolean, default: false },
            otpVerifiedAt: { type: Date }
        },
        agreement: {
            eSignName: { type: String },
            acceptedAt: { type: Date },
            signatureDataUrl: { type: String }
        },
        agreementDetails: { type: mongoose.Schema.Types.Mixed, default: {} },
        submittedAt: { type: Date }
    },
    
    // Move-out Request (submitted by tenant)
    moveoutRequest: {
        status: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },
        requestedDate: { type: Date },
        reason: { type: String, default: '' },
        submittedAt: { type: Date },
        duesAtMoveout: { type: Number, default: 0 },
        refundAmount: { type: Number, default: 0 },
        refundStatus: { type: String, default: '' }
    },

    // Status Tracking
    status: {
        type: String,
        enum: ['pending', 'active', 'inactive', 'suspended'],
        default: 'pending'
    },
    kycStatus: {
        type: String,
        enum: ['pending', 'submitted', 'verified', 'rejected'],
        default: 'pending'
    },
    
    // Owner who assigned
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    
    // Verification by Super Admin
    verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    
    // Timestamps
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

TenantSchema.index({ ownerLoginId: 1 });
TenantSchema.index({ property: 1 });

module.exports = mongoose.models.Tenant || mongoose.model('Tenant', TenantSchema);
