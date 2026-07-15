const mongoose = require('mongoose');

const tenantAttendanceSchema = new mongoose.Schema(
    {
        ownerLoginId: { type: String, required: true, trim: true, uppercase: true },
        tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
        tenantName: { type: String, required: true },
        roomNo: { type: String, required: true },
        status: { 
            type: String, 
            enum: ['Inside', 'Outside', 'On Leave', 'Present', 'Absent'], 
            default: 'Inside' 
        },
        date: { type: String }, // YYYY-MM-DD for daily attendance tracking
        lastScanTime: { type: Date, default: Date.now }
    },
    { timestamps: true }
);

// Unique index per tenant per date for daily records
tenantAttendanceSchema.index({ tenantId: 1, date: 1 }, { unique: true });

tenantAttendanceSchema.index({ ownerLoginId: 1 });

module.exports = mongoose.model('TenantAttendance', tenantAttendanceSchema);
