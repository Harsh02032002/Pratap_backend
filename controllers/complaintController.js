const mongoose = require('mongoose');
const Complaint = require('../models/Complaint');

// Get all complaints for a specific tenant
exports.getTenantComplaints = async (req, res) => {
    try {
        const { tenantId } = req.params;

        // Ownership enforcement for tenants.
        //
        // req.user is a User document (set by protect middleware via JWT).
        // The Tenant collection is separate — there is no req.user.tenantId.
        // We resolve the caller's Tenant record by loginId (indexed, single-row read)
        // and compare its _id against the URL parameter.
        //
        // Admin roles bypass this check and can access any tenant's complaints.
        if (req.user.role === 'tenant') {
            const Tenant = require('../models/Tenant');
            const authTenant = await Tenant.findOne(
                { loginId: req.user.loginId },
                { _id: 1 }   // projection — only _id needed
            );

            if (!authTenant) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }

            if (String(authTenant._id) !== String(tenantId)) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        }

        const complaints = await Complaint.find({ tenantId }).sort({ createdAt: -1 });
        res.json({ success: true, complaints });
    } catch (err) {
        console.error("Get Tenant Complaints Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Get all complaints for a specific owner
exports.getOwnerComplaints = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        // Use exact uppercase match — all loginIds stored uppercase, so this hits the index
        const normalizedId = String(ownerLoginId || '').trim().toUpperCase();

        // Ownership enforcement: owners may only access their own complaints.
        // superadmin and areamanager have unrestricted cross-owner visibility.
        if (req.user.role === 'owner') {
            const callerLoginId = String(req.user.loginId || '').trim().toUpperCase();
            if (callerLoginId !== normalizedId) {
                return res.status(403).json({ success: false, message: 'Forbidden' });
            }
        }

        // Primary: complaints tagged with this owner's loginId (index scan, not collection scan)
        const byOwner = await Complaint.find({ ownerLoginId: normalizedId }).sort({ createdAt: -1 });

        // Fallback: complaints from this owner's tenants that lack ownerLoginId
        // (handles older complaints where ownerLoginId wasn't stored)
        const Tenant = require('../models/Tenant');
        const ownerTenants = await Tenant.find({ ownerLoginId: normalizedId }, '_id');
        const tenantIds = ownerTenants.map(t => String(t._id));

        let complaints = byOwner;
        if (tenantIds.length > 0) {
            const byTenant = await Complaint.find({
                tenantId: { $in: tenantIds },
                $or: [{ ownerLoginId: { $exists: false } }, { ownerLoginId: '' }, { ownerLoginId: null }]
            }).sort({ createdAt: -1 });

            if (byTenant.length > 0) {
                const seen = new Set(byOwner.map(c => String(c._id)));
                const extra = byTenant.filter(c => !seen.has(String(c._id)));
                complaints = [...byOwner, ...extra].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            }
        }

        res.json({ success: true, complaints });
    } catch (err) {
        console.error("Get Owner Complaints Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Create a new complaint
exports.createComplaint = async (req, res) => {
    try {
        // Resolve the authenticated tenant from the DB using the verified JWT identity.
        // Never read tenantId, tenantLoginId, tenantName, or any other identity field
        // from req.body — the caller controls the body and can impersonate any tenant.
        const Tenant = require('../models/Tenant');
        const authTenant = await Tenant.findOne(
            { loginId: req.user.loginId },
            { _id: 1, loginId: 1, name: 1, phone: 1, email: 1,
              propertyTitle: 1, property: 1, roomNo: 1, bedNo: 1, ownerLoginId: 1 }
        );
        if (!authTenant) {
            return res.status(403).json({ success: false, message: 'Forbidden' });
        }

        // Complaint content fields are legitimate user input — read from req.body.
        // Identity and property fields are derived exclusively from the DB record above.
        const { category, issueType, description, priority, type, escalated, imageStr } = req.body;

        // Resolve ownerLoginId from the trusted DB tenant record.
        // Fall back to a Property lookup if the tenant record doesn't carry it directly.
        let ownerLoginId = authTenant.ownerLoginId || '';
        if (!ownerLoginId && authTenant.property) {
            try {
                const Property = require('../models/Property');
                const p = await Property.findById(authTenant.property, { ownerLoginId: 1 });
                if (p?.ownerLoginId) ownerLoginId = p.ownerLoginId;
            } catch {
                // Non-fatal — complaint proceeds without ownerLoginId
            }
        }

        const complaint = new Complaint({
            // Identity and property — always from DB, never from req.body
            tenantId: String(authTenant._id),
            tenantLoginId: authTenant.loginId || '',
            tenantName: authTenant.name || 'Unknown',
            tenantPhone: authTenant.phone || 'N/A',
            tenantEmail: authTenant.email || '',
            property: authTenant.propertyTitle || 'N/A',
            propertyId: String(authTenant.property || ''),
            roomNo: authTenant.roomNo || 'N/A',
            bedNo: authTenant.bedNo || 'N/A',
            ownerLoginId: ownerLoginId ? String(ownerLoginId).toUpperCase() : '',
            // Complaint content — from req.body
            type: type || 'Tenant',
            category: category || 'Other',
            issueType: issueType || '',
            description,
            priority: priority || 'Low',
            status: 'Open',
            escalated: escalated || false,
            imageStr: imageStr || '',
            createdAt: new Date()
        });

        await complaint.save();

        res.status(201).json({
            success: true,
            message: 'Complaint submitted successfully',
            complaint
        });
    } catch (err) {
        console.error("Create Complaint Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Update complaint status (owner + superadmin)
exports.updateComplaintStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, resolvedAt, escalated, ownerResponse } = req.body;

        const updateFields = {
            status,
            updatedAt: new Date()
        };

        if (ownerResponse) {
            updateFields.ownerResponse = ownerResponse;
        }

        // Set resolvedAt when marking as Resolved
        if (status === 'Resolved') {
            updateFields.resolvedAt = resolvedAt || new Date();
            updateFields.escalated = false; // clear escalation on resolve
        }

        // Allow superadmin to manually set/clear escalated flag
        if (typeof escalated !== 'undefined') {
            updateFields.escalated = escalated;
            if (escalated === true) {
                updateFields.escalatedAt = new Date();
            }
        }

        const complaint = await Complaint.findByIdAndUpdate(
            id,
            { $set: updateFields },
            { new: true }
        );

        if (!complaint) {
            return res.status(404).json({ success: false, message: 'Complaint not found' });
        }

        res.json({ success: true, message: 'Complaint updated', complaint });
    } catch (err) {
        console.error("Update Complaint Status Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Assign staff to complaint
exports.assignStaff = async (req, res) => {
    try {
        const { id } = req.params;
        const { assignedStaffId, assignedStaffName } = req.body;

        const complaint = await Complaint.findByIdAndUpdate(
            id,
            { 
                $set: { 
                    assignedStaffId: assignedStaffId, 
                    assignedStaffName: assignedStaffName,
                    status: 'In Progress', // automatically move to in progress when assigned
                    updatedAt: new Date()
                }
            },
            { new: true }
        );

        if (!complaint) {
            return res.status(404).json({ success: false, message: 'Complaint not found' });
        }

        res.json({ success: true, complaint });
    } catch (err) {
        console.error("Assign Staff Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Get all complaints (superadmin) OR owner's complaints via query param
// Usage:
//   /api/complaints              → all (superadmin)
//   /api/complaints?ownerLoginId=ROOMHY12345  → owner panel
exports.getAllComplaints = async (req, res) => {
    try {
        const { type, ownerLoginId } = req.query;
        
        // If ownerLoginId provided → filter for that owner only
        const filter = {};
        if (type) filter.type = type;
        if (ownerLoginId) {
            filter.ownerLoginId = { $regex: new RegExp('^' + ownerLoginId + '$', 'i') };
        }

        const complaints = await Complaint.find(filter).sort({ createdAt: -1 });
        res.json({ success: true, complaints });
    } catch (err) {
        console.error("Get All Complaints Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Owner can reply to a complaint — tenant sees this response
exports.updateOwnerResponse = async (req, res) => {
    try {
        const { id } = req.params;
        const { ownerResponse, ownerResponseBy, ownerResponseByLoginId } = req.body;

        if (!ownerResponse || !ownerResponse.trim()) {
            return res.status(400).json({ success: false, message: 'Response text is required' });
        }

        const responseBy = String(ownerResponseBy || '').trim();
        const responseByLoginId = String(ownerResponseByLoginId || '').trim().toUpperCase();

        const complaint = await Complaint.findByIdAndUpdate(
            id,
            {
                $set: {
                    ownerResponse: ownerResponse.trim(),
                    ownerResponseBy: responseBy,
                    ownerResponseByLoginId: responseByLoginId,
                    updatedAt: new Date()
                }
            },
            { new: true }
        );

        if (!complaint) {
            return res.status(404).json({ success: false, message: 'Complaint not found' });
        }

        res.json({ success: true, message: 'Response saved', complaint });
    } catch (err) {
        console.error("Update Owner Response Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Delete a complaint
exports.deleteComplaint = async (req, res) => {
    try {
        const { id } = req.params;
        
        const complaint = await Complaint.findByIdAndDelete(id);
        if (!complaint) {
            return res.status(404).json({ success: false, message: 'Complaint not found' });
        }
        
        res.json({ success: true, message: 'Complaint deleted successfully' });
    } catch (err) {
        console.error("Delete Complaint Error:", err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Auto escalation cron job threshold 5 days
const ESCALATION_DAYS = 5;
const CHECK_INTERVAL_HOURS = 6;

exports.startEscalationJob = () => {
    const run = async () => {
        if (mongoose.connection.readyState !== 1) {
            console.warn('[EscalationJob] DB not ready — skipping run');
            return;
        }
        try {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - ESCALATION_DAYS);

            const result = await Complaint.updateMany(
                {
                    status:    { $nin: ['Resolved', 'Rejected'] },
                    escalated: { $ne: true },
                    createdAt: { $lte: cutoff }
                },
                {
                    $set: {
                        escalated:   true,
                        escalatedAt: new Date()
                    }
                }
            );

            if (result.modifiedCount > 0) {
                console.log(`[EscalationJob] ✅ Escalated ${result.modifiedCount} complaint(s) at ${new Date().toISOString()}`);
            }
        } catch (err) {
            console.error('[EscalationJob] ❌ Error:', err.message);
        }
    };

    run(); // run once on startup
    setInterval(run, CHECK_INTERVAL_HOURS * 60 * 60 * 1000);
    console.log(`[EscalationJob] Started — every ${CHECK_INTERVAL_HOURS}h, threshold ${ESCALATION_DAYS} days`);
};
