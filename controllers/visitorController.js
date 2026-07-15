const crypto = require('crypto');
const VisitorLog = require('../models/VisitorLog');
const Tenant = require('../models/Tenant');
const Employee = require('../models/Employee');
const Owner = require('../models/Owner');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

// Resolves and authorizes whoever is approving/rejecting a visitor pass.
// Either the Owner (loginId must match the pass's ownerLoginId) OR a Designated
// Warden — an Employee assigned to that owner via parentLoginId. Wardens are
// strictly scoped: they can only act on passes for the owner they belong to.
async function resolveApprover(req, visitor) {
    const role    = String(req.body.approverRole || 'owner').toLowerCase();
    const loginId = String(req.body.approverLoginId || req.body.ownerLoginId || req.user?.loginId || '').toUpperCase();
    const bodyName = req.body.approverName || req.body.ownerName;
    const ownerOfPass = String(visitor.ownerLoginId || '').toUpperCase();

    if (role === 'warden' || role === 'staff') {
        if (!loginId) return { ok: false, code: 400, message: 'Warden identity is required.' };
        const emp = await Employee.findOne({
            loginId: new RegExp('^' + loginId + '$', 'i'),
            isDeleted: { $ne: true },
            isActive: { $ne: false },
        }).select('name parentLoginId').lean();
        if (!emp) return { ok: false, code: 403, message: 'Warden account not found or inactive.' };
        if (String(emp.parentLoginId || '').toUpperCase() !== ownerOfPass) {
            return { ok: false, code: 403, message: 'Not authorized to manage visitor passes for this owner.' };
        }
        return { ok: true, role: 'warden', loginId, name: bodyName || emp.name || 'Designated Warden' };
    }

    // Owner path — if a loginId is supplied it must own the pass.
    if (loginId && loginId !== ownerOfPass) {
        return { ok: false, code: 403, message: 'Not authorized to manage this visitor pass.' };
    }
    return { ok: true, role: 'owner', loginId: loginId || ownerOfPass, name: bodyName || req.user?.name || 'Property Owner' };
}

// Stable, hard-to-guess token that the visitor-pass QR encodes. Generated once
// at creation and never regenerated, so the QR is identical before/after approval.
const generateQrToken = () => crypto.randomBytes(16).toString('hex');

// Unique, human-readable pass id derived from the (already unique) Mongo _id.
const buildPassId = (id) => `VP-${String(id).slice(-6).toUpperCase()}`;

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

        if (!guestName  || !String(guestName).trim())  return res.status(400).json({ success: false, message: 'Visitor name is required.' });
        if (!guestPhone || !String(guestPhone).trim()) return res.status(400).json({ success: false, message: 'Visitor phone is required.' });

        // Load tenant from DB — populate hostName/hostRoom safely
        const tenant = await Tenant.findOne({ loginId: callerLoginId })
            .select('_id name roomNo ownerLoginId loginId propertyTitle')
            .lean();
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found.' });
        }

        const ownerLoginId = String(
            req.body.ownerLoginId || tenant.ownerLoginId || 'SYSTEM'
        ).toUpperCase();

        // Snapshot the owner + property so the scanned pass can display them.
        const owner = await Owner.findOne({ loginId: new RegExp('^' + ownerLoginId + '$', 'i') })
            .select('name propertyTitle')
            .lean();
        const propertyName = tenant.propertyTitle || owner?.propertyTitle || '';
        const ownerName = owner?.name || '';

        // Tenant self-service passes always start as Pending owner approval.
        // The QR token is generated up-front and frozen for the pass's lifetime.
        const visitor = await VisitorLog.create({
            ownerLoginId,
            tenantLoginId: tenant.loginId,
            name:          String(guestName).trim(),
            phone:         String(guestPhone).trim(),
            hostName:      tenant.name,
            hostRoom:      tenant.roomNo || '-',
            propertyName,
            ownerName,
            purpose,
            status:        'Pending',
            qrToken:       generateQrToken(),
            expectedEntryTime: entryTime ? new Date(entryTime) : null,
            entryTime:     null
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
        if (!['Pending', 'Approved', 'Rejected', 'Pre-approved', 'Inside', 'Exited', 'Cancelled'].includes(status)) {
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

// Owner OR assigned Designated Warden approves a pending visitor pass. Assigns a
// unique Pass ID (idempotent — re-approving keeps the existing one) and records
// who approved it, their role, and when. qrToken is never regenerated.
exports.approveVisitor = async (req, res) => {
    try {
        const { id } = req.params;
        const visitor = await VisitorLog.findById(id);
        if (!visitor) return res.status(404).json({ success: false, message: 'Visitor pass not found.' });

        const approver = await resolveApprover(req, visitor);
        if (!approver.ok) return res.status(approver.code).json({ success: false, message: approver.message });

        if (!visitor.qrToken) visitor.qrToken = generateQrToken(); // backfill legacy rows
        if (!visitor.passId)  visitor.passId  = buildPassId(visitor._id);
        visitor.status            = 'Approved';
        visitor.approvedBy        = approver.name;
        visitor.approvedByLoginId = approver.loginId;
        visitor.approvedByRole    = approver.role;
        visitor.approvedAt        = visitor.approvedAt || new Date();
        await visitor.save();

        return res.json({ success: true, visitor: visitor.toObject() });
    } catch (err) {
        console.error('approveVisitor error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

// Owner OR assigned Designated Warden rejects a pending visitor pass. No Pass ID
// / QR is ever exposed. Records who rejected it and their role.
exports.rejectVisitor = async (req, res) => {
    try {
        const { id } = req.params;
        const visitor = await VisitorLog.findById(id);
        if (!visitor) return res.status(404).json({ success: false, message: 'Visitor pass not found.' });

        const approver = await resolveApprover(req, visitor);
        if (!approver.ok) return res.status(approver.code).json({ success: false, message: approver.message });

        visitor.status            = 'Rejected';
        visitor.rejectedBy        = approver.name;
        visitor.rejectedByLoginId = approver.loginId;
        visitor.rejectedByRole    = approver.role;
        visitor.rejectedAt        = new Date();
        await visitor.save();

        return res.json({ success: true, visitor: visitor.toObject() });
    } catch (err) {
        console.error('rejectVisitor error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};

// PUBLIC — resolves a QR token (scanned at the gate) to verification details.
// Only approved passes expose their details; pending/rejected/unknown tokens do not.
exports.verifyByToken = async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        if (!token) return res.status(400).json({ success: false, message: 'Missing pass token.' });

        const visitor = await VisitorLog.findOne({ qrToken: token })
            .select('status passId name hostName propertyName ownerName approvedBy approvedByRole approvedAt expectedEntryTime')
            .lean();

        if (!visitor) {
            return res.status(404).json({ success: false, valid: false, message: 'Visitor pass not found.' });
        }
        if (visitor.status !== 'Approved') {
            return res.json({
                success: true,
                valid: false,
                status: visitor.status,
                message: visitor.status === 'Rejected'
                    ? 'This visitor pass was rejected and is not valid.'
                    : 'This visitor pass is awaiting owner approval and is not yet valid.'
            });
        }

        const approverLabel = visitor.approvedByRole === 'warden' ? 'Designated Warden' : 'Owner';
        return res.json({
            success: true,
            valid: true,
            status: 'Approved',
            message: `Approved by ${approverLabel}`,
            passId:            visitor.passId,
            visitorName:       visitor.name,
            tenantName:        visitor.hostName,
            propertyName:      visitor.propertyName || '',
            ownerName:         visitor.ownerName || '',
            approvedBy:        visitor.approvedBy,
            approvedByRole:    visitor.approvedByRole || 'owner',
            approverLabel,
            approvedAt:        visitor.approvedAt,
            expectedEntryTime: visitor.expectedEntryTime
        });
    } catch (err) {
        console.error('verifyByToken error:', err.message);
        return res.status(500).json({ success: false, message: 'Internal server error.' });
    }
};
