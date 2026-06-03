const mongoose = require('mongoose');

const VisitDataSchema = new mongoose.Schema({
    visitId: {
        type: String,
        unique: true,
        required: true,
        index: true
    },
    
    // Visitor/Staff Information
    visitorName: String,
    visitorEmail: String,
    visitorPhone: String,
    staffName: String,
    staffId: String,
    submittedBy: String,
    submittedById: String,
    submittedByLoginId: String,
    ownerLoginId: String,
    
    // Property Information
    propertyName: String,
    propertyType: String,
    city: String,
    area: String,
    address: String,
    pincode: String,
    landmark: String,
    nearbyLocation: String,
    
    // Details
    description: String,
    amenities: [String],
    genderSuitability: String,
    gender: String,
    monthlyRent: Number,
    deposit: String,
    
    // Owner Information
    ownerName: String,
    ownerEmail: String,
    ownerPhone: String,
    ownerCity: String,
    contactPhone: String,
    roomCount: { type: Number, default: 0 },
    bedCount: { type: Number, default: 0 },
    vacantRooms: { type: Number, default: 0 },
    vacantBeds: { type: Number, default: 0 },
    occupiedRooms: { type: Number, default: 0 },
    occupiedBeds: { type: Number, default: 0 },
    
    // Photos
    photos: [String],
    professionalPhotos: [String],
    
    // Ratings and Reviews
    studentReviewsRating: Number,
    studentReviews: String,
    employeeRating: Number,
    cleanlinessRating: Number,
    cleanliness: String,
    ownerBehaviour: String,
    ownerBehaviourPublic: String,
    
    // Property Features
    furnishing: String,
    ventilation: String,
    minStay: String,
    entryExit: String,
    visitorsAllowed: Boolean,
    cookingAllowed: Boolean,
    smokingAllowed: Boolean,
    petsAllowed: Boolean,
    
    // Internal Notes
    internalRemarks: String,
    cleanlinessNote: String,
    
    // Location
    latitude: Number,
    longitude: Number,
    
    // Status
    status: {
        type: String,
        enum: ['submitted', 'pending_review', 'pending', 'approved', 'rejected', 'hold'],
        default: 'submitted',
        index: true
    },
    
    // Approval Information
    approvedAt: Date,
    approvalNotes: String,
    approvedBy: String,
    holdReason: String,
    holdAction: {
        type: String,
        enum: ['edit', 'none', ''],
        default: ''
    },
    holdAt: Date,
    rejectReason: String,
    rejectAction: {
        type: String,
        enum: ['reupload', 'cancel', ''],
        default: ''
    },
    rejectedAt: Date,
    generatedCredentials: {
        loginId: String,
        tempPassword: String
    },
    
    // KYC link tracking
    kycStatus: {
        type: String,
        enum: ['not_sent', 'sent', 'completed'],
        default: 'not_sent',
        index: true
    },
    kycToken: { type: String },
    kycTokenExpiry: { type: Date },
    kycSentAt: { type: Date },
    
    // KYC data filled by owner
    kycAadhaarNumber: { type: String },
    kycPanNumber: { type: String },
    kycPhone: { type: String },
    kycCompletedAt: { type: Date },

    // Bank Details
    bankAccountHolderName: { type: String },
    bankAccountNumber:     { type: String },
    bankIfscCode:          { type: String },
    bankName:              { type: String },
    bankBranchName:        { type: String },
    bankUpiId:             { type: String },
    isLiveOnWebsite: {
        type: Boolean,
        default: false
    },
    
    // Property Info Object (for backward compatibility)
    propertyInfo: mongoose.Schema.Types.Mixed,
    
    // Metadata
    submittedAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Auto-update updatedAt on save
VisitDataSchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

VisitDataSchema.index({ staffId: 1, submittedAt: -1 });
VisitDataSchema.index({ staffName: 1, submittedAt: -1 });
VisitDataSchema.index({ submittedBy: 1, submittedAt: -1 });
VisitDataSchema.index({ submittedById: 1, submittedAt: -1 });
VisitDataSchema.index({ submittedByLoginId: 1, submittedAt: -1 });
VisitDataSchema.index({ ownerLoginId: 1, submittedAt: -1 });
VisitDataSchema.index({ submittedAt: -1 });

module.exports = mongoose.model('VisitData', VisitDataSchema);
