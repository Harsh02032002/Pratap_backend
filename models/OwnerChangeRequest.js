const mongoose = require('mongoose');

const ownerChangeRequestSchema = new mongoose.Schema({
    ownerLoginId: { type: String, required: true },
    requestType: { type: String, enum: ['profile', 'bank_details'], required: true },
    requestedChanges: { type: mongoose.Schema.Types.Mixed, required: true },
    // Snapshot of the owner's field values at submission time, so the review
    // screen can show a "previous vs requested" diff without depending on
    // the Owner record still holding the old value by the time it's reviewed.
    // Kept under BOTH names: the superadmin review page reads `previousValues`,
    // the owner-facing page reads `currentValues`.
    previousValues: { type: mongoose.Schema.Types.Mixed, default: {} },
    currentValues:  { type: mongoose.Schema.Types.Mixed, default: {} },
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
