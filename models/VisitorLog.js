const mongoose = require('mongoose');

const visitorLogSchema = new mongoose.Schema(
    {
        ownerLoginId:  { type: String, required: true, trim: true, uppercase: true },
        tenantLoginId: { type: String, trim: true, uppercase: true },
        name:          { type: String, required: true },
        phone:         { type: String, required: true },
        hostName:      { type: String, required: true },
        hostRoom:      { type: String, required: true },
        // Snapshot of property + owner at creation, shown on the scanned pass.
        propertyName:  { type: String },
        ownerName:     { type: String },
        purpose:       { type: String, default: 'Social' },
        status: {
            type: String,
            // 'Pending'/'Approved'/'Rejected' drive the tenant→owner approval workflow.
            // 'Pre-approved'/'Inside'/'Exited'/'Cancelled' are retained for the gate flows.
            enum: ['Pending', 'Approved', 'Rejected', 'Pre-approved', 'Inside', 'Exited', 'Cancelled'],
            default: 'Inside'
        },
        // Stable verification token generated once at creation and NEVER regenerated.
        // The visitor pass QR encodes a public verify URL built from this token, so the
        // QR stays identical before and after approval.
        qrToken:           { type: String, index: true },
        // Human-readable, unique pass identifier assigned when the owner approves.
        passId:            { type: String, index: true },
        // Approval / rejection audit trail. approver may be the Owner or an
        // assigned Designated Warden (staff). Role drives the "Approved by …" label.
        approvedBy:        { type: String },          // approver display name
        approvedByLoginId: { type: String, uppercase: true },
        approvedByRole:    { type: String, enum: ['owner', 'warden'] },
        approvedAt:        { type: Date },
        rejectedBy:        { type: String },
        rejectedByLoginId: { type: String, uppercase: true },
        rejectedByRole:    { type: String, enum: ['owner', 'warden'] },
        rejectedAt:        { type: Date },
        // The visitor's intended entry time (kept separate from gate entryTime).
        expectedEntryTime: { type: Date },
        entryTime: { type: Date, default: Date.now },
        exitTime:  { type: Date }
    },
    { timestamps: true }
);

visitorLogSchema.index({ tenantLoginId: 1, createdAt: -1 });
visitorLogSchema.index({ ownerLoginId: 1, createdAt: -1 });

module.exports = mongoose.model('VisitorLog', visitorLogSchema);
