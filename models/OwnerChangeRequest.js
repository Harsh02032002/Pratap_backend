const mongoose = require('mongoose');

const ownerChangeRequestSchema = new mongoose.Schema({
    ownerLoginId: { type: String, required: true },
    requestType: { type: String, enum: ['profile', 'bank_details'], required: true },
    requestedChanges: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    reviewedBy: { type: String }, // Superadmin ID
    reviewedAt: { type: Date },
    rejectionReason: { type: String },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.OwnerChangeRequest || mongoose.model('OwnerChangeRequest', ownerChangeRequestSchema);
