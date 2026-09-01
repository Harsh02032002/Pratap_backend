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
    roomTypes: [{
        type: { type: String },
        desc: { type: String },
        totalRooms: { type: String },
        totalBeds: { type: String },
        occupancy: { type: Number },
        pricePerBed: { type: String },
        pricePerRoom: { type: String }
    }],
    
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
    // Why the automatic KYC email failed, when it did. Written by the
    // post-response dispatcher in routes/visitDataRoutes.js, which can no
    // longer report the failure in the submit response itself.
    kycLinkError: { type: String, default: '' },
    
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
    photoTimestamps:       { type: mongoose.Schema.Types.Mixed },
    // Per-photo provenance.
    //
    // `source` is what separates the two capture paths: a 'camera' photo was
    // taken live in the visit form and carries a burnt-in timestamp and place
    // name as evidence, while an 'upload' is a file the staff member chose and
    // is deliberately left unstamped — a timestamp on it would assert something
    // about when and where it was taken that nobody actually verified.
    //
    // The location fields were added because a subdocument schema STRIPS keys it
    // does not declare: the client can send placeName and coordinates all it
    // likes, but without them listed here Mongoose drops them silently on save.
    photoDetails: [{
        url: String,
        capturedAt: String,
        source: { type: String, enum: ['camera', 'upload', 'url'], default: 'upload' },
        latitude: Number,
        longitude: Number,
        // Metres of GPS uncertainty the device reported. Kept because a place
        // name pinned from a 2km fix is not the evidence a 10m fix is.
        accuracy: Number,
        placeName: String,
        // False when the server judged the fix implausible for this property —
        // too vague, or too far from the property's own city. Persisted so a
        // reviewer months later can see the photo was never location-verified,
        // rather than having to infer it.
        locationTrusted: { type: Boolean, default: true },
        // Full postal chain from the geocoder, for when the short label is
        // ambiguous months later during a dispute.
        placeAddress: String
    }],
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
