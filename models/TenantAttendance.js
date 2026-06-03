const mongoose = require('mongoose');

const tenantAttendanceSchema = new mongoose.Schema(
    {
        ownerLoginId: { type: String, required: true, trim: true, uppercase: true },
        tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
        tenantName: { type: String, required: true },
        roomNo: { type: String, required: true },
        status: { 
            type: String, 
            enum: ['Inside', 'Outside', 'On Leave'], 
            default: 'Inside' 
        },
        lastScanTime: { type: Date, default: Date.now }
    },
    { timestamps: true }
);

// We want only ONE attendance record per tenant. We just update it as they move in/out.
tenantAttendanceSchema.index({ tenantId: 1 }, { unique: true });

module.exports = mongoose.model('TenantAttendance', tenantAttendanceSchema);
