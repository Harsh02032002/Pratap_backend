const express = require('express');
const router = express.Router();
const Tenant = require('../models/Tenant');
const Room = require('../models/Room');
const Property = require('../models/Property');
const LedgerEntry = require('../models/LedgerEntry');
const TenantFeedback = require('../models/TenantFeedback');
const Rent = require('../models/Rent');
const { protect, authorize } = require('../middleware/authMiddleware');
const tenantController = require('../controllers/tenantController');
const { auditTrail } = require('../middleware/auditTrail');

// 0. Assign tenant to room - POST must come before GET
// Owner panel currently uses owner session (no JWT), so keep this endpoint open.
router.post('/assign', auditTrail('tenants'), tenantController.assignTenant);

// 1. Get all tenants
router.get('/', tenantController.getAllTenants);

// 1b. Get tenants by owner loginId
router.get('/owner/:ownerId', tenantController.getTenantsByOwner);

// 2. Get tenant by ID
router.get('/:id', async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.id)
            .populate('property', 'title roomType locationCode owner ownerLoginId')
            .populate('room', 'number type rent');
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        res.json(tenant);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 3. Create tenant
router.post('/', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = new Tenant(req.body);
        await tenant.save();
        res.status(201).json(tenant);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// 4. Update tenant
router.patch('/:id', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = await Tenant.findByIdAndUpdate(req.params.id, req.body, { new: true });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        res.json(tenant);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// 5. Delete tenant
router.delete('/:id', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        
        // Remove tenant references from rooms' bedAssignments
        await Room.updateMany(
            { 'bedAssignments.tenantId': req.params.id },
            { $pull: { bedAssignments: { tenantId: req.params.id } } }
        );

        // Delete corresponding login credentials from User collection
        const User = require('../models/user');
        if (tenant.user) {
            await User.findByIdAndDelete(tenant.user);
        }
        if (tenant.loginId) {
            await User.deleteOne({ loginId: tenant.loginId, role: 'tenant' });
        }

        await Tenant.findByIdAndDelete(req.params.id);
        res.json({ message: 'Tenant deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 6. Get tenants by property
router.get('/property/:propertyId', async (req, res) => {
    try {
        const tenants = await Tenant.find({ property: req.params.propertyId })
            .populate('property', 'title roomType locationCode owner ownerLoginId')
            .populate('room', 'number type rent');
        res.json(tenants);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 7. Get tenants by room
router.get('/room/:roomId', async (req, res) => {
    try {
        const tenants = await Tenant.find({ room: req.params.roomId })
            .populate('property', 'title roomType locationCode owner ownerLoginId')
            .populate('room', 'number type rent');
        res.json(tenants);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Check-in / move-in approval
router.post('/checkin/approve', async (req, res) => {
    try {
        const { tenantId } = req.body;
        const tenant = await Tenant.findById(tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        
        tenant.status = 'active';
        await tenant.save();
        res.json({ success: true, tenant });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Get all moveout requests for a specific owner's tenants
router.get('/moveout/owner/:ownerId', async (req, res) => {
    try {
        const ownerLoginId = String(req.params.ownerId).toUpperCase();

        // Find tenants belonging to this owner who have submitted a moveout request
        const tenants = await Tenant.find({
            ownerLoginId,
            'moveoutRequest.status': { $in: ['pending', 'approved', 'rejected'] }
        })
        .populate('property', 'title roomType locationCode ownerLoginId')
        .sort({ 'moveoutRequest.submittedAt': -1 });

        res.json({ success: true, requests: tenants });
    } catch (err) {
        console.error('Get owner moveout requests error:', err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// Move-out notice endpoints
router.post('/moveout', async (req, res) => {
    try {
        const { tenantLoginId, reason, requestedDate } = req.body;
        const tenant = await Tenant.findOne({ loginId: String(tenantLoginId).toUpperCase() });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        
        tenant.moveoutRequest = {
            status: 'pending',
            requestedDate: new Date(requestedDate),
            reason,
            submittedAt: new Date()
        };
        await tenant.save();
        res.json({ success: true, tenant });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post('/moveout/approve', async (req, res) => {
    try {
        const { tenantId, duesAtMoveout, refundAmount, refundStatus } = req.body;
        const tenant = await Tenant.findById(tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        
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
});

router.post('/moveout/reject', async (req, res) => {
    try {
        const { tenantId } = req.body;
        const tenant = await Tenant.findById(tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        
        tenant.moveoutRequest.status = 'rejected';
        await tenant.save();
        res.json({ success: true, tenant });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// KYC Verification endpoints
router.post('/kyc/submit', async (req, res) => {
    try {
        const { tenantLoginId, aadhaarNumber, panNumber, aadharFile, aadhaarFront, aadhaarBack, addressProofFile } = req.body;
        const tenant = await Tenant.findOne({ loginId: String(tenantLoginId).toUpperCase() });
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
        res.json({ success: true, tenant });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post('/kyc/approve', async (req, res) => {
    try {
        const { tenantId } = req.body;
        const tenant = await Tenant.findById(tenantId);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        
        tenant.kycStatus = 'verified';
        await tenant.save();
        res.json({ success: true, tenant });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post('/kyc/reject', async (req, res) => {
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
});

// Police Verification endpoints
router.post('/police/submit', async (req, res) => {
    try {
        const { tenantLoginId, receiptFile } = req.body;
        const tenant = await Tenant.findOne({ loginId: String(tenantLoginId).toUpperCase() });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        
        tenant.policeVerification = {
            status: 'submitted',
            receiptFile,
            submittedAt: new Date()
        };
        await tenant.save();
        res.json({ success: true, tenant });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

router.post('/police/approve', async (req, res) => {
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
});

router.post('/police/reject', async (req, res) => {
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
});

// Ledger endpoints
router.get('/ledger/:tenantLoginId', async (req, res) => {
    try {
        const loginId = String(req.params.tenantLoginId).toUpperCase();
        
        // 1. Fetch Rent records
        const rents = await Rent.find({ tenantLoginId: loginId }).lean();
        
        // 2. Fetch custom Ledger entries
        const customEntries = await LedgerEntry.find({ tenantLoginId: loginId }).lean();
        
        // 3. Convert Rent records to ledger items
        const ledgerItems = [];
        
        rents.forEach(r => {
            const rentMonthLabel = r.collectionMonth || new Date(r.createdAt || r.dueDate || Date.now()).toLocaleString('en-US', { month: 'short', year: 'numeric' });
            
            // Debit: Rent charged
            ledgerItems.push({
                date: r.createdAt || r.dueDate || new Date(),
                details: `Monthly Rent Charged (${rentMonthLabel})`,
                debit: r.rentAmount || 0,
                credit: 0
            });
            
            // Credit: Rent payment if paid/completed
            if (r.paidAmount > 0 || ['paid', 'completed'].includes(String(r.paymentStatus).toLowerCase())) {
                const payDate = r.paymentDate || r.updatedAt || r.createdAt || new Date();
                const payMethod = r.paymentMethod ? ` via ${r.paymentMethod}` : '';
                ledgerItems.push({
                    date: payDate,
                    details: `Rent Payment Received${payMethod} (${rentMonthLabel})`,
                    debit: 0,
                    credit: r.paidAmount || r.rentAmount || 0
                });
            }
        });
        
        // 4. Add custom ledger entries
        customEntries.forEach(c => {
            ledgerItems.push({
                _id: c._id,
                date: c.date,
                details: c.details,
                debit: c.debit || 0,
                credit: c.credit || 0
            });
        });
        
        // 5. Sort chronologically by date
        ledgerItems.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        // 6. Calculate running balance
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
});

router.post('/ledger', async (req, res) => {
    try {
        const { tenantLoginId, details, debit, credit } = req.body;
        const tenant = await Tenant.findOne({ loginId: String(tenantLoginId).toUpperCase() });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        
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
});

// Feedback endpoints
router.post('/feedback', async (req, res) => {
    try {
        const { tenantLoginId, category, rating, comments } = req.body;
        const tenant = await Tenant.findOne({ loginId: String(tenantLoginId).toUpperCase() }).populate('property');
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
});

router.get('/feedback/owner/:ownerLoginId', async (req, res) => {
    try {
        const ownerId = String(req.params.ownerLoginId).toUpperCase();
        const feedbacks = await TenantFeedback.find({ ownerLoginId: ownerId }).sort({ createdAt: -1 });
        res.json({ success: true, feedbacks });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
