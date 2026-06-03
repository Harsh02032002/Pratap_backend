const mongoose = require('mongoose');

const staffSalarySchema = new mongoose.Schema({
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    ownerLoginId: { type: String, required: true },
    month: { type: String, required: true }, // e.g. "May 2026"
    baseSalary: { type: Number, default: 0 },
    deductions: { type: Number, default: 0 },
    bonus: { type: Number, default: 0 },
    netPay: { type: Number, default: 0 },
    status: { type: String, enum: ['Paid', 'Pending'], default: 'Pending' },
    paymentDate: { type: Date },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('StaffSalary', staffSalarySchema);
