const mongoose = require('mongoose');

const VisitReportSchema = new mongoose.Schema({
    areaManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    
    // Property Information (Extended for website display)
    propertyInfo: {
        name: { type: String },
        city: { type: String },
        area: { type: String },
        locality: { type: String },
        address: { type: String },
        locationCode: { type: String },
        contactPhone: { type: String },
        propertyType: { type: String }, // PG, Hostel, Apartment, etc.
        gender: { type: String }, // Male, Female, Co-ed
        description: { type: String }
    },
    
    // Room/Occupancy Information
    roomInfo: {
        occupancy: { type: String }, // Single, Double, Triple, etc.
        bedCount: { type: Number }
    },
    
    // Financial Info
    monthlyRent: { type: Number, default: 0 },
    rent: { type: Number, default: 0 },
    deposit: { type: String },
    
    // Media
    photos: [{ type: String }],
    professionalPhotos: [{ type: String }],
    
    // Website Listing Info
    isLiveOnWebsite: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    rating: { type: Number, default: 4.5 },
    reviewsCount: { type: Number, default: 0 },
    
    // Status & Notes
    notes: { type: String },
    status: { type: String, enum: ['submitted','pending','approved','rejected'], default: 'submitted' },
    
    // Generated Owner Credentials (when property is approved)
    generatedCredentials: {
        loginId: { type: String },
        tempPassword: { type: String }
    },
    
    // Link to created Property (if approved)
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },

    submittedAt: { type: Date, default: Date.now },
    submittedToAdmin: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('VisitReport', VisitReportSchema);