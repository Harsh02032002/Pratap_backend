const express = require('express');
const router = express.Router();
const Tenant = require('../models/Tenant');
const Room = require('../models/Room');
const Property = require('../models/Property');
const LedgerEntry = require('../models/LedgerEntry');
const TenantFeedback = require('../models/TenantFeedback');
const Rent = require('../models/Rent');
const Notification = require('../models/Notification');
const { calcNoticeEndDate } = require('../services/moveoutService');
const { protect, authorize } = require('../middleware/authMiddleware');
const tenantController = require('../controllers/tenantController');
const { auditTrail } = require('../middleware/auditTrail');
const roomTransferService = require('../services/roomTransferService');
const { nextBillingMonth } = require('../utils/istDate');

// ─── Field-level security projection ─────────────────────────────────────────
// Sensitive fields are stripped at the DB query layer (defence-in-depth).
// Even if an upstream auth check were accidentally omitted, these fields
// structurally cannot appear in any response from this router.
// Shared with controllers/tenantController.js and propertyManagerController.js
// via utils/tenantProjections.js so all three can't drift apart.
const { ALWAYS_EXCLUDED_PROJECTION: ALWAYS_EXCLUDED } = require('../utils/tenantProjections');

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Escapes text interpolated into HTML emails. The cancellation reason is typed
// by the owner, so it must not be able to inject markup into the tenant's mail.
const escapeHtml = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Returns the authenticated caller's loginId, normalized to uppercase.
// Always derived from the verified JWT payload — never from request input.
const callerLoginId = (req) => String(req.user?.loginId || '').toUpperCase();

// Horizontal privilege escalation guard for owner-scoped URL parameters.
// Prevents an owner from accessing another owner's data by changing the URL.
const ownerMatchGuard = (paramKey) => (req, res, next) => {
    if (req.user.role !== 'owner') return next();
    const requested = String(req.params[paramKey] || '').toUpperCase();
    if (callerLoginId(req) !== requested) {
        return res.status(403).json({
            success: false,
            message: 'Forbidden: You may only access your own data.'
        });
    }
    next();
};

// ─── ROUTE ORDER NOTE ─────────────────────────────────────────────────────────
// Express matches routes in registration order. Named segment routes (e.g.
// /me, /owner/:x, /moveout, /kyc, /ledger) MUST be registered before the
// catch-all parameterized route (/:id) to avoid the named segment being
// consumed as an id value.
// ─────────────────────────────────────────────────────────────────────────────

// ══ 0. DIRECT ONBOARD WEBUSER1@ROOMHY.COM ═════════════════════════════════════
router.get('/onboard-webuser1-direct', async (req, res) => {
    try {
        const User = require('../models/user');
        const ApprovedProperty = require('../models/ApprovedProperty');

        const email = 'webuser1@roomhy.com';
        const phone = '9876543219';

        let user = await User.findOne({ email });
        if (!user) {
            user = await User.create({
                name: 'Web User One',
                email,
                phone,
                password: 'userpassword123',
                role: 'tenant',
                loginId: email,
                isActive: true
            });
        }

        let property = await Property.findOne({ status: { $ne: 'deleted' } });
        if (!property) {
            property = await ApprovedProperty.findOne({});
        }

        if (!property) {
            property = await Property.create({
                title: 'Roomhy Demo Residency',
                ownerLoginId: 'ROOMHY9999',
                address: 'Sector 62, Noida',
                city: 'Noida',
                monthlyRent: 8000,
                status: 'active',
                isPublished: true,
                isLiveOnWebsite: true
            });
        }

        let room = await Room.findOne({ property: property._id });
        if (!room) {
            room = await Room.create({
                property: property._id,
                title: '101',
                type: 'Single Sharing',
                beds: 2,
                price: 8000,
                status: 'active',
                isAvailable: true
            });
        }

        let tenant = await Tenant.findOne({ email });
        if (!tenant) {
            tenant = await Tenant.create({
                name: user.name || 'Web User One',
                email,
                phone,
                user: user._id,
                property: property._id,
                propertyTitle: property.title,
                room: room._id,
                roomNo: room.title || '101',
                bedNo: 'A',
                ownerLoginId: property.ownerLoginId || 'ROOMHY9999',
                agreedRent: 8000,
                baseRoomRent: 8000,
                status: 'active',
                moveInDate: new Date(),
                kycStatus: 'verified',
                agreementStatus: 'signed',
                agreementSigned: true,
                loginId: user.loginId || email
            });
        } else {
            tenant.user = user._id;
            tenant.property = property._id;
            tenant.propertyTitle = property.title;
            tenant.room = room._id;
            tenant.roomNo = room.title || '101';
            tenant.bedNo = 'A';
            tenant.ownerLoginId = property.ownerLoginId || 'ROOMHY9999';
            tenant.agreedRent = 8000;
            tenant.status = 'active';
            tenant.moveInDate = new Date();
            tenant.kycStatus = 'verified';
            tenant.agreementStatus = 'signed';
            tenant.agreementSigned = true;
            await tenant.save();
        }

        res.json({
            success: true,
            message: '🎉 webuser1@roomhy.com onboarded successfully as an Active Tenant!',
            tenant: {
                id: tenant._id,
                name: tenant.name,
                email: tenant.email,
                property: property.title,
                propertyId: property._id,
                status: tenant.status,
                moveInDate: tenant.moveInDate
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══ 1. ASSIGN TENANT ══════════════════════════════════════════════════════════
router.post(
    '/assign',
    protect,
    authorize('owner', 'propertyowner', 'manager', 'superadmin', 'areamanager'),
    auditTrail('tenants'),
    tenantController.assignTenant
);

// ══ 2. TENANT SELF-SERVICE: OWN PROFILE ══════════════════════════════════════
// SECURITY MODEL: identity is derived exclusively from the verified JWT
// (req.user.loginId set by protect middleware). The client cannot inject a
// different loginId — any attempt to do so is ignored at the controller layer.
router.get(
    '/me',
    protect,
    authorize('tenant'),
    tenantController.getMyProfile
);

const { applyEmployeeScope } = require('../middleware/employeeScope');

// ══ 3. ADMIN: ALL TENANTS ════════════════════════════════════════════════════
// Restricted to privileged roles. Sensitive fields excluded via projection
// in getAllTenants controller (ALWAYS_EXCLUDED_PROJECTION).
router.get(
    '/',
    protect,
    authorize('superadmin', 'areamanager', 'employee', 'manager'),
    applyEmployeeScope,
    tenantController.getAllTenants
);

// ══ 4. OWNER / ADMIN: TENANTS BY OWNER ══════════════════════════════════════
// ownerMatchGuard prevents owner A from reading owner B's tenants by changing
// the URL parameter (horizontal privilege escalation).
router.get(
    '/owner/:ownerId',
    protect,
    authorize('superadmin', 'areamanager', 'owner', 'employee', 'manager'),
    ownerMatchGuard('ownerId'),
    tenantController.getTenantsByOwner
);

// ══ 5. ADMIN/OWNER: MOVE-OUT REQUEST LIST ════════════════════════════════════
router.get(
    '/moveout/owner/:ownerId',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    ownerMatchGuard('ownerId'),
    async (req, res) => {
        try {
            const ownerLoginId = String(req.params.ownerId).toUpperCase();
            const tenants = await Tenant.find({
                ownerLoginId,
                'moveoutRequest.status': { $in: ['pending', 'approved', 'rejected'] }
            })
            .select(ALWAYS_EXCLUDED)
            .populate('property', 'title roomType locationCode ownerLoginId')
            .sort({ 'moveoutRequest.submittedAt': -1 });
            res.json({ success: true, requests: tenants });
        } catch (err) {
            console.error('Get owner moveout requests error:', err);
            res.status(500).json({ success: false, message: err.message });
        }
    }
);

// ══ 6. ADMIN/OWNER: CHECK-IN APPROVAL ════════════════════════════════════════
router.post(
    '/checkin/approve',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            // Owner can only approve check-in for their own tenants
            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }

            tenant.status = 'active';
            await tenant.save();
            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 6.1 ADMIN/OWNER: VIEW TENANT KYC DOCUMENTS ═══════════════════════════
router.get(
    '/:tenantId/kyc',
    protect,
    authorize('superadmin', 'areamanager', 'owner', 'employee', 'manager'),
    async (req, res) => {
        try {
            const { tenantId } = req.params;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) {
                return res.status(404).json({ success: false, message: 'Tenant not found' });
            }

            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }

            res.json({
                success: true,
                kyc: tenant.kyc || {},
                kycStatus: tenant.kycStatus,
                tenantName: tenant.name,
                tenantLoginId: tenant.loginId
            });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
);

// ══ 7. TENANT SELF-SERVICE: KYC SUBMISSION ════════════════════════════════════
// IDOR FIX: tenantLoginId from the request body is intentionally NOT used for
// the database lookup. The tenant record is resolved from req.user.loginId
// (set by protect middleware from the verified JWT). A tenant cannot submit
// KYC on behalf of another tenant regardless of what loginId they send in the body.
router.post(
    '/kyc/submit',
    protect,
    authorize('tenant'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            // Identity from JWT only — body loginId is ignored
            const authenticatedLoginId = callerLoginId(req);
            const { aadhaarNumber, panNumber, aadharFile, aadhaarFront, aadhaarBack, addressProofFile } = req.body;

            const tenant = await Tenant.findOne({ loginId: authenticatedLoginId });
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            if (!tenant.kyc) tenant.kyc = {};
            tenant.kyc.aadhaarNumber = aadhaarNumber || tenant.kyc.aadhaarNumber;
            tenant.kyc.aadhar        = aadhaarNumber || tenant.kyc.aadhar;
            tenant.kyc.aadharFile    = aadharFile    || tenant.kyc.aadharFile;
            tenant.kyc.aadhaarFront  = aadhaarFront  || tenant.kyc.aadhaarFront;
            tenant.kyc.aadhaarBack   = aadhaarBack   || tenant.kyc.aadhaarBack;
            tenant.kyc.addressProofFile = addressProofFile || tenant.kyc.addressProofFile;
            tenant.kyc.idProof       = panNumber ? 'PAN Card' : 'Aadhaar Card';
            tenant.kyc.idProofFile   = panNumber || tenant.kyc.idProofFile;
            tenant.kyc.uploadedAt    = new Date();
            tenant.kycStatus         = 'submitted';

            await tenant.save();
            // Never reflect back sensitive document data in the response
            res.json({ success: true, kycStatus: tenant.kycStatus, idProof: tenant.kyc.idProof, uploadedAt: tenant.kyc.uploadedAt });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 8. ADMIN/OWNER: KYC APPROVE / REJECT WITH DATA COMPARISON ═════════════════
router.post(
    '/:tenantId/kyc-verification',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    tenantController.verifyTenantKYC
);

// ══ 8.1. ADMIN/OWNER: LEGACY KYC APPROVE / REJECT ══════════════════════════════════════════
router.post(
    '/kyc/approve',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }
            tenant.kycStatus = 'verified';
            tenant.status = 'active'; // Activate tenant on KYC approval
            await tenant.save();
            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

router.post(
    '/kyc/reject',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }
            tenant.kycStatus = 'rejected';
            await tenant.save();
            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

router.post(
    '/kyc/resend-link',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }
            if (!tenant.email) {
                return res.status(400).json({ success: false, message: 'Tenant email address is missing' });
            }
            // Alternate-ID-proof tenants never go through Aadhaar-OTP — sending
            // this email would tell them to do something they structurally
            // can't. They're reviewed via the "Request KYC Approve" queue instead.
            if (tenant.kyc?.noAadhaar) {
                return res.status(400).json({ success: false, message: 'This tenant has no Aadhaar and is pending review under Request KYC Approve, not the Aadhaar-OTP link.' });
            }

            const mailer = require('../utils/mailer');
            const origin = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
            const kycLink = `${origin.replace(/\/$/, '')}/digital-checkin/tenantprofile?loginId=${encodeURIComponent(tenant.loginId)}`;

            const sent = await mailer.sendKycLinkEmail(tenant.email, tenant.name, tenant.propertyName || 'RoomHy Tenant Portal', kycLink);

            res.json({
                success: true,
                message: sent ? `KYC link successfully emailed to ${tenant.email}` : `Failed to send email to ${tenant.email}`,
                kycLink
            });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
);

router.post(
    '/:tenantId/resend-kyc-link',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const tenantId = req.params.tenantId || req.body.tenantId;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });
            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }
            if (!tenant.email) {
                return res.status(400).json({ success: false, message: 'Tenant email address is missing' });
            }
            // Alternate-ID-proof tenants never go through Aadhaar-OTP — sending
            // this email would tell them to do something they structurally
            // can't. They're reviewed via the "Request KYC Approve" queue instead.
            if (tenant.kyc?.noAadhaar) {
                return res.status(400).json({ success: false, message: 'This tenant has no Aadhaar and is pending review under Request KYC Approve, not the Aadhaar-OTP link.' });
            }

            const mailer = require('../utils/mailer');
            const origin = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
            const kycLink = `${origin.replace(/\/$/, '')}/digital-checkin/tenantprofile?loginId=${encodeURIComponent(tenant.loginId)}`;

            const sent = await mailer.sendKycLinkEmail(tenant.email, tenant.name, tenant.propertyName || 'RoomHy Tenant Portal', kycLink);
            
            res.json({ 
                success: true, 
                message: sent ? `KYC link successfully emailed to ${tenant.email}` : `Failed to send email to ${tenant.email}`,
                kycLink 
            });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    }
);

// ══ 9. TENANT SELF-SERVICE: POLICE VERIFICATION ══════════════════════════════
// IDOR FIX: same pattern as KYC — identity from JWT, body loginId ignored.
router.post(
    '/police/submit',
    protect,
    authorize('tenant'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const authenticatedLoginId = callerLoginId(req);
            const { receiptFile } = req.body; // tenantLoginId from body: intentionally ignored

            const tenant = await Tenant.findOne({ loginId: authenticatedLoginId });
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            tenant.policeVerification = {
                status: 'submitted',
                receiptFile,
                submittedAt: new Date()
            };
            await tenant.save();
            res.json({ success: true, status: 'submitted', submittedAt: tenant.policeVerification.submittedAt });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 10. ADMIN: POLICE VERIFICATION APPROVE / REJECT ══════════════════════════
router.post(
    '/police/approve',
    protect,
    authorize('superadmin', 'areamanager'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            tenant.policeVerification.status = 'verified';
            await tenant.save();
            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

router.post(
    '/police/reject',
    protect,
    authorize('superadmin', 'areamanager'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            tenant.policeVerification.status = 'rejected';
            await tenant.save();
            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 11. TENANT SELF-SERVICE: MOVE-OUT NOTICE ══════════════════════════════════
// IDOR FIX: tenantLoginId from body ignored; JWT identity used exclusively.
router.post(
    '/moveout',
    protect,
    authorize('tenant'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const authenticatedLoginId = callerLoginId(req);
            const { reason, requestedDate } = req.body; // tenantLoginId from body: intentionally ignored

            if (!requestedDate) {
                return res.status(400).json({ success: false, message: 'requestedDate is required.' });
            }

            const tenant = await Tenant.findOne({ loginId: authenticatedLoginId });
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            tenant.moveoutRequest = {
                status: 'pending',
                requestedDate: new Date(requestedDate),
                reason: reason || '',
                submittedAt: new Date()
            };
            await tenant.save();

            // Notify owner about tenant move-out notice via In-App + FCM Push
            if (tenant.ownerLoginId) {
                try {
                    const Notification = require('../models/Notification');
                    await Notification.create({
                        toLoginId: tenant.ownerLoginId,
                        toRole: 'owner',
                        from: tenant.name || 'Tenant',
                        title: '🚨 Tenant Move-Out Notice Submitted',
                        message: `Tenant ${tenant.name} (Room: ${tenant.roomNo || 'N/A'}) has submitted a move-out notice for ${new Date(requestedDate).toLocaleDateString('en-IN')}.`,
                        type: 'moveout_notice',
                        read: false
                    }).catch(() => {});

                    const fcmService = require('../services/fcmService');
                    fcmService.sendToUser(tenant.ownerLoginId, {
                        title: '🚨 Move-Out Notice Received',
                        body: `Tenant ${tenant.name} (Room: ${tenant.roomNo || 'N/A'}) has submitted a notice to vacate on ${new Date(requestedDate).toLocaleDateString('en-IN')}.`,
                        data: { type: 'moveout_notice', tenantId: String(tenant._id) }
                    }).catch(() => {});
                } catch (_) {}
            }

            res.json({ success: true, moveoutRequest: tenant.moveoutRequest });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 12. ADMIN/OWNER: MOVE-OUT APPROVE / REJECT ══════════════════════════════
router.post(
    '/moveout/approve',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId, duesAtMoveout, refundAmount, refundStatus } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }

            // Approval starts a fixed one-month notice period; it does NOT make
            // the tenant an ex-tenant yet. `status` deliberately stays 'active'
            // so rent generation, the ledger and room occupancy keep treating
            // them as a resident for the month they are still living there.
            // services/cronJobs.js completes the exit once the notice elapses.
            const approvedAt = new Date();
            tenant.moveoutRequest.status = 'approved';
            tenant.moveoutRequest.approvedAt = approvedAt;
            tenant.moveoutRequest.noticeEndDate = calcNoticeEndDate(approvedAt);
            tenant.moveoutRequest.duesAtMoveout = Number(duesAtMoveout) || 0;
            tenant.moveoutRequest.refundAmount = Number(refundAmount) || 0;
            tenant.moveoutRequest.refundStatus = refundStatus || 'cleared';
            await tenant.save();

            // Tell the tenant when their notice ends while they can still be
            // reached — comms are suppressed the moment the exit completes.
            if (tenant.loginId) {
                Notification.create({
                    toLoginId: tenant.loginId,
                    from: 'system',
                    type: 'system',
                    meta: {
                        title: 'Move-out approved — 1 month notice period started',
                        message: `Your move-out request has been approved. Your notice period runs until ${tenant.moveoutRequest.noticeEndDate.toDateString()}. Your tenant account stays active until then, after which it will be closed automatically.`
                    },
                    read: false
                }).catch((e) => console.error('Moveout approval notification failed:', e.message));
            }

            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

router.post(
    '/moveout/reject',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }

            tenant.moveoutRequest.status = 'rejected';
            await tenant.save();
            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 12b. ADMIN/OWNER: CANCEL AN ACTIVE NOTICE PERIOD ════════════════════════
// Reverses an approved move-out while the tenant is still serving notice: the
// exit is called off entirely and the tenant returns to being an ordinary
// resident. Only valid before the notice completes — once completeMoveout has
// run the bed is released and possibly re-let, so undoing it is not safe here.
router.post(
    '/moveout/cancel',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId, reason } = req.body;
            // Reason is optional — when the owner does give one it is stored and
            // surfaced to the tenant on their Move-out Notice tab.
            const cancelReason = String(reason || '').trim();

            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }

            if (tenant.moveoutRequest?.status !== 'approved' || tenant.moveoutRequest?.completedAt) {
                return res.status(400).json({
                    success: false,
                    message: 'This tenant is not currently serving a notice period.'
                });
            }

            // Clear the whole move-out, not just the notice dates — the tenant
            // goes back to a clean slate and would have to raise a fresh exit
            // notice to leave.
            tenant.moveoutRequest = {
                status: 'none',
                reason: '',
                duesAtMoveout: 0,
                refundAmount: 0,
                refundStatus: '',
                cancelledAt: new Date(),
                cancelReason,
                cancelledBy: callerLoginId(req)
            };
            tenant.status = 'active';
            await tenant.save();

            if (tenant.loginId) {
                Notification.create({
                    toLoginId: tenant.loginId,
                    from: 'system',
                    type: 'system',
                    meta: {
                        title: 'Move-out cancelled',
                        message: `Your property owner has cancelled your move-out.${cancelReason ? ` Reason: "${cancelReason}".` : ''} Your notice period has been called off and your tenancy continues as normal. Raise a new move-out notice if you still wish to leave.`
                    },
                    read: false
                }).catch((e) => console.error('Moveout cancel notification failed:', e.message));
            }

            // Email the tenant as well. Fire-and-forget: a mail failure must not
            // roll back a cancellation that is already saved.
            if (tenant.email) {
                const { sendMail } = require('../utils/mailer');
                const propertyName = tenant.propertyTitle || 'your property';
                const reasonLine = cancelReason
                    ? `<p style="margin:16px 0;padding:12px 16px;background:#fffbeb;border-left:3px solid #f59e0b;color:#78350f;"><b>Reason given by your owner:</b><br/>${escapeHtml(cancelReason)}</p>`
                    : '';
                sendMail(
                    tenant.email,
                    'Your move-out has been cancelled — RoomHy',
                    `Dear ${tenant.name}, your property owner has cancelled your move-out at ${propertyName}.`
                        + (cancelReason ? ` Reason: ${cancelReason}.` : '')
                        + ' Your notice period has been called off and your tenancy continues as normal.'
                        + ' Raise a new move-out notice from your tenant dashboard if you still wish to leave.',
                    `<h2 style="color:#111;">Move-out Cancelled</h2>`
                        + `<p>Dear ${escapeHtml(tenant.name || 'Tenant')},</p>`
                        + `<p>Your property owner has <b>cancelled your move-out</b> at <b>${escapeHtml(propertyName)}</b>, and your one-month notice period has been called off.</p>`
                        + reasonLine
                        + `<p>Your tenancy continues as normal — your rent, ledger and room allocation are unchanged, and your tenant portal access stays active.</p>`
                        + `<p>If you still wish to leave, you can raise a fresh move-out notice from the <b>Move-out Notice</b> section of your tenant dashboard.</p>`
                        + `<br/><p>— RoomHy Team</p>`
                ).catch((e) => console.error('Moveout cancel email failed:', e.message));
            }

            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 13. LEDGER (READ) ════════════════════════════════════════════════════════
// Tenant: can only read their own ledger (loginId from JWT must match URL param).
// Owner: can read ledger of tenants belonging to their properties only.
// Admin: unrestricted.
router.get(
    '/ledger/:tenantLoginId',
    protect,
    async (req, res) => {
        try {
            const requestedId = String(req.params.tenantLoginId).toUpperCase();
            const role = req.user.role;

            if (role === 'tenant') {
                if (callerLoginId(req) !== requestedId) {
                    return res.status(403).json({ success: false, message: 'Forbidden.' });
                }
            } else if (role === 'owner') {
                const ownership = await Tenant.findOne({ loginId: requestedId })
                    .select('ownerLoginId').lean();
                if (!ownership || String(ownership.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Tenant does not belong to your property.' });
                }
            } else if (!['superadmin', 'areamanager'].includes(role)) {
                return res.status(403).json({ success: false, message: 'Forbidden.' });
            }

            const loginId = requestedId;
            const Tenant = require('../models/Tenant');
            const RentInvoice = require('../models/RentInvoice');
            const tenantDoc = await Tenant.findOne({ loginId }).lean();
            const rents = await Rent.find({ tenantLoginId: loginId }).lean();
            const invoices = tenantDoc?._id ? await RentInvoice.find({ tenantId: tenantDoc._id }).lean() : [];
            const customEntries = await LedgerEntry.find({ tenantLoginId: loginId }).lean();
            const ledgerItems = [];

            const monthMap = new Map();

            rents.forEach(r => {
                const month = r.collectionMonth || (r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 7) : null);
                if (month) {
                    monthMap.set(month, {
                        rentAmount: r.rentAmount || 0,
                        paidAmount: r.paidAmount || 0,
                        paymentStatus: r.paymentStatus || 'pending',
                        paymentMethod: r.paymentMethod,
                        paymentDate: r.paymentDate,
                        createdAt: r.createdAt || r.dueDate
                    });
                }
            });

            invoices.forEach(inv => {
                const month = inv.billingMonth;
                if (!month) return;
                if (!monthMap.has(month)) {
                    monthMap.set(month, {
                        rentAmount: inv.rentAmount || 0,
                        paidAmount: inv.paidAmount || 0,
                        paymentStatus: inv.status === 'PAID' ? 'paid' : 'pending',
                        paymentMethod: inv.paymentMethod,
                        paymentDate: inv.paymentDate,
                        createdAt: inv.createdAt || inv.dueDate
                    });
                } else {
                    const existing = monthMap.get(month);
                    if (inv.status === 'PAID') {
                        existing.paymentStatus = 'paid';
                        existing.paidAmount = inv.paidAmount || inv.rentAmount;
                        existing.paymentDate = inv.paymentDate || existing.paymentDate;
                    }
                }
            });

            for (const [month, r] of monthMap.entries()) {
                const label = month;
                ledgerItems.push({ date: r.createdAt || new Date(), details: `Monthly Rent Charged (${label})`, debit: r.rentAmount || 0, credit: 0 });
                if (r.paidAmount > 0 || ['paid', 'completed'].includes(String(r.paymentStatus).toLowerCase())) {
                    const method = r.paymentMethod ? ` via ${r.paymentMethod}` : '';
                    ledgerItems.push({ date: r.paymentDate || r.createdAt || new Date(), details: `Rent Payment Received${method} (${label})`, debit: 0, credit: r.paidAmount || r.rentAmount || 0 });
                }
            }

            customEntries.forEach(c => {
                ledgerItems.push({ _id: c._id, date: c.date, details: c.details, debit: c.debit || 0, credit: c.credit || 0 });
            });

            ledgerItems.sort((a, b) => {
                const timeDiff = new Date(a.date) - new Date(b.date);
                if (Math.abs(timeDiff) < 1000 * 60 * 60 * 24) {
                    if (a.debit > 0 && b.credit > 0) return -1;
                    if (a.credit > 0 && b.debit > 0) return 1;
                }
                return timeDiff;
            });

            let balance = 0;
            const entriesWithBalance = ledgerItems.map((item, idx) => {
                balance = balance + item.debit - item.credit;
                return {
                    id: idx + 1,
                    date: new Date(item.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
                    details: item.details,
                    debit: item.debit,
                    credit: item.credit,
                    balance
                };
            });

            res.json({ success: true, ledger: entriesWithBalance, finalBalance: balance });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 14. LEDGER (WRITE) ════════════════════════════════════════════════════════
router.post(
    '/ledger',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantLoginId, details, debit, credit } = req.body;
            const tenant = await Tenant.findOne({ loginId: String(tenantLoginId).toUpperCase() });
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            if (req.user.role === 'owner') {
                if (String(tenant.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden.' });
                }
            }

            const entry = new LedgerEntry({
                tenant: tenant._id,
                tenantLoginId: tenant.loginId,
                ownerLoginId: tenant.ownerLoginId || 'SYSTEM',
                details,
                debit: Number(debit) || 0,
                credit: Number(credit) || 0
            });
            await entry.save();
            res.status(201).json({ success: true, entry });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 15. TENANT SELF-SERVICE: FEEDBACK ════════════════════════════════════════
// IDOR FIX: tenantLoginId from body ignored; JWT identity used exclusively.
router.post(
    '/feedback',
    protect,
    authorize('tenant'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const authenticatedLoginId = callerLoginId(req);
            const { category, rating, comments } = req.body; // tenantLoginId: intentionally ignored

            const tenant = await Tenant.findOne({ loginId: authenticatedLoginId }).populate('property');
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

            const feedback = new TenantFeedback({
                tenant: tenant._id,
                tenantLoginId: tenant.loginId,
                tenantName: tenant.name,
                propertyName: tenant.propertyTitle || (tenant.property && tenant.property.title) || 'Roomhy PG',
                roomNo: tenant.roomNo || 'Gen',
                ownerLoginId: tenant.ownerLoginId || 'SYSTEM',
                category,
                rating: Number(rating) || 5,
                comments
            });
            await feedback.save();
            res.status(201).json({ success: true, feedback });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 16. OWNER: VIEW FEEDBACK FOR THEIR PROPERTIES ════════════════════════════
router.get(
    '/feedback/owner/:ownerLoginId',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    ownerMatchGuard('ownerLoginId'),
    async (req, res) => {
        try {
            const ownerId = String(req.params.ownerLoginId).toUpperCase();
            const feedbacks = await TenantFeedback.find({ ownerLoginId: ownerId }).sort({ createdAt: -1 });
            res.json({ success: true, feedbacks });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 17. ADMIN/OWNER: TENANTS BY PROPERTY ════════════════════════════════════
router.get(
    '/property/:propertyId',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    async (req, res) => {
        try {
            if (req.user.role === 'owner') {
                const property = await Property.findById(req.params.propertyId).select('ownerLoginId').lean();
                if (!property || String(property.ownerLoginId || '').toUpperCase() !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Property does not belong to you.' });
                }
            }

            const tenants = await Tenant.find({ property: req.params.propertyId, isDeleted: { $ne: true } })
                .select(ALWAYS_EXCLUDED)
                .populate('property', 'title roomType locationCode owner ownerLoginId')
                .populate('room', 'number type rent');
            res.json(tenants);
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 18. ADMIN/OWNER: TENANTS BY ROOM ════════════════════════════════════════
router.get(
    '/room/:roomId',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    async (req, res) => {
        try {
            const tenants = await Tenant.find({ room: req.params.roomId, isDeleted: { $ne: true } })
                .select(ALWAYS_EXCLUDED)
                .populate('property', 'title roomType locationCode owner ownerLoginId')
                .populate('room', 'number type rent');

            // Owner: scope to only their tenants (belt-and-suspenders)
            const result = req.user.role === 'owner'
                ? tenants.filter(t => String(t.ownerLoginId || '').toUpperCase() === callerLoginId(req))
                : tenants;

            res.json(result);
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 19. ADMIN/OWNER: SINGLE TENANT BY MONGO _id ═════════════════════════════
// Must be registered AFTER all named two-segment routes above.
router.get(
    '/:id',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    async (req, res) => {
        try {
            const tenant = await Tenant.findById(req.params.id)
                .select(ALWAYS_EXCLUDED)
                .populate('property', 'title roomType locationCode owner ownerLoginId')
                .populate('room', 'number type rent');

            if (!tenant || tenant.isDeleted) return res.status(404).json({ message: 'Tenant not found' });

            if (req.user.role === 'owner') {
                const tenantOwner = String(
                    tenant.ownerLoginId ||
                    (tenant.property && tenant.property.ownerLoginId) || ''
                ).toUpperCase();
                if (tenantOwner !== callerLoginId(req)) {
                    return res.status(403).json({ success: false, message: 'Forbidden: Not your tenant.' });
                }
            }

            res.json(tenant);
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 20. ADMIN/OWNER: CREATE TENANT ══════════════════════════════════════════
router.post(
    '/',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const tenant = new Tenant(req.body);
            await tenant.save();
            res.status(201).json(tenant);
        } catch (err) {
            res.status(400).json({ message: err.message });
        }
    }
);

// ══ 21. ADMIN/OWNER: UPDATE TENANT ══════════════════════════════════════════
router.patch('/:id', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (req.user.role === 'owner') {
            const tenantProperty = await Property.findById(tenant.property);
            if (!tenantProperty || String(tenantProperty.ownerLoginId).toUpperCase() !== callerLoginId(req)) {
                return res.status(403).json({ message: 'Forbidden: You do not own this tenant\'s property' });
            }
        }

        if (req.body.name || req.body.phone || req.body.email) {
            const User = require('../models/user');
            const userUpdate = {};
            if (req.body.name)  userUpdate.name  = req.body.name;
            if (req.body.phone) userUpdate.phone = req.body.phone;
            if (req.body.email) userUpdate.email = req.body.email;

            if (tenant.user) {
                await User.findByIdAndUpdate(tenant.user, userUpdate);
            } else if (tenant.loginId) {
                await User.findOneAndUpdate({ loginId: tenant.loginId }, userUpdate);
            }
        }

        const roomNoChanged = req.body.roomNo !== undefined && req.body.roomNo !== tenant.roomNo;
        const bedNoChanged  = req.body.bedNo  !== undefined && req.body.bedNo  !== tenant.bedNo;

        if (roomNoChanged || bedNoChanged) {
            const targetRoomNo = req.body.roomNo !== undefined ? req.body.roomNo : tenant.roomNo;
            const newRoomObj = targetRoomNo
                ? await Room.findOne({
                    property: tenant.property,
                    title: { $regex: `^${String(targetRoomNo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
                  })
                : null;

            if (newRoomObj) {
                // Delegates to the SAME service the dedicated POST /:id/transfer
                // endpoint uses — one transfer implementation, not two. This
                // predates that endpoint and is kept for any caller (e.g. the
                // "Edit Tenant" form) that bundles a room change with other
                // profile fields. No explicit transferDate here, so "now" is
                // used, same as before this consolidation.
                try {
                    await roomTransferService.transferTenant({
                        tenant,
                        newRoom: newRoomObj,
                        newBedNo: req.body.bedNo,
                        newAgreedRent: req.body.agreedRent,
                        performedBy: callerLoginId(req) || 'unknown',
                    });
                } catch (transferErr) {
                    return res.status(transferErr.status || 500).json({ message: transferErr.message });
                }
            } else if (targetRoomNo) {
                // No matching room found for the given title — preserve the
                // pre-existing fallback (clear the room link) rather than
                // silently doing nothing; there's no valid room to transfer
                // into, so there's nothing for the shared service to do.
                tenant.room = undefined;
            }
        } else {
            if (req.body.name && tenant.room && tenant.bedNo) {
                const currentRoom = await Room.findById(tenant.room);
                if (currentRoom && currentRoom.bedAssignments) {
                    const bIndex = Number(tenant.bedNo) - 1;
                    if (bIndex >= 0 && currentRoom.bedAssignments[bIndex] &&
                        String(currentRoom.bedAssignments[bIndex].tenantId) === String(tenant._id)) {
                        currentRoom.bedAssignments[bIndex].tenantName = req.body.name;
                        currentRoom.markModified('bedAssignments');
                        await currentRoom.save();
                    }
                }
            }
        }

        if (tenant.loginId) {
            const rentUpdate = {};
            if (req.body.name)                         rentUpdate.tenantName  = req.body.name;
            if (req.body.phone)                        rentUpdate.tenantPhone = req.body.phone;
            if (req.body.email)                        rentUpdate.tenantEmail = req.body.email;
            // roomNumber/rentAmount/totalDue are billing fields, not contact
            // details — folding them into the same $set as name/phone/email
            // is what let a room change silently rewrite whatever "pending"
            // Rent doc existed, including one for the CURRENT billing period.
            // Scope those specifically to the period the change actually
            // takes effect: this billing month keeps the old room/rent (see
            // the RoomAssignmentHistory write above); the new values only
            // apply from next month onward.
            const rentUpdateFilter = { tenantLoginId: tenant.loginId, paymentStatus: 'pending' };
            if (Object.keys(rentUpdate).length > 0) {
                await Rent.updateMany(rentUpdateFilter, { $set: rentUpdate });
            }
            // A room/bed change already went through roomTransferService above,
            // which scopes its own Rent update by effective billing month — do
            // not also apply one here or it would double-process the same
            // change. This only handles a pure rent renegotiation with no room
            // change (e.g. an owner adjusting rent without moving the tenant),
            // which needs the same "not yet effective this month" protection.
            if (!(roomNoChanged || bedNoChanged) && req.body.agreedRent !== undefined) {
                await Rent.updateMany(
                    { ...rentUpdateFilter, collectionMonth: { $gte: nextBillingMonth(new Date()) } },
                    { $set: { rentAmount: Number(req.body.agreedRent), totalDue: Number(req.body.agreedRent) } }
                );
            }
        }

        // Update all top-level schema fields
        const schemaFields = [
            'name', 'phone', 'email', 'dob', 'gender', 'guardianNumber',
            'roomNo', 'bedNo', 'moveInDate', 'agreedRent', 'paymentFrequency',
            'status', 'kycStatus', 'baseRoomRent', 'securityDepositTotal',
            'securityDepositPaid', 'securityDepositBalance', 'remarks', 'occupation', 'company',
            'permanentAddress'
        ];
        schemaFields.forEach(key => {
            if (req.body[key] !== undefined) {
                if (['agreedRent', 'baseRoomRent', 'securityDepositTotal', 'securityDepositPaid', 'securityDepositBalance'].includes(key)) {
                    tenant[key] = req.body[key] !== '' && req.body[key] !== null ? Number(req.body[key]) : undefined;
                } else if (key === 'moveInDate') {
                    tenant[key] = req.body[key] ? new Date(req.body[key]) : undefined;
                } else {
                    tenant[key] = req.body[key];
                }
            }
        });

        // Recalculate securityDepositBalance if total or paid were updated
        if (req.body.securityDepositTotal !== undefined || req.body.securityDepositPaid !== undefined) {
            const tot = Number(tenant.securityDepositTotal || 0);
            const paid = Number(tenant.securityDepositPaid || 0);
            tenant.securityDepositBalance = Math.max(0, tot - paid);
        }

        // Update emergencyContact fields
        if (req.body.additional) {
            const add = req.body.additional;
            if (!tenant.emergencyContact) tenant.emergencyContact = {};
            if (add.emergencyName !== undefined) tenant.emergencyContact.name = add.emergencyName;
            if (add.emergencyPhone !== undefined) tenant.emergencyContact.phone = add.emergencyPhone;
            if (add.relationship !== undefined) tenant.emergencyContact.relationship = add.relationship;
            
            // Sync permanentAddress, remarks, occupation, company if present in additional
            if (add.permanentAddress !== undefined) tenant.permanentAddress = add.permanentAddress;
            if (add.remarks !== undefined) tenant.remarks = add.remarks;
            if (add.occupation !== undefined) tenant.occupation = add.occupation;
            if (add.company !== undefined) tenant.company = add.company;
        }

        // Update kyc details if idProof is passed
        if (req.body.idProof) {
            const ip = req.body.idProof;
            if (!tenant.kyc) tenant.kyc = {};
            if (ip.type !== undefined) tenant.kyc.idProof = ip.type;
            if (ip.number !== undefined) {
                tenant.kyc.idProofFile = ip.number;
                tenant.kyc.aadhaarNumber = ip.number;
                tenant.kyc.aadhar = ip.number;
            }
            if (ip.file !== undefined) {
                tenant.kyc.idProofFile = ip.file;
                tenant.kyc.aadharFile = ip.file;
                tenant.kyc.aadhaarFront = ip.file;
            }
            tenant.markModified('kyc');
        }

        // Update digitalCheckin profile and agreementDetails
        if (!tenant.digitalCheckin) tenant.digitalCheckin = {};
        if (!tenant.digitalCheckin.profile) tenant.digitalCheckin.profile = {};
        
        tenant.digitalCheckin.profile.name = tenant.name;
        tenant.digitalCheckin.profile.phone = tenant.phone;
        tenant.digitalCheckin.profile.email = tenant.email;
        tenant.digitalCheckin.profile.roomNo = tenant.roomNo;
        tenant.digitalCheckin.profile.agreedRent = tenant.agreedRent;
        tenant.digitalCheckin.profile.dob = tenant.dob;

        if (!tenant.digitalCheckin.agreementDetails) tenant.digitalCheckin.agreementDetails = {};
        const agd = tenant.digitalCheckin.agreementDetails;
        
        if (req.body.accommodationType !== undefined) agd.accommodationType = req.body.accommodationType;
        if (req.body.minStay !== undefined) agd.minimumStayDuration = `${req.body.minStay} Months`;
        if (req.body.noticePeriod !== undefined) agd.noticePeriodDays = req.body.noticePeriod;
        if (req.body.rentDueDate !== undefined) agd.licenseFeeDueDate = req.body.rentDueDate;
        if (req.body.lateFee !== undefined) agd.lateFee = req.body.lateFee;
        if (req.body.licenseDuration !== undefined) agd.licenseDuration = `${req.body.licenseDuration} months`;
        if (req.body.moveOutCharges !== undefined) agd.moveOutCharges = req.body.moveOutCharges;
        if (req.body.noticePeriodCharges !== undefined) agd.noticePeriodCharges = req.body.noticePeriodCharges;
        if (req.body.inclusions !== undefined) agd.inclusions = req.body.inclusions;
        if (req.body.gstCharges !== undefined) agd.gstCharges = req.body.gstCharges;
        if (req.body.advanceCharge !== undefined) agd.advanceCharge = req.body.advanceCharge;
        if (req.body.propertyAddress !== undefined) agd.propertyAddress = req.body.propertyAddress;
        if (req.body.permanentAddress !== undefined) agd.permanentAddress = req.body.permanentAddress;
        if (tenant.securityDepositTotal !== undefined) agd.securityDeposit = tenant.securityDepositTotal;
        
        tenant.markModified('digitalCheckin');

        await tenant.save();
        res.json(tenant);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// ══ 22. ADMIN/OWNER: DELETE (SOFT) TENANT ════════════════════════════════════
router.delete('/:id', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        if (req.user.role === 'owner') {
            const tenantProperty = await Property.findById(tenant.property);
            if (!tenantProperty || String(tenantProperty.ownerLoginId).toUpperCase() !== callerLoginId(req)) {
                return res.status(403).json({ message: 'Forbidden: You do not own this tenant\'s property' });
            }
        }

        const roomsToUpdate = await Room.find({ 'bedAssignments.tenantId': req.params.id });
        for (const room of roomsToUpdate) {
            room.bedAssignments = room.bedAssignments.map(assignment => {
                if (assignment.tenantId && assignment.tenantId.toString() === req.params.id) return {};
                return assignment;
            });
            room.markModified('bedAssignments');
            await room.save();
        }

        const User = require('../models/user');
        if (tenant.user)    await User.findByIdAndUpdate(tenant.user, { $set: { isDeleted: true, isActive: false } });
        if (tenant.loginId) await User.updateOne({ loginId: tenant.loginId, role: 'tenant' }, { $set: { isDeleted: true, isActive: false } });

        tenant.status    = 'inactive';
        tenant.isDeleted = true;
        tenant.room      = undefined;
        await tenant.save();
        res.json({ message: 'Tenant deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// ══ 23. ADMIN/OWNER: DEACTIVATE / REACTIVATE ════════════════════════════════
router.post('/:id/deactivate', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = await Tenant.findByIdAndUpdate(req.params.id, { $set: { status: 'suspended' } }, { new: true });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const User = require('../models/user');
        if (tenant.user)    await User.findByIdAndUpdate(tenant.user, { $set: { isActive: false } });
        if (tenant.loginId) await User.updateOne({ loginId: tenant.loginId, role: 'tenant' }, { $set: { isActive: false } });

        return res.json({ success: true, message: 'Tenant account deactivated successfully', data: tenant });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/:id/reactivate', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = await Tenant.findByIdAndUpdate(req.params.id, { $set: { status: 'active' } }, { new: true });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const User = require('../models/user');
        if (tenant.user)    await User.findByIdAndUpdate(tenant.user, { $set: { isActive: true } });
        if (tenant.loginId) await User.updateOne({ loginId: tenant.loginId, role: 'tenant' }, { $set: { isActive: true } });

        return res.json({ success: true, message: 'Tenant account reactivated successfully', data: tenant });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ══ 23b. ADMIN/OWNER: TRANSFER TENANT TO A NEW ROOM ═════════════════════════
// Thin HTTP wrapper — all transfer business logic lives in
// services/roomTransferService.js, shared with the generic PATCH handler
// above (which still allows a room change bundled with other profile edits).
// There is exactly one transfer implementation, not two.
router.post('/:id/transfer', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const { newRoomId, newRoomNo, newBedNo, newAgreedRent, transferDate } = req.body || {};
        if (!newRoomId && !newRoomNo) {
            return res.status(400).json({ success: false, message: 'newRoomId or newRoomNo is required' });
        }
        if (transferDate !== undefined && isNaN(new Date(transferDate).getTime())) {
            return res.status(400).json({ success: false, message: 'transferDate is not a valid date' });
        }

        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

        if (req.user.role === 'owner') {
            const tenantProperty = await Property.findById(tenant.property);
            if (!tenantProperty || String(tenantProperty.ownerLoginId).toUpperCase() !== callerLoginId(req)) {
                return res.status(403).json({ success: false, message: 'Forbidden: You do not own this tenant\'s property' });
            }
        }

        const newRoom = newRoomId
            ? await Room.findOne({ _id: newRoomId, property: tenant.property })
            : await Room.findOne({
                property: tenant.property,
                title: { $regex: `^${String(newRoomNo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
              });
        if (!newRoom) return res.status(404).json({ success: false, message: 'Target room not found on this property' });

        const result = await roomTransferService.transferTenant({
            tenant,
            newRoom,
            newBedNo,
            newAgreedRent,
            transferDate,
            performedBy: req.user?.loginId || String(req.user?.id || 'unknown'),
        });

        return res.json({
            success: true,
            message: 'Tenant transferred. The current billing period keeps the old room/rent; the new room/rent applies from next month.',
            data: { tenant: result.tenant, assignment: result.assignment },
        });
    } catch (err) {
        console.error('[tenantRoutes] transfer error:', err);
        return res.status(err.status || 500).json({ success: false, message: err.message });
    }
});

// ══ BULK: SEND RENT REMINDERS ════════════════════════════════════════════════
router.post('/bulk-rent-reminder', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { tenantIds, ownerLoginId } = req.body;
        if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
            return res.status(400).json({ success: false, message: 'tenantIds[] required' });
        }
        const tenants = await Tenant.find({ _id: { $in: tenantIds }, status: 'active' }).select('name email phone loginId ownerLoginId');
        const Notification = require('../models/Notification');
        let sent = 0;
        for (const t of tenants) {
            try {
                await Notification.create({
                    userId: t._id,
                    title: 'Rent Reminder',
                    message: `Dear ${t.name || 'Tenant'}, your rent is due. Please pay on time to avoid late fees.`,
                    type: 'rent_reminder',
                });
                sent++;
            } catch (_) {}
        }
        res.json({ success: true, message: `Rent reminder sent to ${sent} tenant(s)`, sent });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══ BULK: DELETE INACTIVE TENANTS ════════════════════════════════════════════
router.delete('/bulk-delete-inactive', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { tenantIds } = req.body;
        if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
            return res.status(400).json({ success: false, message: 'tenantIds[] required' });
        }
        // Only allow deleting inactive/ex tenants
        const result = await Tenant.deleteMany({ _id: { $in: tenantIds }, status: { $in: ['inactive', 'ex-tenant'] } });
        res.json({ success: true, deleted: result.deletedCount, message: `${result.deletedCount} inactive tenant(s) deleted` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══ BULK: APPROVE MOVE-OUT REQUESTS ════════════════════════════════════════════
router.put('/moveout/bulk-approve', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { tenantIds } = req.body;
        if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
            return res.status(400).json({ success: false, message: 'tenantIds[] required' });
        }
        const { calcNoticeEndDate } = require('../services/moveoutService');
        const approvedAt = new Date();
        const noticeEndDate = calcNoticeEndDate(approvedAt);
        const result = await Tenant.updateMany(
            { _id: { $in: tenantIds }, 'moveoutRequest.status': 'pending' },
            { $set: { 'moveoutRequest.status': 'approved', 'moveoutRequest.approvedAt': approvedAt, 'moveoutRequest.noticeEndDate': noticeEndDate } }
        );
        res.json({ success: true, modified: result.modifiedCount, message: `${result.modifiedCount} move-out request(s) approved` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══ KYC: BULK APPROVE ════════════════════════════════════════════════════════
router.post('/kyc/bulk-approve', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { tenantIds } = req.body;
        if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
            return res.status(400).json({ success: false, message: 'tenantIds[] required' });
        }
        const result = await Tenant.updateMany(
            { _id: { $in: tenantIds } },
            { $set: { kycStatus: 'verified', 'kyc.verified': true, 'kyc.verifiedAt': new Date() } }
        );
        res.json({ success: true, modified: result.modifiedCount, message: `${result.modifiedCount} KYC(s) approved` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══ KYC: BULK REJECT ═════════════════════════════════════════════════════════
router.post('/kyc/bulk-reject', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { tenantIds, reason } = req.body;
        if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
            return res.status(400).json({ success: false, message: 'tenantIds[] required' });
        }
        const result = await Tenant.updateMany(
            { _id: { $in: tenantIds } },
            { $set: { kycStatus: 'rejected', 'kyc.rejectedAt': new Date(), 'kyc.rejectionReason': reason || 'Bulk rejected by admin' } }
        );
        res.json({ success: true, modified: result.modifiedCount, message: `${result.modifiedCount} KYC(s) rejected` });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══ KYC: POLICE VERIFICATION CSV EXPORT ══════════════════════════════════════
router.get('/kyc/police-verification-export', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { ownerLoginId } = req.query;
        const filter = { kycStatus: { $in: ['verified', 'submitted'] } };
        if (ownerLoginId) filter.ownerLoginId = ownerLoginId.toUpperCase();

        const tenants = await Tenant.find(filter).select('name phone email dateOfBirth kyc roomNo propertyTitle ownerLoginId moveInDate');

        const rows = tenants.map(t => [
            t.name || '',
            t.phone || '',
            t.email || '',
            t.dateOfBirth ? new Date(t.dateOfBirth).toLocaleDateString('en-IN') : '',
            t.kyc?.idProofType || '',
            t.kyc?.idProofNumber || '',
            t.kyc?.address || '',
            t.roomNo || '',
            t.propertyTitle || '',
            t.moveInDate ? new Date(t.moveInDate).toLocaleDateString('en-IN') : '',
        ]);

        const headers = ['Name', 'Phone', 'Email', 'Date of Birth', 'ID Proof Type', 'ID Proof Number', 'Address', 'Room No', 'Property', 'Move-In Date'];
        const csvRows = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="police_verification.csv"');
        res.send(csvRows);
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══ AGREEMENTS: BULK SEND ════════════════════════════════════════════════════
router.post('/agreements/bulk-send', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { tenantIds } = req.body;
        if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
            return res.status(400).json({ success: false, message: 'tenantIds[] required' });
        }
        const tenants = await Tenant.find({ _id: { $in: tenantIds } }).select('name email phone loginId');
        const Notification = require('../models/Notification');
        let sent = 0;
        for (const t of tenants) {
            try {
                await Notification.create({
                    userId: t._id,
                    title: 'Rental Agreement',
                    message: `Dear ${t.name || 'Tenant'}, please sign your rental agreement. Login to your Roomhy account to complete the process.`,
                    type: 'agreement_request',
                });
                sent++;
            } catch (_) {}
        }
        res.json({ success: true, message: `Agreement send request sent to ${sent} tenant(s)`, sent });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ══ TENANTS: BULK DELETE ══════════════════════════════════════════════════════
router.post('/bulk-delete', protect, authorize('superadmin', 'areamanager', 'owner'), async (req, res) => {
    try {
        const { tenantIds } = req.body;
        if (!Array.isArray(tenantIds) || tenantIds.length === 0) {
            return res.status(400).json({ success: false, message: 'tenantIds[] array required' });
        }
        const result = await Tenant.deleteMany({ _id: { $in: tenantIds } });
        return res.json({
            success: true,
            deleted: result.deletedCount,
            message: `${result.deletedCount} tenant(s) deleted successfully`
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
