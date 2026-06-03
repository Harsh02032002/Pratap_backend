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
            licenseDuration, moveOutCharges, noticePeriodCharges, inclusions, gstCharges,
            propertyAddress, permanentAddress
        } = req.body;

        const depositTotal = Math.max(0, parseInt(securityDepositTotal, 10) || 0);
        const depositPaid = Math.max(0, parseInt(securityDepositPaid, 10) || 0);
        const explicitDepositBalance = parseInt(securityDepositBalance, 10);
        const depositBalance = Math.max(0, Number.isFinite(explicitDepositBalance) ? explicitDepositBalance : (depositTotal - depositPaid));
        const electricityChargeAmount = Math.max(0, parseInt(electricityCharge, 10) || 0);
        const maintenanceChargeAmount = Math.max(0, parseInt(maintenanceCharge, 10) || 0);
        
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

        // Find Room record if exists
        let roomObj = null;
        if (property && roomNo) {
            roomObj = await Room.findOne({
                property: property._id,
                title: { $regex: `^${String(roomNo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
            });

            if (roomObj && bedNo) {
                const bIndex = Number(bedNo) - 1;
                // Ensure array exists
                if (!roomObj.bedAssignments) {
                    roomObj.bedAssignments = [];
                }
                while (roomObj.bedAssignments.length <= bIndex) {
                    roomObj.bedAssignments.push({});
                }
                if (roomObj.bedAssignments[bIndex] && roomObj.bedAssignments[bIndex].tenantId) {
                    return res.status(400).json({ success: false, message: `Bed ${bedNo} in Room ${roomNo} is already occupied by another tenant.` });
                }
            }
        }

        // Generate unique tenant login ID
        const loginId = await generateTenantId();

        // Generate temporary password (8 chars: mix of alphanumeric)
        const tempPassword = crypto.randomBytes(4).toString('hex').toUpperCase();

        // Create User record for tenant (role: 'tenant')
        const user = await User.create({
            name,
            email,
            phone,
            password: tempPassword, // Will be hashed by pre-save hook
            role: 'tenant',
            loginId,
            locationCode: effectiveLocationCode,
            status: 'active',
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
            bedNo,
            moveInDate: moveInDate ? new Date(moveInDate) : null,
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
            loginId,
            tempPassword, // Store for now; will be displayed once, then forgotten
            user: user._id,
            securityDepositTotal: depositTotal,
            securityDepositPaid: depositPaid,
            securityDepositBalance: depositBalance,
            electricityCharge: electricityChargeAmount,
            maintenanceCharge: maintenanceChargeAmount,
            kyc: {
                idProof: idProof?.type || '',
                idProofFile: idProof?.file || '',
                aadhaarNumber: (idProof?.type === 'Aadhaar Card' ? idProof?.number : ''),
                aadhar: (idProof?.type === 'Aadhaar Card' ? idProof?.number : ''),
                aadhaarFront: (idProof?.type === 'Aadhaar Card' ? idProof?.file : '')
            },
            ownerLoginId: String(ownerLoginId || property.ownerLoginId || '').toUpperCase() || undefined,
            propertyTitle: assignedPropertyTitle || property.title || '',
            assignedBy: req.user ? req.user.id : (property.owner && property.owner._id ? property.owner._id : undefined),
            status: 'pending',
            kycStatus: idProof?.file ? 'submitted' : 'pending',
            digitalCheckin: {
                agreementDetails: {
                    ...(accommodationType    && { accommodationType }),
                    ...(minStay              && { minimumStayDuration: `${minStay} Months` }),
                    ...(noticePeriod         && { noticePeriodDays: noticePeriod }),
                    ...(rentDueDate          && { licenseFeeDueDate: rentDueDate }),
                    ...(lateFee              && { lateFee }),
                    ...(licenseDuration      && { licenseDuration: `${licenseDuration} months` }),
                    ...(moveOutCharges       != null && { moveOutCharges }),
                    ...(noticePeriodCharges  != null && { noticePeriodCharges }),
                    ...(inclusions           && { inclusions }),
                    ...(gstCharges           != null && { gstCharges }),
                    ...(propertyAddress      && { propertyAddress }),
                    ...(permanentAddress     && { permanentAddress }),
                    securityDeposit: depositTotal || 0
                }
            }
        });

        // Populate for response (include locationCode and owner info)
        await tenant.populate('property', 'title roomType locationCode owner ownerLoginId');

        // Update Room's bed assignment
        if (roomObj && bedNo) {
            const bIndex = Number(bedNo) - 1;
            roomObj.bedAssignments[bIndex] = {
                tenantId: tenant._id,
                tenantName: tenant.name,
                tenantLoginId: tenant.loginId,
                assignedAt: new Date()
            };
            roomObj.markModified('bedAssignments');
            await roomObj.save();
        }

        // Create Rent record for this tenant
        const rentAmount = parseInt(agreedRent);
        const rentPropertyName = assignedPropertyTitle || property.title || 'Property';
        const rent = await Rent.create({
            propertyName: rentPropertyName,
            roomNumber: roomNo,
            area: property.area || '-',
            tenantName: name,
            tenantEmail: email,
            tenantPhone: phone,
            tenantLoginId: loginId,
            rentAmount: rentAmount,
            totalDue: rentAmount,
            paidAmount: 0,
            paymentStatus: 'pending',
            moveInDate: moveInDate ? new Date(moveInDate) : new Date(),
            dueDate: moveInDate ? new Date(moveInDate) : new Date(),
            createdAt: new Date()
        });

        // Log notification for super admin
        console.log(`[TENANT ASSIGNED] ${name} (${loginId}) assigned to ${rentPropertyName}, Room ${roomNo}`);
        console.log(`[RENT RECORD CREATED] Rent ID: ${rent._id}, Amount: ₹${rentAmount}`);

        // Send email to tenant with loginId, tempPassword and digital check-in link (non-blocking)
        const baseWebUrl = process.env.FRONTEND_URL || process.env.WEB_APP_URL || 'https://admin.roomhy.com';
        const tenantCheckinLink = `${baseWebUrl}/digital-checkin/tenantprofile?loginId=${encodeURIComponent(tenant.loginId)}`;
        try {
            if (tenant.email) {
                console.log(`[MAIL] Attempting to send credentials to ${tenant.email}`);
                const subject = 'Your RoomHy Tenant Login Credentials + Digital Check-In Link';
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
        .content { background: white; padding: 30px; border-radius: 0 0 12px 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
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
            <h2 style="margin-top: 0; color: #7c3aed; font-size: 20px;">Tenant Account & KYC Setup</h2>
            <p style="color: #64748b; line-height: 1.5;">Your tenant account has been created successfully. To finalize your stay, please complete your Digital KYC and profile verification.</p>
            
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
                <p style="margin-bottom: 8px; font-weight: 600; color: #1e293b;">Access Credentials:</p>
                <div class="login-box">
                    <div style="margin-bottom: 8px;">
                        <span class="detail-label">Login ID:</span>
                        <span style="font-family: monospace; font-size: 16px; font-weight: 700; margin-left: 8px; color: #1e293b;">${tenant.loginId}</span>
                    </div>
                    <div>
                        <span class="detail-label">Password:</span>
                        <span style="font-family: monospace; font-size: 16px; font-weight: 700; margin-left: 8px; color: #1e293b;">${tenant.tempPassword}</span>
                    </div>
                </div>
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
                const text = `Tenant account created.\nProperty: ${assignedPropertyTitle || property.title || '-'}\nRoom Number: ${roomNo || '-'}\nBed Number: ${bedNo || '-'}\nRent: INR ${parseInt(agreedRent || 0, 10)}\nSecurity Deposit Total: INR ${depositTotal}\nSecurity Deposit Paid: INR ${depositPaid}\nSecurity Deposit Balance: INR ${depositBalance}\nLogin ID: ${tenant.loginId}\nPassword: ${tenant.tempPassword}\nDigital Check-In: ${tenantCheckinLink}`;
                
                await mailer.sendMail(tenant.email, subject, text, html);
                console.log(`[MAIL] Email sent successfully to ${tenant.email}`);
            }

            // Send WhatsApp to tenant's phone (the number owner entered during room allotment)
            console.log('[TENANT ALLOTMENT] tenant.phone=', tenant.phone, 'tenantCheckinLink=', tenantCheckinLink);
            if (tenant.phone) {
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

            // Also send a copy to owner email (if available)
            const ownerEmail =
                (property.owner && property.owner.email) ||
                (property.owner && property.owner.profile && property.owner.profile.email) ||
                '';
            if (ownerEmail) {
                console.log(`[MAIL] Sending owner copy to ${ownerEmail}`);
                await mailer.sendCredentials(ownerEmail, tenant.loginId, tenant.tempPassword, 'Tenant (Owner Copy)');
            }
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
                securityDepositBalance: tenant.securityDepositBalance
            },
            tenantCheckinLink
        });

    } catch (error) {
        console.error('assignTenant error:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
    }
};

/**
 * Get all tenants (Super Admin)
 * GET /api/tenants
 */
exports.getAllTenants = async (req, res) => {
    try {
        const tenants = await Tenant.find()
            .populate('property', 'title locationCode')
            .populate('user', 'name email phone')
            .sort({ createdAt: -1 })
            .lean();

        res.json({ success: true, tenants });
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

        let query = {};
        if (require('mongoose').Types.ObjectId.isValid(ownerId)) {
            query = { owner: ownerId };
        } else {
            query = { ownerLoginId: String(ownerId).toUpperCase() };
        }

        // Get all properties owned by this owner
        const properties = await Property.find(query).lean();
        const propertyIds = properties.map(p => p._id);

        // Get tenants assigned to these properties
        const tenants = await Tenant.find({ property: { $in: propertyIds } })
            .populate('property', 'title roomType locationCode owner ownerLoginId')
            .populate('user', 'name email phone')
            .sort({ createdAt: -1 })
            .lean();

        res.json({ success: true, tenants });
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
