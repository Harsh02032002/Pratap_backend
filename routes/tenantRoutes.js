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
        if (!tenant || tenant.isDeleted) return res.status(404).json({ message: 'Tenant not found' });
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
        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        // Sync to User credentials if basic info changes
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

        // Handle room and bed assignment updates
        const roomNoChanged = req.body.roomNo !== undefined && req.body.roomNo !== tenant.roomNo;
        const bedNoChanged = req.body.bedNo !== undefined && req.body.bedNo !== tenant.bedNo;

        if (roomNoChanged || bedNoChanged) {
            // Free the old bed assignment if it exists
            if (tenant.room && tenant.bedNo) {
                const oldRoom = await Room.findById(tenant.room);
                if (oldRoom && oldRoom.bedAssignments) {
                    const oldIndex = Number(tenant.bedNo) - 1;
                    if (oldIndex >= 0 && oldRoom.bedAssignments[oldIndex] && String(oldRoom.bedAssignments[oldIndex].tenantId) === String(tenant._id)) {
                        oldRoom.bedAssignments[oldIndex] = {};
                        oldRoom.markModified('bedAssignments');
                        await oldRoom.save();
                    }
                }
            }

            // Assign the new bed assignment
            const targetRoomNo = req.body.roomNo !== undefined ? req.body.roomNo : tenant.roomNo;
            const targetBedNo = req.body.bedNo !== undefined ? req.body.bedNo : tenant.bedNo;

            let newRoomObj = null;
            if (targetRoomNo) {
                newRoomObj = await Room.findOne({
                    property: tenant.property,
                    title: { $regex: `^${String(targetRoomNo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
                });
            }

            if (newRoomObj) {
                tenant.room = newRoomObj._id;
                if (targetBedNo) {
                    const bIndex = Number(targetBedNo) - 1;
                    if (bIndex >= 0) {
                        if (!newRoomObj.bedAssignments) {
                            newRoomObj.bedAssignments = [];
                        }
                        while (newRoomObj.bedAssignments.length <= bIndex) {
                            newRoomObj.bedAssignments.push({});
                        }

                        const occupant = newRoomObj.bedAssignments[bIndex];
                        if (occupant && occupant.tenantId && String(occupant.tenantId) !== String(tenant._id)) {
                            return res.status(400).json({ message: `Bed ${targetBedNo} in Room ${targetRoomNo} is already occupied.` });
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
            // Room and bed did not change, but maybe name changed
            if (req.body.name && tenant.room && tenant.bedNo) {
                const currentRoom = await Room.findById(tenant.room);
                if (currentRoom && currentRoom.bedAssignments) {
                    const bIndex = Number(tenant.bedNo) - 1;
                    if (bIndex >= 0 && currentRoom.bedAssignments[bIndex] && String(currentRoom.bedAssignments[bIndex].tenantId) === String(tenant._id)) {
                        currentRoom.bedAssignments[bIndex].tenantName = req.body.name;
                        currentRoom.markModified('bedAssignments');
                        await currentRoom.save();
                    }
                }
            }
        }

        // Sync pending rent bills
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

        // Apply updates
        const allowedUpdates = [
            'name', 'phone', 'email', 'dob', 'gender', 'guardianNumber',
            'roomNo', 'bedNo', 'moveInDate', 'agreedRent', 'paymentFrequency',
            'status', 'kycStatus'
        ];

        allowedUpdates.forEach(key => {
            if (req.body[key] !== undefined) {
                tenant[key] = req.body[key];
            }
        });

        // Sync digitalCheckin profile
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

// 5. Delete tenant
router.delete('/:id', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = await Tenant.findById(req.params.id);
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });
        
        // Free tenant references from rooms' bedAssignments preserving indexes
        const roomsToUpdate = await Room.find({ 'bedAssignments.tenantId': req.params.id });
        for (const room of roomsToUpdate) {
            room.bedAssignments = room.bedAssignments.map(assignment => {
                if (assignment.tenantId && assignment.tenantId.toString() === req.params.id) {
                    return {}; // free assignment
                }
                return assignment;
            });
            room.markModified('bedAssignments');
            await room.save();
        }

        // Soft delete corresponding login credentials from User collection
        const User = require('../models/user');
        if (tenant.user) {
            await User.findByIdAndUpdate(tenant.user, { $set: { isDeleted: true, isActive: false } });
        }
        if (tenant.loginId) {
            await User.updateOne({ loginId: tenant.loginId, role: 'tenant' }, { $set: { isDeleted: true, isActive: false } });
        }

        // Instead of hard-deleting the tenant, soft-delete them to 'inactive' status (Ex-Tenant)
        tenant.status = 'inactive';
        tenant.isDeleted = true;
        tenant.room = undefined; // clear Mongoose room ref
        await tenant.save();
        res.json({ message: 'Tenant deleted' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// 6. Get tenants by property
router.get('/property/:propertyId', async (req, res) => {
    try {
        const tenants = await Tenant.find({ property: req.params.propertyId, isDeleted: { $ne: true } })
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
        const tenants = await Tenant.find({ room: req.params.roomId, isDeleted: { $ne: true } })
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

// Deactivate tenant
router.post('/:id/deactivate', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = await Tenant.findByIdAndUpdate(req.params.id, { $set: { status: 'suspended' } }, { new: true });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const User = require('../models/user');
        if (tenant.user) {
            await User.findByIdAndUpdate(tenant.user, { $set: { isActive: false } });
        }
        if (tenant.loginId) {
            await User.updateOne({ loginId: tenant.loginId, role: 'tenant' }, { $set: { isActive: false } });
        }

        return res.json({ success: true, message: 'Tenant account deactivated successfully', data: tenant });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Reactivate tenant
router.post('/:id/reactivate', protect, authorize('superadmin', 'areamanager', 'owner'), auditTrail('tenants'), async (req, res) => {
    try {
        const tenant = await Tenant.findByIdAndUpdate(req.params.id, { $set: { status: 'active' } }, { new: true });
        if (!tenant) return res.status(404).json({ message: 'Tenant not found' });

        const User = require('../models/user');
        if (tenant.user) {
            await User.findByIdAndUpdate(tenant.user, { $set: { isActive: true } });
        }
        if (tenant.loginId) {
            await User.updateOne({ loginId: tenant.loginId, role: 'tenant' }, { $set: { isActive: true } });
        }

        return res.json({ success: true, message: 'Tenant account reactivated successfully', data: tenant });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
