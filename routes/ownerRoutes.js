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
router.delete('/:loginId', protect, authorize('superadmin'), auditTrail('owners'), async (req, res) => {
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
router.patch('/:loginId', protect, authorize('superadmin', 'owner'), auditTrail('owners'), async (req, res) => {
    try {
        console.log('✏️ Owner PATCH request for:', req.params.loginId);

        // Owners can only modify their own record
        if (req.user.role === 'owner' && String(req.user.loginId || '').toUpperCase() !== String(req.params.loginId || '').toUpperCase()) {
            return res.status(403).json({ error: 'Forbidden: You can only update your own record' });
        }

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
        await ownerController.healOwnerProperties(loginId);
        // Find properties owned by this owner
        const properties = await Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } }).select('_id title');

        // Sync property occupancy (fire-and-forget to avoid blocking API response)
        for (const prop of properties) {
            ownerController.syncPropertyOccupancyData(prop._id).catch(syncErr => {
                console.error(`❌ Error syncing occupancy during rooms fetch for property ${prop._id}:`, syncErr.message);
            });
        }

        const propertyIds = properties.map(p => p._id);
        const limit = parseInt(req.query.limit) || 0;

        let rooms = [];
        const propertyTotals = {};

        if (limit > 0) {
            // Only fetch 'limit' rooms per property for paginated initial load
            for (const propId of propertyIds) {
                const propRooms = await Room.find({ property: propId, isDeleted: { $ne: true } })
                    .populate('property', 'title ownerLoginId')
                    .limit(limit)
                    .lean();
                const total = await Room.countDocuments({ property: propId, isDeleted: { $ne: true } });
                rooms.push(...propRooms);
                propertyTotals[propId.toString()] = total;
            }
        } else {
            // Fallback to all rooms if no limit
            rooms = await Room.find({ property: { $in: propertyIds }, isDeleted: { $ne: true } })
                .populate('property', 'title ownerLoginId')
                .lean();
            for (const propId of propertyIds) {
                propertyTotals[propId.toString()] = rooms.filter(r => String(r.property?._id || r.property) === propId.toString()).length;
            }
        }

        return res.json({ properties, rooms, propertyTotals });
    } catch (err) {
        console.error('❌ Error fetching owner rooms:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

// 7. Get properties for owner by loginId
router.get('/:loginId/properties', async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').trim().toUpperCase();
        await ownerController.healOwnerProperties(loginId);
        const properties = await Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } });

        const syncedProperties = [];
        for (const prop of properties) {
            // Trigger async sync in background to keep data fresh without delaying response
            ownerController.syncPropertyOccupancyData(prop._id).catch(err => console.error('Async sync error:', err));
            syncedProperties.push(prop);
        }
        return res.json({ properties: syncedProperties });
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
        ownerController.fireHeal(loginId);

        const PaymentTransaction = require('../models/PaymentTransaction');
        const RentPayment = require('../models/RentPayment');

        // Run property lookup and owner lookup in parallel first
        const [properties, ownerDoc] = await Promise.all([
            Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } }).select('_id'),
            Owner.findOne({ loginId }).select('_id')
        ]);
        const propertyIds = properties.map(p => p._id);

        // Now run all three money queries in parallel
        const [enquiries, transactions, rentPayments] = await Promise.all([
            // 1. Find enquiries for these properties that are accepted/approved
            Enquiry.find({
                $or: [
                    { propertyId: { $in: propertyIds } },
                    { ownerLoginId: loginId }
                ],
                status: { $in: ['accepted', 'approved', 'active'] }
            }).select('paidAmount').lean(),

            // 2. Find online booking payment transactions (PaymentTransaction)
            PaymentTransaction.find({ owner_id: loginId }).select('owner_amount').lean(),

            // 3. Find monthly rent invoice payments (RentPayment)
            ownerDoc
                ? RentPayment.find({ ownerId: ownerDoc._id }).select('amount').lean()
                : Promise.resolve([])
        ]);

        const enquiriesTotal = enquiries.reduce((sum, e) => sum + (e.paidAmount || 0), 0);
        const txTotal = transactions.reduce((sum, t) => sum + (t.owner_amount || 0), 0);
        const rentPaymentsTotal = rentPayments.reduce((sum, r) => sum + (r.amount || 0), 0);

        const totalRent = enquiriesTotal + txTotal + rentPaymentsTotal;
        return res.json({ totalRent });
    } catch (err) {
        console.error('❌ Error fetching owner rent:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/:loginId/revenue-dashboard', async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').trim().toUpperCase();
        await ownerController.healOwnerProperties(loginId);

        const properties = await Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } }).select('_id title');
        const propertyIds = properties.map(p => p._id);

        // 1. Fetch Tenant Payments (gross)
        // a. From PaymentTransaction
        const PaymentTransaction = require('../models/PaymentTransaction');
        const transactions = await PaymentTransaction.find({ owner_id: loginId }).sort({ payment_date: -1 }).lean();
        const txTotal = transactions.reduce((sum, t) => sum + (t.booking_amount || t.owner_amount || 0), 0);

        // b. From RentPayment
        // First map all active and historical tenants for these properties
        const Tenant = require('../models/Tenant');
        const tenants = await Tenant.find({ property: { $in: propertyIds } }).select('_id').lean();
        const RentInvoice = require('../models/RentInvoice');

        let rentPaymentsTotal = 0;
        let rentPayments = [];

        if (tenants.length > 0) {
            const allInvoices = await RentInvoice.find({ tenantId: { $in: tenants.map(t => t._id) } }).select('_id').lean();
            const RentPayment = require('../models/RentPayment');

            rentPayments = await RentPayment.find({ invoiceId: { $in: allInvoices.map(i => i._id) } }).sort({ createdAt: -1 }).lean();
            rentPaymentsTotal = rentPayments.reduce((sum, r) => sum + (r.amount || 0), 0);
        }

        // c. From Enquiry (accepted/approved)
        const Enquiry = require('../models/Enquiry');
        const enquiries = await Enquiry.find({
            $or: [
                { propertyId: { $in: propertyIds } },
                { ownerLoginId: loginId }
            ],
            status: { $in: ['accepted', 'approved', 'active'] }
        }).sort({ createdAt: -1 }).lean();
        const enquiriesTotal = enquiries.reduce((sum, e) => sum + (e.paidAmount || 0), 0);

        const tenantCollected = txTotal + rentPaymentsTotal + enquiriesTotal;

        // 2. Fetch Payouts
        const PayoutLog = require('../models/PayoutLog');
        const payouts = await PayoutLog.find({ owner_id: loginId }).sort({ created_at: -1 }).lean();

        const ownerPayouts = payouts
            .filter(p => ['processed', 'sandbox_success'].includes(p.status))
            .reduce((sum, p) => sum + (p.amount || 0), 0);

        const pendingPayouts = payouts
            .filter(p => ['initiated', 'contact_created', 'fund_account_created', 'queued', 'processing'].includes(p.status))
            .reduce((sum, p) => sum + (p.amount || 0), 0);

        // 3. Fetch Tenant Dues (Direct optimized query to prevent dashboard hanging)
        let tenantDues = 0;
        if (tenants.length > 0) {
            const unpaidInvoices = await RentInvoice.find({
                tenantId: { $in: tenants.map(t => t._id) },
                status: { $in: ['PENDING', 'PARTIAL'] }
            }).select('outstandingAmount rentAmount rentPaidAmount paidAmount totalPenalty electricityBill').lean();

            unpaidInvoices.forEach(inv => {
                const rentPaid = inv.rentPaidAmount ?? inv.paidAmount ?? 0;
                const rentDue = Math.max(0, (inv.rentAmount || 0) - rentPaid);
                const penalty = inv.totalPenalty || 0;
                const elec = inv.electricityBill || 0;
                const computed = Math.max(0, rentDue + penalty + elec - Math.max(0, (inv.paidAmount || 0) - rentPaid));

                let invOutstanding = computed;
                if (typeof inv.outstandingAmount === 'number') {
                    invOutstanding = Math.max(computed, Math.max(0, inv.outstandingAmount));
                }
                tenantDues += Math.round(invOutstanding);
            });
        }

        // 4. Format Recent Payments
        const formattedPayments = [];
        transactions.forEach(t => {
            formattedPayments.push({
                id: t._id || `TXN-${String(t.payment_id || '').slice(-6)}`,
                tenant: t.tenant_name || 'Tenant',
                room: t.room_number || 'TBD',
                amount: t.booking_amount || t.owner_amount || 0,
                category: 'Online Booking',
                date: t.payment_date ? new Date(t.payment_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A',
                status: 'Paid'
            });
        });

        rentPayments.forEach(r => {
            formattedPayments.push({
                id: r._id ? `RNT-${String(r._id).slice(-6)}` : 'N/A',
                tenant: r.tenantName || 'Tenant',
                room: r.roomNumber || 'TBD',
                amount: r.amount || 0,
                category: 'Monthly Rent',
                date: r.createdAt ? new Date(r.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A',
                status: 'Paid'
            });
        });

        enquiries.forEach(e => {
            formattedPayments.push({
                id: `ENQ-${String(e._id).slice(-4)}`,
                tenant: e.name || e.tenantName || 'Tenant',
                room: e.roomNumber || 'TBD',
                amount: e.paidAmount || 0,
                category: 'Booking Deposit',
                date: e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A',
                status: e.status === 'active' ? 'Paid' : 'Pending'
            });
        });

        formattedPayments.sort((a, b) => new Date(b.date) - new Date(a.date));

        // 5. Format Recent Payouts
        const formattedPayouts = payouts.map(p => {
            let statusLabel = 'Pending';
            if (['processed', 'sandbox_success'].includes(p.status)) statusLabel = 'Processed';
            if (['failed', 'sandbox_failed'].includes(p.status)) statusLabel = 'Failed';

            return {
                id: p.payout_id || `PAY-${String(p._id).slice(-6)}`,
                title: p.purpose || 'Owner Payout',
                method: p.mode === 'upi' ? 'UPI' : 'Bank Transfer',
                amount: p.amount || 0,
                date: p.created_at ? new Date(p.created_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : 'N/A',
                status: statusLabel
            };
        });

        // 6. Generate Chart Data (Last 5 Months)
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const monthlyData = {};

        for (let i = 4; i >= 0; i--) {
            const d = new Date();
            d.setMonth(d.getMonth() - i);
            const mName = months[d.getMonth()];
            monthlyData[mName] = { name: mName, tenantRent: 0, ownerPayout: 0, sortKey: d.getTime() };
        }

        transactions.forEach(t => {
            if (t.payment_date) {
                const date = new Date(t.payment_date);
                const mName = months[date.getMonth()];
                if (monthlyData[mName]) {
                    monthlyData[mName].tenantRent += (t.booking_amount || t.owner_amount || 0);
                }
            }
        });

        rentPayments.forEach(r => {
            if (r.createdAt) {
                const date = new Date(r.createdAt);
                const mName = months[date.getMonth()];
                if (monthlyData[mName]) {
                    monthlyData[mName].tenantRent += (r.amount || 0);
                }
            }
        });

        enquiries.forEach(e => {
            if (e.createdAt) {
                const date = new Date(e.createdAt);
                const mName = months[date.getMonth()];
                if (monthlyData[mName]) {
                    monthlyData[mName].tenantRent += (e.paidAmount || 0);
                }
            }
        });

        payouts.forEach(p => {
            if (p.created_at && ['processed', 'sandbox_success'].includes(p.status)) {
                const date = new Date(p.created_at);
                const mName = months[date.getMonth()];
                if (monthlyData[mName]) {
                    monthlyData[mName].ownerPayout += (p.amount || 0);
                }
            }
        });

        const revenueChartData = Object.values(monthlyData).sort((a, b) => a.sortKey - b.sortKey).map(m => ({
            name: m.name,
            tenantRent: m.tenantRent || 0,
            ownerPayout: m.ownerPayout || 0
        }));

        // 7. Dynamic Collection Breakdown
        let penaltyCollected = 0;
        let electricityCollected = 0;

        let rentCollected = 0;

        const RentInvoiceModel = require('../models/RentInvoice');
        const paidInvoices = await RentInvoiceModel.find({
            ownerId: properties.length > 0 ? (properties[0].ownerLoginId || properties[0].ownerId) : null, // Not strictly constrained, let's use the owner string
            tenantName: { $exists: true } // or just no filter, since we map over invoices or use tenants array
        }).lean();

        // Better cross-reference using the tenants generated above
        if (tenants && tenants.length > 0) {
            const paidInvFiltered = await RentInvoiceModel.find({
                tenantId: { $in: tenants.map(t => t._id) },
                status: { $in: ['PAID', 'PARTIAL'] }
            }).lean();

            paidInvFiltered.forEach(inv => {
                penaltyCollected += (inv.penaltyPaidAmount || inv.totalPenalty || 0); // Fines portion
                rentCollected += (inv.rentPaidAmount || inv.rentAmount || 0);         // Rent portion
                if (inv.status === 'PAID') {
                    electricityCollected += (inv.electricityBill || 0);               // Utilities portion
                }
            });
        }

        rentCollected += txTotal + enquiriesTotal;
        const totalCat = (rentCollected + penaltyCollected + electricityCollected) || 1; // prevent div/0

        const collectionBreakdown = {
            rent: { amount: rentCollected, percent: Math.round((rentCollected / totalCat) * 100) },
            penalty: { amount: penaltyCollected, percent: Math.round((penaltyCollected / totalCat) * 100) },
            electricity: { amount: electricityCollected, percent: Math.round((electricityCollected / totalCat) * 100) }
        };

        return res.json({
            success: true,
            summaryMetrics: {
                tenantCollected,
                ownerPayouts,
                pendingPayouts,
                tenantDues
            },
            recentPayments: formattedPayments.slice(0, 10),
            recentPayouts: formattedPayouts.slice(0, 10),
            revenueChartData,
            collectionBreakdown
        });
    } catch (err) {
        console.error('❌ Error in /revenue-dashboard:', err.message);
        return res.status(500).json({ error: err.message });
    }
});

router.get('/:loginId/tenants', async (req, res) => {
    try {
        const loginId = String(req.params.loginId || '').trim().toUpperCase();
        await ownerController.healOwnerProperties(loginId);
        const properties = await Property.find({ ownerLoginId: loginId, isDeleted: { $ne: true } }).select('_id');
        const propertyIds = properties.map((p) => p._id);
        const tenants = await require('../models/Tenant').find({ property: { $in: propertyIds }, isDeleted: { $ne: true } }).lean();

        let tenantsWithDues = tenants;
        if (req.query.nodues !== 'true') {
            const { enrichTenantsWithDues } = require('../services/tenantDuesService');
            tenantsWithDues = await enrichTenantsWithDues(tenants);
        }

        return res.json({ tenants: tenantsWithDues });
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
