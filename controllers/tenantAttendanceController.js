const TenantAttendance = require('../models/TenantAttendance');
const Tenant = require('../models/Tenant');

// Get attendance status for all tenants of an owner — either for a single
// date (existing behavior) or a whole month (for history views), optionally
// scoped to one tenant.
exports.getOwnerTenantAttendance = async (req, res) => {
    try {
        // Set by scopeOwnerLoginId middleware — never trust a client-supplied
        // ownerLoginId directly, and never allow an unscoped (all-owners) query.
        const ownerLoginId = req.effectiveOwnerLoginId;
        const { date, month, year, tenantId } = req.query;

        let query = { ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') } };
        if (tenantId) {
            query.tenantId = tenantId;
        }
        if (date) {
            query.date = date;
        } else if (month && year) {
            // date is stored as a "YYYY-MM-DD" string, so a zero-padded prefix
            // match is a correct and index-friendly way to select a whole month
            const mm = String(month).padStart(2, '0');
            query.date = { $regex: '^' + year + '-' + mm };
        }

        const attendance = await TenantAttendance.find(query).sort({ date: -1 }).lean();

        // For backward compatibility and frontend expectations, return both keys
        res.json({ success: true, data: attendance, attendance });
    } catch (err) {
        console.error("Get Tenant Attendance Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Update or create tenant attendance record
exports.updateTenantStatus = async (req, res) => {
    try {
        const ownerLoginId = req.effectiveOwnerLoginId;
        const { tenantLoginId, tenantId, tenantName, roomNo, status, date } = req.body;

        let finalTenantId = tenantId;
        let finalTenantName = tenantName;
        let finalRoomNo = roomNo;

        // Find tenant document if missing info
        let tenantDoc = null;
        if (finalTenantId) {
            tenantDoc = await Tenant.findById(finalTenantId);
        } else if (tenantLoginId) {
            tenantDoc = await Tenant.findOne({ loginId: tenantLoginId });
        }

        if (tenantDoc) {
            finalTenantId = tenantDoc._id;
            finalTenantName = tenantDoc.name;
            finalRoomNo = tenantDoc.roomNo || 'N/A';

            // A caller may only mark attendance for their own tenants — without
            // this check, a staff member could mark attendance for any tenant
            // ID belonging to a different owner entirely.
            if (String(tenantDoc.ownerLoginId || '').toUpperCase() !== String(ownerLoginId).toUpperCase()) {
                return res.status(403).json({ success: false, message: 'Forbidden: tenant does not belong to your account' });
            }
        }

        if (!finalTenantId) {
            return res.status(400).json({ success: false, message: 'Tenant identity not found' });
        }

        const finalDate = date || new Date().toISOString().split('T')[0];

        // Upsert the attendance record for the tenant on this specific date
        const attendance = await TenantAttendance.findOneAndUpdate(
            { tenantId: finalTenantId, date: finalDate },
            {
                ownerLoginId: String(ownerLoginId).toUpperCase(),
                tenantId: finalTenantId,
                tenantName: finalTenantName,
                roomNo: finalRoomNo || 'N/A',
                status,
                date: finalDate,
                lastScanTime: new Date()
            },
            { new: true, upsert: true }
        );

        res.json({ success: true, attendance });
    } catch (err) {
        console.error("Update Tenant Status Error:", err);
        res.status(500).json({ success: false, message: err.message || 'Server error' });
    }
};

// Sync attendance records with active tenants
exports.syncTenantAttendance = async (req, res) => {
    try {
        const ownerLoginId = req.effectiveOwnerLoginId;
        const requestedTenants = req.body.tenants || []; // Array of { id, name, room }

        // Only sync tenants that actually belong to the caller's own scope —
        // otherwise a caller could plant attendance rows against tenant IDs
        // that belong to a different owner.
        const ownedTenantIds = new Set(
            (await Tenant.find({
                _id: { $in: requestedTenants.map(t => t.id).filter(Boolean) },
                ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') }
            }).select('_id').lean()).map(t => String(t._id))
        );
        const tenants = requestedTenants.filter(t => ownedTenantIds.has(String(t.id)));

        let count = 0;
        const todayStr = new Date().toISOString().split('T')[0];

        for (const t of tenants) {
            const exists = await TenantAttendance.findOne({ tenantId: t.id, date: todayStr });
            if (!exists) {
                await TenantAttendance.create({
                    ownerLoginId: String(ownerLoginId).toUpperCase(),
                    tenantId: t.id,
                    tenantName: t.name,
                    roomNo: t.room || 'N/A',
                    date: todayStr,
                    status: 'Inside' // Default state
                });
                count++;
            }
        }

        res.json({ success: true, message: `Synced ${count} new tenants.` });
    } catch (err) {
        console.error("Sync Tenant Attendance Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
}
