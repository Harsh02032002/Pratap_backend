const mongoose = require('mongoose');

const TenantFeedbackSchema = new mongoose.Schema({
    tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    tenantLoginId: { type: String, required: true },
    tenantName: { type: String, required: true },
    propertyName: { type: String },
    roomNo: { type: String },
    ownerLoginId: { type: String, required: true },
    category: { 
        type: String, 
        enum: ['Food', 'Cleanliness', 'Amenities', 'Staff', 'Other'],
        required: true 
    },
    rating: { type: Number, min: 1, max: 5, required: true },
    comments: { type: String },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.TenantFeedback || mongoose.model('TenantFeedback', TenantFeedbackSchema);
