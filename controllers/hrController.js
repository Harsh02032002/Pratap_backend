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
        const { employeeId, employeeLoginId, ownerLoginId, date, status, checkIn, checkOut, notes, leaveType, leaveReason } = req.body;

        // If employeeLoginId provided but no employeeId, look up the employee
        let resolvedEmployeeId = employeeId;
        if (!resolvedEmployeeId && employeeLoginId) {
            const Employee = require('../models/Employee');
            const emp = await Employee.findOne({ loginId: employeeLoginId });
            if (emp) resolvedEmployeeId = emp._id;
        }

        if (!resolvedEmployeeId) {
            return res.status(400).json({ success: false, error: 'employeeId or employeeLoginId required' });
        }

        const parsedDate = new Date(date);
        parsedDate.setHours(0, 0, 0, 0);

        const existing = await StaffAttendance.findOne({ employeeId: resolvedEmployeeId, date: parsedDate });
        if (existing) {
            if (status) existing.status = status;
            if (checkIn) existing.checkIn = checkIn;
            if (checkOut) existing.checkOut = checkOut;
            if (notes !== undefined) existing.notes = notes;
            if (leaveType) existing.leaveType = leaveType;
            if (leaveReason) existing.leaveReason = leaveReason;
            if (employeeLoginId) existing.employeeLoginId = employeeLoginId;
            existing.updatedAt = new Date();
            await existing.save();
            return res.json({ success: true, data: existing });
        }

        const record = new StaffAttendance({
            employeeId: resolvedEmployeeId,
            employeeLoginId: employeeLoginId || '',
            ownerLoginId,
            date: parsedDate,
            status,
            checkIn,
            checkOut,
            notes: notes || '',
            leaveType: leaveType || '',
            leaveReason: leaveReason || '',
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
