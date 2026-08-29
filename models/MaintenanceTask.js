const mongoose = require('mongoose');

const maintenanceTaskSchema = new mongoose.Schema({
    ownerLoginId: { type: String, required: true, index: true, trim: true, uppercase: true },

    // Which property this task belongs to.
    //
    // Deliberately NOT required: tasks created before this field existed have
    // no property, and back-filling them with a guess would attach work to the
    // wrong building. Those legacy rows are visible to the OWNER only (and only
    // in the "All Properties" view) — staff never see them. See
    // controllers/maintenanceController.js buildTaskScope().
    //
    // Without this field a Warden at property A could see, and assign staff
    // from, every other property the owner runs — the whole list was scoped by
    // ownerLoginId alone.
    propertyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', default: null, index: true },

    title: { type: String, required: true },
    frequency: { type: String, enum: ['Daily', 'Weekly', 'Monthly', 'Quarterly', 'Bi-Annually', 'Yearly', 'One-time'], default: 'One-time' },
    scheduledDate: { type: String, required: true },
    staff: { type: String, required: true },
    assignedStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee' },
    assignedStaffName: { type: String },
    status: { type: String, enum: ['Scheduled', 'In Progress', 'Completed', 'Cancelled'], default: 'Scheduled' },
    createdByRole: { type: String, default: 'owner' },
    createdById: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// The only query this collection serves is "tasks for this owner, optionally
// narrowed to one property, newest first" — one compound index covers it.
maintenanceTaskSchema.index({ ownerLoginId: 1, propertyId: 1, createdAt: -1 });

module.exports = mongoose.model('MaintenanceTask', maintenanceTaskSchema);
