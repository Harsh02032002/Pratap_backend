const mongoose = require('mongoose');

const maintenanceTaskSchema = new mongoose.Schema({
    ownerLoginId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    frequency: { type: String, enum: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Bi-Annually', 'Yearly', 'One-time'], default: 'One-time' },
    scheduledDate: { type: String, required: true },
    staff: { type: String, required: true },
    assignedStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    assignedStaffName: { type: String },
    status: { type: String, enum: ['Scheduled', 'In Progress', 'Completed', 'Cancelled'], default: 'Scheduled' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('MaintenanceTask', maintenanceTaskSchema);
