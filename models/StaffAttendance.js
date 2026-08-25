const mongoose = require('mongoose');

const staffAttendanceSchema = new mongoose.Schema({
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeLoginId: { type: String, default: '' },
    ownerLoginId: { type: String, required: true, trim: true, uppercase: true },
    date: { type: Date, required: true },
    status: { type: String, enum: ['Present', 'Absent', 'Half Day', 'Leave', 'Late'], default: 'Present' },
    checkIn: { type: String }, // e.g., "09:00 AM"
    checkOut: { type: String }, // e.g., "05:00 PM"
    notes: { type: String, default: '' },
    leaveType: { type: String, enum: ['Sick Leave', 'Casual Leave', 'Emergency Leave', ''], default: '' },
    leaveReason: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

staffAttendanceSchema.index({ employeeId: 1, date: 1 });
// Serves getAttendance: find({ ownerLoginId }).sort({ date: -1 }) — the filter
// and the sort are both covered, so no in-memory sort is needed.
staffAttendanceSchema.index({ ownerLoginId: 1, date: -1 });

module.exports = mongoose.model('StaffAttendance', staffAttendanceSchema);
