const express = require('express');
const router = express.Router();
const Task = require('../models/Task');

/**
 * GET /api/tasks
 * Query: ownerLoginId, assignedStaffLoginId, status, priority, category
 */
router.get('/', async (req, res) => {
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
router.get('/stats/:ownerLoginId', async (req, res) => {
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
router.get('/:id', async (req, res) => {
    try {
        const task = await Task.findById(req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        return res.status(200).json({ success: true, data: task });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to fetch task', details: err.message });
    }
});

/**
 * POST /api/tasks
 */
router.post('/', async (req, res) => {
    try {
        const { ownerLoginId, title, description, propertyId, propertyName, roomNo,
            assignedStaffId, assignedStaffName, assignedStaffLoginId,
            priority, category, dueDate, notes, createdBy } = req.body;

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
 * Update task fields
 */
router.patch('/:id', async (req, res) => {
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
 * Quick status update
 */
router.patch('/:id/status', async (req, res) => {
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
 */
router.delete('/:id', async (req, res) => {
    try {
        const task = await Task.findByIdAndDelete(req.params.id);
        if (!task) return res.status(404).json({ error: 'Task not found' });
        return res.status(200).json({ success: true, message: 'Task deleted successfully' });
    } catch (err) {
        return res.status(500).json({ error: 'Failed to delete task', details: err.message });
    }
});

module.exports = router;
