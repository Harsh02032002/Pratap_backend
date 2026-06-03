const mongoose = require('mongoose');

const ApprovedPropertySchema = new mongoose.Schema({
    visitId: {
        type: String,
        unique: true,
        required: true,
        index: true
    },
    propertyId: { type: String },
    enquiry_id: { type: String },
    propertyCategory: { type: String },
    state: { type: String },
    pincode: { type: String },
    landmark: { type: String },
    contact: {
        name: { type: String },
        number: { type: String },
        email: { type: String }
    },
    videoUrl: { type: String },
    images: [{ type: String }],
    featuredImage: { type: String },
    propertyInfo: {
        name: { type: String, required: true },
        address: { type: String },
        city: { type: String, index: true },
        area: { type: String },
        photos: [{ type: String }],
        ownerGmail: { type: String },
        ownerName: { type: String },
        ownerPhone: { type: String },
        ownerEmail: { type: String },
        rent: { type: Number },
        deposit: { type: String },
        roomCount: { type: Number, default: 0 },
        bedCount: { type: Number, default: 0 },
        vacantRooms: { type: Number, default: 0 },
        vacantBeds: { type: Number, default: 0 },
        occupiedRooms: { type: Number, default: 0 },
        occupiedBeds: { type: Number, default: 0 },
        description: { type: String },
        amenities: [{ type: String }],
        genderSuitability: { type: String },
        propertyType: { type: String }
    },
    professionalPhotos: [{ type: String }],
    nearbyColleges: [{ type: String }],
    generatedCredentials: {
        loginId: { type: String },
        tempPassword: { type: String }
    },
    isLiveOnWebsite: {
        type: Boolean,
        default: false,
        index: true
    },
    status: {
        type: String,
        enum: ['approved', 'live', 'offline'],
        default: 'approved',
        index: true
    },
    submittedAt: {
        type: Date,
        default: Date.now
    },
    approvedAt: {
        type: Date,
        default: Date.now,
        index: true
    },
    reuploadRequests: [{
        requestId: { type: String, required: true },
        ownerLoginId: String,
        roomId: String,
        roomNo: String,
        bedNo: Number,
        securityDepositSettled: { type: Boolean, default: false },
        wantsReupload: { type: Boolean, default: false },
        status: {
            type: String,
            enum: ['pending', 'published', 'cancelled'],
            default: 'pending'
        },
        requestedAt: { type: Date, default: Date.now },
        publishedAt: Date,
        propertyInfo: mongoose.Schema.Types.Mixed
    }],
    bannerPhoto: { type: String },
    websiteBannerPhoto: { type: String },
    
    // New fields for enhanced UI
    highlights: [{
        icon: { type: String },
        text: { type: String },
        subtext: { type: String }
    }],
    benefits: [{ type: String }],
    offers: [{ type: String }],
    nearbyPlaces: [{
        name: { type: String },
        type: { type: String }, // e.g., 'college', 'landmark'
        distance: { type: Number },
        lat: { type: Number },
        lng: { type: Number }
    }],
    roomVariants: [{
        name: { type: String },
        image: { type: String },
        size: { type: String },
        price: { type: Number },
        originalPrice: { type: Number },
        discount: { type: Number },
        amenities: [{ type: String }]
    }],
    ratingBreakdown: {
        5: { type: Number, default: 0 },
        4: { type: Number, default: 0 },
        3: { type: Number, default: 0 },
        2: { type: Number, default: 0 },
        1: { type: Number, default: 0 }
    },
    pricingDetails: {
        baseRent: { type: Number },
        discount: { type: Number },
        totalAmount: { type: Number },
        offers: [{
            label: { type: String },
            amount: { type: Number }
        }]
    },
    originalPrice: { type: Number }, // Quick access variable

    // Premium UI Enhancement Fields
    propertyViews: [{
        label: { type: String, required: true },
        images: [{ type: String }],
        description: { type: String }
    }],
    amenities: [{
        name: { type: String, required: true },
        icon: { type: String, default: 'check' },
        category: { type: String, enum: ['basic', 'comfort', 'luxury'], default: 'basic' }
    }],
    exclusiveBenefits: [{
        title: { type: String, required: true },
        description: { type: String },
        icon: { type: String, default: 'gift' }
    }],
    facilities: {
        wifi: { type: Boolean, default: false },
        ac: { type: Boolean, default: false },
        food: { type: Boolean, default: false },
        laundry: { type: Boolean, default: false },
        parking: { type: Boolean, default: false },
        gym: { type: Boolean, default: false },
        tv: { type: Boolean, default: false },
        powerBackup: { type: Boolean, default: false }
    },
    // Wizard Data Support
    roomTypes: [{
        type: { type: String },
        desc: { type: String },
        totalRooms: { type: String },
        totalBeds: { type: String },
        occupancy: { type: Number },
        pricePerBed: { type: String },
        pricePerRoom: { type: String },
        images: [{ type: String }]
    }],
    propertyDetails: {
        totalArea: { type: String },
        yearBuilt: { type: String },
        propertyAge: { type: String },
        floors: { type: String },
        liftAvailable: { type: String },
        parkingAvailable: { type: String },
        noticePeriod: { type: String },
        genderPref: { type: String },
        preferredFor: {
          students: { type: Boolean },
          professionals: { type: Boolean },
          both: { type: Boolean },
          family: { type: Boolean }
        }
    },
    pricing: {
        rentType: { type: String },
        securityDeposit: { type: String },
        advanceRent: { type: String },
        noticePeriod: { type: String },
        lockInPeriod: { type: String },
        discountPercent: { type: String },
        includedInRent: { type: Object },
        additionalCharges: [{
          name: { type: String },
          amount: { type: String },
          per: { type: String }
        }],
        cancellationPolicy: { type: String }
    },
    policies: {
        smokingAllowed: { type: String },
        alcoholAllowed: { type: String },
        petsAllowed: { type: String },
        cookingAllowed: { type: String },
        visitorsAllowed: { type: String },
        visitorTiming: { type: String },
        partyAllowed: { type: String },
        outsideFood: { type: String },
        quietHours: { type: String },
        quietHoursTiming: { type: String },
        earlyCheckIn: { type: String }
    },
    tenantDescription: { type: String },

    latitude: { type: Number },
    longitude: { type: Number },

    // View and click tracking
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },

    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

ApprovedPropertySchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

ApprovedPropertySchema.index({ isLiveOnWebsite: 1, status: 1, approvedAt: -1 });
ApprovedPropertySchema.index({ status: 1, approvedAt: -1 });

module.exports = mongoose.models.ApprovedProperty || mongoose.model('ApprovedProperty', ApprovedPropertySchema);
