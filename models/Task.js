const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema({
    ownerLoginId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property' },
    propertyName: { type: String, default: '' },
    roomNo: { type: String, default: '' },
    assignedStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    assignedStaffName: { type: String, default: '' },
    assignedStaffLoginId: { type: String, default: '' },
    priority: { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
    category: { type: String, enum: ['Maintenance', 'Cleaning', 'KYC', 'Rent', 'Complaint', 'Inspection', 'Other'], default: 'Other' },
    status: { type: String, enum: ['Pending', 'In Progress', 'Completed', 'Cancelled'], default: 'Pending' },
    dueDate: { type: Date },
    completedAt: { type: Date },
    notes: { type: String, default: '' },
    createdBy: { type: String, default: '' },
}, { timestamps: true });

taskSchema.index({ ownerLoginId: 1, status: 1 });
taskSchema.index({ assignedStaffLoginId: 1, status: 1 });

module.exports = mongoose.model('Task', taskSchema);
