const mongoose = require('mongoose');

const tenantLeaveRequestSchema = new mongoose.Schema(
    {
        ownerLoginId: { type: String, required: true, trim: true, uppercase: true },
        tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant', required: true },
        tenantName: { type: String, required: true },
        roomNo: { type: String, required: true },
        fromDate: { type: Date, required: true },
        toDate: { type: Date, required: true },
        reason: { type: String, required: true },
        status: { 
            type: String, 
            enum: ['Pending', 'Approved', 'Rejected'], 
            default: 'Pending' 
        }
    },
    { timestamps: true }
);

module.exports = mongoose.model('TenantLeaveRequest', tenantLeaveRequestSchema);
