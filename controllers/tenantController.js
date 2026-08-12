const Tenant = require('../models/Tenant');
const User = require('../models/user');
const Property = require('../models/Property');
const Owner = require('../models/Owner');
const Rent = require('../models/Rent');
const Room = require('../models/Room');
const generateTenantId = require('../utils/generateTenantId');
const crypto = require('crypto');
const mailer = require('../utils/mailer');
const { sendTemplateToResolvedUser } = require('../utils/whatsappBot');
const { enrichTenantsWithDues } = require('../services/tenantDuesService');
const { validateDocumentType } = require('../utils/documentValidator');

/**
 * Approve or reject tenant KYC verification
 * POST /api/tenants/:tenantId/kyc-verification
 * Body: { action: 'approve' | 'reject', reason?: string }
 */
exports.verifyTenantKYC = async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { action, reason } = req.body;

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({ success: false, message: 'Invalid action' });
        }

        const tenant = await Tenant.findById(tenantId);
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found' });
        }

        // Compare tenant-submitted KYC data with admin-entered data
        const adminData = tenant.kycVerificationData || {};
        const tenantData = tenant.digitalCheckin?.kyc || {};
        
        const mismatches = [];
        
        // Compare name
        if (adminData.adminEnteredName && tenant.digitalCheckin?.profile?.name) {
            if (adminData.adminEnteredName.toLowerCase() !== tenant.digitalCheckin.profile.name.toLowerCase()) {
                mismatches.push({
                    field: 'name',
                    admin: adminData.adminEnteredName,
                    tenant: tenant.digitalCheckin.profile.name
                });
            }
        }
        
        // Compare Aadhaar number
        if (adminData.adminEnteredAadhaar && tenantData.aadhaarNumber) {
            if (adminData.adminEnteredAadhaar !== tenantData.aadhaarNumber) {
                mismatches.push({
                    field: 'aadhaar',
                    admin: adminData.adminEnteredAadhaar,
                    tenant: tenantData.aadhaarNumber
                });
            }
        }
        
        // Compare phone
        if (adminData.adminEnteredPhone && tenant.aadhaarLinkedPhone) {
            if (adminData.adminEnteredPhone !== tenant.aadhaarLinkedPhone) {
                mismatches.push({
                    field: 'phone',
                    admin: adminData.adminEnteredPhone,
                    tenant: tenant.aadhaarLinkedPhone
                });
            }
        }

        if (action === 'approve') {
            tenant.kycStatus = 'verified';
            // Status remains 'pending' until onboarding payment is completed
            
            // Send notification to tenant
            try {
                const Notification = require('../models/Notification');
                await Notification.create({
                    type: 'kyc_approved',
                    title: 'KYC Verification Approved',
                    message: 'Your KYC has been verified and approved. You can now access your account.',
                    recipientId: tenant.user,
                    recipientType: 'tenant',
                    tenantId: tenant._id,
                    createdAt: new Date(),
                    isRead: false
                });
            } catch (notifErr) {
                console.error('[NOTIFICATION ERROR] Failed to send KYC approval notification:', notifErr && notifErr.message);
            }
        } else {
            tenant.kycStatus = 'rejected';
            
            // Send notification to tenant with rejection reason
            try {
                const Notification = require('../models/Notification');
                await Notification.create({
                    type: 'kyc_rejected',
                    title: 'KYC Verification Rejected',
                    message: `Your KYC verification was rejected. ${reason || 'Please contact support for more information.'}`,
                    recipientId: tenant.user,
                    recipientType: 'tenant',
                    tenantId: tenant._id,
                    rejectionReason: reason,
                    createdAt: new Date(),
                    isRead: false
                });
            } catch (notifErr) {
                console.error('[NOTIFICATION ERROR] Failed to send KYC rejection notification:', notifErr && notifErr.message);
            }
        }

        // Store verification result
        tenant.kycVerificationResult = {
            action,
            verifiedBy: req.user ? req.user.id : null,
            verifiedAt: new Date(),
            mismatches: mismatches.length > 0 ? mismatches : null,
            reason: action === 'reject' ? reason : null
        };

        await tenant.save();

        res.json({
            success: true,
            message: action === 'approve' ? 'Tenant KYC approved successfully' : 'Tenant KYC rejected',
            tenant: {
                id: tenant._id,
                name: tenant.name,
                kycStatus: tenant.kycStatus,
                status: tenant.status,
                mismatches: mismatches.length > 0 ? mismatches : undefined
            }
        });
    } catch (error) {
        console.error('[KYC VERIFICATION ERROR]', error);
        res.status(500).json({ success: false, message: 'Failed to process KYC verification' });
    }
};

/**
 * Assign a tenant to a room
 * POST /api/tenants/assign
 * Body: { name, phone, email, propertyId, roomNo, bedNo, moveInDate, agreedRent }
 */
exports.assignTenant = async (req, res) => {
    try {
        const {
            name, phone, email, propertyId, roomNo, bedNo, moveInDate, agreedRent,
            ownerLoginId, propertyTitle, locationCode,
            dob, gender, building, floor, rentAgreementType,
            paymentFrequency, additional, idProof,
            securityDepositTotal, securityDepositPaid, securityDepositBalance,
            electricityCharge, maintenanceCharge,
            minStay, noticePeriod, rentDueDate, accommodationType, lateFee,
            licenseDuration, moveOutCharges, noticePeriodCharges, inclusions, gstCharges, advanceCharge,
            propertyAddress, permanentAddress,
            noAadhaar, alternateProofType, alternateProofFile
        } = req.body;

        // Alternate ID proof path: the tenant never gets the Aadhaar-OTP link,
        // so a superadmin-reviewable proof document must be present — silently
        // falling back to the OTP email would strand exactly the tenants this
        // path exists for.
        const useAlternateProof = Boolean(noAadhaar);
        if (useAlternateProof && !(alternateProofType && alternateProofFile)) {
            return res.status(400).json({
                success: false,
                message: 'An alternate ID proof type and document are required when the tenant has no Aadhaar.'
            });
        }

        const advanceChargeAmount = Math.max(0, parseInt(advanceCharge, 10) || 0);

        let depositTotal = Math.max(0, parseInt(securityDepositTotal, 10) || 0);
        const depositPaid = Math.max(0, parseInt(securityDepositPaid, 10) || 0);
        const explicitDepositBalance = parseInt(securityDepositBalance, 10);
        let depositBalance = Math.max(0, Number.isFinite(explicitDepositBalance) ? explicitDepositBalance : (depositTotal - depositPaid));
        const electricityChargeAmount = Math.max(0, parseInt(electricityCharge, 10) || 0);
        const maintenanceChargeAmount = Math.max(0, parseInt(maintenanceCharge, 10) || 0);
        // Normalize bedNo: accept "1", 1, "Bed 1", "bed1" → numeric string "1"
        const normalizedBedNo = bedNo != null
            ? String(bedNo).trim().replace(/^[Bb]ed\s*/i, '') || null
            : null;

        let assignedPropertyTitle = String(propertyTitle || '').trim();

        const normalizedOwnerLoginId = String(ownerLoginId || '').toUpperCase();
        if (normalizedOwnerLoginId) {
            const ownerProfile = await Owner.findOne({ loginId: normalizedOwnerLoginId })
                .select('checkinUpiId profile')
                .lean();
            const ownerUpiId = String(ownerProfile?.checkinUpiId || ownerProfile?.profile?.upiId || '').trim();
            if (!ownerUpiId) {
                return res.status(400).json({
                    success: false,
                    message: 'Owner UPI details are missing. Please complete owner profile payment details before assigning a tenant.'
                });
            }
        }

        // Validation
        const requiredFields = {
            name, phone, email, propertyId, roomNo, agreedRent
        };

        const missing = Object.entries(requiredFields)
            .filter(([_, v]) => !v)
            .map(([k]) => k);

        if (missing.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Missing required fields: ${missing.join(', ')}`
            });
        }

        // Document type validation - check if uploaded document matches selected type
        if (idProof && idProof.type && idProof.file) {
            console.log('[DOCUMENT VALIDATION] Validating document type:', idProof.type);
            const validation = await validateDocumentType(idProof.file, idProof.type);
            
            if (!validation.valid) {
                console.log('[DOCUMENT VALIDATION] Failed:', validation.message);
                return res.status(400).json({
                    success: false,
                    message: validation.message,
                    detectedType: validation.detectedType
                });
            }
            console.log('[DOCUMENT VALIDATION] Passed:', validation.message);
        }

        // Indian mobile number validation: must be 10 digits starting with 6-9
        const phoneClean = String(phone || '').replace(/\D/g, '');
        if (!/^[6-9]\d{9}$/.test(phoneClean)) {
            return res.status(400).json({ success: false, message: 'Please enter a valid mobile number' });
        }
        if (additional?.emergencyPhone) {
            const emergencyClean = String(additional.emergencyPhone).replace(/\D/g, '');
            if (!/^[6-9]\d{9}$/.test(emergencyClean)) {
                return res.status(400).json({ success: false, message: 'Please enter a valid guardian mobile number' });
            }
        }

        // Additional validation for emergency contact (optional for owner panel)
        const hasEmergencyInfo = additional && additional.emergencyName && additional.emergencyPhone && additional.relationship;

        // If it's a superadmin request (usually has building/floor), we can be stricter, 
        // but for now let's just make it optional to avoid breaking the owner flow.

        // Resolve property. If raw propertyId is not a Mongo id, fallback by owner/title.
        let property = null;
        if (propertyId && /^[a-f\d]{24}$/i.test(String(propertyId).trim())) {
            try {
                property = await Property.findById(String(propertyId).trim()).populate('owner');
            } catch (e) {
                // continue to fallback resolution
                property = null;
            }
        }

        if (!property && ownerLoginId) {
            const normalizedOwnerId = String(ownerLoginId).toUpperCase();
            // Prefer exact property title match from assignment payload first.
            if (propertyTitle) {
                property = await Property.findOne({
                    ownerLoginId: normalizedOwnerId,
                    title: { $regex: `^${String(propertyTitle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
                }).populate('owner');
            }
            if (!property) {
                property = await Property.findOne({ ownerLoginId: normalizedOwnerId }).populate('owner');
            }
        }

        if (!assignedPropertyTitle && ownerLoginId) {
            const ownerProfile = await Owner.findOne({ loginId: String(ownerLoginId).toUpperCase() })
                .select('propertyTitle propertyName')
                .lean();
            assignedPropertyTitle = String(
                assignedPropertyTitle ||
                property?.title ||
                ownerProfile?.propertyTitle ||
                ownerProfile?.propertyName ||
                ''
            ).trim();
        }

        if (!property) {
            // Last fallback: create a minimal property so tenant assignment can proceed.
            const normalizedOwnerId = String(ownerLoginId || '').toUpperCase();
            const derivedLocationCode = String(locationCode || normalizedOwnerId.slice(0, 3) || 'GEN').toUpperCase();
            const derivedTitle = assignedPropertyTitle || `Property ${normalizedOwnerId || 'GEN'}`;
            property = await Property.create({
                title: derivedTitle,
                locationCode: derivedLocationCode,
                ownerLoginId: normalizedOwnerId || undefined,
                status: 'active'
            });
            property = await Property.findById(property._id).populate('owner');
        }

        // Get location code from property
        const effectiveLocationCode = property.locationCode || String(locationCode || '').toUpperCase() || 'GEN';
        assignedPropertyTitle = String(assignedPropertyTitle || property.title || '').trim();

        if (!depositTotal && property) {
            const propDep = parseInt(property.pricing?.securityDeposit || property.securityDeposit, 10) || 0;
            if (propDep > 0) depositTotal = propDep;
        }
        depositBalance = Math.max(0, Number.isFinite(explicitDepositBalance) ? explicitDepositBalance : (depositTotal - depositPaid));

        // Find Room record if exists
        let roomObj = null;
        if (property && roomNo) {
            roomObj = await Room.findOne({
                property: property._id,
                title: { $regex: `^${String(roomNo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
            });

            if (roomObj && normalizedBedNo) {
                const bIndex = Number(normalizedBedNo) - 1;
                // Ensure array exists
                if (!roomObj.bedAssignments) {
                    roomObj.bedAssignments = [];
                }
                while (roomObj.bedAssignments.length <= bIndex) {
                    roomObj.bedAssignments.push({});
                }
                if (roomObj.bedAssignments[bIndex] && roomObj.bedAssignments[bIndex].tenantId) {
                    return res.status(400).json({ success: false, message: `Bed ${normalizedBedNo} in Room ${roomNo} is already occupied by another tenant.` });
                }
            }

            // Also guard against stale bedAssignments: check Tenant collection directly
            const activeTenantQuery = { property: property._id, roomNo, isDeleted: { $ne: true }, status: { $ne: 'inactive' } };
            if (normalizedBedNo) activeTenantQuery.bedNo = normalizedBedNo;
            const existingActiveTenant = await Tenant.findOne(activeTenantQuery).select('_id name').lean();
            if (existingActiveTenant) {
                return res.status(400).json({
                    success: false,
                    message: `Room ${roomNo}${normalizedBedNo ? `, Bed ${normalizedBedNo}` : ''} already has an active tenant (${existingActiveTenant.name}). Move them out first.`
                });
            }
        }

        // Generate unique tenant login ID
        const loginId = await generateTenantId();

        // Generate temporary password (8 chars: mix of alphanumeric)
        const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();

        // Create User record for tenant (role: 'tenant', inactive until payment)
        const user = await User.create({
            name,
            email,
            phone,
            password: tempPassword, // Will be hashed by pre-save hook
            role: 'tenant',
            loginId,
            locationCode: effectiveLocationCode,
            status: 'pending',
            isActive: false,
            requirePasswordReset: true
        });

        // Create Tenant record
        const tenant = await Tenant.create({
            name,
            phone,
            email,
            dob,
            gender,
            property: property._id,
            room: roomObj ? roomObj._id : undefined,
            roomNo,
            building,
            floor,
            bedNo: normalizedBedNo,
            moveInDate: moveInDate ? new Date(moveInDate) : null,
            baseRoomRent: parseInt(req.body.baseRoomRent) || parseInt(agreedRent),
            agreedRent: parseInt(agreedRent),
            rentAgreementType,
            paymentFrequency,
            occupation: additional?.occupation,
            company: additional?.company,
            emergencyContact: {
                name: additional?.emergencyName,
                phone: additional?.emergencyPhone,
                relationship: additional?.relationship
            },
            remarks: additional?.remarks,
            advanceChargeAmount: advanceChargeAmount,
            loginId,
            tempPassword, // Store for now; will be displayed once, then forgotten
            user: user._id,
            securityDepositTotal: depositTotal,
            securityDepositPaid: depositPaid > 0 ? depositPaid : depositTotal,
            securityDepositBalance: depositPaid > 0 ? Math.max(0, depositTotal - depositPaid) : 0,
            electricityCharge: electricityChargeAmount,
            maintenanceCharge: maintenanceChargeAmount,
            kyc: {
                idProof: idProof?.type || '',
                idProofFile: idProof?.file || '',
                aadhaarNumber: (idProof?.type === 'Aadhaar Card' ? idProof?.number : ''),
                aadhar: (idProof?.type === 'Aadhaar Card' ? idProof?.number : ''),
                aadhaarFront: (idProof?.type === 'Aadhaar Card' ? idProof?.file : ''),
                // Store Aadhaar OCR data for verification
                aadhaarData: idProof?.aadhaarData || null,
                fatherName: additional?.fatherName || '',
                permanentAddress: additional?.permanentAddress || '',
                noAadhaar: useAlternateProof,
                alternateProofType: useAlternateProof ? alternateProofType : '',
                alternateProofFile: useAlternateProof ? alternateProofFile : ''
            },
            kycStatus: 'pending', // Always pending upon creation until tenant completes digital check-in
            kycVerificationData: {
                // Store data from Add Tenant for comparison during tenant KYC
                adminEnteredName: name,
                adminEnteredFatherName: additional?.fatherName || '',
                adminEnteredAddress: additional?.permanentAddress || '',
                adminEnteredDob: dob,
                adminEnteredAadhaar: idProof?.number || '',
                adminEnteredPhone: phone
            },
            ownerLoginId: String(ownerLoginId || property.ownerLoginId || '').toUpperCase() || undefined,
            propertyTitle: assignedPropertyTitle || property.title || '',
            assignedBy: req.user ? req.user.id : (property.owner && property.owner._id ? property.owner._id : undefined),
            status: 'pending', // Always pending upon creation until onboarding payment is completed
            digitalCheckin: {
                agreementDetails: {
                    ...(accommodationType && { accommodationType }),
                    ...(minStay && { minimumStayDuration: `${minStay} Months` }),
                    ...(noticePeriod && { noticePeriodDays: noticePeriod }),
                    ...(rentDueDate && { licenseFeeDueDate: rentDueDate }),
                    ...(lateFee && { lateFee }),
                    ...(licenseDuration && { licenseDuration: `${licenseDuration} months` }),
                    ...(moveOutCharges != null && { moveOutCharges }),
                    ...(noticePeriodCharges != null && { noticePeriodCharges }),
                    ...(inclusions && { inclusions }),
                    ...(gstCharges != null && { gstCharges }),
                    ...(advanceCharge != null && { advanceCharge: advanceChargeAmount }),
                    ...(propertyAddress && { propertyAddress }),
                    ...(permanentAddress && { permanentAddress }),
                    securityDeposit: depositTotal || 0
                }
            }
        });

        // Queue the alternate ID proof for superadmin review — approval is what
        // releases the agreement + payment link for this tenant.
        let alternateProofRequest = null;
        if (useAlternateProof) {
            const TenantKycRequest = require('../models/TenantKycRequest');
            alternateProofRequest = await TenantKycRequest.create({
                tenantId: tenant._id,
                ownerLoginId: tenant.ownerLoginId || String(ownerLoginId || property.ownerLoginId || '').toUpperCase(),
                tenantName: name,
                proofType: alternateProofType,
                proofFileUrl: alternateProofFile
            });
            console.log(`[TENANT KYC REQUEST] Alternate proof request ${alternateProofRequest._id} created for ${tenant.loginId}`);
        }

        // Populate for response (include locationCode and owner info)
        await tenant.populate('property', 'title roomType locationCode owner ownerLoginId');

        // Update Room's bed assignment & vacancy status
        if (roomObj) {
            if (!Array.isArray(roomObj.bedAssignments)) roomObj.bedAssignments = [];
            const bIndex = Math.max(0, Number(normalizedBedNo || 1) - 1);
            roomObj.bedAssignments[bIndex] = {
                tenantId: tenant._id,
                tenantName: tenant.name,
                tenantLoginId: tenant.loginId,
                assignedAt: new Date()
            };
            roomObj.markModified('bedAssignments');

            const totalBeds = roomObj.beds || 1;
            const occupiedCount = roomObj.bedAssignments.filter(b => b && (b.tenantId || b.tenantLoginId || b.tenantName)).length;
            roomObj.isAvailable = occupiedCount < totalBeds;
            await roomObj.save();

            // Recalculate and sync property bed/room counters
            try {
                const Room = require('../models/Room');
                const allPropertyRooms = await Room.find({ property: property._id, isDeleted: false });
                let totalPropertyBeds = 0;
                let occupiedPropertyBeds = 0;
                let occupiedRoomsCount = 0;
                let totalRoomsCount = allPropertyRooms.length;

                allPropertyRooms.forEach(r => {
                    const rTotal = r.beds || 1;
                    const rOcc = (r.bedAssignments || []).filter(b => b && (b.tenantId || b.tenantLoginId || b.tenantName)).length;
                    totalPropertyBeds += rTotal;
                    occupiedPropertyBeds += rOcc;
                    if (rOcc > 0) occupiedRoomsCount++;
                });

                const vacantPropertyBeds = Math.max(0, totalPropertyBeds - occupiedPropertyBeds);
                const vacantRoomsCount = Math.max(0, totalRoomsCount - occupiedRoomsCount);

                if (property.propertyInfo) {
                    property.propertyInfo.occupiedBeds = occupiedPropertyBeds;
                    property.propertyInfo.vacantBeds = vacantPropertyBeds;
                    property.propertyInfo.occupiedRooms = occupiedRoomsCount;
                    property.propertyInfo.vacantRooms = vacantRoomsCount;
                    property.markModified('propertyInfo');
                    await property.save();
                }

                const ApprovedProperty = require('../models/ApprovedProperty');
                await ApprovedProperty.updateOne(
                    { $or: [{ _id: property._id }, { visitId: property.visitId }] },
                    {
                        $set: {
                            'propertyInfo.occupiedBeds': occupiedPropertyBeds,
                            'propertyInfo.vacantBeds': vacantPropertyBeds,
                            'propertyInfo.occupiedRooms': occupiedRoomsCount,
                            'propertyInfo.vacantRooms': vacantRoomsCount,
                            occupiedBeds: occupiedPropertyBeds,
                            vacantBeds: vacantPropertyBeds,
                            occupiedRooms: occupiedRoomsCount,
                            vacantRooms: vacantRoomsCount
                        }
                    }
                ).catch(() => {});
            } catch (syncErr) {
                console.warn('Property bed counter sync error:', syncErr.message);
            }
        }

        // Create Rent record for this tenant
        const rentAmount = parseInt(agreedRent);
        const rentPropertyName = assignedPropertyTitle || property.title || 'Property';
        const collectionMonth = new Date().toISOString().slice(0, 7);

        let rent = await Rent.findOne({ tenantLoginId: loginId, collectionMonth });

        if (!rent) {
            const advChargeNum = Number(advanceChargeAmount || 0);
            rent = await Rent.create({
                propertyName: rentPropertyName,
                roomNumber: roomNo,
                area: property.area || '-',
                tenantName: name,
                tenantEmail: email,
                tenantPhone: phone,
                tenantLoginId: loginId,
                rentAmount: rentAmount,
                advanceChargeAmount: advChargeNum,
                totalDue: rentAmount + advChargeNum,
                paidAmount: 0,
                paymentStatus: 'pending',
                moveInDate: moveInDate ? new Date(moveInDate) : new Date(),
                dueDate: moveInDate ? new Date(moveInDate) : new Date(),
                collectionMonth: collectionMonth,
                createdAt: new Date()
            });
            console.log(`[RENT RECORD CREATED] Rent ID: ${rent._id}, Rent: ₹${rentAmount}, Advance Charge: ₹${advChargeNum}, Total Due: ₹${rentAmount + advChargeNum}`);
        } else {
            console.log(`[RENT ALREADY EXISTS] Skipped duplicate rent generation for ${loginId} in ${collectionMonth}`);
        }

        // Rent invoice and payment record will be created when tenant completes payment / cash OTP verification

        // Log notification for super admin
        console.log(`[TENANT ASSIGNED] ${name} (${loginId}) assigned to ${rentPropertyName}, Room ${roomNo}`);

        // Send notification to owner about new tenant requiring KYC verification
        try {
            const ownerLoginId = property?.ownerLoginId || property?.owner_id || (property?.owner && typeof property.owner === 'string' ? property.owner : '');
            const ownerNotification = {
                toRole: 'owner',
                toLoginId: String(ownerLoginId || '').toUpperCase(),
                from: String(tenant.loginId || 'system'),
                type: 'kyc_verification_required',
                title: 'New Tenant KYC Verification Required',
                message: `Tenant ${name} has been assigned to Room ${roomNo} in ${rentPropertyName}. Please review their KYC details and approve/reject.`,
                meta: {
                    tenantId: tenant._id,
                    tenantName: tenant.name,
                    propertyName: rentPropertyName,
                    roomNo: roomNo,
                    kycData: {
                        adminEntered: {
                            name: name,
                            fatherName: additional?.fatherName || '',
                            address: additional?.permanentAddress || '',
                            aadhaar: idProof?.number || '',
                            phone: phone
                        },
                        aadhaarOCR: idProof?.aadhaarData || null
                    }
                },
                createdAt: new Date(),
                read: false
            };
            
            const Notification = require('../models/Notification');
            await Notification.create(ownerNotification);
            console.log(`[NOTIFICATION] KYC verification notification sent to owner for tenant ${tenant.loginId}`);
        } catch (notifErr) {
            console.error('[NOTIFICATION ERROR] Failed to send KYC verification notification:', notifErr && notifErr.message);
        }

        // Send email to tenant with loginId and digital check-in link (NO PASSWORD - will be sent after payment)
        const baseWebUrl = process.env.DIGITAL_CHECKIN_URL || process.env.APP_BASE_URL || process.env.APP_URL || process.env.FRONTEND_URL || 'https://app.roomhy.com';
        const tenantCheckinLink = `${baseWebUrl}/digital-checkin/tenantprofile?loginId=${encodeURIComponent(tenant.loginId)}`;
        // Alternate-proof tenants can never clear the Aadhaar OTP step, so the
        // check-in invite is suppressed — superadmin approval of their proof
        // sends them the agreement and payment link instead.
        const sendCheckinInvite = !useAlternateProof;
        try {
            if (sendCheckinInvite && tenant.email) {
                console.log(`[MAIL] Attempting to send KYC link to ${tenant.email}`);
                const subject = 'Your RoomHy Tenant ID - Complete Digital KYC';
                const html = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        .email-container { font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333; background-color: #f8fafc; padding: 20px; border-radius: 12px; }
        .header { background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%); padding: 30px; border-radius: 12px 12px 0 0; text-align: center; color: white; }
        .header h1 { margin: 0; font-size: 24px; font-weight: 700; }
        .content { background: white; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6 -1px rgba(0, 0, 0, 0.1); }
        .success-badge { display: inline-block; background: #f0fdf4; color: #166534; padding: 4px 12px; border-radius: 99px; font-size: 12px; font-weight: 600; margin-bottom: 16px; }
        .detail-item { margin-bottom: 12px; }
        .detail-label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
        .detail-value { font-size: 15px; font-weight: 600; color: #1e293b; }
        .bill-card { background: #1e293b; color: white; padding: 20px; border-radius: 12px; margin: 24px 0; }
        .bill-title { font-size: 16px; font-weight: 700; margin-top: 0; margin-bottom: 16px; color: #e2e8f0; border-bottom: 1px solid #334155; padding-bottom: 10px; }
        .bill-row { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .bill-label { color: #94a3b8; }
        .bill-value { font-weight: 600; color: #f8fafc; }
        .creds-section { border-top: 1px dashed #e2e8f0; padding-top: 20px; margin-top: 20px; }
        .login-box { background: #f1f5f9; padding: 16px; border-radius: 8px; margin: 12px 0; border: 1px solid #e2e8f0; }
        .cta-button { display: block; background: #7c3aed; color: white !important; text-align: center; padding: 14px; border-radius: 8px; text-decoration: none; font-weight: 700; margin-top: 24px; box-shadow: 0 4px 14px 0 rgba(124, 58, 237, 0.39); }
        .footer { text-align: center; margin-top: 24px; color: #94a3b8; font-size: 12px; }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="header">
            <h1>🏠 RoomHy</h1>
        </div>
        <div class="content">
            <div class="success-badge">Verification Pending ✓</div>
            <h2 style="margin-top: 0; color: #7c3aed; font-size: 20px;">Your Tenant Account Created</h2>
            <p style="color: #64748b; line-height: 1.5;">Your tenant account has been created successfully. Please complete your Digital KYC to proceed with onboarding.</p>
            
            <div style="background: #fdf4ff; padding: 16px; border-radius: 8px; border-left: 4px solid #a855f7; margin-bottom: 20px;">
                <div class="detail-item">
                    <div class="detail-label">Property</div>
                    <div class="detail-value">${assignedPropertyTitle || property.title || '-'}</div>
                </div>
                <div style="display: flex; gap: 40px;">
                    <div class="detail-item">
                        <div class="detail-label">Room Number</div>
                        <div class="detail-value">${roomNo || '-'}</div>
                    </div>
                    <div class="detail-item">
                        <div class="detail-label">Bed Number</div>
                        <div class="detail-value">${bedNo || '-'}</div>
                    </div>
                </div>
                <div class="detail-item" style="margin-bottom: 0;">
                    <div class="detail-label">Monthly Rent</div>
                    <div class="detail-value" style="color: #7c3aed; font-size: 18px;">INR ${parseInt(agreedRent || 0, 10)}</div>
                </div>
            </div>

            <div class="bill-card">
                <h4 class="bill-title">Security Deposit Bill</h4>
                <div class="bill-row">
                    <span class="bill-label">Total Deposit</span>
                    <span class="bill-value">INR ${depositTotal}</span>
                </div>
                <div class="bill-row">
                    <span class="bill-label">Paid Amount</span>
                    <span class="bill-value" style="color: #4ade80;">INR ${depositPaid}</span>
                </div>
                <div class="bill-row" style="margin-top: 10px; border-top: 1px solid #334155; padding-top: 10px;">
                    <span class="bill-label" style="color: #f8fafc; font-weight: 700;">Balance Due</span>
                    <span class="bill-value" style="color: #f87171; font-size: 16px;">INR ${depositBalance}</span>
                </div>
            </div>

            <div class="creds-section">
                <p style="margin-bottom: 8px; font-weight: 600; color: #1e293b;">Your Tenant ID:</p>
                <div class="login-box">
                    <div>
                        <span class="detail-label">Login ID:</span>
                        <span style="font-family: monospace; font-size: 16px; font-weight: 700; margin-left: 8px; color: #1e293b;">${tenant.loginId}</span>
                    </div>
                </div>
                <p style="font-size: 12px; color: #f59e0b; margin-top: 12px; font-weight: 600;">⚠️ Your password will be sent after completing payment.</p>
            </div>

            <p style="margin-top: 20px; font-size: 13px; color: #64748b; line-height: 1.5;">
                Please complete your profile, upload KYC documents, and e-sign the agreement to finalize your check-in:
            </p>
            
            <a href="${tenantCheckinLink}" class="cta-button">Complete Digital KYC</a>
            
            <p style="font-size: 11px; color: #94a3b8; margin-top: 20px; word-break: break-all; text-align: center;">
                If the button doesn't work, copy this link: <br>
                ${tenantCheckinLink}
            </p>
        </div>
        <div class="footer">
            <p>© 2026 RoomHy - Managed Living Made Simple</p>
            <p>This is an automated message, please do not reply.</p>
        </div>
    </div>
</body>
</html>
                `;
                const text = `Tenant account created.\nProperty: ${assignedPropertyTitle || property.title || '-'}\nRoom Number: ${roomNo || '-'}\nBed Number: ${bedNo || '-'}\nRent: INR ${parseInt(agreedRent || 0, 10)}\nSecurity Deposit Total: INR ${depositTotal}\nSecurity Deposit Paid: INR ${depositPaid}\nSecurity Deposit Balance: INR ${depositBalance}\nLogin ID: ${tenant.loginId}\nDigital Check-In: ${tenantCheckinLink}\n\nNote: Your password will be sent after completing payment.`;

                await mailer.sendMail(tenant.email, subject, text, html);
                console.log(`[MAIL] KYC link email sent successfully to ${tenant.email}`);
            }

            // Send WhatsApp to tenant's phone (the number owner entered during room allotment)
            console.log('[TENANT ALLOTMENT] tenant.phone=', tenant.phone, 'tenantCheckinLink=', tenantCheckinLink);
            if (!sendCheckinInvite) {
                console.log(`[TENANT ALLOTMENT] Alternate ID proof path — check-in invite suppressed for ${tenant.loginId}`);
            } else if (tenant.phone) {
                sendTemplateToResolvedUser({
                    phone: tenant.phone,
                    templateName: 'roomhy_kyc_pending',
                    options: {
                        namedParams: {
                            tenant_name: tenant.name || 'Tenant',
                            kyc_url: tenantCheckinLink
                        }
                    }
                }).then((sent) => {
                    console.log('[TENANT ALLOTMENT] WhatsApp kyc_pending sent=', sent, 'to phone=', tenant.phone);
                }).catch((err) => console.warn('[TENANT ALLOTMENT] WhatsApp failed:', err && err.message));
            } else {
                console.warn('[TENANT ALLOTMENT] No phone — skipping WhatsApp');
            }

            // Do NOT send password to owner yet - will be sent after payment completion
        } catch (err) {
            console.error('[MAIL ERROR] Failed to send tenant credentials:', err && err.message);
        }

        // For testing we still return credentials in response

        res.status(201).json({
            success: true,
            message: 'Tenant assigned successfully',
            tenant: {
                id: tenant._id,
                name: tenant.name,
                loginId: tenant.loginId,
                tempPassword: tenant.tempPassword, // Return once for display
                phone: tenant.phone,
                email: tenant.email,
                property: tenant.property,
                propertyTitle: tenant.propertyTitle || assignedPropertyTitle || property.title || '',
                ownerLoginId: tenant.ownerLoginId || '',
                roomNo: tenant.roomNo,
                bedNo: tenant.bedNo,
                moveInDate: tenant.moveInDate,
                agreedRent: tenant.agreedRent,
                securityDepositTotal: tenant.securityDepositTotal,
                securityDepositPaid: tenant.securityDepositPaid,
                securityDepositBalance: tenant.securityDepositBalance,
                depositAmount: tenant.securityDepositTotal
            },
            tenantCheckinLink,
            kycMode: useAlternateProof ? 'alternate_proof' : 'aadhaar_otp',
            alternateProofRequestId: alternateProofRequest ? alternateProofRequest._id : null
        });

    } catch (error) {
        console.error('assignTenant error:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
};

// ─── Field-level security projections ────────────────────────────────────────
// Defence-in-depth: sensitive PII is stripped at the database query layer so it
// can never appear in a response even if a future auth check is accidentally
// skipped or bypassed upstream.
//
// ALWAYS_EXCLUDED — never sent to any caller regardless of role
const ALWAYS_EXCLUDED_PROJECTION =
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

// ME_PROJECTION — whitelist for the tenant self-service /me endpoint.
// Uses explicit inclusion so adding fields to the Tenant schema never
// accidentally exposes them; they must be consciously added here.
const ME_PROJECTION =
    'name email phone status roomNo bedNo building floor moveInDate agreedRent' +
    ' kycStatus loginId propertyTitle ownerLoginId property occupation company' +
    ' gender dob guardianNumber emergencyContact' +
    ' policeVerification.status policeVerification.submittedAt' +
    ' moveoutRequest.status moveoutRequest.requestedDate moveoutRequest.reason moveoutRequest.submittedAt' +
    ' securityDepositTotal securityDepositPaid securityDepositBalance' +
    ' electricityCharge maintenanceCharge' +
    ' agreementSigned agreementSignedAt agreementESignName' +
    ' digitalCheckin.agreement.pdfUrl digitalCheckin.agreement.pdfUploadedAt' +
    ' digitalCheckin.agreementDetails' +
    ' kyc.idProof kyc.uploadedAt' +
    ' createdAt';

/**
 * GET /api/tenants/me
 * Tenant self-service: fetch only their own record.
 * Identity is always derived from the verified JWT — never from request body/query.
 * Returns a whitelist of safe fields; sensitive KYC documents are excluded.
 */
exports.getMyProfile = async (req, res) => {
    try {
        const authenticatedLoginId = String(req.user.loginId || '').toUpperCase();
        if (!authenticatedLoginId) {
            return res.status(401).json({ success: false, message: 'Authenticated identity could not be resolved.' });
        }

        const tenant = await Tenant.findOne({ loginId: authenticatedLoginId })
            .select(ME_PROJECTION)
            .populate('property', 'title locationCode ownerLoginId')
            .lean();

        if (!tenant) {
            return res.status(404).json({
                success: false,
                message: 'Tenant record not found for your account. Please contact your property manager.'
            });
        }

        if (tenant.isDeleted || tenant.status === 'inactive') {
            return res.status(403).json({
                success: false,
                message: 'Your account is no longer active.'
            });
        }

        res.json({ success: true, tenant });
    } catch (error) {
        console.error('getMyProfile error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Get all tenants (Super Admin / Area Manager only)
 * GET /api/tenants
 */
exports.getAllTenants = async (req, res) => {
    try {
        const { applyTenantScope } = require('../utils/scopeHelpers');
        const filter = applyTenantScope(req, { isDeleted: { $ne: true } });

        const tenants = await Tenant.find(filter)
            .select(ALWAYS_EXCLUDED_PROJECTION)
            .populate('property', 'title locationCode ownerLoginId')
            .populate('user', 'name email phone')
            .sort({ createdAt: -1 })
            .lean();

        const tenantsWithDues = await enrichTenantsWithDues(tenants);
        res.json({ success: true, tenants: tenantsWithDues });
    } catch (error) {
        console.error('getAllTenants error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Get tenants for owner (owned properties)
 * GET /api/tenants/owner/:ownerId
 */
exports.getTenantsByOwner = async (req, res) => {
    try {
        const { ownerId } = req.params;
        const normalizedId = String(ownerId).toUpperCase();
        const { propertyId } = req.query;

        // Resolve legacy property IDs (older records link via Property, not ownerLoginId)
        let propQuery = {};
        if (require('mongoose').Types.ObjectId.isValid(ownerId)) {
            propQuery.owner = ownerId;
        } else {
            propQuery.ownerLoginId = normalizedId;
        }
        if (propertyId) propQuery._id = propertyId;
        const properties = await Property.find(propQuery).lean();
        const propertyIds = properties.map(p => p._id);

        // Single query covering both direct (ownerLoginId) and legacy (property-linked)
        // tenants via $or, instead of two separate Tenant.find()+populate() round trips.
        // When scoped to one property, tenants with no property link at all are
        // deliberately excluded rather than shown under every property.
        const allTenants = await Tenant.find({
            isDeleted: { $ne: true },
            ...(propertyId
                ? { property: { $in: propertyIds } }
                : { $or: [{ ownerLoginId: normalizedId }, ...(propertyIds.length > 0 ? [{ property: { $in: propertyIds } }] : [])] })
        })
            .select(ALWAYS_EXCLUDED_PROJECTION)
            .populate('property', 'title roomType locationCode owner ownerLoginId')
            .populate('user', 'name email phone')
            .sort({ createdAt: -1 })
            .lean();

        // Reproduce the original ordering (direct matches first, then legacy-only matches).
        // Each bucket is a subsequence of an already createdAt-desc-sorted array, so it
        // stays sorted — concatenating them yields the exact same order as before, and
        // since $or matches each document at most once, no dedup pass is needed.
        const direct = [];
        const legacyOnly = [];
        for (const t of allTenants) {
            if (t.ownerLoginId === normalizedId) direct.push(t);
            else legacyOnly.push(t);
        }
        const tenants = [...direct, ...legacyOnly];

        const tenantsWithDues = await enrichTenantsWithDues(tenants);
        res.json({ success: true, tenants: tenantsWithDues });
    } catch (error) {
        console.error('getTenantsByOwner error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Get single tenant details
 * GET /api/tenants/:tenantId
 */
exports.getTenant = async (req, res) => {
    try {
        const { tenantId } = req.params;

        const tenant = await Tenant.findById(tenantId)
            .populate('property', 'title roomType locationCode owner')
            .populate('user', 'name email phone')
            .populate('assignedBy', 'name')
            .populate('verifiedBy', 'name')
            .lean();

        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found' });
        }

        res.json({ success: true, tenant });
    } catch (error) {
        console.error('getTenant error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Verify tenant (Super Admin action)
 * POST /api/tenants/:tenantId/verify
 * Body: { kycApproved }
 */
exports.verifyTenant = async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { kycApproved } = req.body;

        const tenant = await Tenant.findById(tenantId);
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found' });
        }

        tenant.status = kycApproved ? 'active' : 'inactive';
        tenant.kycStatus = kycApproved ? 'verified' : 'rejected';
        tenant.verifiedBy = req.user ? req.user.id : null;
        tenant.verifiedAt = new Date();
        await tenant.save();

        res.json({
            success: true,
            message: `Tenant ${kycApproved ? 'verified' : 'rejected'} successfully`,
            tenant
        });
    } catch (error) {
        console.error('verifyTenant error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Update tenant KYC
 * POST /api/tenants/:tenantId/kyc
 * Body: { aadhar, idProofFile, addressProofFile }
 */
exports.updateTenantKyc = async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { aadhar, idProofFile, addressProofFile } = req.body;

        const tenant = await Tenant.findById(tenantId);
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found' });
        }

        if (!tenant.kyc) tenant.kyc = {};

        tenant.kyc.aadhar = aadhar || tenant.kyc.aadhar;
        tenant.kyc.idProofFile = idProofFile || tenant.kyc.idProofFile;
        tenant.kyc.addressProofFile = addressProofFile || tenant.kyc.addressProofFile;
        tenant.kyc.uploadedAt = new Date();
        tenant.kycStatus = 'submitted';

        await tenant.save();

        console.log(`[TENANT KYC UPLOADED] ${tenant.name} (${tenant.loginId})`);

        res.json({
            success: true,
            message: 'KYC updated successfully',
            tenant
        });
    } catch (error) {
        console.error('updateTenantKyc error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * [PHASE 6] Generate User credentials for a newly onboarded tenant.
 * Called atomically inside a MongoDB session from finalizeOnboardingPayment.
 * Idempotent: returns existing credentials if already generated.
 *
 * @param {ObjectId|string} tenantId - Tenant._id
 * @param {string} fallbackLocationCode - Location code from property (if not loaded)
 * @param {object} opts - { session } optional mongoose session
 */
exports.generateTenantCredentials = async (tenantId, fallbackLocationCode = '', opts = {}) => {
    const { session } = opts;
    const tenant = await Tenant.findById(tenantId).populate('property').session(session || null);
    if (!tenant) throw new Error('Tenant not found');

    // Idempotency: abort if already credentialed
    if (tenant.user && tenant.loginId) {
        return { tenant, user: tenant.user, loginId: tenant.loginId, tempPassword: tenant.tempPassword };
    }

    const loginId = tenant.loginId || await generateTenantId();
    const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();

    const propCode = tenant.property ? tenant.property.locationCode : '';
    const effectiveLocationCode = propCode
        || String(fallbackLocationCode || tenant.assignmentLocationCode || '').toUpperCase()
        || 'GEN';

    const [user] = await User.create([{
        name: tenant.name,
        email: tenant.email,
        phone: tenant.phone,
        password: tempPassword,
        role: 'tenant',
        loginId,
        locationCode: effectiveLocationCode,
        status: 'active',
        requirePasswordReset: true
    }], session ? { session } : {});

    tenant.loginId = loginId;
    tenant.tempPassword = tempPassword;
    tenant.user = user._id;
    await tenant.save(session ? { session } : {});

    return { tenant, user, loginId, tempPassword };
};

/**
 * [PHASE 6] Transaction-safe onboarding finalization.
 * 
 * Transaction block (atomic, no network I/O):
 *   1. Sets paymentLinkStatus → 'paid' + stores onboardingRentId
 *   2. Generates User credentials via generateTenantCredentials
 *   If anything fails → session.abortTransaction() → no orphaned state
 * 
 * Post-commit side effects (each independently try/caught):
 *   1. Sends credentials email to tenant
 *   2. Sends receipt email to tenant + owner
 *   Email failures NEVER roll back the committed transaction.
 * 
 * @param {string} loginId - Tenant loginId from JWT
 * @param {string|ObjectId} rentRecordId - Exact Rent._id from JWT
 */
exports.finalizeOnboardingPayment = async (loginId, rentRecordId) => {

    if (!loginId) return false;

    const mongoose = require('mongoose');
    const Rent = require('../models/Rent');
    const { sendCredentials, sendReceiptEmail } = require('../utils/mailer');

    const session = await mongoose.startSession();
    let credentialResult = null;
    let updatedTenant = null;

    // ── TRANSACTION BLOCK ──────────────────────────────────────────────
    try {
        session.startTransaction();

        updatedTenant = await Tenant.findOneAndUpdate(
            { loginId, paymentLinkStatus: { $ne: 'paid' } },
            { $set: { paymentLinkStatus: 'paid', onboardingRentId: rentRecordId, status: 'active', kycStatus: 'verified' } },
            { new: true, session }
        );

        if (!updatedTenant) {
            await session.abortTransaction();
            session.endSession();
            return false;
        }

        // Activate User account so tenant can login after payment
        await User.updateOne(
            { loginId: updatedTenant.loginId },
            { $set: { isActive: true, status: 'active' } },
            session ? { session } : {}
        );

        console.log(`[ONBOARDING FINALIZATION] Triggering credentials & activating account for ${updatedTenant.loginId}`);
        credentialResult = await exports.generateTenantCredentials(updatedTenant._id, updatedTenant.assignmentLocationCode, { session });

        await session.commitTransaction();
    } catch (txError) {
        console.error('[ONBOARDING FINALIZATION] Transaction failed, rolling back:', txError.message);
        try { await session.abortTransaction(); } catch (_) { }
        session.endSession();
        throw txError;
    }
    session.endSession();

    // ── POST-COMMIT EMAIL DISPATCH ─────────────────────────────────────
    const { loginId: credLoginId, tempPassword } = credentialResult;

    console.log(`[ONBOARDING EMAIL] Starting email dispatch for ${updatedTenant.loginId}`);
    console.log(`[ONBOARDING EMAIL] Credential result:`, { credLoginId, hasTempPassword: !!tempPassword });

    // Email 1: Credentials
    try {
        console.log(`[ONBOARDING EMAIL] Sending credentials to ${updatedTenant.email}`);
        await sendCredentials(updatedTenant.email, credLoginId, tempPassword, 'Tenant');
        await Tenant.updateOne({ _id: updatedTenant._id }, { $set: { credentialsEmailStatus: 'sent' } });
        console.log(`[ONBOARDING EMAIL] ✓ Credentials sent to ${updatedTenant.email}`);
    } catch (credEmailErr) {
        console.error(`[ONBOARDING EMAIL] ✗ Credentials FAILED for ${updatedTenant.email}:`, credEmailErr.message);
        console.error(`[ONBOARDING EMAIL] Stack:`, credEmailErr.stack);
        await Tenant.updateOne({ _id: updatedTenant._id }, { $set: { credentialsEmailStatus: 'failed' } });
    }

    // Email 2: Receipt (to tenant + owner)
    try {
        const rent = rentRecordId ? await Rent.findById(rentRecordId).lean() : null;
        if (rent && rent.tenantLoginId !== loginId) {
            console.error(`[ONBOARDING RECEIPT] Rent/tenant mismatch! rent.tenantLoginId=${rent.tenantLoginId}, expected=${loginId}`);
            throw new Error('Rent-tenant ownership mismatch cross-leakage prevented');
        }

        const receiptDetails = {
            receiptNo: rent?._id || `RCPT-${Date.now().toString(36).toUpperCase()}`,
            tenantName: updatedTenant.name,
            propertyName: updatedTenant.propertyTitle,
            roomNo: updatedTenant.roomNo,
            amount: rent?.rentAmount || updatedTenant.agreedRent,
            paidAmount: rent?.paidAmount || updatedTenant.agreedRent,
            paymentMethod: rent?.paymentMethod || 'Razorpay / Cash',
            period: rent?.collectionMonth || new Date().toISOString().slice(0, 7)
        };

        await sendReceiptEmail(updatedTenant.email, receiptDetails);

        await Tenant.updateOne({ _id: updatedTenant._id }, { $set: { receiptEmailStatus: 'sent' } });
        console.log(`[ONBOARDING EMAIL] Receipt sent to tenant=${updatedTenant.email}`);
    } catch (receiptEmailErr) {
        console.error(`[ONBOARDING EMAIL] Receipt FAILED for ${updatedTenant.email}:`, receiptEmailErr.message);
        await Tenant.updateOne({ _id: updatedTenant._id }, { $set: { receiptEmailStatus: 'failed' } });
    }

    return true;
};

/**
 * [PHASE 6] Retry sweep for failed onboarding emails.
 */
exports.retryFailedOnboardingEmails = async (req, res) => {
    const Rent = require('../models/Rent');
    const { sendCredentials, sendReceiptEmail } = require('../utils/mailer');

    try {
        const filter = {
            paymentLinkStatus: 'paid',
            $or: [
                { credentialsEmailStatus: 'failed' },
                { receiptEmailStatus: 'failed' }
            ]
        };
        if (req && req.user && req.user.role === 'owner') {
            filter.ownerLoginId = String(req.user.loginId || '').toUpperCase();
        }

        const failedTenants = await Tenant.find(filter).lean();

        console.log(`[RETRY SWEEP] Found ${failedTenants.length} tenant(s) with failed emails`);
        const results = [];

        for (const tenant of failedTenants) {
            const result = { loginId: tenant.loginId, retried: [] };

            if (tenant.credentialsEmailStatus === 'failed') {
                try {
                    await sendCredentials(tenant.email, tenant.loginId, tenant.tempPassword, 'Tenant');
                    await Tenant.updateOne({ _id: tenant._id }, { $set: { credentialsEmailStatus: 'sent' } });
                    result.retried.push('credentials:sent');
                } catch (err) {
                    result.retried.push(`credentials:failed(${err.message})`);
                }
            }

            if (tenant.receiptEmailStatus === 'failed') {
                try {
                    const rent = tenant.onboardingRentId
                        ? await Rent.findById(tenant.onboardingRentId).lean()
                        : null;
                    const receiptDetails = {
                        receiptNo: rent?._id || `RCPT-${Date.now().toString(36).toUpperCase()}`,
                        tenantName: tenant.name,
                        propertyName: tenant.propertyTitle,
                        roomNo: tenant.roomNo,
                        amount: rent?.rentAmount || tenant.agreedRent,
                        paidAmount: rent?.paidAmount || tenant.agreedRent,
                        paymentMethod: rent?.paymentMethod || 'Razorpay / Cash',
                        period: rent?.collectionMonth || new Date().toISOString().slice(0, 7)
                    };

                    await sendReceiptEmail(tenant.email, receiptDetails);
                    await Tenant.updateOne({ _id: tenant._id }, { $set: { receiptEmailStatus: 'sent' } });
                    result.retried.push('receipt:sent');
                } catch (err) {
                    result.retried.push(`receipt:failed(${err.message})`);
                }
            }

            results.push(result);
        }

        if (res) {
            return res.json({ success: true, processed: results.length, results });
        }
        return results;
    } catch (error) {
        console.error('[RETRY SWEEP] Error:', error);
        if (res) {
            return res.status(500).json({ success: false, error: 'Retry sweep failed' });
        }
        throw error;
    }
};
