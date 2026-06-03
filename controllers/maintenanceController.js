const MaintenanceTask = require('../models/MaintenanceTask');

exports.getOwnerTasks = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const tasks = await MaintenanceTask.find({ 
            ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') } 
        }).sort({ createdAt: -1 });
        res.json({ success: true, tasks });
    } catch (err) {
        console.error("Get Owner Maintenance Tasks Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.createTask = async (req, res) => {
    try {
        const { ownerLoginId, title, frequency, scheduledDate, staff } = req.body;
        const task = new MaintenanceTask({
            ownerLoginId: ownerLoginId ? String(ownerLoginId).toUpperCase() : '',
            title,
            frequency,
            scheduledDate,
            staff,
            status: 'Scheduled'
        });
        await task.save();
        res.status(201).json({ success: true, task });
    } catch (err) {
        console.error("Create Maintenance Task Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Update Maintenance Task Status
exports.updateTaskStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const task = await MaintenanceTask.findByIdAndUpdate(
            id,
            { status, updatedAt: new Date() },
            { new: true }
        );
        res.json({ success: true, task });
    } catch (err) {
        console.error("Update Maintenance Task Status Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Assign staff to maintenance task
exports.assignStaff = async (req, res) => {
    try {
        const { id } = req.params;
        const { assignedStaffId, assignedStaffName } = req.body;
        const task = await MaintenanceTask.findByIdAndUpdate(
            id,
            { 
                $set: { 
                    assignedStaffId: assignedStaffId, 
                    assignedStaffName: assignedStaffName,
                    staff: assignedStaffName, // Keep original string field synced
                    status: 'In Progress',
                    updatedAt: new Date()
                }
            },
            { new: true }
        );
        res.json({ success: true, task });
    } catch (err) {
        console.error("Assign Maintenance Staff Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.deleteTask = async (req, res) => {
    try {
        const { id } = req.params;
        await MaintenanceTask.findByIdAndDelete(id);
        res.json({ success: true, message: 'Task deleted successfully' });
    } catch (err) {
        console.error("Delete Maintenance Task Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
