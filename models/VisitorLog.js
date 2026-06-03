const mongoose = require('mongoose');

const visitorLogSchema = new mongoose.Schema(
    {
        ownerLoginId: { type: String, required: true, trim: true, uppercase: true },
        name: { type: String, required: true },
        phone: { type: String, required: true },
        hostName: { type: String, required: true },
        hostRoom: { type: String, required: true },
        purpose: { type: String, default: 'Social' },
        status: { 
            type: String, 
            enum: ['Pre-approved', 'Inside', 'Exited', 'Cancelled'], 
            default: 'Inside' 
        },
        entryTime: { type: Date, default: Date.now },
        exitTime: { type: Date }
    },
    { timestamps: true }
);

module.exports = mongoose.model('VisitorLog', visitorLogSchema);
