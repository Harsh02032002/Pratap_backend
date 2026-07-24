const express = require('express');
const router = express.Router();
const Tenant = require('../models/Tenant');
const Room = require('../models/Room');
const Property = require('../models/Property');
const jwt = require('jsonwebtoken');
const { sendMail } = require('../utils/mailer');
const LedgerEntry = require('../models/LedgerEntry');
const TenantFeedback = require('../models/TenantFeedback');
const Rent = require('../models/Rent');
const { protect, authorize } = require('../middleware/authMiddleware');
const tenantController = require('../controllers/tenantController');
const { auditTrail } = require('../middleware/auditTrail');

// ─── Field-level security projection ─────────────────────────────────────────
// Sensitive fields are stripped at the DB query layer (defence-in-depth).
// Even if an upstream auth check were accidentally omitted, these fields
// structurally cannot appear in any response from this router.
const ALWAYS_EXCLUDED =
    '-tempPassword' +
    ' -kyc.aadhaarNumber' +
    ' -kyc.aadhar' +
    ' -kyc.aadhaarLinkedPhone' +
    ' -kyc.aadharFile' +
    ' -kyc.aadhaarFront' +
    ' -kyc.aadhaarBack' +
    ' -kyc.idProofFile' +
    ' -kyc.addressProofFile' +
    ' -kyc.otpVerified' +
    ' -kyc.otpVerifiedAt' +
    ' -digitalCheckin.kyc' +
    ' -digitalCheckin.agreement.signatureDataUrl' +
    ' -agreementRequestId' +
    ' -agreementESignName';

// ─── Internal helpers ─────────────────────────────────────────────────────────

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

// ══ 1. ASSIGN TENANT ══════════════════════════════════════════════════════════
// Kept open: owner panel does not transmit JWT during assignment flow.
// Protected by auditTrail (actor logged as 'anonymous' when no JWT).
// TODO: migrate owner panel to send JWT and add protect + authorize('owner').
router.post(
    '/assign',
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

// ══ 3. ADMIN: ALL TENANTS ════════════════════════════════════════════════════
// Restricted to privileged roles. Sensitive fields excluded via projection
// in getAllTenants controller (ALWAYS_EXCLUDED_PROJECTION).
router.get(
    '/',
    protect,
    authorize('superadmin', 'areamanager'),
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
            tenant.kyc.aadhar = aadhaarNumber || tenant.kyc.aadhar;
            tenant.kyc.aadharFile = aadharFile || tenant.kyc.aadharFile;
            tenant.kyc.aadhaarFront = aadhaarFront || tenant.kyc.aadhaarFront;
            tenant.kyc.aadhaarBack = aadhaarBack || tenant.kyc.aadhaarBack;
            tenant.kyc.addressProofFile = addressProofFile || tenant.kyc.addressProofFile;
            tenant.kyc.idProof = panNumber ? 'PAN Card' : 'Aadhaar Card';
            tenant.kyc.idProofFile = panNumber || tenant.kyc.idProofFile;
            tenant.kyc.uploadedAt = new Date();
            tenant.kycStatus = 'submitted';

            await tenant.save();
            // Never reflect back sensitive document data in the response
            res.json({ success: true, kycStatus: tenant.kycStatus, idProof: tenant.kyc.idProof, uploadedAt: tenant.kyc.uploadedAt });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

// ══ 8. ADMIN: KYC APPROVE / REJECT ══════════════════════════════════════════
router.post(
    '/kyc/approve',
    protect,
    authorize('superadmin', 'areamanager'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            tenant.kycStatus = 'verified';
            await tenant.save();

            // [PHASE 3 HOOK 3: Admin Approval -> Payment Link]
            try {
                if (tenant.paymentLinkStatus !== 'sent' && tenant.paymentLinkStatus !== 'paid') {
                    let rent = await Rent.findOne({ tenantId: tenant._id, paymentStatus: 'pending' }).sort({ createdAt: -1 });
                    if (!rent) {
                        rent = new Rent({
                            tenantId: tenant._id,
                            tenantLoginId: tenant.loginId,
                            tenantName: tenant.name,
                            tenantEmail: tenant.email,
                            tenantPhone: tenant.phone,
                            ownerLoginId: tenant.ownerLoginId,
                            propertyName: tenant.propertyTitle || 'RoomHy Property',
                            roomNumber: tenant.roomNo || '',
                            rentAmount: tenant.agreedRent || 0,
                            totalDue: tenant.agreedRent || 0,
                            paymentStatus: 'pending'
                        });
                        await rent.save();
                    }
                    const rentRecordId = rent._id;
                    const jwtSecret = process.env.JWT_SECRET;
                    if (!jwtSecret) throw new Error('JWT_SECRET environment variable is missing');

                    const token = jwt.sign(
                        { loginId: tenant.loginId, rentRecordId, purpose: 'onboarding_payment' },
                        jwtSecret,
                        { expiresIn: '72h' }
                    );
                    let appBase = process.env.APP_URL || 'http://localhost:5173';
                    if (appBase.endsWith('/')) appBase = appBase.slice(0, -1);
                    const paymentUrl = `${appBase}/payment/gateway?token=${token}`;

                    const subject = `Payment Required: Secure your booking for ${tenant.propertyTitle || 'RoomHy'}`;
                    const text = `Hello ${tenant.name},\n\nYour KYC is verified! Please complete your pending onboarding payment to secure your booking.\n\nPay here: ${paymentUrl}\n\nThis link expires in 72 hours.\n\n© RoomHy`;
                    const html = `<p>Hello ${tenant.name},</p><p>Your KYC is verified! Please complete your pending onboarding payment to secure your booking.</p><p><a href="${paymentUrl}">Click here to Pay</a></p><p><i>Link expires in 72 hours.</i></p>`;

                    await sendMail(tenant.email, subject, text, html);

                    tenant.paymentLinkStatus = 'sent';
                    await tenant.save();
                    console.log(`[PAYMENT LINK] Hook 3 (admin approve) sent for ${tenant.loginId}`);
                }
            } catch (hookErr) {
                console.error('[PAYMENT LINK ERROR] Hook 3 Failed:', hookErr.message);
            }

            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
        }
    }
);

router.post(
    '/kyc/reject',
    protect,
    authorize('superadmin', 'areamanager'),
    auditTrail('tenants'),
    async (req, res) => {
        try {
            const { tenantId } = req.body;
            const tenant = await Tenant.findById(tenantId);
            if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
            tenant.kycStatus = 'rejected';
            await tenant.save();
            res.json({ success: true, tenant });
        } catch (err) {
            res.status(500).json({ message: err.message });
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

            tenant.status = 'inactive';
            tenant.moveoutRequest.status = 'approved';
            tenant.moveoutRequest.duesAtMoveout = Number(duesAtMoveout) || 0;
            tenant.moveoutRequest.refundAmount = Number(refundAmount) || 0;
            tenant.moveoutRequest.refundStatus = refundStatus || 'cleared';
            await tenant.save();
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
            const rents = await Rent.find({ tenantLoginId: loginId }).lean();
            const customEntries = await LedgerEntry.find({ tenantLoginId: loginId }).lean();
            const ledgerItems = [];

            rents.forEach(r => {
                const label = r.collectionMonth ||
                    new Date(r.createdAt || r.dueDate || Date.now()).toLocaleString('en-US', { month: 'short', year: 'numeric' });
                ledgerItems.push({ date: r.createdAt || r.dueDate || new Date(), details: `Monthly Rent Charged (${label})`, debit: r.rentAmount || 0, credit: 0 });
                if (r.paidAmount > 0 || ['paid', 'completed'].includes(String(r.paymentStatus).toLowerCase())) {
                    const method = r.paymentMethod ? ` via ${r.paymentMethod}` : '';
                    ledgerItems.push({ date: r.paymentDate || r.updatedAt || r.createdAt || new Date(), details: `Rent Payment Received${method} (${label})`, debit: 0, credit: r.paidAmount || r.rentAmount || 0 });
                }
            });

            customEntries.forEach(c => {
                ledgerItems.push({ _id: c._id, date: c.date, details: c.details, debit: c.debit || 0, credit: c.credit || 0 });
            });

            ledgerItems.sort((a, b) => new Date(a.date) - new Date(b.date));

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

// ══ PHASE 6: ADMIN RETRY FOR FAILED ONBOARDING EMAILS ═══════════════════════
router.post(
    '/retry-failed-emails',
    protect,
    authorize('superadmin', 'areamanager', 'owner'),
    tenantController.retryFailedOnboardingEmails
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
            if (req.body.name) userUpdate.name = req.body.name;
            if (req.body.phone) userUpdate.phone = req.body.phone;
            if (req.body.email) userUpdate.email = req.body.email;

            if (tenant.user) {
                await User.findByIdAndUpdate(tenant.user, userUpdate);
            } else if (tenant.loginId) {
                await User.findOneAndUpdate({ loginId: tenant.loginId }, userUpdate);
            }
        }

        const roomNoChanged = req.body.roomNo !== undefined && req.body.roomNo !== tenant.roomNo;
        const bedNoChanged = req.body.bedNo !== undefined && req.body.bedNo !== tenant.bedNo;

        if (roomNoChanged || bedNoChanged) {
            if (tenant.room && tenant.bedNo) {
                const oldRoom = await Room.findById(tenant.room);
                if (oldRoom && oldRoom.bedAssignments) {
                    const oldBedNoRaw = String(tenant.bedNo).trim().replace(/^[Bb]ed\s*/i, '');
                    const oldIndex = Number(oldBedNoRaw) - 1;
                    if (oldIndex >= 0 && oldRoom.bedAssignments[oldIndex] &&
                        String(oldRoom.bedAssignments[oldIndex].tenantId) === String(tenant._id)) {
                        oldRoom.bedAssignments[oldIndex] = {};
                        oldRoom.markModified('bedAssignments');
                        await oldRoom.save();
                    }
                }
            }

            const targetRoomNo = req.body.roomNo !== undefined ? req.body.roomNo : tenant.roomNo;
            const targetBedNoRaw = req.body.bedNo !== undefined ? req.body.bedNo : tenant.bedNo;
            const targetBedNoStr = String(targetBedNoRaw).trim().replace(/^[Bb]ed\s*/i, '');

            let newRoomObj = null;
            if (targetRoomNo) {
                newRoomObj = await Room.findOne({
                    property: tenant.property,
                    title: { $regex: `^${String(targetRoomNo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
                });
            }

            if (newRoomObj) {
                tenant.room = newRoomObj._id;
                if (targetBedNoStr) {
                    const bIndex = Number(targetBedNoStr) - 1;
                    if (bIndex >= 0) {
                        if (!newRoomObj.bedAssignments) newRoomObj.bedAssignments = [];
                        while (newRoomObj.bedAssignments.length <= bIndex) newRoomObj.bedAssignments.push({});

                        const occupant = newRoomObj.bedAssignments[bIndex];
                        if (occupant && occupant.tenantId && String(occupant.tenantId) !== String(tenant._id)) {
                            return res.status(400).json({ message: `Bed ${targetBedNoRaw} in Room ${targetRoomNo} is already occupied.` });
                        }

                        newRoomObj.bedAssignments[bIndex] = {
                            tenantId: tenant._id,
                            tenantName: req.body.name || tenant.name,
                            tenantLoginId: tenant.loginId,
                            assignedAt: new Date()
                        };
                        newRoomObj.markModified('bedAssignments');
                        await newRoomObj.save();
                    }
                }
            } else if (targetRoomNo) {
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
            if (req.body.name) rentUpdate.tenantName = req.body.name;
            if (req.body.phone) rentUpdate.tenantPhone = req.body.phone;
            if (req.body.email) rentUpdate.tenantEmail = req.body.email;
            if (req.body.roomNo !== undefined) rentUpdate.roomNumber = req.body.roomNo;
            if (req.body.agreedRent !== undefined) {
                rentUpdate.rentAmount = Number(req.body.agreedRent);
                rentUpdate.totalDue = Number(req.body.agreedRent);
            }
            if (Object.keys(rentUpdate).length > 0) {
                await Rent.updateMany({ tenantLoginId: tenant.loginId, paymentStatus: 'pending' }, { $set: rentUpdate });
            }
        }

        const allowedUpdates = [
            'name', 'phone', 'email', 'dob', 'gender', 'guardianNumber',
            'roomNo', 'bedNo', 'moveInDate', 'agreedRent', 'paymentFrequency',
            'status', 'kycStatus'
        ];
        allowedUpdates.forEach(key => {
            if (req.body[key] !== undefined) tenant[key] = req.body[key];
        });

        if (tenant.digitalCheckin && tenant.digitalCheckin.profile) {
            if (req.body.name) tenant.digitalCheckin.profile.name = req.body.name;
            if (req.body.phone) tenant.digitalCheckin.profile.phone = req.body.phone;
            if (req.body.email) tenant.digitalCheckin.profile.email = req.body.email;
            if (req.body.roomNo !== undefined) tenant.digitalCheckin.profile.roomNo = req.body.roomNo;
            if (req.body.agreedRent !== undefined) tenant.digitalCheckin.profile.agreedRent = Number(req.body.agreedRent);
            tenant.markModified('digitalCheckin');
        }

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
        if (tenant.user) await User.findByIdAndUpdate(tenant.user, { $set: { isDeleted: true, isActive: false } });
        if (tenant.loginId) await User.updateOne({ loginId: tenant.loginId, role: 'tenant' }, { $set: { isDeleted: true, isActive: false } });

        tenant.status = 'inactive';
        tenant.isDeleted = true;
        tenant.room = undefined;
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
        if (tenant.user) await User.findByIdAndUpdate(tenant.user, { $set: { isActive: false } });
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
        if (tenant.user) await User.findByIdAndUpdate(tenant.user, { $set: { isActive: true } });
        if (tenant.loginId) await User.updateOne({ loginId: tenant.loginId, role: 'tenant' }, { $set: { isActive: true } });

        return res.json({ success: true, message: 'Tenant account reactivated successfully', data: tenant });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
