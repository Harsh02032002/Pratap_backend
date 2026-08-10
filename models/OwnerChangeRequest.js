const mongoose = require('mongoose');

const ownerChangeRequestSchema = new mongoose.Schema({
    ownerLoginId: { type: String, required: true },
    requestType: { type: String, enum: ['profile', 'bank_details'], required: true },
    requestedChanges: { type: mongoose.Schema.Types.Mixed, required: true },
    // Snapshot of the owner's field values at submission time, so the review
    // screen can show a "previous vs requested" diff without depending on
    // the Owner record still holding the old value by the time it's reviewed.
    previousValues: { type: mongoose.Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    reviewedBy: { type: String }, // Superadmin ID
    reviewedAt: { type: Date },
    rejectionReason: { type: String },
    createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.OwnerChangeRequest || mongoose.model('OwnerChangeRequest', ownerChangeRequestSchema);
