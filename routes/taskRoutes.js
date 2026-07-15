const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const { protect, authorize } = require('../middleware/authMiddleware');

// ─── Scope guard ─────────────────────────────────────────────────────────────
// Same pattern already used in routes/employeeRoutes.js: owner/employee scope
// filters are forced to the caller's own identity, ignoring client-supplied values.
// areamanager/superadmin pass through unrestricted.
const scopeTaskQuery = (req, res, next) => {
    if (req.user.role === 'owner') {
        req.query.ownerLoginId = req.user.loginId;
    } else if (req.user.role === 'employee' || req.user.role === 'manager') {
        req.query.assignedStaffLoginId = req.user.loginId;
    }
    next();
};

// Loads the task and checks the caller is allowed to act on it (owner of the task,
// or the employee it's assigned to). areamanager/superadmin bypass the check.
const loadTaskAndAuthorize = async (req, res, next) => {
    try {
        const task = await Task.findById(req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        if (req.user.role === 'owner' && String(task.ownerLoginId || '').toUpperCase() !== String(req.user.loginId || '').toUpperCase()) {
            return res.status(403).json({ error: 'Forbidden: not your task' });
        }
        if ((req.user.role === 'employee' || req.user.role === 'manager') &&
            String(task.assignedStaffLoginId || '').toUpperCase() !== String(req.user.loginId || '').toUpperCase()) {
            return res.status(403).json({ error: 'Forbidden: not assigned to you' });
        }

        req.task = task;
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Failed to load task', details: err.message });
    }
};

/**
 * GET /api/tasks
 * Query: ownerLoginId, assignedStaffLoginId, status, priority, category
 */
router.get('/', protect, authorize('owner', 'employee', 'manager', 'areamanager', 'superadmin'), scopeTaskQuery, async (req, res) => {
    try {
        const { ownerLoginId, assignedStaffLoginId, status, priority, category } = req.query;
        const filter = {};
        if (ownerLoginId) filter.ownerLoginId = ownerLoginId;
        if (assignedStaffLoginId) filter.assignedStaffLoginId = assignedStaffLoginId;
        if (status) filter.status = status;
        if (priority) filter.priority = priority;
        if (category) filter.category = category;

        const tasks = await Task.find(filter).sort({ createdAt: -1 });
        return res.status(200).json({ success: true, data: tasks, count: tasks.length });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch tasks', details: err.message });
    }
});

/**
 * GET /api/tasks/stats/:ownerLoginId
 * Returns task counts by status
 */
router.get('/stats/:ownerLoginId', protect, authorize('owner', 'areamanager', 'superadmin'), (req, res, next) => {
    if (req.user.role === 'owner' && String(req.params.ownerLoginId).toUpperCase() !== String(req.user.loginId).toUpperCase()) {
        return res.status(403).json({ error: 'Forbidden: not your data' });
    }
    next();
}, async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const [pending, inProgress, completed, total] = await Promise.all([
            Task.countDocuments({ ownerLoginId, status: 'Pending' }),
            Task.countDocuments({ ownerLoginId, status: 'In Progress' }),
            Task.countDocuments({ ownerLoginId, status: 'Completed' }),
            Task.countDocuments({ ownerLoginId }),
        ]);
        return res.status(200).json({ success: true, data: { pending, inProgress, completed, total } });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch task stats', details: err.message });
    }
});

/**
 * GET /api/tasks/:id
 */
router.get('/:id', protect, authorize('owner', 'employee', 'manager', 'areamanager', 'superadmin'), loadTaskAndAuthorize, async (req, res) => {
    return res.status(200).json({ success: true, data: req.task });
});

/**
 * POST /api/tasks
 * Only owner/areamanager/superadmin create and assign tasks.
 */
router.post('/', protect, authorize('owner', 'areamanager', 'superadmin'), async (req, res) => {
    try {
        const { title, description, propertyId, propertyName, roomNo,
            assignedStaffId, assignedStaffName, assignedStaffLoginId,
            priority, category, dueDate, notes, createdBy } = req.body;

        const ownerLoginId = req.user.role === 'owner' ? req.user.loginId : req.body.ownerLoginId;

        if (!ownerLoginId || !title) {
            return res.status(400).json({ error: 'Missing required fields: ownerLoginId, title' });
        }

        const task = await Task.create({
            ownerLoginId, title, description, propertyId, propertyName, roomNo,
            assignedStaffId, assignedStaffName, assignedStaffLoginId,
            priority, category, dueDate, notes, createdBy: createdBy || ownerLoginId
        });

        return res.status(201).json({ success: true, data: task });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to create task', details: err.message });
    }
});

/**
 * PATCH /api/tasks/:id
 * Full field update — restricted to management roles.
 */
router.patch('/:id', protect, authorize('owner', 'areamanager', 'superadmin'), loadTaskAndAuthorize, async (req, res) => {
    try {
        const updates = req.body;
        if (updates.status === 'Completed' && !updates.completedAt) {
            updates.completedAt = new Date();
        }
        const task = await Task.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true });
        if (!task) return res.status(404).json({ error: 'Task not found' });
        return res.status(200).json({ success: true, data: task });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update task', details: err.message });
    }
});

/**
 * PATCH /api/tasks/:id/status
 * Quick status update — the assigned staff member or task owner can update status.
 */
router.patch('/:id/status', protect, authorize('owner', 'employee', 'manager', 'areamanager', 'superadmin'), loadTaskAndAuthorize, async (req, res) => {
    try {
        const { status, notes } = req.body;
        const updates = { status };
        if (status === 'Completed') updates.completedAt = new Date();
        if (notes) updates.notes = notes;
        const task = await Task.findByIdAndUpdate(req.params.id, updates, { new: true });
        if (!task) return res.status(404).json({ error: 'Task not found' });
        return res.status(200).json({ success: true, data: task });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to update task status', details: err.message });
    }
});

/**
 * DELETE /api/tasks/:id
 * Only owner/areamanager/superadmin delete tasks.
 */
router.delete('/:id', protect, authorize('owner', 'areamanager', 'superadmin'), loadTaskAndAuthorize, async (req, res) => {
    try {
        const task = await Task.findByIdAndDelete(req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        return res.status(200).json({ success: true, message: 'Task deleted successfully' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete task', details: err.message });
    }
});

module.exports = router;
