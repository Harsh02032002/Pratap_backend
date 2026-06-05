const express = require('express');
const router = express.Router();
const enquiryController = require('../controllers/enquiryController');
// Enquiry API: create, list for owner, update status
router.post('/:ownerLoginId/enquiries', enquiryController.createEnquiry); // create
router.get('/:ownerLoginId/enquiries', enquiryController.listEnquiries); // list for owner
router.patch('/enquiries/:id', enquiryController.updateEnquiry); // update status
const Owner = require('../models/Owner');
const Message = require('../models/Message');
const Property = require('../models/Property');
const Room = require('../models/Room');
const Enquiry = require('../models/Enquiry');
const CheckinRecord = require('../models/CheckinRecord');
const { protect, authorize } = require('../middleware/authMiddleware');
const ownerController = require('../controllers/ownercontroller');
const { auditTrail } = require('../middleware/auditTrail');
const mailer = require('../utils/mailer');

// 1. Create new owner (Preserved from original - used by enquiry approval/import)
router.post('/', auditTrail('owners'), async (req, res) => {
    try {
        console.log('📝 Owner POST request:', req.body);
        const owner = new Owner(req.body);
        await owner.save();
        console.log('✅ Owner created:', owner.loginId);

        // Send KYC link to owner's email automatically
        if (owner.email) {
            try {
                const DIGITAL_CHECKIN_URL = process.env.DIGITAL_CHECKIN_URL || process.env.FRONTEND_URL || 'https://admin.roomhy.com';
                const password = owner.credentials?.password || owner.checkinPassword || (req.body.credentials && req.body.credentials.password) || '';
                const area = owner.locationCode || owner.area || '';
                
                const kycLink = `${DIGITAL_CHECKIN_URL}/digital-checkin/ownerprofile?loginId=${encodeURIComponent(owner.loginId)}&email=${encodeURIComponent(owner.email)}&area=${encodeURIComponent(area)}&password=${encodeURIComponent(password)}`;
                
                await mailer.sendKycLinkEmail(owner.email, owner.name || 'Owner', 'Roomhy Asset Portal', kycLink);
                
                // Update KYC status to 'sent'
                owner.kyc = owner.kyc || {};
                owner.kyc.status = 'sent';
                await owner.save();
                console.log(`✉️ Direct KYC link sent to ${owner.email} for newly created Owner ${owner.loginId}`);
            } catch (mailErr) {
                console.warn('❌ Failed to send direct KYC email for new Owner:', mailErr.message);
            }
        }

        res.status(201).json(owner);
    } catch (err) {
        console.error('❌ Owner POST error:', err.message);
        if (err.code === 11000) {
            // Duplicate key error - return existing owner to make POST idempotent
            try {
                const existing = await Owner.findOne({ loginId: req.body.loginId }).lean();
                if (existing) {
                    console.log('ℹ️ Owner POST duplicate detected; returning existing owner for', req.body.loginId);
                    return res.status(200).json(existing);
                }
            } catch (e) {
                console.error('❌ Error retrieving existing owner after duplicate:', e && e.message);
            }
            return res.status(409).json({ error: 'Owner ID already exists', code: 'DUPLICATE' });
        } else {
            res.status(400).json({ error: err.message });
        }
    }
});

// 2. List all owners (Updated for Dashboard & Area Manager Filtering)
// Supports: ?locationCode=KO (prefix match), ?kycStatus=verified, ?search=...
router.get('/', ownerController.getAllOwners);

// 2b. Request new owner (Employee Action)
router.post('/request', auditTrail('owners'), ownerController.requestOwner);

// 2c. Approve owner request (Super Admin Action)
router.post('/:loginId/approve', protect, authorize('superadmin', 'areamanager'), auditTrail('owners'), ownerController.approveOwner);

// 3. Get owner by loginId (Preserved)
router.get('/:loginId', ownerController.getOwnerById);

// 3b. Delete owner by loginId (Soft Delete)
router.delete('/:loginId', auditTrail('owners'), async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').toUpperCase();
        if (!loginId) {
            return res.status(400).json({ success: false, message: 'Invalid owner loginId' });
        }

        const owner = await Owner.findOne({ loginId });
        if (!owner) {
            return res.status(404).json({ success: false, message: `Owner ${loginId} not found` });
        }

        // 1. Soft delete owner profile
        owner.isDeleted = true;
        owner.isActive = false;
        await owner.save();

        // 2. Soft delete corresponding login credentials from User collection
        const User = require('../models/user');
        await User.updateOne({ loginId, role: 'owner' }, { $set: { isDeleted: true, isActive: false } });

        // 3. Soft delete all properties owned by this owner
        const Property = require('../models/Property');
        const Room = require('../models/Room');
        const ApprovedProperty = require('../models/ApprovedProperty');

        const properties = await Property.find({ ownerLoginId: loginId });
        const propertyIds = properties.map(p => p._id);

        await Property.updateMany({ ownerLoginId: loginId }, { $set: { isDeleted: true, status: 'inactive', isPublished: false, isLiveOnWebsite: false } });
        await Room.updateMany({ property: { $in: propertyIds } }, { $set: { isDeleted: true } });

        // Remove from public website approved listings
        await ApprovedProperty.deleteMany({ 'generatedCredentials.loginId': loginId });

        return res.json({ success: true, message: `Owner ${loginId} deleted successfully` });
    } catch (err) {
        console.error('❌ Owner DELETE error:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 4. Update Owner KYC Status (NEW - Super Admin Only)
// Relaxed auth for development/testing
router.patch('/:id/kyc', protect, authorize('superadmin', 'areamanager'), auditTrail('owners'), ownerController.updateOwnerKyc);

// 5. Update owner by loginId (Preserved - Used for Password Updates)
router.patch('/:loginId', auditTrail('owners'), async (req, res) => {
    try {
        console.log('✏️ Owner PATCH request for:', req.params.loginId);

        // Prepare update payload
        let updatePayload = { ...req.body };
        updatePayload.loginId = req.params.loginId;

        // If password is being updated, ensure flags are set correctly
        if (updatePayload.credentials && updatePayload.credentials.password) {
            updatePayload.credentials.firstTime = false;
            updatePayload.passwordSet = true;
        }

        // Use findOneAndUpdate with upsert so missing owners (from legacy local storage) are created
        const owner = await Owner.findOneAndUpdate(
            { loginId: req.params.loginId },
            { $set: updatePayload, $setOnInsert: { createdAt: new Date() } },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        
        res.json(owner);
    } catch (err) {
        console.error('❌ Owner PATCH error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 6. Get rooms for owner by loginId (Preserved - Used by Dashboard)
router.get('/:loginId/rooms', async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').trim().toUpperCase();
        // Find properties owned by this owner
        const properties = await Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } }).select('_id title');
        const propertyIds = properties.map(p => p._id);

        // Find rooms that belong to those properties
        const rooms = await Room.find({ property: { $in: propertyIds }, isDeleted: { $ne: true } }).populate('property', 'title ownerLoginId');

        return res.json({ properties, rooms });
    } catch (err) {
        console.error('❌ Error fetching owner rooms:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// 7. Get properties for owner by loginId
router.get('/:loginId/properties', async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').trim().toUpperCase();
        const properties = await Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } });
        return res.json({ properties });
    } catch (err) {
        console.error('❌ Error fetching owner properties:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// 7b. Create property for owner by loginId (used by owner panel rooms/properties sync)
router.post('/:loginId/properties', auditTrail('owners'), async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').toUpperCase();
        const { title, address, locationCode, city, area, description } = req.body || {};

        if (!title || !String(title).trim()) {
            return res.status(400).json({ success: false, message: 'Property title is required' });
        }

        const normalizedTitle = String(title).trim();
        const normalizedLocationCode = String(locationCode || area || city || loginId.slice(0, 3) || 'GEN').toUpperCase();

        let property = await Property.findOne({
            ownerLoginId: loginId,
            title: { $regex: `^${normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
        });

        if (!property) {
            property = await Property.create({
                title: normalizedTitle,
                address: address || '',
                locationCode: normalizedLocationCode,
                ownerLoginId: loginId,
                description: description || '',
                status: 'active',
                isPublished: true
            });
        }

        return res.status(201).json({ success: true, property });
    } catch (err) {
        console.error('❌ Error creating owner property:', err.message);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// 8. Get rent collected for owner by loginId
router.get('/:loginId/rent', async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').trim().toUpperCase();
        // Find properties owned by this owner
        const properties = await Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } }).select('_id');
        const propertyIds = properties.map(p => p._id);

        // Find enquiries for these properties that are accepted/approved
        const enquiries = await Enquiry.find({
            propertyId: { $in: propertyIds },
            status: { $in: ['accepted', 'approved'] }
        }).select('paidAmount');

        const totalRent = enquiries.reduce((sum, e) => sum + (e.paidAmount || 0), 0);
        return res.json({ totalRent });
    } catch (err) {
        console.error('❌ Error fetching owner rent:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/:loginId/tenants', async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').trim().toUpperCase();
        const properties = await Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } }).select('_id');
        const propertyIds = properties.map((p) => p._id);
        const tenants = await require('../models/Tenant').find({ property: { $in: propertyIds }, isDeleted: { $ne: true } });
        return res.json({ tenants });
    } catch (err) {
        console.error('❌ Error fetching owner tenants:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// POST /owners/:loginId/request-head
// Called by an authenticated owner to request escalation to Super Admin (head).
router.post('/:loginId/request-head', protect, auditTrail('owners'), async (req, res) => {
    try {
        const loginId = req.params.loginId;
        // only owner role should be allowed here
        if (!req.user || req.user.role !== 'owner' || req.user.loginId !== loginId) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const text = req.body.text || 'Owner requests to chat with Super Admin.';
        const time = req.body.time || new Date().toISOString();

        let convo = await Message.findOne({ participant: `owner:${loginId}` });
        if (!convo) {
            convo = new Message({ participant: `owner:${loginId}`, messages: [] });
        }

        // mark conversation as headOnly so only superadmin can reply
        convo.headOnly = true;
        convo.messages.push({ from: `owner:${loginId}`, text, time, createdAt: new Date() });
        convo.updatedAt = new Date();
        await convo.save();

        return res.json({ participant: convo.participant, messages: convo.messages });
    } catch (err) {
        console.error('Error in request-head:', err);
        res.status(500).json({ message: err.message });
    }
});

// Add tenant to property (Owner)
router.post('/:ownerLoginId/properties/:propertyId/tenants', auditTrail('tenants'), ownerController.addTenantToProperty);

// Get tenants for owner's property
router.get('/:ownerLoginId/properties/:propertyId/tenants', ownerController.getPropertyTenants);

// Deactivate owner
router.post('/:loginId/deactivate', protect, authorize('superadmin'), auditTrail('owners'), async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').toUpperCase();
        const owner = await Owner.findOneAndUpdate({ loginId }, { $set: { isActive: false } }, { new: true });
        if (!owner) return res.status(404).json({ success: false, message: 'Owner not found' });

        const User = require('../models/user');
        await User.updateOne({ loginId, role: 'owner' }, { $set: { isActive: false } });

        return res.json({ success: true, message: 'Owner account deactivated successfully', data: owner });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

// Reactivate owner
router.post('/:loginId/reactivate', protect, authorize('superadmin'), auditTrail('owners'), async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').toUpperCase();
        const owner = await Owner.findOneAndUpdate({ loginId }, { $set: { isActive: true } }, { new: true });
        if (!owner) return res.status(404).json({ success: false, message: 'Owner not found' });

        const User = require('../models/user');
        await User.updateOne({ loginId, role: 'owner' }, { $set: { isActive: true } });

        return res.json({ success: true, message: 'Owner account reactivated successfully', data: owner });
    } catch (err) {
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
