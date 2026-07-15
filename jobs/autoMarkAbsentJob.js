'use strict';
const cron = require('node-cron');
const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const StaffAttendance = require('../models/StaffAttendance');
const StaffShift = require('../models/StaffShift');
const { acquireLock, releaseLock } = require('../services/cronLockService');

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Never backfill further back than this many days, even if a gap is older —
// protects against flooding old, pre-feature history with retroactive "Absent"
// records and bounds the per-run workload.
const MAX_BACKFILL_DAYS = 90;

function dateKey(date) {
    return new Date(date).toISOString().slice(0, 10);
}

// Marks Warden staff absent for every completed day that has no attendance
// record at all (no check-in, no leave request, no manual entry by the owner).
// Only Wardens are auto-marked — every other role is left "Not Marked" when the
// owner doesn't record anything, so their history stays blank rather than being
// forced to Absent. Scans a bounded window of past days each run — not just
// "yesterday" — so a day that was missed keeps getting picked up on every
// subsequent run until it's filled in, instead of being skipped forever the
// moment it stops being "yesterday".
async function runAutoMarkAbsentJob() {
    if (mongoose.connection.readyState !== 1) {
        console.warn('[AutoAbsent] DB not connected, skipping');
        return;
    }

    const lockAcquired = await acquireLock('autoMarkAbsent', 15);
    if (!lockAcquired) {
        console.warn('[AutoAbsent] Another instance is already running — skipping this execution');
        return;
    }

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0); // exclusive upper bound — only fully-completed days are evaluated

        const globalFloor = new Date(today);
        globalFloor.setDate(globalFloor.getDate() - MAX_BACKFILL_DAYS);

        // Only Wardens get auto-marked absent. Match case-insensitively since
        // `role` is a free-text field ("Warden", "warden", …). Every other role
        // is intentionally excluded so unmarked days stay "Not Marked".
        const activeStaff = await Employee.find({
            isActive: true,
            isDeleted: { $ne: true },
            role: { $regex: /^\s*warden\s*$/i }
        }).select('_id loginId parentLoginId createdAt').lean();

        if (activeStaff.length === 0) {
            console.log('[AutoAbsent] No active Warden staff to evaluate');
            return;
        }

        const staffIds = activeStaff.map(e => e._id);

        // Pull every existing record across the whole window once, instead of
        // querying per employee per day — cheap even for a 90-day scan.
        const existingRecords = await StaffAttendance.find({
            employeeId: { $in: staffIds },
            date: { $gte: globalFloor, $lt: today }
        }).select('employeeId date').lean();
        const recordedSet = new Set(
            existingRecords.map(r => `${r.employeeId}|${dateKey(r.date)}`)
        );

        const shifts = await StaffShift.find({ employeeId: { $in: staffIds } }).select('employeeId days').lean();
        const shiftDaysMap = new Map(
            shifts
                .filter(s => Array.isArray(s.days) && s.days.length > 0)
                .map(s => [String(s.employeeId), new Set(s.days)])
        );

        const docsToInsert = [];
        const missingOwner = new Set();

        for (const emp of activeStaff) {
            const empIdStr = String(emp._id);
            const empShiftDays = shiftDaysMap.get(empIdStr);

            const empStart = new Date(emp.createdAt);
            empStart.setHours(0, 0, 0, 0);
            const cursor = new Date(Math.max(empStart.getTime(), globalFloor.getTime()));

            while (cursor < today) {
                const dayName = WEEKDAY_NAMES[cursor.getDay()];
                const isScheduledOff = empShiftDays && !empShiftDays.has(dayName);
                const key = `${empIdStr}|${dateKey(cursor)}`;

                if (!isScheduledOff && !recordedSet.has(key)) {
                    if (!emp.parentLoginId) {
                        missingOwner.add(emp.loginId);
                    } else {
                        docsToInsert.push({
                            employeeId: emp._id,
                            employeeLoginId: emp.loginId,
                            ownerLoginId: emp.parentLoginId,
                            date: new Date(cursor),
                            status: 'Absent',
                            notes: 'Auto-marked absent — no attendance recorded'
                        });
                    }
                }
                cursor.setDate(cursor.getDate() + 1);
            }
        }

        if (missingOwner.size > 0) {
            console.warn(`[AutoAbsent] Skipped staff with no parentLoginId set: ${[...missingOwner].join(', ')}`);
        }

        let insertedCount = 0;
        if (docsToInsert.length > 0) {
            try {
                const result = await StaffAttendance.insertMany(docsToInsert, { ordered: false });
                insertedCount = result.length;
            } catch (insertErr) {
                // insertMany with ordered:false still writes the valid docs and throws
                // a bulk error describing which ones failed — surface that instead of
                // letting it pass as a silent partial success.
                insertedCount = insertErr.insertedDocs?.length || 0;
                const failedCount = docsToInsert.length - insertedCount;
                console.error(`❌ Auto-absent job: ${insertedCount} inserted, ${failedCount} failed — ${insertErr.message}`);
            }
        }

        console.log(`✅ Auto-absent job: backfilled ${insertedCount} absent record(s) across ${activeStaff.length} active Warden(s) (scanned up to ${MAX_BACKFILL_DAYS} days back)`);
    } catch (err) {
        console.error('❌ Auto-absent job error:', err.message);
    } finally {
        await releaseLock('autoMarkAbsent');
    }
}

// Serverless-safe entry point: runs the backfill at most once per day, no matter
// how many requests call it. On Vercel (and any host that doesn't keep a
// long-running process alive) the node-cron schedule below never fires, so this
// is invoked lazily from the owner's attendance fetch instead. The day-scoped
// lock (TTL just under 24h, never explicitly released) guarantees only the first
// caller each day actually does the work; everyone else returns immediately.
async function ensureDailyAutoMarkAbsent() {
    if (mongoose.connection.readyState !== 1) return;
    // 20h TTL: long enough that repeat requests the same day are skipped, short
    // enough that the lock has expired by the same time tomorrow and can re-run.
    const gotDaily = await acquireLock('autoMarkAbsentDaily', 20 * 60);
    if (!gotDaily) return; // already ran (or is running) today
    await runAutoMarkAbsentJob();
}

function registerAutoMarkAbsentJob() {
    // Runs daily at 12:15 AM — re-scans the backfill window every time so any
    // gap (a missed run, a day nobody marked) gets caught on the next run.
    cron.schedule('15 0 * * *', runAutoMarkAbsentJob);
    console.log('🕐 Auto-absent attendance job scheduled: Daily 12:15 AM (gap-scanning, up to 90 days back)');
}

module.exports = { registerAutoMarkAbsentJob, runAutoMarkAbsentJob, ensureDailyAutoMarkAbsent };
