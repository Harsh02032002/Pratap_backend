const mongoose = require('mongoose');

const WebsitePropertyDataSchema = new mongoose.Schema({
    propertyId: {
        type: String,
        required: true,
        unique: true
    },
    propertyInfo: {
        name: String,
        address: String,
        city: String,
        area: String,
        photos: [String],
        ownerName: String,
        ownerPhone: String,
        rent: Number,
        deposit: String,
        description: String,
        amenities: [String],
        genderSuitability: String
    },
    gender: String,
    status: {
        type: String,
        enum: ['active', 'inactive', 'approved', 'rejected'],
        default: 'active'
    },
    isLiveOnWebsite: {
        type: Boolean,
        default: false
    },
    photos: [String],
    professionalPhotos: [String],
    websiteBannerPhoto: String,
    monthlyRent: Number,
    notes: String,
    submittedAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
}, { timestamps: true });

module.exports = mongoose.model('WebsitePropertyData', WebsitePropertyDataSchema);
