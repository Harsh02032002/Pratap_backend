// Get properties for an owner
exports.getOwnerProperties = async (req, res) => {
    try {
        const ownerLoginId = req.params.loginId;
        const properties = await Property.find({ ownerLoginId }).lean();
        res.json({ properties });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// Get rooms for an owner
exports.getOwnerRooms = async (req, res) => {
    try {
        const ownerLoginId = req.params.loginId;
        const properties = await Property.find({ ownerLoginId }).lean();
        const propertyIds = properties.map(p => p._id);
        const rooms = await require('../models/Room').find({ property: { $in: propertyIds } }).lean();
        res.json({ rooms });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// Get tenants for an owner
exports.getOwnerTenants = async (req, res) => {
    try {
        const ownerLoginId = req.params.loginId;
        const properties = await Property.find({ ownerLoginId }).lean();
        const propertyIds = properties.map(p => p._id);
        const tenants = await require('../models/Tenant').find({ property: { $in: propertyIds } }).lean();
        res.json({ tenants });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// Get rent collected for an owner
exports.getOwnerRent = async (req, res) => {
    try {
        const ownerLoginId = req.params.loginId;
        const enquiries = await require('../models/Enquiry').find({ ownerLoginId, status: { $in: ['accepted', 'approved'] } }).lean();
        const totalRent = enquiries.reduce((sum, e) => sum + (e.paidAmount || 0), 0);
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

// List Owners with Filtering (Area, KYC Status)
exports.getAllOwners = async (req, res) => {
    try {
        const { locationCode, kycStatus, search } = req.query;
        let query = {};

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

        // Search
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { loginId: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
                { 'profile.name': { $regex: search, $options: 'i' } }
            ];
        }

        const owners = await Owner.find(query).sort({ createdAt: -1 }).lean();

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

        // ✅ NEW: Ensure all owners have merged profile data at top level for easy frontend access
        const checkins = ownerLoginIds.length > 0
            ? await CheckinRecord.find({ role: 'owner', loginId: { $in: ownerLoginIds } }).lean()
            : [];
        const checkinMap = {};
        checkins.forEach(c => { checkinMap[c.loginId] = c; });

        const enrichedOwners = owners.map(o => ({
            ...o,
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
            kycStatus: o.kyc?.status || 'pending',
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
        }));

        res.json({ success: true, owners: enrichedOwners });
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
            status: function(code) {
                this.statusCode = code;
                return this;
            },
            json: function(data) {
                tenantResponse = { statusCode: this.statusCode || 200, data };
                return this;
            }
        };

        // Import and call tenant assignment
        const tenantController = require('./tenantController');
        
        // Create a custom response handler
        await new Promise((resolve, reject) => {
            const originalJson = mockRes.json;
            mockRes.json = function(data) {
                tenantResponse = { statusCode: this.statusCode || 200, data };
                resolve();
                return this;
            };
            mockRes.status = function(code) {
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
