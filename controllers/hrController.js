const StaffAttendance = require('../models/StaffAttendance');
const StaffSalary = require('../models/StaffSalary');
const StaffShift = require('../models/StaffShift');

// --- Attendance ---
exports.getAttendance = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const records = await StaffAttendance.find({
            ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') }
        }).populate('employeeId', 'name role').sort({ date: -1 });
        res.json({ success: true, data: records });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

exports.markAttendance = async (req, res) => {
    try {
        const { employeeId, ownerLoginId, date, status, checkIn, checkOut } = req.body;
        const parsedDate = new Date(date);
        parsedDate.setHours(0, 0, 0, 0);

        const existing = await StaffAttendance.findOne({ employeeId, date: parsedDate });
        if (existing) {
            existing.status = status || existing.status;
            existing.checkIn = checkIn || existing.checkIn;
            existing.checkOut = checkOut || existing.checkOut;
            existing.updatedAt = new Date();
            await existing.save();
            return res.json({ success: true, data: existing });
        }

        const record = new StaffAttendance({
            employeeId,
            ownerLoginId,
            date: parsedDate,
            status,
            checkIn,
            checkOut
        });
        await record.save();
        res.json({ success: true, data: record });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

// --- Salaries ---
exports.getSalaries = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const records = await StaffSalary.find({
            ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') }
        }).populate('employeeId', 'name role').sort({ createdAt: -1 });
        res.json({ success: true, data: records });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

exports.processSalary = async (req, res) => {
    try {
        const { employeeId, ownerLoginId, month, baseSalary, deductions, bonus, status } = req.body;
        const netPay = (Number(baseSalary) || 0) + (Number(bonus) || 0) - (Number(deductions) || 0);
        
        const existing = await StaffSalary.findOne({ employeeId, month });
        if (existing) {
            existing.baseSalary = baseSalary;
            existing.deductions = deductions;
            existing.bonus = bonus;
            existing.netPay = netPay;
            existing.status = status;
            if (status === 'Paid' && existing.status !== 'Paid') existing.paymentDate = new Date();
            await existing.save();
            return res.json({ success: true, data: existing });
        }

        const record = new StaffSalary({
            employeeId,
            ownerLoginId,
            month,
            baseSalary,
            deductions,
            bonus,
            netPay,
            status,
            paymentDate: status === 'Paid' ? new Date() : null
        });
        await record.save();
        res.json({ success: true, data: record });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

// --- Shifts ---
exports.getShifts = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const records = await StaffShift.find({
            ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') }
        }).populate('employeeId', 'name role');
        res.json({ success: true, data: records });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};

exports.saveShift = async (req, res) => {
    try {
        const { employeeId, ownerLoginId, shiftName, startTime, endTime, days } = req.body;
        
        const existing = await StaffShift.findOne({ employeeId });
        if (existing) {
            existing.shiftName = shiftName;
            existing.startTime = startTime;
            existing.endTime = endTime;
            existing.days = days;
            await existing.save();
            return res.json({ success: true, data: existing });
        }

        const record = new StaffShift({
            employeeId,
            ownerLoginId,
            shiftName,
            startTime,
            endTime,
            days
        });
        await record.save();
        res.json({ success: true, data: record });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
};
