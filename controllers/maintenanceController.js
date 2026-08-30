const mongoose = require('mongoose');
const MaintenanceTask = require('../models/MaintenanceTask');
const Employee = require('../models/Employee');
const Property = require('../models/Property');
const { normalizeLoginId } = require('../utils/normalizeId');

/**
 * Maintenance tasks are scoped to a PROPERTY, not just to an owner.
 *
 * Before this, every query was `find({ ownerLoginId })` and the task carried no
 * property at all. A Warden assigned to one building could see every task the
 * owner had anywhere, and assign staff from any other building to them. These
 * helpers are the single place that decides what a caller may see and touch.
 */

/** Ids of the properties a staff member is assigned to, as strings. */
function staffPropertyIds(user) {
    const raw = Array.isArray(user?.assignedProperties) ? user.assignedProperties : [];
    return raw.map((p) => String(p?._id || p?.id || p)).filter(Boolean);
}

const isStaff = (user) => user?.role === 'employee' || user?.role === 'manager';

/**
 * Mongo filter for the tasks this caller is allowed to read.
 *
 * Staff  → only their assigned properties. Legacy tasks (propertyId null) are
 *          excluded entirely: we cannot prove which building they belong to, so
 *          showing them to a Warden would reproduce the leak this fixes.
 * Owner  → their own properties, plus legacy tasks so nothing disappears from
 *          the owner's view. Narrowed to one property when one is requested.
 */
function buildTaskScope(req, ownerLoginId) {
    const scope = { ownerLoginId };
    const requested = req.query.propertyId && req.query.propertyId !== 'all'
        ? String(req.query.propertyId)
        : null;

    if (isStaff(req.user)) {
        const allowed = staffPropertyIds(req.user);
        if (allowed.length === 0) {
            // Assigned to nothing — sees nothing, rather than everything.
            return { scope: null, reason: 'no_assigned_properties' };
        }
        // A staff member asking for a property they are not assigned to gets
        // their own properties, never the one they asked for.
        const ids = requested && allowed.includes(requested) ? [requested] : allowed;
        scope.propertyId = { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) };
        return { scope, reason: null };
    }

    if (requested && mongoose.isValidObjectId(requested)) {
        scope.propertyId = new mongoose.Types.ObjectId(requested);
    }
    // No property requested → owner sees everything they own, legacy included.
    return { scope, reason: null };
}

/**
 * May this staff member be assigned to work at this property?
 *
 * Staff with no assigned property are treated as owner-level (an Accountant, a
 * roving Manager) and allowed anywhere within the owner. Staff who ARE assigned
 * somewhere must be assigned to this property specifically.
 *
 * @returns {Promise<{ok: boolean, message?: string, employee?: object}>}
 */
async function assertStaffAllowedOnProperty(staffId, ownerLoginId, propertyId) {
    if (!staffId) return { ok: true, employee: null }; // unassigning is always fine

    if (!mongoose.isValidObjectId(staffId)) {
        return { ok: false, message: 'Invalid staff selected' };
    }

    const employee = await Employee.findById(staffId)
        .select('_id name role parentLoginId assignedProperties isDeleted')
        .lean();

    if (!employee || employee.isDeleted) {
        return { ok: false, message: 'Staff member not found' };
    }

    // Cross-owner assignment is never allowed, whatever the property says.
    if (normalizeLoginId(String(employee.parentLoginId || '')) !== ownerLoginId) {
        return { ok: false, message: 'That staff member does not belong to this account' };
    }

    const assigned = staffPropertyIds(employee);
    if (assigned.length === 0) return { ok: true, employee }; // owner-level staff

    if (!propertyId) {
        // Property-bound staff cannot be put on a task that has no property.
        return { ok: false, message: 'Select a property before assigning this staff member' };
    }

    if (!assigned.includes(String(propertyId))) {
        return { ok: false, message: 'That staff member is not assigned to this property' };
    }

    return { ok: true, employee };
}

/** The property a task should be created against, validated against the owner. */
async function resolveCreateProperty(req, ownerLoginId) {
    const raw = req.body.propertyId;

    if (isStaff(req.user)) {
        // Staff never choose — they are pinned to their own assignment.
        const allowed = staffPropertyIds(req.user);
        if (allowed.length === 0) {
            return { ok: false, message: 'Your account is not assigned to a property' };
        }
        if (raw && allowed.includes(String(raw))) return { ok: true, propertyId: String(raw) };
        return { ok: true, propertyId: allowed[0] };
    }

    if (!raw || raw === 'all') {
        return { ok: false, message: 'Select a property for this maintenance task' };
    }
    if (!mongoose.isValidObjectId(raw)) {
        return { ok: false, message: 'Invalid property selected' };
    }

    // Never trust a property id from the body — confirm the owner owns it.
    const owned = await Property.exists({
        _id: raw,
        ownerLoginId,
        isDeleted: { $ne: true },
    });
    if (!owned) return { ok: false, message: 'That property does not belong to this account' };

    return { ok: true, propertyId: String(raw) };
}

/** Load a task and confirm the caller is allowed to act on it. */
async function loadTaskForCaller(req, taskId) {
    if (!mongoose.isValidObjectId(taskId)) {
        return { ok: false, status: 400, message: 'Invalid task id' };
    }
    const task = await MaintenanceTask.findById(taskId);
    if (!task) return { ok: false, status: 404, message: 'Task not found' };

    if (task.ownerLoginId !== req.effectiveOwnerLoginId) {
        // Same 404 as a missing task — do not confirm another owner's task exists.
        return { ok: false, status: 404, message: 'Task not found' };
    }

    if (isStaff(req.user)) {
        const allowed = staffPropertyIds(req.user);
        const taskProperty = task.propertyId ? String(task.propertyId) : null;
        if (!taskProperty || !allowed.includes(taskProperty)) {
            return { ok: false, status: 403, message: 'This task belongs to another property' };
        }
    }

    return { ok: true, task };
}

// ── Handlers ────────────────────────────────────────────────────────────────

exports.getOwnerTasks = async (req, res) => {
    try {
        const ownerLoginId = req.effectiveOwnerLoginId;
        const { scope } = buildTaskScope(req, ownerLoginId);

        // Staff with no property assignment see an empty list, not everything.
        if (!scope) return res.json({ success: true, tasks: [] });

        const tasks = await MaintenanceTask.find(scope).sort({ createdAt: -1 }).lean();
        res.json({ success: true, tasks });
    } catch (err) {
        console.error('Get Owner Maintenance Tasks Error:', err.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.createTask = async (req, res) => {
    try {
        const ownerLoginId = req.effectiveOwnerLoginId;
        const { title, frequency, scheduledDate, staff, assignedStaffName, createdByRole, createdById } = req.body;

        const property = await resolveCreateProperty(req, ownerLoginId);
        if (!property.ok) return res.status(400).json({ success: false, message: property.message });

        let assignedStaffId = req.body.assignedStaffId || null;
        if (assignedStaffId === '') assignedStaffId = null;

        const allowed = await assertStaffAllowedOnProperty(assignedStaffId, ownerLoginId, property.propertyId);
        if (!allowed.ok) return res.status(403).json({ success: false, message: allowed.message });

        // Trust the employee record for the name rather than the request body.
        const resolvedName = allowed.employee?.name || assignedStaffName || staff || 'Unassigned';

        const task = await MaintenanceTask.create({
            ownerLoginId,
            propertyId: property.propertyId,
            title,
            frequency,
            scheduledDate,
            staff: resolvedName,
            assignedStaffId,
            assignedStaffName: assignedStaffId ? resolvedName : null,
            status: 'Scheduled',
            createdByRole: createdByRole || req.user?.role || 'owner',
            createdById: createdById || req.user?.loginId || ownerLoginId,
        });

        res.status(201).json({ success: true, task });
    } catch (err) {
        console.error('Create Maintenance Task Error:', err.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.updateTaskStatus = async (req, res) => {
    try {
        const loaded = await loadTaskForCaller(req, req.params.id);
        if (!loaded.ok) return res.status(loaded.status).json({ success: false, message: loaded.message });

        const { status } = req.body;
        if (!MaintenanceTask.schema.path('status').enumValues.includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        loaded.task.status = status;
        loaded.task.updatedAt = new Date();
        await loaded.task.save();

        res.json({ success: true, task: loaded.task });
    } catch (err) {
        console.error('Update Maintenance Task Status Error:', err.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.assignStaff = async (req, res) => {
    try {
        const loaded = await loadTaskForCaller(req, req.params.id);
        if (!loaded.ok) return res.status(loaded.status).json({ success: false, message: loaded.message });

        const { task } = loaded;
        let { assignedStaffId } = req.body;
        if (assignedStaffId === '' || !assignedStaffId) assignedStaffId = null;

        // The check that closes the reported hole: the staff member must belong
        // to THIS task's property (or be owner-level with no property at all).
        const allowed = await assertStaffAllowedOnProperty(
            assignedStaffId,
            task.ownerLoginId,
            task.propertyId ? String(task.propertyId) : null,
        );
        if (!allowed.ok) return res.status(403).json({ success: false, message: allowed.message });

        const resolvedName = allowed.employee?.name || null;

        task.assignedStaffId = assignedStaffId;
        task.assignedStaffName = resolvedName;
        task.staff = resolvedName || 'Unassigned';
        task.updatedAt = new Date();
        await task.save();

        res.json({ success: true, task });
    } catch (err) {
        console.error('Assign Maintenance Staff Error:', err.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

exports.deleteTask = async (req, res) => {
    try {
        const loaded = await loadTaskForCaller(req, req.params.id);
        if (!loaded.ok) return res.status(loaded.status).json({ success: false, message: loaded.message });

        await MaintenanceTask.deleteOne({ _id: loaded.task._id });
        res.json({ success: true, message: 'Task deleted successfully' });
    } catch (err) {
        console.error('Delete Maintenance Task Error:', err.message);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Exported for tests.
exports._internals = {
    staffPropertyIds,
    buildTaskScope,
    assertStaffAllowedOnProperty,
    resolveCreateProperty,
};
