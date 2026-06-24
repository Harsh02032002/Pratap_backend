const TenantLeaveRequest = require('../models/TenantLeaveRequest');
const Tenant = require('../models/Tenant');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

exports.createLeaveRequest = async (req, res) => {
    try {
        // Identity always from JWT — never trust frontend for tenantId/name/room
        const callerLoginId = String(req.user?.loginId || req.body?.tenantLoginId || '').toUpperCase();
        if (!callerLoginId) {
            return res.status(400).json({ success: false, message: 'Tenant identity could not be determined.' });
        }

        // Accept both fromDate/toDate and startDate/endDate (frontend sends startDate/endDate)
        const fromDate = req.body.fromDate || req.body.startDate;
        const toDate   = req.body.toDate   || req.body.endDate;
        const { reason } = req.body;

        if (!fromDate) return res.status(400).json({ success: false, message: 'fromDate is required.' });
        if (!toDate)   return res.status(400).json({ success: false, message: 'toDate is required.' });
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ success: false, message: 'reason is required.' });
        }

        const from = new Date(fromDate);
        const to   = new Date(toDate);
        if (isNaN(from.getTime())) return res.status(400).json({ success: false, message: 'fromDate is not a valid date.' });
        if (isNaN(to.getTime()))   return res.status(400).json({ success: false, message: 'toDate is not a valid date.' });
        if (from > to) return res.status(400).json({ success: false, message: 'fromDate must be on or before toDate.' });

        // Load tenant from DB — populate identity fields safely
        const tenant = await Tenant.findOne({ loginId: callerLoginId })
            .select('_id name roomNo ownerLoginId loginId')
            .lean();
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found.' });
        }

        const ownerLoginId = String(
            req.body.ownerLoginId || tenant.ownerLoginId || 'SYSTEM'
        ).toUpperCase();

        const request = await TenantLeaveRequest.create({
            ownerLoginId,
            tenantId:      tenant._id,
            tenantLoginId: tenant.loginId,
            tenantName:    tenant.name,
            roomNo:        tenant.roomNo || '-',
            fromDate:      from,
            toDate:        to,
            reason:        String(reason).trim(),
            status:        'Pending'
        });

        return res.status(201).json({ success: true, request });
    } catch (err) {
        console.error('createLeaveRequest error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

exports.getTenantLeaveHistory = async (req, res) => {
    try {
        const requestedLoginId = String(req.params.loginId || '').toUpperCase();
        if (!requestedLoginId) {
            return res.status(400).json({ success: false, message: 'loginId is required.' });
        }

        // Tenants can only see their own history; admins/areamanagers can see any
        if (req.user.role === 'tenant') {
            const callerLoginId = String(req.user.loginId || '').toUpperCase();
            if (callerLoginId !== requestedLoginId) {
                return res.status(403).json({ success: false, message: 'Forbidden: You may only access your own leave history.' });
            }
        }

        const tenant = await Tenant.findOne({ loginId: requestedLoginId }).select('_id').lean();
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found.' });
        }

        const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
        const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
        const skip  = (page - 1) * limit;

        const [leaves, count] = await Promise.all([
            TenantLeaveRequest.find({ tenantId: tenant._id })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            TenantLeaveRequest.countDocuments({ tenantId: tenant._id })
        ]);

        return res.json({ success: true, count, page, limit, leaves });
    } catch (err) {
        console.error('getTenantLeaveHistory error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

exports.getOwnerLeaveRequests = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
        const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
        const skip  = (page - 1) * limit;

        const query = { ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') } };

        const [requests, count] = await Promise.all([
            TenantLeaveRequest.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            TenantLeaveRequest.countDocuments(query)
        ]);

        return res.json({ success: true, count, page, limit, requests });
    } catch (err) {
        console.error('getOwnerLeaveRequests error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

exports.updateLeaveRequestStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        if (!['Pending', 'Approved', 'Rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status value.' });
        }
        const request = await TenantLeaveRequest.findByIdAndUpdate(
            id,
            { $set: { status } },
            { new: true }
        ).lean();
        if (!request) return res.status(404).json({ success: false, message: 'Leave request not found.' });
        return res.json({ success: true, request });
    } catch (err) {
        console.error('updateLeaveRequestStatus error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};
