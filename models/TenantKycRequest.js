const mongoose = require('mongoose');

const tenantKycRequestSchema = new mongoose.Schema({
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
    ownerLoginId: { type: String, required: true },
    // Denormalized so the review queue renders without a Tenant lookup per row.
    tenantName: { type: String },
    proofType: { type: String, enum: ['Voter ID', 'PAN', 'Driving License', 'Passport', 'Other'], required: true },
    proofFileUrl: { type: String, required: true },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    reviewedBy: { type: String }, // Superadmin ID
    reviewedAt: { type: Date },
    rejectionReason: { type: String },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.TenantKycRequest || mongoose.model('TenantKycRequest', tenantKycRequestSchema);
