const { normalizeLoginId } = require('../utils/normalizeId');

/**
 * Owner↔property link repair now lives in jobs/ownerPropertyHealJob.js and runs
 * on a schedule under a distributed lock — it is NOT part of any request path.
 * See that file for the batching, idempotency and locking rationale.
 *
 * This re-export is kept so existing callers and tests keep resolving, and so
 * an operator can still repair a single owner on demand (e.g. from a script or
 * an admin action). Never call it from a GET handler.
 */
exports.healOwnerProperties = (loginId) =>
    require('../jobs/ownerPropertyHealJob').healOwnerProperties(loginId);

/**
 * @deprecated Repair no longer runs on the request path. Retained as a no-op so
 * any straggling caller cannot silently reintroduce writes into a read handler.
 * Use the scheduled job (jobs/ownerPropertyHealJob.js) instead.
 */
exports.fireHeal = () => {};

exports.healTenantInvoices = async (ownerLoginId) => {
    try {
        const mongoose = require('mongoose');
        const RentInvoice = mongoose.models.RentInvoice || require('../models/RentInvoice');
        const Rent = mongoose.models.Rent || require('../models/Rent');
        const Owner = mongoose.models.Owner || require('../models/Owner');
        const Tenant = mongoose.models.Tenant || require('../models/Tenant');
        const RentPayment = mongoose.models.RentPayment || require('../models/RentPayment');
        const { getEffectiveConfig } = require('../services/invoiceService');

        const ownerDoc = await Owner.findOne({ loginId: ownerLoginId }).lean();
        if (!ownerDoc) return;

        const isOwnerObjectId = ownerDoc._id && mongoose.Types.ObjectId.isValid(ownerDoc._id) && String(ownerDoc._id).match(/^[0-9a-fA-F]{24}$/);
        const safeOwnerId = isOwnerObjectId
            ? ownerDoc._id
            : new mongoose.Types.ObjectId(require('crypto').createHash('md5').update(String(ownerLoginId)).digest('hex').slice(0, 24));

        // 1. Heal existing PENDING/PARTIAL invoices if a paid Rent record exists
        const invoices = await RentInvoice.find({
            $or: [
                { ownerId: safeOwnerId },
                ...(isOwnerObjectId ? [{ ownerId: ownerDoc._id }] : [])
            ],
            status: { $in: ['PENDING', 'PARTIAL'] }
        });

        for (const inv of invoices) {
            const rentRecord = await Rent.findOne({
                $or: [
                    { tenantId: inv.tenantId },
                    ...(inv.tenantLoginId ? [{ tenantLoginId: inv.tenantLoginId }] : []),
                    ...(inv.tenantEmail ? [{ tenantEmail: inv.tenantEmail }] : [])
                ],
                collectionMonth: inv.billingMonth,
                paymentStatus: { $in: ['paid', 'completed'] }
            });

            if (rentRecord) {
                console.log(`🧹 Healing RentInvoice ${inv._id}: Tenant already paid via Rent record!`);
                const paidAmt = rentRecord.paidAmount || inv.rentAmount || 0;
                inv.paidAmount = paidAmt;
                inv.rentPaidAmount = paidAmt;
                inv.outstandingAmount = 0;
                inv.status = 'PAID';
                inv.paymentMethod = rentRecord.paymentMethod || 'cash';
                inv.razorpayPaymentId = rentRecord.razorpayPaymentId || '';
                inv.paymentDate = rentRecord.paymentDate || new Date();
                await inv.save();
            }
        }

        // 2. Auto-create missing PAID invoices for tenants who have paid Rent records but no RentInvoice
        const currentMonth = new Date().toISOString().slice(0, 7);
        const tenants = await Tenant.find({ ownerLoginId: ownerLoginId, isDeleted: { $ne: true } }).lean();

        for (const t of tenants) {
            const paidRent = await Rent.findOne({
                $or: [
                    { tenantLoginId: t.loginId },
                    { tenantId: t._id },
                    ...(t.email ? [{ tenantEmail: t.email }] : [])
                ],
                paymentStatus: { $in: ['paid', 'completed'] }
            }).sort({ createdAt: -1 });

            if (paidRent) {
                const billingMonth = paidRent.collectionMonth || currentMonth;
                const existingInv = await RentInvoice.findOne({ tenantId: t._id, billingMonth });

                if (!existingInv) {
                    const rentAmt = Number(t.agreedRent || paidRent.rentAmount || 0);
                    const invoiceNumber = `INV-${billingMonth}-${String(t._id).slice(-6)}-${Date.now().toString(36).toUpperCase()}`;
                    const config = await getEffectiveConfig(safeOwnerId, t.property, null);
                    const [yr, mo] = billingMonth.split('-');
                    const dueDate = new Date(parseInt(yr), parseInt(mo) - 1, config?.rentDueDay || 1);

                    const newInv = await RentInvoice.create({
                        invoiceNumber,
                        ownerId: safeOwnerId,
                        propertyId: t.property || null,
                        tenantId: t._id,
                        tenantName: t.name || '',
                        tenantEmail: t.email || '',
                        tenantPhone: t.phone || '',
                        billingMonth,
                        rentAmount: rentAmt,
                        dueDate,
                        totalDue: rentAmt,
                        outstandingAmount: 0,
                        paidAmount: rentAmt,
                        rentPaidAmount: rentAmt,
                        status: 'PAID',
                        paymentDate: paidRent.paymentDate || new Date(),
                        penaltyConfigSnapshot: config || {},
                    });

                    if (rentAmt > 0) {
                        await RentPayment.create({
                            invoiceId: newInv._id,
                            tenantId: t._id,
                            propertyId: t.property || null,
                            ownerId: safeOwnerId,
                            amount: rentAmt,
                            paymentMethod: paidRent.paymentMethod || 'cash',
                            transactionId: paidRent.razorpayPaymentId || `HEAL-${Date.now().toString(36).toUpperCase()}`,
                            isPartial: false,
                            remainingAfter: 0,
                            rentPaidAmount: rentAmt,
                            penaltyPaidAmount: 0,
                            paymentDate: paidRent.paymentDate || new Date(),
                            recordedBy: ownerLoginId,
                            notes: 'Auto-healed move-in rent payment receipt',
                        }).catch(() => { });
                    }
                    console.log(`🧾 Auto-healed missing PAID invoice for tenant ${t.name} (${t.loginId})`);
                }
            }
        }
    } catch (err) {
        console.error('❌ Error healing tenant invoices:', err.message);
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
        const rawLoginId = req.params.loginId;
        const ownerLoginId = normalizeLoginId(String(rawLoginId || ''));
        // Canonical form plus the caller's literal input, deduped. An $in of
        // plain strings can use the ownerLoginId index; the case-insensitive
        // regex branch this replaces could not, and an $or is only
        // index-eligible when every one of its branches is.
        const ownerIdCandidates = [...new Set([ownerLoginId, rawLoginId].filter(Boolean))];
        // Read-only path: repair runs in jobs/ownerPropertyHealJob.js.

        const mongoose = require('mongoose');
        const Owner = mongoose.models.Owner || require('../models/Owner');
        const Property = mongoose.models.Property || require('../models/Property');
        const ApprovedProperty = mongoose.models.ApprovedProperty || require('../models/ApprovedProperty');

        const ownerDoc = await Owner.findOne({
            loginId: { $in: ownerIdCandidates }
        }).lean();

        const ownerEmails = [ownerLoginId, ownerDoc?.email, ownerDoc?.profile?.email, ownerDoc?.checkinEmail]
            .filter(Boolean).map(e => String(e).toLowerCase());
        const ownerPhones = [ownerDoc?.phone, ownerDoc?.profile?.phone, ownerDoc?.checkinPhone]
            .filter(Boolean).map(p => String(p).replace(/\D/g, '')).filter(p => p.length >= 10);

        const matchOr = [
            { ownerLoginId: { $in: ownerIdCandidates } }
        ];

        if (ownerDoc?._id) {
            matchOr.push({ owner: ownerDoc._id });
        }

        if (ownerEmails.length > 0) {
            matchOr.push({ 'email': { $in: ownerEmails } });
            matchOr.push({ 'contact.email': { $in: ownerEmails } });
        }
        if (ownerPhones.length > 0) {
            ownerPhones.forEach(ph => {
                const last10 = ph.slice(-10);
                matchOr.push({ 'ownerPhone': new RegExp(last10 + '$') });
                matchOr.push({ 'contact.number': new RegExp(last10 + '$') });
                matchOr.push({ 'phone': new RegExp(last10 + '$') });
            });
        }

        let properties = await Property.find({
            $or: matchOr,
            isDeleted: { $ne: true }
        }).lean();

        // Also merge items from ApprovedProperty if not already in properties list
        const approvedProps = await ApprovedProperty.find({
            $or: [
                { 'generatedCredentials.loginId': { $in: ownerIdCandidates } },
                { ownerLoginId: { $in: ownerIdCandidates } },
                ...matchOr
            ]
        }).lean();

        const existingIds = new Set(properties.map(p => p._id ? p._id.toString() : ''));
        for (const ap of approvedProps) {
          const apId = ap._id ? ap._id.toString() : '';
          const propIdStr = ap.propertyId ? ap.propertyId.toString() : '';
          if (apId && !existingIds.has(apId) && !existingIds.has(propIdStr)) {
            const mapped = {
              _id: ap._id,
              title: ap.propertyInfo?.name || ap.title || 'Property',
              city: ap.propertyInfo?.city || ap.city || '',
              locality: ap.propertyInfo?.area || ap.locality || '',
              address: ap.propertyInfo?.address || ap.address || '',
              monthlyRent: ap.propertyInfo?.rent || ap.monthlyRent || 0,
              propertyType: ap.propertyInfo?.propertyType || ap.propertyType || 'pg',
              status: ap.status || 'active',
              images: ap.images || ap.photos || [],
              ownerLoginId: ownerLoginId,
              ...ap
            };
            properties.push(mapped);
          }
        }

        const syncedProperties = [];
        for (const prop of properties) {
            // Occupancy sync intentionally not triggered from this read path.
            syncedProperties.push({
                ...prop,
                title: prop.title || prop.name || 'Property',
                status: prop.status || 'pending_approval',
                roomCount: prop.roomCount ?? 0,
                bedCount: prop.bedCount ?? 0,
                occupiedBeds: prop.occupiedBeds ?? 0,
                occupiedRooms: prop.occupiedRooms ?? 0,
                vacantRooms: prop.vacantRooms ?? 0,
                vacantBeds: prop.vacantBeds ?? 0
            });
        }
        res.json({ properties: syncedProperties });
    } catch (err) {
        console.error('Error fetching owner properties:', err);
        res.status(500).json({ message: err.message });
    }
};

// Get rooms for an owner
exports.getOwnerRooms = async (req, res) => {
    try {
        const ownerLoginId = req.params.loginId;
        // Read-only path: repair runs in jobs/ownerPropertyHealJob.js.
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
        // Occupancy sync intentionally not triggered from this read path.
        res.json({ rooms, totalCount, page, limit });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// Get tenants for an owner
exports.getOwnerTenants = async (req, res) => {
    try {
        const ownerLoginId = req.params.loginId;
        // Read-only path: repair runs in jobs/ownerPropertyHealJob.js.
        const properties = await Property.find({ ownerLoginId, isDeleted: { $ne: true } }).lean();
        const propertyIds = properties.map(p => p._id);
        const Tenant = require('../models/Tenant');

        // Fetch tenants for this owner's properties
        const tenants = await Tenant.find({ property: { $in: propertyIds }, isDeleted: { $ne: true } }).lean();
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

        // All three totals are summed by MongoDB — only the scalar is needed.
        // Same filters as before: same properties, same enquiry statuses, same
        // owner scoping.
        const { sumPaymentTransactions, sumRentPayments, sumEnquiryPaidAmounts } =
            require('../services/paymentTotalsService');
        const Owner = require('../models/Owner');
        const ownerDoc = await Owner.findOne({ loginId: ownerLoginId }).select('_id').lean();

        const [enquiriesTotal, txTotal, rentPaymentsTotal] = await Promise.all([
            // 1. Booking deposits on accepted/approved/active enquiries
            sumEnquiryPaidAmounts({
                $or: [
                    { propertyId: { $in: propertyIds } },
                    { ownerLoginId }
                ],
                status: { $in: ['accepted', 'approved', 'active'] }
            }),
            // 2. Owner's share of online booking payments
            sumPaymentTransactions({ owner_id: ownerLoginId }),
            // 3. Manually recorded monthly rent payments
            ownerDoc ? sumRentPayments({ ownerId: ownerDoc._id }) : Promise.resolve(0),
        ]);

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

        const { applyOwnerScope } = require('../utils/scopeHelpers');
        let query = applyOwnerScope(req, { isDeleted: { $ne: true } });

        // Area Based Filtering
        if (locationCode) {
            query.locationCode = { $regex: `^${locationCode}`, $options: 'i' };
        }

        // Status Filtering
        if (kycStatus) {
            query['kyc.status'] = kycStatus;
        }

        // Search
        if (search) {
            const searchRegex = new RegExp(search, 'i');
            const searchClause = {
                $or: [
                    { name: searchRegex },
                    { loginId: searchRegex },
                    { phone: searchRegex },
                    { email: searchRegex },
                    { 'profile.name': searchRegex }
                ]
            };
            if (query.$or) {
                query = { $and: [query, searchClause] };
            } else {
                query.$or = searchClause.$or;
            }
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
            const isPendingApproval = Boolean(o.isEmployeeSubmitted && o.status === 'pending_approval');
            const kycComplete = Boolean(
                ['verified', 'submitted', 'completed'].includes(o.kycStatus) ||
                ['verified', 'submitted', 'completed'].includes(o.kyc?.status) ||
                checkin?.ownerKyc?.otpVerified ||
                checkin?.ownerKyc?.digilockerVerified ||
                checkin?.ownerFinalVerified ||
                o.checkinAadhaarNumber
            );
            const shouldBeActive = isPendingApproval ? false : (o.isActive === true);

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
                checkinOwnerPhoto: o.checkinOwnerPhoto || checkinMap[o.loginId]?.ownerKyc?.ownerPhoto || '',
                checkinBankProof: o.checkinBankProof || checkinMap[o.loginId]?.ownerKyc?.bankProof || '',
                checkinAadhaarImage: o.checkinAadhaarImage || o.kyc?.documentImage || checkinMap[o.loginId]?.ownerKyc?.aadhaarImage || '',
                checkinCancelledCheque: o.checkinCancelledCheque || checkinMap[o.loginId]?.ownerKyc?.cancelledCheque || null,
                checkinOtpVerified: !!checkinMap[o.loginId]?.ownerKyc?.otpVerified,
                checkinSubmittedAt: checkinMap[o.loginId]?.ownerSubmittedAt || null,
                checkinTermsAcceptedAt: checkinMap[o.loginId]?.ownerTermsAcceptedAt || checkinMap[o.loginId]?.ownerSubmittedAt || o.createdAt || null,
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

        const mongoose = require('mongoose');
        const param = String(id || '').trim();
        const isObjId = mongoose.Types.ObjectId.isValid(param) && param.match(/^[0-9a-fA-F]{24}$/);
        const query = isObjId 
            ? { $or: [{ _id: param }, { loginId: param.toUpperCase() }, { loginId: param }] }
            : { $or: [{ loginId: param.toUpperCase() }, { loginId: param }] };

        const owner = await Owner.findOne(query);
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
            status: 'pending_approval',
            isEmployeeSubmitted: true,
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
        const password = req.body.password || 'Roomhy@123';

        const mongoose = require('mongoose');
        const param = String(loginId || '').trim();
        const isObjId = mongoose.Types.ObjectId.isValid(param) && param.match(/^[0-9a-fA-F]{24}$/);
        const query = isObjId 
            ? { $or: [{ _id: param }, { loginId: param.toUpperCase() }, { loginId: param }] }
            : { $or: [{ loginId: param.toUpperCase() }, { loginId: param }] };

        const owner = await Owner.findOne(query);
        if (!owner) return res.status(404).json({ message: 'Owner not found' });

        // Verify KYC submission before approval
        const hasKyc = Boolean(
            owner.kycStatus === 'verified' ||
            (owner.kyc?.status && owner.kyc.status !== 'pending' && owner.kyc.status !== 'requested') ||
            owner.checkinSubmittedAt ||
            owner.checkinAadhaarNumber ||
            owner.kyc?.aadhaarNumber ||
            owner.checkinOwnerPhoto
        );

        if (!hasKyc && req.body.overrideKyc !== true) {
            return res.status(400).json({ success: false, message: 'KYC submission is required before approving this owner account.' });
        }

        // Set credentials and activate owner
        owner.credentials = { password, firstTime: true };
        owner.checkinPassword = password;
        owner.kyc = owner.kyc || {};
        owner.kyc.status = 'verified';
        owner.kycStatus = 'verified';
        owner.isActive = true;
        owner.status = 'approved';
        await owner.save();

        // Sync User model if exists
        try {
            const User = require('../models/user');
            await User.updateOne(
                { $or: [{ loginId: owner.loginId }, { email: owner.email }] },
                { $set: { isActive: true, status: 'active', requirePasswordReset: false } }
            );
        } catch (uErr) {
            console.warn('Sync User on owner approve warning:', uErr.message);
        }

        // Send credentials email
        if (owner.email) {
            try {
                const mailer = require('../utils/mailer');
                const APP_URL = process.env.APP_URL || process.env.CLIENT_APP_URL || 'https://app.roomhy.com';
                const loginLink = `${APP_URL}/propertyowner/ownerlogin`;

                const subject = "Welcome to Roomhy — Your Property Owner Login Credentials";
                const html = `
                  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 12px; padding: 24px; background: #ffffff;">
                    <h2 style="color: #0f172a; margin-top: 0;">Congratulations! Your Roomhy Owner Account is Approved</h2>
                    <p style="color: #475569; font-size: 14px;">Dear ${owner.name || 'Property Owner'},</p>
                    <p style="color: #475569; font-size: 14px;">Your Property Owner account on Roomhy has been approved by Superadmin. You can now log in to manage your properties, rooms, and view tenant rent collections.</p>
                    <div style="background: #f8fafc; padding: 16px; border-radius: 8px; border: 1px solid #cbd5e1; margin: 20px 0;">
                      <p style="margin: 4px 0; font-size: 14px;"><strong>Login ID:</strong> <code style="color: #2563eb; font-weight: bold;">${owner.loginId}</code></p>
                      <p style="margin: 4px 0; font-size: 14px;"><strong>Password:</strong> <code style="color: #2563eb; font-weight: bold;">${password}</code></p>
                    </div>
                    <div style="text-align: center; margin-top: 24px;">
                      <a href="${loginLink}" style="display: inline-block; background: #0f172a; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 14px;">Log In to Owner Portal</a>
                    </div>
                  </div>
                `;

                await mailer.sendMail(owner.email, subject, '', html);
                console.log(`✉️ Credentials email sent to ${owner.email} for approved Owner ${owner.loginId}`);
            } catch (mailErr) {
                console.warn('❌ Failed to send credentials email for approved Owner:', mailErr.message);
            }
        }

        res.json({ success: true, message: 'Owner request approved and credentials sent to email.', owner });
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

        // Fallback: read bank, phone, address, location & occupancy fields from VisitData if Owner checkin fields are missing
        const VisitData = require('../models/VisitData');
        const visitForBank = await VisitData.findOne({
            $or: [
                { 'generatedCredentials.loginId': normalizedLoginId },
                { visitId: normalizedLoginId }
            ]
        }).sort({ updatedAt: -1 }).lean();

        const checkin = await CheckinRecord.findOne({ role: 'owner', loginId: normalizedLoginId }).lean();
        const primaryProperty = await Property.findOne({ ownerLoginId: normalizedLoginId })
            .sort({ createdAt: 1 })
            .select('title locationCode')
            .lean();

        const visitPhone = visitForBank?.ownerPhone || visitForBank?.visitorPhone || visitForBank?.contactPhone || '';
        const visitAddress = visitForBank?.address || visitForBank?.fullAddress || '';
        const visitArea = visitForBank?.area || visitForBank?.areaLocality || visitForBank?.city || '';
        const visitEmail = visitForBank?.ownerEmail || visitForBank?.visitorEmail || '';
        const visitName = visitForBank?.ownerName || visitForBank?.visitorName || '';

        const checkinBankName = owner.checkinBankName || checkin?.ownerProfile?.payment?.bankName || owner.bankName || visitForBank?.bankName || '';
        const checkinBranchName = owner.checkinBranchName || checkin?.ownerProfile?.payment?.branchName || owner.branchName || visitForBank?.bankBranchName || '';
        const checkinBankAccountNumber = owner.checkinBankAccountNumber || checkin?.ownerProfile?.payment?.bankAccountNumber || visitForBank?.bankAccountNumber || '';
        const checkinIfscCode = owner.checkinIfscCode || checkin?.ownerProfile?.payment?.ifscCode || visitForBank?.bankIfscCode || '';
        const checkinAccountHolderName = owner.checkinAccountHolderName || checkin?.ownerProfile?.payment?.accountHolderName || visitForBank?.bankAccountHolderName || visitName || '';
        const checkinUpiId = owner.checkinUpiId || checkin?.ownerProfile?.payment?.upiId || visitForBank?.bankUpiId || '';
        const bankLockedByVisit = !!owner.bankLockedByVisit || !!(visitForBank?.bankName || visitForBank?.bankAccountNumber);
        const phoneLockedByVisit = !!visitPhone;

        const vacantRooms = Number(owner.vacantRooms ?? visitForBank?.vacantRooms ?? 0);
        const occupiedRooms = Number(owner.occupiedRooms ?? visitForBank?.occupiedRooms ?? 0);
        const vacantBeds = Number(owner.vacantBeds ?? visitForBank?.vacantBeds ?? (vacantRooms * 1));
        const occupiedBeds = Number(owner.occupiedBeds ?? visitForBank?.occupiedBeds ?? (occupiedRooms * 1));

        res.json({
            ...owner,
            propertyTitle: primaryProperty?.title || visitForBank?.propertyName || '',
            propertyName: primaryProperty?.title || visitForBank?.propertyName || '',
            propertyLocationCode: primaryProperty?.locationCode || visitArea || '',
            name: owner.profile?.name || owner.name || visitName || 'Unknown',
            email: owner.profile?.email || owner.email || owner.checkinEmail || visitEmail || (checkin?.ownerProfile?.email || ''),
            phone: owner.profile?.phone || owner.phone || owner.checkinPhone || visitPhone || (checkin?.ownerProfile?.phone || ''),
            address: owner.profile?.address || owner.address || owner.checkinAddress || visitAddress || (checkin?.ownerProfile?.address || ''),
            locationCode: owner.profile?.locationCode || owner.locationCode || owner.checkinArea || visitArea || (checkin?.ownerProfile?.area || ''),
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
            checkinEmail: owner.checkinEmail || checkin?.ownerProfile?.email || owner.email || visitEmail || '',
            checkinPhone: owner.checkinPhone || checkin?.ownerProfile?.phone || owner.phone || visitPhone || '',
            checkinAddress: owner.checkinAddress || checkin?.ownerProfile?.address || owner.address || visitAddress || '',
            checkinArea: owner.checkinArea || checkin?.ownerProfile?.area || owner.locationCode || visitArea || '',
            checkinAccountHolderName,
            checkinBankAccountNumber,
            checkinIfscCode,
            checkinBankName,
            checkinBranchName,
            checkinUpiId,
            vacantRooms,
            occupiedRooms,
            vacantBeds,
            occupiedBeds,
            roomTypes: (owner.roomTypes && owner.roomTypes.length) ? owner.roomTypes : ((primaryProperty && primaryProperty.roomTypes && primaryProperty.roomTypes.length) ? primaryProperty.roomTypes : ((approvedProperty && approvedProperty.roomTypes && approvedProperty.roomTypes.length) ? approvedProperty.roomTypes : (visitForBank?.roomTypes || []))),
            bankLockedByVisit,
            phoneLockedByVisit,
            checkinAadhaarLinkedPhone: owner.checkinAadhaarLinkedPhone || checkin?.ownerKyc?.aadhaarLinkedPhone || owner.kyc?.aadhaarLinkedPhone || visitPhone || '',
            checkinOwnerPhoto: owner.checkinOwnerPhoto || checkin?.ownerKyc?.ownerPhoto || '',
            checkinOwnerPhotoName: owner.checkinOwnerPhotoName || '',
            checkinOwnerPhotoType: owner.checkinOwnerPhotoType || '',
            checkinBankProof: owner.checkinBankProof || checkin?.ownerKyc?.bankProof || '',
            checkinBankProofName: owner.checkinBankProofName || '',
            checkinBankProofType: owner.checkinBankProofType || '',
            checkinAadhaarImage: owner.checkinAadhaarImage || owner.kyc?.documentImage || checkin?.ownerKyc?.aadhaarImage || '',
            checkinAadhaarImageName: owner.checkinAadhaarImageName || '',
            checkinAadhaarImageType: owner.checkinAadhaarImageType || '',
            documentImage: owner.kyc?.documentImage || owner.checkinAadhaarImage || checkin?.ownerKyc?.aadhaarImage || '',
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
            checkinTermsAcceptedAt: checkin?.ownerTermsAcceptedAt || checkin?.ownerSubmittedAt || owner.createdAt || null,
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

        // Rent invoice and payment record will be created when tenant completes payment / cash OTP verification

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

