const mongoose = require('mongoose');

const staffAttendanceSchema = new mongoose.Schema({
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    ownerLoginId: { type: String, required: true },
    date: { type: Date, required: true },
    status: { type: String, enum: ['Present', 'Absent', 'Half Day', 'Leave'], default: 'Present' },
    checkIn: { type: String }, // e.g., "09:00 AM"
    checkOut: { type: String }, // e.g., "05:00 PM"
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('StaffAttendance', staffAttendanceSchema);
