const mongoose = require('mongoose');

const WebsitePropertySchema = new mongoose.Schema({
    visitId: { type: String, required: true, unique: true }, // Reference to the original visit report
    propertyName: { type: String, required: true },
    propertyType: { type: String, required: true },
    city: { type: String, required: true },
    area: { type: String, required: true },
    gender: { type: String },
    ownerName: { type: String },
    contactPhone: { type: String },
    monthlyRent: { type: Number, required: true },
    professionalPhotos: [{ type: String }], // URLs
    fieldPhotos: [{ type: String }], // URLs
    images: [{ type: String }], // Unified images
    featuredImage: { type: String },
    
    // Rich Data Fields (Synchronized with Property model)
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
    
    // Location Data
    latitude: { type: Number },
    longitude: { type: Number },
    address: { type: String },
    location: { type: String },

    isLiveOnWebsite: { type: Boolean, default: true },
    status: { type: String, enum: ['online', 'offline'], default: 'online' },
    views: { type: Number, default: 0 },
    clicks: { type: Number, default: 0 },
    submittedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Auto-update updatedAt on save
WebsitePropertySchema.pre('save', function(next) {
    this.updatedAt = new Date();
    next();
});

module.exports = mongoose.model('WebsiteProperty', WebsitePropertySchema);