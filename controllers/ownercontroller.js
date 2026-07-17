// Cache to prevent running the unindexed RegExp auto-healer query on every API request
const healedOwners = new Set();

/**
 * fireHeal — fire-and-forget wrapper for healOwnerProperties.
 * Call this in routes instead of await healOwnerProperties(...) so the route
 * never blocks waiting for the property linker to finish.
 */
exports.fireHeal = (loginId) => {
    exports.healOwnerProperties(loginId).catch(err =>
        console.error(`[fireHeal] healOwnerProperties error for ${loginId}:`, err.message)
    );
};

// Auto-healer function to match and link previously unlinked properties to owners on-the-fly
exports.healOwnerProperties = async (loginId) => {
    try {
        const normalizedLoginId = String(loginId || '').trim().toUpperCase();
        if (!normalizedLoginId) return;

        if (healedOwners.has(normalizedLoginId)) {
            return;
        }
        healedOwners.add(normalizedLoginId);

        const mongoose = require('mongoose');
        const Owner = mongoose.models.Owner || require('../models/Owner');
        const Property = mongoose.models.Property || require('../models/Property');
        const User = mongoose.models.User || require('../models/user');

        const ownerDoc = await Owner.findOne({ loginId: normalizedLoginId });
        if (!ownerDoc) return;

        // Collect all possible emails and phones of the owner
        const emails = [
            ownerDoc.email,
            ownerDoc.profile?.email,
            ownerDoc.checkinEmail
        ].map(e => String(e || '').trim().toLowerCase()).filter(Boolean);

        const phones = [
            ownerDoc.phone,
            ownerDoc.profile?.phone,
            ownerDoc.checkinPhone
        ].map(p => {
            const clean = String(p || '').replace(/\D/g, '');
            return clean.length >= 10 ? clean.slice(-10) : '';
        }).filter(Boolean);

        if (emails.length === 0 && phones.length === 0) return;

        const matchConditions = [];
        if (emails.length > 0) {
            matchConditions.push({ 'contact.email': { $in: emails } });
            matchConditions.push({ 'email': { $in: emails } });
        }
        if (phones.length > 0) {
            phones.forEach(p => {
                matchConditions.push({ 'contact.number': new RegExp(p + '$') });
                matchConditions.push({ 'ownerPhone': new RegExp(p + '$') });
                matchConditions.push({ 'phone': new RegExp(p + '$') });
            });
        }

        if (matchConditions.length === 0) return;

        const finalQuery = {
            $and: [
                {
                    $or: [
                        { ownerLoginId: { $exists: false } },
                        { ownerLoginId: null },
                        { ownerLoginId: "" },
                        { ownerLoginId: "TEMP" },
                        { ownerLoginId: "GEN" }
                    ]
                },
                { isDeleted: { $ne: true } },
                { $or: matchConditions }
            ]
        };

        const unmatchedProperties = await Property.find(finalQuery);
        if (unmatchedProperties.length === 0) return;

        console.log(`🧹 Auto-Healer: Found ${unmatchedProperties.length} unmatched properties matching owner ${normalizedLoginId}. Healing now...`);

        const userDoc = await User.findOne({ loginId: normalizedLoginId, role: 'owner' });
        const ownerUserId = userDoc ? userDoc._id : null;

        for (const prop of unmatchedProperties) {
            prop.ownerLoginId = normalizedLoginId;
            if (ownerUserId) {
                prop.owner = ownerUserId;
            }
            if (!prop.ownerName) {
                prop.ownerName = ownerDoc.name || ownerDoc.profile?.name;
            }
            if (!prop.ownerPhone) {
                prop.ownerPhone = ownerDoc.phone || ownerDoc.profile?.phone;
            }
            await prop.save();
            console.log(`   ✓ Linked property "${prop.title}" to owner ${normalizedLoginId}`);
        }
    } catch (err) {
        console.error('❌ Error running auto-healer in healOwnerProperties:', err);
    }
};

// Sync occupancy counts for a property based on Rooms, Tenants, and roomTypes fallback
exports.syncPropertyOccupancyData = async (propertyId) => {
    try {
        const mongoose = require('mongoose');
        const Room = mongoose.models.Room || require('../models/Room');
        const Tenant = mongoose.models.Tenant || require('../models/Tenant');
        const Property = mongoose.models.Property || require('../models/Property');
        const ApprovedProperty = mongoose.models.ApprovedProperty || require('../models/ApprovedProperty');

        const property = await Property.findById(propertyId);
        if (!property) return null;

        // 1. Get rooms count and total beds from Room collection
        let rooms = await Room.find({ property: propertyId, isDeleted: { $ne: true } }).lean();

        // Auto-generate rooms if none exist in the database for this property
        if (rooms.length === 0 && property.roomTypes && property.roomTypes.length > 0) {
            console.log(`🏠 Auto-Generating rooms for property "${property.title}" from roomTypes...`);
            let roomIndex = 1;
            const newRooms = [];
            for (const rt of property.roomTypes) {
                const numRooms = parseInt(rt.totalRooms || 0, 10);
                const occupancy = parseInt(rt.occupancy || 1, 10);
                const price = Number(rt.pricePerBed || rt.pricePerRoom || 0);

                for (let i = 0; i < numRooms; i++) {
                    const title = String(100 + roomIndex);
                    newRooms.push({
                        property: propertyId,
                        title,
                        type: rt.type || 'AC',
                        beds: occupancy,
                        price,
                        sharingType: rt.type || '',
                        status: 'active', // Mark active so it is visible and usable
                        isAvailable: true,
                        createdBy: property.owner || null
                    });
                    roomIndex++;
                }
            }
            if (newRooms.length > 0) {
                await Room.insertMany(newRooms);
                // Re-fetch the newly generated rooms
                rooms = await Room.find({ property: propertyId, isDeleted: { $ne: true } }).lean();
                console.log(`✅ Successfully generated ${rooms.length} rooms for property "${property.title}"`);
            }
        }

        let totalRooms = 0;
        let totalBeds = 0;

        if (rooms.length > 0) {
            totalRooms = rooms.length;
            rooms.forEach(r => {
                totalBeds += Number(r.beds || r.capacity || 1);
            });
        } else if (property.roomTypes && property.roomTypes.length > 0) {
            // Fallback to roomTypes from Wizard
            property.roomTypes.forEach(rt => {
                totalRooms += parseInt(rt.totalRooms || 0, 10);
                totalBeds += parseInt(rt.totalBeds || 0, 10);
            });
        }

        // 2. Get active/pending tenants count from Tenant collection
        const tenants = await Tenant.find({
            property: propertyId,
            status: { $in: ['active', 'pending'] },
            isDeleted: { $ne: true }
        }).lean();

        const occupiedBeds = tenants.length;

        // Calculate occupied rooms by checking unique rooms of active tenants
        const occupiedRoomIds = new Set();
        const occupiedRoomNos = new Set();
        tenants.forEach(t => {
            if (t.room) {
                occupiedRoomIds.add(t.room.toString());
            }
            if (t.roomNo) {
                occupiedRoomNos.add(String(t.roomNo).trim().toLowerCase());
            }
        });
        const occupiedRooms = Math.max(occupiedRoomIds.size, occupiedRoomNos.size);

        const vacantRooms = Math.max(0, totalRooms - occupiedRooms);
        const vacantBeds = Math.max(0, totalBeds - occupiedBeds);

        // 3. Update Property document
        await Property.updateOne(
            { _id: propertyId },
            {
                $set: {
                    roomCount: totalRooms,
                    bedCount: totalBeds,
                    totalRooms,
                    occupiedBeds,
                    occupiedRooms,
                    vacantRooms,
                    vacantBeds
                }
            }
        );

        // Sync to ApprovedProperty (website) if exists
        const approved = await ApprovedProperty.findOne({
            $or: [
                { propertyId: propertyId.toString() },
                { visitId: property.visitId || propertyId.toString() }
            ]
        });

        if (approved) {
            approved.propertyInfo = approved.propertyInfo || {};
            approved.propertyInfo.roomCount = totalRooms;
            approved.propertyInfo.bedCount = totalBeds;
            approved.propertyInfo.vacantRooms = vacantRooms;
            approved.propertyInfo.vacantBeds = vacantBeds;
            approved.propertyInfo.occupiedRooms = occupiedRooms;
            approved.propertyInfo.occupiedBeds = occupiedBeds;
            await approved.save();
        }

        return {
            totalRooms,
            totalBeds,
            occupiedBeds,
            occupiedRooms,
            vacantRooms,
            vacantBeds
        };
    } catch (err) {
        console.error(`❌ Error syncing occupancy for property ${propertyId}:`, err.message);
        return null;
    }
};

// Get properties for an owner
exports.getOwnerProperties = async (req, res) => {
    try {
        const ownerLoginId = req.params.loginId;
        await exports.healOwnerProperties(ownerLoginId);
        const properties = await Property.find({ ownerLoginId, isDeleted: { $ne: true } });

        const syncedProperties = [];
        for (const prop of properties) {
            // Use existing stored occupancy fields; avoid blocking sync on each request.
            // Trigger async sync in background to keep data fresh without delaying response.
            exports.syncPropertyOccupancyData(prop._id).catch(err => console.error('Async sync error:', err));
            const propObj = prop.toObject ? prop.toObject() : prop;
            propObj.roomCount = prop.roomCount ?? propObj.roomCount;
            propObj.bedCount = prop.bedCount ?? propObj.bedCount;
            propObj.occupiedBeds = prop.occupiedBeds ?? propObj.occupiedBeds;
            propObj.occupiedRooms = prop.occupiedRooms ?? propObj.occupiedRooms;
            propObj.vacantRooms = prop.vacantRooms ?? propObj.vacantRooms;
            propObj.vacantBeds = prop.vacantBeds ?? propObj.vacantBeds;
            syncedProperties.push(propObj);
        }
        res.json({ properties: syncedProperties });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// Get rooms for an owner
exports.getOwnerRooms = async (req, res) => {
    try {
        const ownerLoginId = req.params.loginId;
        // Fire-and-forget heal properties (do not block)
        exports.healOwnerProperties(ownerLoginId).catch(err => console.error('Heal error:', err));
        // pagination (default page 1, 3 per page)
        const page = Math.max(parseInt(req.query.page) || 1, 1);
        const limit = Math.max(parseInt(req.query.limit) || 3, 1);
        const skip = (page - 1) * limit;
        // Use aggregation to fetch rooms belonging to this owner's properties
        const Room = require('../models/Room');
        const pipeline = [
            { $lookup: { from: 'properties', localField: 'property', foreignField: '_id', as: 'prop' } },
            { $unwind: '$prop' },
            { $match: { 'prop.ownerLoginId': ownerLoginId, isDeleted: { $ne: true } } },
            { $skip: skip },
            { $limit: limit },
            { $project: { prop: 0 } }
        ];
        const rooms = await Room.aggregate(pipeline);
        // Total count (separate aggregation)
        const totalAgg = await Room.aggregate([
            { $lookup: { from: 'properties', localField: 'property', foreignField: '_id', as: 'prop' } },
            { $unwind: '$prop' },
            { $match: { 'prop.ownerLoginId': ownerLoginId, isDeleted: { $ne: true } } },
            { $count: 'count' }
        ]);
        const totalCount = (totalAgg[0] && totalAgg[0].count) || 0;
        // Async sync occupancy for each property (fire-and-forget)
        const syncPromises = [];
        const propertyIds = rooms.map(r => r.property);
        const Property = require('../models/Property');
        const props = await Property.find({ _id: { $in: propertyIds } }).lean();
        props.forEach(p => syncPromises.push(exports.syncPropertyOccupancyData(p._id).catch(err => console.error('Async sync error:', err))));
        res.json({ rooms, totalCount, page, limit });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// Get tenants for an owner
exports.getOwnerTenants = async (req, res) => {
    try {
        const ownerLoginId = req.params.loginId;
        await exports.healOwnerProperties(ownerLoginId);
        const properties = await Property.find({ ownerLoginId, isDeleted: { $ne: true } }).lean();
        const propertyIds = properties.map(p => p._id);
        const tenants = await require('../models/Tenant').find({ property: { $in: propertyIds }, isDeleted: { $ne: true } }).lean();
        res.json({ tenants });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// Get rent collected for an owner
exports.getOwnerRent = async (req, res) => {
    try {
        const ownerLoginId = String(req.params.loginId || '').trim().toUpperCase();

        // Find properties owned by this owner
        const Property = require('../models/Property');
        const properties = await Property.find({ ownerLoginId, isDeleted: { $ne: true } }).select('_id');
        const propertyIds = properties.map(p => p._id);

        // 1. Find enquiries for these properties that are accepted/approved
        const enquiries = await require('../models/Enquiry').find({
            $or: [
                { propertyId: { $in: propertyIds } },
                { ownerLoginId }
            ],
            status: { $in: ['accepted', 'approved', 'active'] }
        }).lean();
        const enquiriesTotal = enquiries.reduce((sum, e) => sum + (e.paidAmount || 0), 0);

        // 2. Find online booking payment transactions (PaymentTransaction)
        const PaymentTransaction = require('../models/PaymentTransaction');
        const transactions = await PaymentTransaction.find({
            owner_id: ownerLoginId
        }).select('owner_amount');
        const txTotal = transactions.reduce((sum, t) => sum + (t.owner_amount || 0), 0);

        // 3. Find monthly rent invoice payments (RentPayment)
        const RentPayment = require('../models/RentPayment');
        const Owner = require('../models/Owner');
        const ownerDoc = await Owner.findOne({ loginId: ownerLoginId });
        let rentPaymentsTotal = 0;
        if (ownerDoc) {
            const rentPayments = await RentPayment.find({
                ownerId: ownerDoc._id
            }).select('amount');
            rentPaymentsTotal = rentPayments.reduce((sum, r) => sum + (r.amount || 0), 0);
        }

        const totalRent = enquiriesTotal + txTotal + rentPaymentsTotal;
        res.json({ totalRent });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};
const Owner = require('../models/Owner');
const Notification = require('../models/Notification');
const Property = require('../models/Property');
const CheckinRecord = require('../models/CheckinRecord');
const ApprovedProperty = require('../models/ApprovedProperty');

// List Owners with Filtering (Area, KYC Status) + Pagination
exports.getAllOwners = async (req, res) => {
    try {
        const { locationCode, kycStatus, search, page = 1, limit } = req.query;

        // Smart default: small limit when searching (dropdown), larger for full table
        const pageSize = Math.min(parseInt(limit) || (search ? 10 : 50), 200);
        const skip = (Math.max(parseInt(page) || 1, 1) - 1) * pageSize;

        let query = { isDeleted: { $ne: true } };

        // Area Based Filtering
        if (locationCode) {
            query.$or = [
                { locationCode: { $regex: `^${locationCode}`, $options: 'i' } },
                { 'profile.locationCode': { $regex: `^${locationCode}`, $options: 'i' } }
            ];
        }

        // Status Filtering
        if (kycStatus) {
            query['kyc.status'] = kycStatus;
        }

        // Search — overrides locationCode $or if both provided (last write wins in MongoDB)
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { loginId: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { 'profile.name': { $regex: search, $options: 'i' } }
            ];
        }

        // Run count & data query in parallel
        const [total, owners] = await Promise.all([
            Owner.countDocuments(query),
            Owner.find(query).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean()
        ]);

        // Attach property counts per owner for frontend display
        const ownerLoginIds = owners.map(o => o.loginId).filter(Boolean);
        const primaryPropertyMap = {};
        const approvedPropertyMap = {};

        if (ownerLoginIds.length > 0) {
            const counts = await Property.aggregate([
                { $match: { ownerLoginId: { $in: ownerLoginIds } } },
                { $group: { _id: '$ownerLoginId', count: { $sum: 1 } } }
            ]);
            const countMap = {};
            counts.forEach(c => { countMap[c._id] = c.count; });
            owners.forEach(o => { o.propertyCount = countMap[o.loginId] || 0; });

            const firstProperties = await Property.find({ ownerLoginId: { $in: ownerLoginIds } })
                .sort({ createdAt: 1 })
                .select('ownerLoginId title locationCode roomCount bedCount vacantRooms vacantBeds occupiedRooms occupiedBeds')
                .lean();
            firstProperties.forEach((property) => {
                if (property?.ownerLoginId && !primaryPropertyMap[property.ownerLoginId]) {
                    primaryPropertyMap[property.ownerLoginId] = property;
                }
            });

            const approvedProperties = await ApprovedProperty.find({
                'generatedCredentials.loginId': { $in: ownerLoginIds }
            })
                .sort({ approvedAt: -1 })
                .select('visitId isLiveOnWebsite status generatedCredentials propertyInfo')
                .lean();
            approvedProperties.forEach((item) => {
                const loginId = item?.generatedCredentials?.loginId;
                if (loginId && !approvedPropertyMap[loginId]) {
                    approvedPropertyMap[loginId] = item;
                }
            });
        } else {
            owners.forEach(o => { o.propertyCount = 0; });
        }

        // ✅ Ensure all owners have merged profile data at top level for easy frontend access
        const checkins = ownerLoginIds.length > 0
            ? await CheckinRecord.find({ role: 'owner', loginId: { $in: ownerLoginIds } }).lean()
            : [];
        const checkinMap = {};
        checkins.forEach(c => { checkinMap[c.loginId] = c; });

        const enrichedOwners = owners.map(o => {
            const checkin = checkinMap[o.loginId];
            const kycComplete = ['verified', 'submitted'].includes(o.kyc?.status) ||
                checkin?.ownerKyc?.otpVerified ||
                checkin?.ownerKyc?.digilockerVerified ||
                checkin?.ownerFinalVerified;
            const shouldBeActive = o.isActive === true || kycComplete;

            // Self-heal owners stuck inactive after completing digital check-in
            if (shouldBeActive && o.isActive !== true) {
                Owner.updateOne(
                    { loginId: o.loginId },
                    { $set: { isActive: true, 'kyc.status': 'verified', 'kyc.verifiedAt': o.kyc?.verifiedAt || new Date() } }
                ).catch(() => { });
            }

            return {
                ...o,
                isActive: shouldBeActive,
                propertyTitle: primaryPropertyMap[o.loginId]?.title || '',
                propertyName: primaryPropertyMap[o.loginId]?.title || '',
                propertyLocationCode: primaryPropertyMap[o.loginId]?.locationCode || '',
                checkinDob: o.checkinDob || checkinMap[o.loginId]?.ownerProfile?.dob || '',
                checkinEmail: o.checkinEmail || checkinMap[o.loginId]?.ownerProfile?.email || o.email || '',
                checkinPhone: o.checkinPhone || checkinMap[o.loginId]?.ownerProfile?.phone || o.phone || '',
                checkinAddress: o.checkinAddress || checkinMap[o.loginId]?.ownerProfile?.address || o.address || '',
                checkinArea: o.checkinArea || checkinMap[o.loginId]?.ownerProfile?.area || o.locationCode || o.profile?.locationCode || '',
                checkinPassword: o.checkinPassword || o.credentials?.password || '',
                checkinAccountHolderName: o.checkinAccountHolderName || checkinMap[o.loginId]?.ownerProfile?.payment?.accountHolderName || o.profile?.accountHolderName || '',
                checkinBankAccountNumber: o.checkinBankAccountNumber || checkinMap[o.loginId]?.ownerProfile?.payment?.bankAccountNumber || o.accountNumber || o.profile?.accountNumber || '',
                checkinIfscCode: o.checkinIfscCode || checkinMap[o.loginId]?.ownerProfile?.payment?.ifscCode || o.ifscCode || o.profile?.ifscCode || '',
                checkinBankName: o.checkinBankName || checkinMap[o.loginId]?.ownerProfile?.payment?.bankName || o.bankName || o.profile?.bankName || '',
                checkinBranchName: o.checkinBranchName || checkinMap[o.loginId]?.ownerProfile?.payment?.branchName || o.branchName || o.profile?.branchName || '',
                checkinUpiId: o.checkinUpiId || checkinMap[o.loginId]?.ownerProfile?.payment?.upiId || o.profile?.upiId || '',
                checkinAadhaarLinkedPhone: o.checkinAadhaarLinkedPhone || checkinMap[o.loginId]?.ownerKyc?.aadhaarLinkedPhone || o.kyc?.aadhaarLinkedPhone || '',
                checkinAadhaarNumber: o.checkinAadhaarNumber || checkinMap[o.loginId]?.ownerKyc?.aadhaarNumber || o.kyc?.aadharNumber || o.kyc?.aadhaarNumber || '',
                checkinOtpVerified: !!checkinMap[o.loginId]?.ownerKyc?.otpVerified,
                checkinSubmittedAt: checkinMap[o.loginId]?.ownerSubmittedAt || null,
                // Merge profile data to top level (profile takes priority, then top-level field)
                name: o.profile?.name || o.name || 'Unknown',
                email: o.profile?.email || o.email || o.checkinEmail || (checkinMap[o.loginId]?.ownerProfile?.email || ''),
                phone: o.profile?.phone || o.phone || o.checkinPhone || (checkinMap[o.loginId]?.ownerProfile?.phone || ''),
                address: o.profile?.address || o.address || o.checkinAddress || (checkinMap[o.loginId]?.ownerProfile?.address || ''),
                locationCode: o.profile?.locationCode || o.locationCode || o.checkinArea || (checkinMap[o.loginId]?.ownerProfile?.area || ''),
                bankName: o.profile?.bankName || o.checkinBankName || '',
                accountNumber: o.profile?.accountNumber || o.accountNumber || o.checkinBankAccountNumber || (checkinMap[o.loginId]?.ownerProfile?.payment?.bankAccountNumber || ''),
                ifscCode: o.profile?.ifscCode || o.ifscCode || o.checkinIfscCode || (checkinMap[o.loginId]?.ownerProfile?.payment?.ifscCode || ''),
                branchName: o.profile?.branchName || o.branchName || o.checkinBranchName || '',
                aadharNumber: o.kyc?.aadharNumber || o.kyc?.aadhaarNumber || o.checkinAadhaarNumber || '',
                kycStatus: kycComplete ? 'verified' : (o.kyc?.status || 'pending'),
                documentImage: o.kyc?.documentImage || '',
                profileFilled: !!o.profileFilled,
                password: o.credentials?.password || o.checkinPassword || '',
                bankLockedByVisit: !!o.bankLockedByVisit,
                roomCount: Number(o.roomCount ?? primaryPropertyMap[o.loginId]?.roomCount ?? 0),
                bedCount: Number(o.bedCount ?? primaryPropertyMap[o.loginId]?.bedCount ?? 0),
                vacantRooms: Number(o.vacantRooms ?? primaryPropertyMap[o.loginId]?.vacantRooms ?? 0),
                vacantBeds: Number(o.vacantBeds ?? primaryPropertyMap[o.loginId]?.vacantBeds ?? 0),
                occupiedRooms: Number(o.occupiedRooms ?? primaryPropertyMap[o.loginId]?.occupiedRooms ?? 0),
                occupiedBeds: Number(o.occupiedBeds ?? primaryPropertyMap[o.loginId]?.occupiedBeds ?? 0),
                roomInventory: Array.isArray(o.roomInventory) ? o.roomInventory : [],
                approvedVisitId: approvedPropertyMap[o.loginId]?.visitId || '',
                isLiveOnWebsite: Boolean(approvedPropertyMap[o.loginId]?.isLiveOnWebsite),
                websiteStatus: approvedPropertyMap[o.loginId]?.status || '',
                city: o.profile?.city || o.city || primaryPropertyMap[o.loginId]?.city || ''
            };
        });

        res.json({
            success: true,
            owners: enrichedOwners,
            pagination: {
                total,
                page: parseInt(page) || 1,
                limit: pageSize,
                totalPages: Math.ceil(total / pageSize),
                hasNext: skip + owners.length < total,
                hasPrev: (parseInt(page) || 1) > 1
            }
        });
    } catch (err) {
        console.error('Get Owners Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};


// Update Owner KYC Status (Super Admin Action)
exports.updateOwnerKyc = async (req, res) => {
    try {
        const { id } = req.params; // Can be _id or loginId
        const { status, rejectionReason } = req.body; // 'verified' or 'rejected'

        if (!['verified', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const owner = await Owner.findOne({ $or: [{ _id: id }, { loginId: id }] });
        if (!owner) return res.status(404).json({ message: 'Owner not found' });

        owner.kyc = owner.kyc || {};
        owner.kyc.status = status;
        if (status === 'verified') {
            owner.kyc.verifiedAt = new Date();
            owner.isActive = true; // Activate owner on verification
        } else {
            owner.kyc.rejectionReason = rejectionReason || '';
            owner.isActive = false;
        }

        await owner.save();

        // Send Notification to Owner (assuming Notification model exists)
        // Note: recipient needs to be the User _id associated if decoupled, 
        // but often Owner model implies a User. Adjust recipient as needed.
        // For now, we assume a notification system integration:
        // await Notification.create({
        //    recipient: owner.userId, // field linking to User model
        //    type: 'kyc_update',
        //    message: `Your KYC has been ${status}.`
        // });

        res.json({ success: true, message: `Owner KYC ${status}`, owner });
    } catch (err) {
        console.error('KYC Update Error:', err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

// Request Owner (Employee Action)
exports.requestOwner = async (req, res) => {
    try {
        console.log('📝 Owner Request POST:', req.body);
        const { name, email, phone, locationCode } = req.body;

        // Always auto-generate a ROOMHY#### login ID — ignore any frontend-supplied value
        const generateOwnerId = require('../utils/generateOwnerId');
        const loginId = await generateOwnerId();

        const owner = new Owner({
            loginId,
            name,
            email,
            phone,
            locationCode,
            isActive: false,
            kyc: {
                status: 'requested'
            }
        });

        await owner.save();
        console.log('✅ Owner request created:', owner.loginId);

        res.status(201).json({ success: true, owner, message: 'Owner request submitted successfully' });
    } catch (err) {
        console.error('❌ Owner Request error:', err.message);
        res.status(500).json({ error: err.message });
    }
};

// Approve Owner Request (Super Admin Action)
exports.approveOwner = async (req, res) => {
    try {
        const { loginId } = req.params;
        const { password } = req.body;

        if (!password) {
            return res.status(400).json({ message: 'Password is required for approval' });
        }

        const owner = await Owner.findOne({ loginId });
        if (!owner) return res.status(404).json({ message: 'Owner not found' });

        if (owner.kyc?.status !== 'requested') {
            return res.status(400).json({ message: 'Owner is not in requested status' });
        }

        // Set credentials
        owner.credentials = { password, firstTime: true };
        owner.checkinPassword = password;
        owner.kyc = owner.kyc || {};
        owner.kyc.status = 'sent'; // Indicate link sent
        owner.isActive = true;
        await owner.save();

        // Send email
        if (owner.email) {
            try {
                const mailer = require('../utils/mailer');
                const DIGITAL_CHECKIN_URL = process.env.DIGITAL_CHECKIN_URL || process.env.FRONTEND_URL || 'https://admin.roomhy.com';
                const area = owner.locationCode || owner.area || '';

                const kycLink = `${DIGITAL_CHECKIN_URL}/digital-checkin/ownerprofile?loginId=${encodeURIComponent(owner.loginId)}&email=${encodeURIComponent(owner.email)}&area=${encodeURIComponent(area)}&password=${encodeURIComponent(password)}`;

                await mailer.sendKycLinkEmail(owner.email, owner.name || 'Owner', 'Roomhy Asset Portal', kycLink);
                console.log(`✉️ Direct KYC link sent to ${owner.email} for newly approved Owner ${owner.loginId}`);
            } catch (mailErr) {
                console.warn('❌ Failed to send direct KYC email for approved Owner:', mailErr.message);
            }
        }

        res.json({ success: true, message: 'Owner request approved and link sent.', owner });
    } catch (err) {
        console.error('❌ Approve Owner error:', err.message);
        res.status(500).json({ error: err.message });
    }
};

// Get Single Owner
exports.getOwnerById = async (req, res) => {
    try {
        const normalizedLoginId = String(req.params.loginId || '').trim().toUpperCase();
        const owner = await Owner.findOne({ loginId: normalizedLoginId }).lean();
        if (!owner) return res.status(404).json({ message: 'Owner not found' });
        const approvedProperty = await ApprovedProperty.findOne({ 'generatedCredentials.loginId': normalizedLoginId })
            .sort({ approvedAt: -1 })
            .select('visitId isLiveOnWebsite status')
            .lean();

        // Fallback: read bank fields from VisitData if Owner checkin fields are missing
        const VisitData = require('../models/VisitData');
        const visitForBank = await VisitData.findOne({ 'generatedCredentials.loginId': normalizedLoginId })
            .select('bankAccountHolderName bankAccountNumber bankIfscCode bankName bankBranchName bankUpiId ownerPhone contactPhone')
            .sort({ updatedAt: -1 })
            .lean();

        const checkin = await CheckinRecord.findOne({ role: 'owner', loginId: normalizedLoginId }).lean();
        const primaryProperty = await Property.findOne({ ownerLoginId: normalizedLoginId })
            .sort({ createdAt: 1 })
            .select('title locationCode')
            .lean();

        const checkinBankName = owner.checkinBankName || checkin?.ownerProfile?.payment?.bankName || owner.bankName || visitForBank?.bankName || '';
        const checkinBranchName = owner.checkinBranchName || checkin?.ownerProfile?.payment?.branchName || owner.branchName || visitForBank?.bankBranchName || '';
        const checkinBankAccountNumber = owner.checkinBankAccountNumber || checkin?.ownerProfile?.payment?.bankAccountNumber || visitForBank?.bankAccountNumber || '';
        const checkinIfscCode = owner.checkinIfscCode || checkin?.ownerProfile?.payment?.ifscCode || visitForBank?.bankIfscCode || '';
        const checkinAccountHolderName = owner.checkinAccountHolderName || checkin?.ownerProfile?.payment?.accountHolderName || visitForBank?.bankAccountHolderName || '';
        const checkinUpiId = owner.checkinUpiId || checkin?.ownerProfile?.payment?.upiId || visitForBank?.bankUpiId || '';
        const bankLockedByVisit = !!owner.bankLockedByVisit || !!(visitForBank?.bankName || visitForBank?.bankAccountNumber);
        const visitPhone = visitForBank?.ownerPhone || visitForBank?.contactPhone || '';
        const phoneLockedByVisit = !!visitPhone;

        res.json({
            ...owner,
            propertyTitle: primaryProperty?.title || '',
            propertyName: primaryProperty?.title || '',
            propertyLocationCode: primaryProperty?.locationCode || '',
            name: owner.profile?.name || owner.name || 'Unknown',
            email: owner.profile?.email || owner.email || owner.checkinEmail || (checkin?.ownerProfile?.email || ''),
            phone: owner.profile?.phone || owner.phone || owner.checkinPhone || (checkin?.ownerProfile?.phone || ''),
            address: owner.profile?.address || owner.address || owner.checkinAddress || (checkin?.ownerProfile?.address || ''),
            locationCode: owner.profile?.locationCode || owner.locationCode || owner.checkinArea || (checkin?.ownerProfile?.area || ''),
            bankName: owner.profile?.bankName || checkinBankName || '',
            accountNumber: owner.profile?.accountNumber || owner.accountNumber || checkinBankAccountNumber || '',
            ifscCode: owner.profile?.ifscCode || owner.ifscCode || checkinIfscCode || '',
            branchName: owner.profile?.branchName || owner.branchName || checkinBranchName || '',
            aadharNumber: owner.kyc?.aadharNumber || owner.kyc?.aadhaarNumber || owner.checkinAadhaarNumber || '',
            kycStatus: owner.kyc?.status || 'pending',
            documentImage: owner.kyc?.documentImage || '',
            profileFilled: !!owner.profileFilled,
            password: owner.credentials?.password || owner.checkinPassword || '',
            checkinDob: owner.checkinDob || checkin?.ownerProfile?.dob || '',
            checkinEmail: owner.checkinEmail || checkin?.ownerProfile?.email || owner.email || '',
            checkinPhone: owner.checkinPhone || checkin?.ownerProfile?.phone || owner.phone || '',
            checkinAddress: owner.checkinAddress || checkin?.ownerProfile?.address || owner.address || '',
            checkinArea: owner.checkinArea || checkin?.ownerProfile?.area || owner.locationCode || '',
            checkinAccountHolderName,
            checkinBankAccountNumber,
            checkinIfscCode,
            checkinBankName,
            checkinBranchName,
            checkinUpiId,
            bankLockedByVisit,
            phoneLockedByVisit,
            checkinAadhaarLinkedPhone: owner.checkinAadhaarLinkedPhone || checkin?.ownerKyc?.aadhaarLinkedPhone || owner.kyc?.aadhaarLinkedPhone || visitPhone || '',
            checkinOwnerPhoto: owner.checkinOwnerPhoto || '',
            checkinOwnerPhotoName: owner.checkinOwnerPhotoName || '',
            checkinOwnerPhotoType: owner.checkinOwnerPhotoType || '',
            checkinBankProof: owner.checkinBankProof || '',
            checkinBankProofName: owner.checkinBankProofName || '',
            checkinBankProofType: owner.checkinBankProofType || '',
            roomCount: Number(owner.roomCount || primaryProperty?.roomCount || 0),
            bedCount: Number(owner.bedCount || primaryProperty?.bedCount || 0),
            vacantRooms: Number(owner.vacantRooms || primaryProperty?.vacantRooms || 0),
            vacantBeds: Number(owner.vacantBeds || primaryProperty?.vacantBeds || 0),
            occupiedRooms: Number(owner.occupiedRooms || primaryProperty?.occupiedRooms || 0),
            occupiedBeds: Number(owner.occupiedBeds || primaryProperty?.occupiedBeds || 0),
            roomInventory: Array.isArray(owner.roomInventory) ? owner.roomInventory : [],
            approvedVisitId: approvedProperty?.visitId || '',
            isLiveOnWebsite: Boolean(approvedProperty?.isLiveOnWebsite),
            websiteStatus: approvedProperty?.status || '',
            city: owner.profile?.city || owner.city || primaryProperty?.city || '',
            checkinOtpVerified: !!checkin?.ownerKyc?.otpVerified,
            checkinSubmittedAt: checkin?.ownerSubmittedAt || null,
            settings: {
                checkoutTime: owner.settings?.checkoutTime || "10:00 AM",
                checkinTime: owner.settings?.checkinTime || "11:00 AM",
                fineGracePeriod: owner.settings?.fineGracePeriod !== undefined ? owner.settings.fineGracePeriod : 5,
                fineAmount: owner.settings?.fineAmount !== undefined ? owner.settings.fineAmount : 100,
                curfewTime: owner.settings?.curfewTime || "11:00 PM",
                electricityUnitRate: owner.settings?.electricityUnitRate !== undefined ? owner.settings.electricityUnitRate : 12,
            }
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// Add tenant to property (Owner)
exports.addTenantToProperty = async (req, res) => {
    try {
        const { ownerLoginId, propertyId } = req.params;
        const {
            name, phone, email, roomNo, bedNo, moveInDate, agreedRent,
            dob, gender, building, floor, rentAgreementType, paymentFrequency,
            additional, idProof,
            securityDepositTotal, securityDepositPaid, securityDepositBalance,
            electricityCharge, maintenanceCharge, electricityUnitCost
        } = req.body;

        // Verify property belongs to owner
        const normalizedOwnerId = String(ownerLoginId || '').toUpperCase();
        const property = await Property.findById(propertyId);

        if (!property) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        if (property.ownerLoginId !== normalizedOwnerId) {
            return res.status(403).json({
                success: false,
                message: 'Property does not belong to this owner'
            });
        }

        // Prepare tenant assignment request
        const tenantAssignmentPayload = {
            name,
            phone,
            email,
            propertyId: propertyId,
            roomNo,
            bedNo,
            moveInDate,
            agreedRent,
            dob,
            gender,
            building,
            floor,
            rentAgreementType,
            paymentFrequency,
            additional,
            idProof,
            securityDepositTotal,
            securityDepositPaid,
            securityDepositBalance,
            electricityCharge,
            maintenanceCharge,
            electricityUnitCost,
            ownerLoginId: normalizedOwnerId,
            propertyTitle: property.title
        };

        // Create request object for tenant assignment
        const mockReq = {
            body: tenantAssignmentPayload,
            user: {
                id: property.owner
            }
        };

        // Create response object to capture tenant assignment response
        let tenantResponse = null;
        let tenantError = null;

        const mockRes = {
            status: function (code) {
                this.statusCode = code;
                return this;
            },
            json: function (data) {
                tenantResponse = { statusCode: this.statusCode || 200, data };
                return this;
            }
        };

        // Import and call tenant assignment
        const tenantController = require('./tenantController');

        // Create a custom response handler
        await new Promise((resolve, reject) => {
            const originalJson = mockRes.json;
            mockRes.json = function (data) {
                tenantResponse = { statusCode: this.statusCode || 200, data };
                resolve();
                return this;
            };
            mockRes.status = function (code) {
                this.statusCode = code;
                return this;
            };

            tenantController.assignTenant(mockReq, mockRes).catch((err) => {
                tenantError = err;
                reject(err);
            });
        });

        if (tenantError) {
            return res.status(500).json({
                success: false,
                message: 'Failed to assign tenant',
                error: tenantError.message
            });
        }

        if (!tenantResponse || !tenantResponse.data.success) {
            return res.status(tenantResponse?.statusCode || 400).json(
                tenantResponse?.data || { success: false, message: 'Failed to assign tenant' }
            );
        }

        // Log action for audit
        console.log(`✅ Tenant ${name} (${email}) added to property ${property.title} by owner ${normalizedOwnerId}`);

        // Return response with tenant assignment data
        return res.status(201).json({
            success: true,
            message: 'Tenant added successfully to your property',
            tenant: tenantResponse.data.tenant,
            tenantCheckinLink: tenantResponse.data.tenantCheckinLink,
            onboarding: tenantResponse.data.onboarding
        });

    } catch (err) {
        console.error('Error adding tenant:', err);
        return res.status(500).json({
            success: false,
            message: 'Failed to add tenant',
            error: err.message
        });
    }
};

// Get tenants for owner's property
exports.getPropertyTenants = async (req, res) => {
    try {
        const { ownerLoginId, propertyId } = req.params;

        // Verify property belongs to owner
        const normalizedOwnerId = String(ownerLoginId || '').toUpperCase();
        const property = await Property.findById(propertyId).lean();

        if (!property) {
            return res.status(404).json({
                success: false,
                message: 'Property not found'
            });
        }

        if (property.ownerLoginId !== normalizedOwnerId) {
            return res.status(403).json({
                success: false,
                message: 'Property does not belong to this owner'
            });
        }

        // Get tenants for the property
        const Tenant = require('../models/Tenant');
        const tenants = await Tenant.find({ property: propertyId })
            .populate('property', 'title roomType locationCode ownerLoginId')
            .sort({ createdAt: -1 })
            .lean();

        return res.json({
            success: true,
            propertyId: propertyId,
            propertyTitle: property.title,
            totalTenants: tenants.length,
            tenants
        });

    } catch (err) {
        console.error('Error fetching property tenants:', err);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch tenants',
            error: err.message
        });
    }
};

// --- SSE handler ---
const sseManager = require('../utils/sseManager');
exports.sseStream = (req, res) => {
    const { loginId } = req.params;
    if (!loginId) {
        return res.status(400).end();
    }
    sseManager.addClient(req, res, loginId);
};

