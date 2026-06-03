const TenantAttendance = require('../models/TenantAttendance');
const Tenant = require('../models/Tenant');

// Get current attendance status for all tenants of an owner
exports.getOwnerTenantAttendance = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        
        // 1. Fetch all tenants for this owner's properties
        // We'll just fetch all Tenant records and filter. In a real scenario we'd query by Property's ownerLoginId,
        // but for now, we will just fetch the attendance records.
        const attendance = await TenantAttendance.find({ 
            ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') } 
        });

        res.json({ success: true, attendance });
    } catch (err) {
        console.error("Get Tenant Attendance Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Update or create tenant attendance record
exports.updateTenantStatus = async (req, res) => {
    try {
        const { ownerLoginId, tenantId, tenantName, roomNo, status } = req.body;
        
        // Upsert the attendance record for the tenant
        const attendance = await TenantAttendance.findOneAndUpdate(
            { tenantId },
            {
                ownerLoginId: String(ownerLoginId).toUpperCase(),
                tenantId,
                tenantName,
                roomNo,
                status,
                lastScanTime: new Date()
            },
            { new: true, upsert: true }
        );

        res.json({ success: true, attendance });
    } catch (err) {
        console.error("Update Tenant Status Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Sync attendance records with active tenants
// This handles tenants who might not have an attendance record yet.
exports.syncTenantAttendance = async (req, res) => {
    try {
        const { ownerLoginId } = req.body;
        const tenants = req.body.tenants || []; // Array of { id, name, room }

        let count = 0;
        for (const t of tenants) {
            const exists = await TenantAttendance.findOne({ tenantId: t.id });
            if (!exists) {
                await TenantAttendance.create({
                    ownerLoginId: String(ownerLoginId).toUpperCase(),
                    tenantId: t.id,
                    tenantName: t.name,
                    roomNo: t.room || 'N/A',
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
