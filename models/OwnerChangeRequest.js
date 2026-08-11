const mongoose = require('mongoose');

const ownerChangeRequestSchema = new mongoose.Schema({
    ownerLoginId: { type: String, required: true },
    requestType: { type: String, enum: ['profile', 'bank_details'], required: true },
    requestedChanges: { type: mongoose.Schema.Types.Mixed, required: true },
    // Snapshot of owner's live values at the time of submission — powers the diff view
    currentValues: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Bank-proof document uploaded via POST /api/checkin/owner/documents
    bankProofUrl:  { type: String, default: '' },
    bankProofName: { type: String, default: '' },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    reviewedBy: { type: String }, // Superadmin ID
    reviewedAt: { type: Date },
    rejectionReason: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Keep updatedAt in sync on every save
ownerChangeRequestSchema.pre('save', function (next) {
    this.updatedAt = new Date();
    next();
});

module.exports = mongoose.models.OwnerChangeRequest || mongoose.model('OwnerChangeRequest', ownerChangeRequestSchema);
