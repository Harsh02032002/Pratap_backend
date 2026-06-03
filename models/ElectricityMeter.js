const mongoose = require('mongoose');

const ElectricityMeterSchema = new mongoose.Schema({
    tenant: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
    roomNo: { type: String, required: true },
    property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
    billingMonth: { type: String, required: true }, // Format: YYYY-MM
    previousReading: { type: Number, default: 0 },
    currentReading: { type: Number, default: 0 },
    unitsConsumed: { type: Number, default: 0 },
    unitCost: { type: Number, required: true, default: 0 },
    totalBill: { type: Number, default: 0 },
    status: { type: String, enum: ['unbilled', 'billed', 'paid'], default: 'unbilled' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Update the updatedAt timestamp before saving
ElectricityMeterSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

module.exports = mongoose.models.ElectricityMeter || mongoose.model('ElectricityMeter', ElectricityMeterSchema);
