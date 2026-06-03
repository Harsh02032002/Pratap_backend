const mongoose = require('mongoose');

const WebsiteEnquirySchema = new mongoose.Schema({
    enquiry_id: { 
        type: String, 
        unique: true, 
        required: true,
        index: true
    },
    property_type: { type: String, required: true },
    property_name: { type: String, required: true },
    city: { type: String, required: true, index: true },
    locality: { type: String },
    address: { type: String },
    pincode: { type: String },
    description: { type: String },
    amenities: [{ type: String }],
    gender_suitability: { type: String },
    rent: { type: Number },
    deposit: { type: String },
    owner_name: { type: String, required: true },
    owner_email: { type: String },
    owner_phone: { type: String },
    contact_name: { type: String },
    country: { type: String },
    tenants_managed: { type: Number, default: 0 },
    additional_message: { type: String },
    photos: [{ type: String }], // URLs of uploaded photos
    status: {
        type: String,
        enum: ['pending', 'assigned', 'accepted', 'completed', 'rejected'],
        default: 'pending',
        index: true
    },
    assigned_to: { type: String, default: null }, // Area manager name/ID
    assigned_to_loginId: { type: String, default: null },
    assigned_email: { type: String, default: null },
    assigned_area: { type: String, default: null }, // Area name
    assigned_date: { type: Date, default: null },
    notes: { type: String, default: '' },
    created_at: { 
        type: Date, 
        default: Date.now,
        index: true
    },
    updated_at: { 
        type: Date, 
        default: Date.now 
    }
});

// Auto-update updatedAt on save
WebsiteEnquirySchema.pre('save', function(next) {
    this.updated_at = new Date();
    next();
});

module.exports = mongoose.model('WebsiteEnquiry', WebsiteEnquirySchema);
