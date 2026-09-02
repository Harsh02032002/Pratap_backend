const Tenant = require('../models/Tenant');
const Room = require('../models/Room');

// Fixed one-month notice period. The exit clock starts the day the owner
// approves the move-out request — not the day the tenant submitted it, and not
// the tenant's requested date.
const NOTICE_PERIOD_MONTHS = 1;

/**
 * Returns the date the notice period ends, given the approval date.
 * Uses calendar-month arithmetic so 31 Jan + 1 month lands on 28/29 Feb rather
 * than spilling into March.
 */
function calcNoticeEndDate(approvedAt = new Date()) {
    const start = new Date(approvedAt);
    const end = new Date(start);
    end.setMonth(end.getMonth() + NOTICE_PERIOD_MONTHS);
    // setMonth overflows when the target month is shorter (e.g. 31 Jan -> 3 Mar).
    // Clamp back to the last day of the intended month.
    if (end.getDate() !== start.getDate()) end.setDate(0);
    // Normalise to the start of the day. The completion job runs at 01:00, so
    // keeping the approval's time-of-day here (e.g. 15:40) would push the exit
    // to the following day's run — the tenant would serve a month plus a day.
    end.setHours(0, 0, 0, 0);
    return end;
}

/**
 * True when the tenant is serving their notice period: the owner has approved
 * the exit but the notice month has not finished, so they are still a resident.
 */
function isOnNotice(tenant) {
    return !!tenant
        && tenant.moveoutRequest?.status === 'approved'
        && !tenant.moveoutRequest?.completedAt
        && tenant.status !== 'inactive';
}

/**
 * Completes a move-out: the tenant becomes an ex-tenant, their bed is released
 * back to the room, and their panel login is revoked.
 *
 * Idempotent — calling it on an already-completed tenant is a no-op, so a cron
 * re-run or a manual trigger racing the job cannot double-release a bed that
 * has since been assigned to somebody new.
 */
async function completeMoveout(tenant) {
    if (!tenant || tenant.moveoutRequest?.completedAt) return false;

    // Release the bed so the room shows as vacant again. Mirrors the cleanup
    // that DELETE /api/tenants/:id already performs.
    const tenantId = String(tenant._id);
    const rooms = await Room.find({ 'bedAssignments.tenantId': tenant._id });
    for (const room of rooms) {
        room.bedAssignments = room.bedAssignments.map((assignment) => {
            if (assignment?.tenantId && String(assignment.tenantId) === tenantId) return {};
            return assignment;
        });
        room.markModified('bedAssignments');
        await room.save();
    }

    tenant.status = 'inactive';
    tenant.moveoutRequest.completedAt = new Date();
    tenant.room = undefined;
    await tenant.save();

    // Revoke tenant panel access. Required in addition to tenant.status because
    // the login handler keys off the User document.
    const User = require('../models/user');
    if (tenant.user) await User.findByIdAndUpdate(tenant.user, { $set: { isActive: false } });
    if (tenant.loginId) {
        await User.updateOne({ loginId: tenant.loginId, role: 'tenant' }, { $set: { isActive: false } });
    }

    return true;
}

/**
 * Finds every tenant whose notice period has elapsed and completes their exit.
 * Returns the tenants that were moved out, for logging/notification by caller.
 */
async function completeElapsedNotices(now = new Date()) {
    const due = await Tenant.find({
        'moveoutRequest.status': 'approved',
        'moveoutRequest.completedAt': { $exists: false },
        'moveoutRequest.noticeEndDate': { $lte: now },
        status: { $ne: 'inactive' },
        isDeleted: { $ne: true }
    });

    const completed = [];
    for (const tenant of due) {
        try {
            if (await completeMoveout(tenant)) completed.push(tenant);
        } catch (err) {
            console.error(`❌ Move-out completion failed for ${tenant.loginId}:`, err.message);
        }
    }
    return completed;
}

module.exports = {
    NOTICE_PERIOD_MONTHS,
    calcNoticeEndDate,
    isOnNotice,
    completeMoveout,
    completeElapsedNotices
};
