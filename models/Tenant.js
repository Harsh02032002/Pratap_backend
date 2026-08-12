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
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
    roomNo: { type: String }, // Store room number for quick reference
    building: { type: String },
    floor: { type: String },
    bedNo: { type: String }, // Specific bed in room (e.g., "A", "B")
    
    // Rental Details
    moveInDate: { type: Date },
    baseRoomRent: { type: Number },
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
    permanentAddress: { type: String },
    
    // Login Credentials (generated during assignment)
    loginId: { type: String, unique: true, sparse: true }, // e.g., ROOMHYTNT4821
    tempPassword: { type: String }, // Stored temporarily; user will set own password
    ownerLoginId: { type: String },
    propertyTitle: { type: String },
    assignmentLocationCode: { type: String, default: '' }, // locationCode from property at time of assignment

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
        // Alternate ID proof path: tenant has no Aadhaar (or no Aadhaar-linked
        // mobile), so the owner uploads another document for superadmin review
        // instead of the tenant self-verifying by OTP.
        noAadhaar: { type: Boolean, default: false },
        alternateProofType: { type: String },
        alternateProofFile: { type: String },
        alternateProofApproved: { type: Boolean, default: false },
        addressProof: { type: String },
        addressProofFile: { type: String },
        uploadedAt: { type: Date },
        // Store Aadhaar OCR data from admin entry
        aadhaarData: { type: mongoose.Schema.Types.Mixed },
        fatherName: { type: String },
        permanentAddress: { type: String }
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

    // Onboarding Payment Tracking (Phase 4–6.5)
    paymentLinkStatus: {
        type: String,
        enum: ['pending', 'sent', 'paid', 'failed'],
        default: 'pending'
    },
    onboardingRentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rent' },
    credentialsEmailStatus: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
    receiptEmailStatus: { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },

    // Status Tracking
    status: {
        type: String,
        enum: ['pending', 'active', 'inactive', 'suspended'],
        default: 'pending'
    },
    isDeleted: { type: Boolean, default: false },
    kycStatus: {
        type: String,
        enum: ['pending', 'submitted', 'pending_verification', 'audit_pending', 'mismatch_review', 'verified', 'rejected'],
        default: 'pending'
    },
    // Store admin-entered data for KYC comparison
    kycVerificationData: {
        adminEnteredName: { type: String },
        adminEnteredFatherName: { type: String },
        adminEnteredAddress: { type: String },
        adminEnteredDob: { type: String },
        adminEnteredAadhaar: { type: String },
        adminEnteredPhone: { type: String }
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
