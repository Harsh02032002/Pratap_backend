const VisitorLog = require('../models/VisitorLog');
const Tenant = require('../models/Tenant');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

exports.createVisitor = async (req, res) => {
    try {
        // Identity always from JWT — never trust frontend for host details
        const callerLoginId = String(req.user?.loginId || req.body?.tenantLoginId || '').toUpperCase();
        if (!callerLoginId) {
            return res.status(400).json({ success: false, message: 'Tenant identity could not be determined.' });
        }

        // Accept both field name conventions from frontend
        const guestName  = req.body.visitorName  || req.body.name;
        const guestPhone = req.body.visitorPhone  || req.body.phone;
        const entryTime  = req.body.expectedEntryTime || req.body.entryTime || null;
        const purpose    = req.body.purpose || 'Guest Visitor';
        const status     = req.body.status  || 'Pre-approved';

        if (!guestName  || !String(guestName).trim())  return res.status(400).json({ success: false, message: 'Visitor name is required.' });
        if (!guestPhone || !String(guestPhone).trim()) return res.status(400).json({ success: false, message: 'Visitor phone is required.' });

        // Load tenant from DB — populate hostName/hostRoom safely
        const tenant = await Tenant.findOne({ loginId: callerLoginId })
            .select('_id name roomNo ownerLoginId loginId')
            .lean();
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found.' });
        }

        const ownerLoginId = String(
            req.body.ownerLoginId || tenant.ownerLoginId || 'SYSTEM'
        ).toUpperCase();

        const visitor = await VisitorLog.create({
            ownerLoginId,
            tenantLoginId: tenant.loginId,
            name:          String(guestName).trim(),
            phone:         String(guestPhone).trim(),
            hostName:      tenant.name,
            hostRoom:      tenant.roomNo || '-',
            purpose,
            status,
            entryTime:     status === 'Pre-approved' ? null : (entryTime ? new Date(entryTime) : new Date())
        });

        return res.status(201).json({ success: true, visitor });
    } catch (err) {
        console.error('createVisitor error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

exports.getTenantVisitorHistory = async (req, res) => {
    try {
        const requestedLoginId = String(req.params.loginId || '').toUpperCase();
        if (!requestedLoginId) {
            return res.status(400).json({ success: false, message: 'loginId is required.' });
        }

        // Tenants can only see their own history; admins/areamanagers can see any
        if (req.user.role === 'tenant') {
            const callerLoginId = String(req.user.loginId || '').toUpperCase();
            if (callerLoginId !== requestedLoginId) {
                return res.status(403).json({ success: false, message: 'Forbidden: You may only access your own visitor history.' });
            }
        }

        const tenant = await Tenant.findOne({ loginId: requestedLoginId }).select('_id').lean();
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found.' });
        }

        const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
        const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
        const skip  = (page - 1) * limit;

        const [visitors, count] = await Promise.all([
            VisitorLog.find({ tenantLoginId: requestedLoginId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            VisitorLog.countDocuments({ tenantLoginId: requestedLoginId })
        ]);

        return res.json({ success: true, count, page, limit, visitors });
    } catch (err) {
        console.error('getTenantVisitorHistory error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

exports.getOwnerVisitors = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const { status } = req.query;
        const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
        const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT));
        const skip  = (page - 1) * limit;

        const query = { ownerLoginId: { $regex: new RegExp('^' + ownerLoginId + '$', 'i') } };
        if (status) query.status = status;

        const [visitors, count] = await Promise.all([
            VisitorLog.find(query).sort({ entryTime: -1 }).skip(skip).limit(limit).lean(),
            VisitorLog.countDocuments(query)
        ]);

        return res.json({ success: true, count, page, limit, visitors });
    } catch (err) {
        console.error('getOwnerVisitors error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

exports.updateVisitorStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        if (!['Pre-approved', 'Inside', 'Exited', 'Cancelled'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status value.' });
        }

        const updateData = { status };
        if (status === 'Exited') updateData.exitTime  = new Date();
        if (status === 'Inside') updateData.entryTime = new Date();

        const visitor = await VisitorLog.findByIdAndUpdate(id, { $set: updateData }, { new: true }).lean();
        if (!visitor) return res.status(404).json({ success: false, message: 'Visitor log not found.' });

        return res.json({ success: true, visitor });
    } catch (err) {
        console.error('updateVisitorStatus error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};
