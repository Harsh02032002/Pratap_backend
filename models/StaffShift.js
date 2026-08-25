const mongoose = require('mongoose');

const staffShiftSchema = new mongoose.Schema({
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    ownerLoginId: { type: String, required: true, trim: true, uppercase: true },
    shiftName: { type: String, required: true },
    startTime: { type: String, required: true }, // e.g. "08:00 AM"
    endTime: { type: String, required: true },   // e.g. "04:00 PM"
    days: [{ type: String }], // e.g. ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

// Serves getShifts: find({ ownerLoginId }) — unsorted, so a single-field index.
staffShiftSchema.index({ ownerLoginId: 1 });

module.exports = mongoose.model('StaffShift', staffShiftSchema);
