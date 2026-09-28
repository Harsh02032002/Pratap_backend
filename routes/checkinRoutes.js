const express = require('express');
const router = express.Router();
const CheckinRecord = require('../models/CheckinRecord');
const { normalizeRoomInventory, summarizeRoomInventory } = require('../utils/ownerOccupancy');
const Owner = require('../models/Owner');
const Tenant = require('../models/Tenant');
const Property = require('../models/Property');
const User = require('../models/user');
const { sendMail } = require('../utils/mailer');
const { sendDocumentToResolvedUser, sendTemplateToResolvedUser } = require('../utils/whatsappBot');
const { otpLimiter, otpIpLimiter } = require('../middleware/security');
const { requestAadhaarOtp, verifyAadhaarOtp, aadhaarOcr } = require('../services/cashfreeKycService');
const { verhoeffCheck, extractAadhaarNumber } = require('../utils/aadhaarUtils');
const cloudinary = require('../utils/cloudinary');
const { generateOwnerAgreementPdfBuffer } = require('../utils/generateOwnerAgreementPdf');
const {
    completeTenantAgreementAndNotify,
    generateTenantAgreementPdfBuffer
} = require('../services/tenantOnboardingService');
const {
    verifyDigilockerAccount,
    createDigilockerUrl,
    getDigilockerVerificationStatus,
    getDigilockerDocument
} = require('../services/cashfreeDigilockerService');

const WEBSITE_URL = process.env.WEBSITE_URL || 'https://roomhy.com';
const ADMIN_URL = process.env.ADMIN_URL || 'https://admin.roomhy.com';
const APP_URL = process.env.APP_URL || process.env.CLIENT_APP_URL || 'https://app.roomhy.com';
const DIGITAL_CHECKIN_URL = process.env.DIGITAL_CHECKIN_URL || process.env.FRONTEND_URL || 'https://roomhy.com';
const BACKEND_URL = process.env.BACKEND_URL || process.env.API_BASE_URL || 'https://api.roomhy.com';

const otpStore = new Map();

function keyFor(role, loginId, aadhaarNumber) {
    return `${role}:${String(loginId || '').toUpperCase()}:${String(aadhaarNumber || '')}`;
}

function ensureRole(role) {
    return role === 'owner' || role === 'tenant';
}

async function upsertRecord(loginId, role, update) {
    return CheckinRecord.findOneAndUpdate(
        { loginId: String(loginId || '').toUpperCase(), role },
        { $set: update, $setOnInsert: { loginId: String(loginId || '').toUpperCase(), role } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
}

function createDigilockerRef(loginId) {
    const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `DL-${String(loginId || '').toUpperCase()}-${Date.now()}-${suffix}`;
}

function isOwnerKycVerified(record) {
    return Boolean(record?.ownerKyc?.otpVerified || record?.ownerKyc?.digilockerVerified);
}

function buildOtpEmail({ otp, name, loginId, role = 'Owner', expiryMinutes = 10 }) {
    const isSandbox = Boolean(otp);
    const otpDisplay = isSandbox ? String(otp) : null;
    const logoUrl = `${APP_URL}/website/images/roomhy.png`;
    const year = new Date().getFullYear();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OTP Verification — RoomHy</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f4;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #dddddd;">
        <tr>
          <td style="padding:24px 32px;border-bottom:1px solid #dddddd;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td><img src="${logoUrl}" alt="RoomHy" height="32" style="display:block;border:0;" /></td>
                <td align="right" style="font-size:11px;color:#999999;font-family:Arial,Helvetica,sans-serif;">Digital Check-In Portal</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 0;">
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#111111;font-family:Arial,Helvetica,sans-serif;">OTP Verification</h1>
            <p style="margin:0 0 8px;font-size:15px;color:#333333;font-family:Arial,Helvetica,sans-serif;">Dear <strong>${name || loginId || 'Applicant'}</strong>,</p>
            <p style="margin:0 0 24px;font-size:14px;color:#555555;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">
              You have requested an Aadhaar OTP verification for your RoomHy <strong>${role}</strong> account.
              ${isSandbox ? 'Please use the One-Time Password below to complete your identity verification.' : 'Your OTP has been dispatched to your Aadhaar-linked mobile number.'}
            </p>
          </td>
        </tr>
        ${isSandbox && otpDisplay ? `<tr><td style="padding:0 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #cccccc;background-color:#f9f9f9;">
              <tr><td align="center" style="padding:28px 24px;">
                <p style="margin:0 0 14px;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#888888;font-family:Arial,Helvetica,sans-serif;">Your One-Time Password</p>
                <p style="margin:0;font-size:42px;font-weight:700;letter-spacing:0.24em;color:#111111;font-family:'Courier New',Courier,monospace;">${otpDisplay}</p>
                <p style="margin:16px 0 0;font-size:12px;color:#888888;font-family:Arial,Helvetica,sans-serif;">Valid for ${expiryMinutes} minutes &nbsp;&#183;&nbsp; Do not share this code with anyone</p>
              </td></tr>
            </table>
          </td></tr>` : ''}
        <tr>
          <td style="border-top:1px solid #dddddd;padding:20px 32px;background-color:#f9f9f9;">
            <p style="margin:0;font-size:12px;color:#888888;line-height:1.8;font-family:Arial,Helvetica,sans-serif;">
              <strong style="color:#555555;">RoomHy Support Team</strong><br>
              Email: support@roomhy.com &nbsp;&#124;&nbsp; Website: www.roomhy.com<br>
              &copy; ${year} RoomHy. All rights reserved.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Tenant agreement helpers ─────────────────────────────────────────────────

function buildTenantLoginEmail(tenant, dashboardUrl, record = {}) {
    const logoUrl = `${APP_URL}/website/images/roomhy.png`;
    const year = new Date().getFullYear();
    const tenantName = tenant.name || 'Tenant';
    const propertyName = tenant.propertyTitle || tenant.digitalCheckin?.profile?.propertyName || 'RoomHy Property';
    const roomNo = tenant.roomNo || '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Digital Check-In Complete — RoomHy</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f4;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid #dddddd;">
        <tr>
          <td style="padding:24px 32px;border-bottom:1px solid #dddddd;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;">
                  <img src="${logoUrl}" alt="RoomHy" height="32" style="display:block;height:32px;max-width:140px;border:0;" />
                </td>
                <td align="right" style="vertical-align:middle;font-size:11px;color:#999999;font-family:Arial,Helvetica,sans-serif;">Tenant Portal</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 8px;">
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#111111;font-family:Arial,Helvetica,sans-serif;">Digital Check-In Complete</h1>
            <p style="margin:0 0 8px;font-size:15px;color:#333333;font-family:Arial,Helvetica,sans-serif;">Dear <strong>${tenantName}</strong>,</p>
            <p style="margin:0 0 24px;font-size:14px;color:#555555;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">
              Your digital check-in and Licence &amp; Subscription Agreement signing have been completed successfully. Your RoomHy Tenant account is now active. Your login credentials and a copy of the signed agreement are provided below.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dddddd;">
              <tr>
                <td colspan="2" style="padding:12px 18px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#888888;background-color:#f4f4f4;border-bottom:1px solid #dddddd;font-family:Arial,Helvetica,sans-serif;">Account &amp; Property Details</td>
              </tr>
              <tr>
                <td style="padding:11px 18px;font-size:13px;color:#888888;border-bottom:1px solid #eeeeee;width:150px;font-family:Arial,Helvetica,sans-serif;">Login ID</td>
                <td style="padding:11px 18px;font-size:14px;font-weight:700;color:#111111;border-bottom:1px solid #eeeeee;font-family:'Courier New',Courier,monospace;">${tenant.loginId || '—'}</td>
              </tr>
              <tr>
                <td style="padding:11px 18px;font-size:13px;color:#888888;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">Email</td>
                <td style="padding:11px 18px;font-size:13px;color:#111111;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">${tenant.email || '—'}</td>
              </tr>
              <tr>
                <td style="padding:11px 18px;font-size:13px;color:#888888;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">Property</td>
                <td style="padding:11px 18px;font-size:13px;font-weight:700;color:#111111;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">${propertyName}</td>
              </tr>
              ${roomNo ? `<tr>
                <td style="padding:11px 18px;font-size:13px;color:#888888;font-family:Arial,Helvetica,sans-serif;">Room</td>
                <td style="padding:11px 18px;font-size:13px;font-weight:700;color:#111111;font-family:Arial,Helvetica,sans-serif;">${roomNo}</td>
              </tr>` : ''}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 12px;">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="background-color:#111111;">
                  <a href="${dashboardUrl}" style="display:inline-block;background-color:#111111;color:#ffffff;text-decoration:none;padding:13px 28px;font-size:14px;font-weight:600;font-family:Arial,Helvetica,sans-serif;white-space:nowrap;">Open Tenant Dashboard</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;">
            <p style="margin:0;font-size:12px;color:#888888;line-height:1.6;font-family:Arial,Helvetica,sans-serif;">If the button above does not work, copy and paste the following link into your browser:<br><span style="color:#333333;">${dashboardUrl}</span></p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dddddd;border-left:3px solid #111111;background-color:#f9f9f9;">
              <tr>
                <td style="padding:14px 18px;font-size:13px;color:#333333;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">
                  Your signed Licence &amp; Subscription Agreement has been generated and is attached to this email as a PDF document. Please retain this document for your records.
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px;">
            <p style="margin:0;font-size:13px;color:#555555;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">
              For any questions or assistance, please contact our support team at <strong>support@roomhy.com</strong>.
            </p>
          </td>
        </tr>
        <tr>
          <td style="border-top:1px solid #dddddd;padding:20px 32px;background-color:#f9f9f9;">
            <p style="margin:0;font-size:12px;color:#888888;line-height:1.8;font-family:Arial,Helvetica,sans-serif;">
              <strong style="color:#555555;">RoomHy Support Team</strong><br>
              Email: support@roomhy.com &nbsp;&#124;&nbsp; Website: www.roomhy.com<br>
              &copy; ${year} RoomHy. All rights reserved.<br>
              This is an automated message. Please do not reply to this email.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function isTenantKycVerified(record) {
    return Boolean(record?.tenantKyc?.otpVerified || record?.tenantKyc?.digilockerVerified);
}

router.post('/owner/profile', async (req, res) => {
    try {
        const {
            loginId, name, dob, email, phone, address, area, password, payment = {},
            roomInventory = [], occupiedRooms, occupiedBeds, vacantRooms, vacantBeds
        } = req.body || {};
        if (!loginId || !name || !dob || !email || !phone || !address || !area || !payment.bankAccountNumber || !payment.ifscCode || !payment.accountHolderName) {
            return res.status(400).json({ success: false, message: 'Missing required owner profile fields' });
        }
        const normalizedRooms = normalizeRoomInventory(roomInventory);
        const inventorySummary = summarizeRoomInventory(normalizedRooms);
        const occupancy = normalizedRooms.length
            ? inventorySummary
            : {
                roomCount: Number(occupiedRooms || 0) + Number(vacantRooms || 0),
                bedCount: Number(occupiedBeds || 0) + Number(vacantBeds || 0),
                occupiedRooms: Number(occupiedRooms || 0),
                occupiedBeds: Number(occupiedBeds || 0),
                vacantRooms: Number(vacantRooms || 0),
                vacantBeds: Number(vacantBeds || 0)
            };
        const record = await upsertRecord(loginId, 'owner', {
            ownerProfile: { name, dob, email, phone, address, area, password, payment },
            ...(normalizedRooms.length ? { roomInventory: normalizedRooms } : {}),
            ...occupancy
        });

        // Mirror to Owner collection so superadmin owner list can show this data
        const existingOwner = await Owner.findOne({ loginId: String(loginId).toUpperCase() }).lean();
        const existingProfile = existingOwner?.profile || {};

        const updatedOwner = await Owner.findOneAndUpdate(
            { loginId: String(loginId).toUpperCase() },
            {
                $set: {
                    loginId: String(loginId).toUpperCase(),
                    name: name,
                    email: email,
                    phone: phone,
                    address: address,
                    locationCode: area,
                    profileFilled: true,
                    // Store with "checkin" prefix for frontend display
                    checkinDob: dob,
                    checkinPhone: phone,
                    checkinAddress: address,
                    checkinArea: area,
                    checkinPassword: password || '',
                    checkinAccountHolderName: payment.accountHolderName || '',
                    checkinBankAccountNumber: payment.bankAccountNumber || '',
                    checkinIfscCode: payment.ifscCode || '',
                    checkinBankName: payment.bankName || '',
                    checkinBranchName: payment.branchName || '',
                    checkinUpiId: payment.upiId || '',
                    checkinCancelledCheque: payment.cancelledCheque || {},
                    ...(normalizedRooms.length ? { roomInventory: normalizedRooms } : {}),
                    ...occupancy,
                    // Also set top-level fields for backward compatibility
                    accountNumber: payment.bankAccountNumber || '',
                    ifscCode: payment.ifscCode || '',
                    bankName: payment.bankName || '',
                    branchName: payment.branchName || '',
                    profile: {
                        ...existingProfile,
                        name,
                        email,
                        phone,
                        address,
                        locationCode: area,
                        accountNumber: payment.bankAccountNumber || '',
                        ifscCode: payment.ifscCode || '',
                        bankName: payment.bankName || '',
                        branchName: payment.branchName || '',
                        accountHolderName: payment.accountHolderName || '',
                        upiId: payment.upiId || ''
                    },
                    credentials: {
                        password: password || (existingOwner?.credentials && existingOwner.credentials.password) || '',
                        firstTime: true
                    }
                },
                $setOnInsert: {
                    kyc: { status: 'pending' }
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return res.json({ success: true, record, owner: updatedOwner });
    } catch (err) {
        console.error('owner/profile error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/owner/kyc/send-otp', otpIpLimiter, otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarLinkedPhone, aadhaarNumber, email } = req.body || {};
        console.log('[CHECKIN KYC] Received send-otp request:', { loginId, aadhaarLinkedPhone, aadhaarNumber, email });

        if (!loginId || !aadhaarLinkedPhone || !aadhaarNumber) {
            console.log('[CHECKIN KYC] Missing fields - loginId:', !!loginId, 'phone:', !!aadhaarLinkedPhone, 'aadhaar:', !!aadhaarNumber);
            return res.status(400).json({ success: false, message: 'Missing KYC fields' });
        }

        // Validate Aadhaar format (12 digits)
        if (!/^\d{12}$/.test(aadhaarNumber)) {
            console.log('[CHECKIN KYC] Invalid aadhaar format:', aadhaarNumber, 'length:', aadhaarNumber.length);
            return res.status(400).json({ success: false, message: 'Aadhaar must be 12 digits' });
        }

        await upsertRecord(loginId, 'owner', {
            ownerKyc: { aadhaarLinkedPhone, aadhaarNumber, otpVerified: false }
        });

        // Get owner details including email
        let owner = await Owner.findOne({ loginId: String(loginId).toUpperCase() }).lean();

        // Fallback: if email is missing in DB but provided by frontend, backfill it.
        if ((!owner || !owner.email) && email) {
            owner = await Owner.findOneAndUpdate(
                { loginId: String(loginId).toUpperCase() },
                { $set: { email: String(email).trim() } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            ).lean();
        }

        if (!owner || !owner.email) {
            return res.status(400).json({ success: false, message: 'Owner email not found. Complete profile first.' });
        }

        // Update Owner model with Aadhaar info and checkin fields
        await Owner.findOneAndUpdate(
            { loginId: String(loginId).toUpperCase() },
            {
                $set: {
                    loginId: String(loginId).toUpperCase(),
                    // Store with "checkin" prefix for frontend display
                    checkinAadhaarLinkedPhone: aadhaarLinkedPhone,
                    checkinAadhaarNumber: aadhaarNumber,
                    kyc: {
                        aadharNumber: aadhaarNumber,
                        aadhaarLinkedPhone: aadhaarLinkedPhone,
                        status: 'pending'
                    }
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const k = keyFor('owner', loginId, aadhaarNumber);
        otpStore.set(k, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });
        console.log('[CHECKIN KYC] Owner OTP generated for', loginId);

        // Send OTP via WhatsApp first, fall back to email
        let whatsappOtpSent = false;
        try {
            whatsappOtpSent = await sendTemplateToResolvedUser({
                phone: aadhaarLinkedPhone,
                email: owner.email || '',
                userId: String(loginId).toUpperCase(),
                templateName: 'roomhy_otp_verification',
                variables: [otp],
                options: { urlButtons: [[otp]] }
            });
        } catch (whatsAppErr) {
            console.warn('[CHECKIN KYC] Owner WhatsApp OTP failed:', whatsAppErr.message);
        }

        if (!whatsappOtpSent && owner.email) {
            try {
                await sendMail(
                    owner.email,
                    'RoomHy Owner KYC — OTP Verification',
                    `Your OTP is: ${otp}. Valid for 10 minutes.`,
                    buildOtpEmail({ otp, name: owner.name, loginId: String(loginId).toUpperCase(), role: 'Owner' })
                );
            } catch (mailErr) {
                console.warn('[CHECKIN KYC] Owner OTP email fallback failed:', mailErr.message);
            }
        }

        return res.json({
            success: true,
            message: 'OTP sent to your WhatsApp number',
            whatsappSent: whatsappOtpSent
        });
    } catch (err) {
        console.error('owner/kyc/send-otp error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/owner/kyc/verify-otp', otpIpLimiter, otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarNumber, otp } = req.body || {};
        const k = keyFor('owner', loginId, aadhaarNumber);
        const entry = otpStore.get(k);
        if (!entry || Date.now() > entry.expiresAt) {
            return res.status(400).json({ success: false, message: 'OTP expired or not found. Please request a new OTP.' });
        }
        if (!otp || String(otp).trim() !== String(entry.otp)) {
            return res.status(400).json({ success: false, message: 'Incorrect OTP. Please try again.' });
        }
        otpStore.delete(k);

        const record = await upsertRecord(loginId, 'owner', { 'ownerKyc.otpVerified': true });

        // Get owner details
        const normalizedLoginId = String(loginId).toUpperCase();
        const ownerDoc = await Owner.findOne({ loginId: normalizedLoginId });
        const ownerEmail = ownerDoc?.email || record?.ownerProfile?.email || '';
        const ownerPassword = ownerDoc?.checkinPassword || ownerDoc?.credentials?.password || record?.ownerProfile?.password || 'Roomhy@123';
        const updatedOwner = await Owner.findOneAndUpdate(
            { loginId: normalizedLoginId },
            {
                $set: {
                    'kyc.status': 'verified',
                    kycStatus: 'verified',
                    'kyc.submittedAt': new Date(),
                    'kyc.verifiedAt': new Date(),
                    isActive: true,
                    status: 'approved',
                    credentials: {
                        password: ownerPassword,
                        firstTime: true
                    }
                },
            },
            { new: true }
        );

        // Do not auto-activate owner account upon KYC submission; activation happens upon SuperAdmin approval.
        try {
            const User = require('../models/user');
            await User.updateOne(
                { $or: [{ loginId: normalizedLoginId }, { email: ownerEmail }] },
                { $set: { status: 'pending_approval' } }
            );
        } catch (uErr) {
            console.warn('Sync User status on owner KYC verify warning:', uErr.message);
        }

        // Notify owner that KYC verification was received and is pending SuperAdmin review (No credentials sent yet).
        if (ownerEmail) {
            const emailHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <style>
                        body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; }
                        .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 12px; }
                        .header { background: linear-gradient(135deg, #16a34a 0%, #15803d 100%); color: white; padding: 30px; text-align: center; border-radius: 12px 12px 0 0; }
                        .header h1 { margin: 0; font-size: 24px; }
                        .content { padding: 30px; background: #ffffff; }
                        .notice { background: #f0fdf4; border-left: 4px solid #16a34a; padding: 15px; margin: 20px 0; border-radius: 8px; }
                        .notice p { margin: 8px 0; font-size: 14px; color: #166534; }
                        .success { color: #16a34a; font-weight: bold; font-size: 18px; margin-bottom: 15px; }
                        .footer { font-size: 12px; color: #888; text-align: center; margin-top: 20px; border-top: 1px solid #eee; padding-top: 15px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>✓ KYC Verification Received</h1>
                        </div>
                        <div class="content">
                            <p>Dear <strong>${ownerDoc?.name || updatedOwner?.name || 'Property Owner'}</strong>,</p>
                            
                            <div class="success">🎉 Your Digital KYC Verification has been Received!</div>
                            
                            <p>Thank you for submitting your digital KYC details for RoomHy property onboarding.</p>
                            
                            <div class="notice">
                                <p><strong>Next Step:</strong> Your visit report and property details are currently under review by RoomHy SuperAdmin.</p>
                                <p>Once approved by SuperAdmin, your property will be published live and your Owner Portal login credentials will be delivered to your email.</p>
                            </div>
                        </div>
                        <div class="footer">
                            © 2026 RoomHy Platform. All rights reserved.
                        </div>
                    </div>
                </body>
                </html>
            `;

            try {
                await sendMail(ownerEmail, '✓ RoomHy Digital KYC Verification Received', '', emailHtml);
                console.log('[CHECKIN KYC] Sent KYC completion confirmation email (holding credentials for SuperAdmin approval) to:', ownerEmail);
            } catch (emailErr) {
                console.error('[CHECKIN KYC] Email error:', emailErr.message);
            }
        }

        return res.json({ success: true, record, owner: updatedOwner, message: 'OTP verified successfully' });
    } catch (err) {
        console.error('owner/kyc/verify-otp error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/owner/kyc/digilocker/start', otpIpLimiter, otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarLinkedPhone, aadhaarNumber, email, redirectUrl: clientRedirectUrl } = req.body || {};
        if (!loginId || !aadhaarNumber) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        if (!/^\d{12}$/.test(String(aadhaarNumber))) {
            return res.status(400).json({ success: false, message: 'Aadhaar must be 12 digits' });
        }

        const ref = createDigilockerRef(loginId);
        const redirectUrl = clientRedirectUrl || process.env.DIGILOCKER_REDIRECT_URL || `${DIGITAL_CHECKIN_URL}/digital-checkin/ownerkyc`;

        const accountCheck = await verifyDigilockerAccount({
            verificationId: ref,
            mobileNumber: aadhaarLinkedPhone,
            aadhaarNumber
        });
        const userFlow = accountCheck?.account_exists ? 'signin' : 'signup';
        const digilockerInit = await createDigilockerUrl({
            verificationId: ref,
            redirectUrl,
            userFlow,
            documents: ['AADHAAR']
        });

        const cashfreeVerificationId = digilockerInit?.verification_id || ref;
        const cashfreeReferenceId = digilockerInit?.reference_id || digilockerInit?.ref_id || '';
        const verifyUrl = digilockerInit?.url || digilockerInit?.verification_url || digilockerInit?.link || '';

        await upsertRecord(loginId, 'owner', {
            ownerKyc: {
                aadhaarLinkedPhone: aadhaarLinkedPhone || '',
                aadhaarNumber: String(aadhaarNumber),
                otpVerified: false,
                digilockerVerified: false,
                digilockerStatus: 'pending',
                digilockerRef: ref,
                digilockerVerificationId: cashfreeVerificationId,
                digilockerReferenceId: cashfreeReferenceId,
                digilockerUrl: verifyUrl,
                digilockerStartedAt: new Date()
            }
        });

        await Owner.findOneAndUpdate(
            { loginId: String(loginId).toUpperCase() },
            {
                $set: {
                    loginId: String(loginId).toUpperCase(),
                    email: email || undefined,
                    checkinAadhaarLinkedPhone: aadhaarLinkedPhone || '',
                    checkinAadhaarNumber: String(aadhaarNumber),
                    'kyc.status': 'pending',
                    'kyc.provider': 'digilocker'
                }
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return res.json({
            success: true,
            provider: 'digilocker',
            referenceId: cashfreeReferenceId || ref,
            verificationId: cashfreeVerificationId,
            verifyUrl,
            userFlow,
            message: 'DigiLocker verification initiated. Complete DigiLocker auth and return to this page.'
        });
    } catch (err) {
        console.error('owner/kyc/digilocker/start error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/owner/kyc/digilocker/complete', otpIpLimiter, otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarNumber, referenceId, verificationId } = req.body || {};
        if (!loginId || !aadhaarNumber || (!referenceId && !verificationId)) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        const normalizedLoginId = String(loginId).toUpperCase();
        const record = await CheckinRecord.findOne({ loginId: normalizedLoginId, role: 'owner' });
        if (!record || !record.ownerKyc) {
            return res.status(404).json({ success: false, message: 'Owner KYC record not found' });
        }
        if (String(record.ownerKyc.aadhaarNumber || '') !== String(aadhaarNumber)) {
            return res.status(400).json({ success: false, message: 'Aadhaar mismatch' });
        }
        const storedVerificationId = record.ownerKyc.digilockerVerificationId || record.ownerKyc.digilockerRef;
        const storedReferenceId = record.ownerKyc.digilockerReferenceId || record.ownerKyc.digilockerRef;
        const checkVerificationId = verificationId || storedVerificationId;
        const checkReferenceId = referenceId || storedReferenceId;
        if (!checkVerificationId && !checkReferenceId) {
            return res.status(400).json({ success: false, message: 'Missing DigiLocker verification context' });
        }

        const statusResp = await getDigilockerVerificationStatus({
            verificationId: checkVerificationId,
            referenceId: checkReferenceId
        });
        const verificationStatus = String(
            statusResp?.status ||
            statusResp?.verification_status ||
            statusResp?.data?.status ||
            ''
        ).toUpperCase();
        const validStatuses = ['AUTHENTICATED', 'SUCCESS', 'COMPLETED', 'VERIFIED'];
        if (!validStatuses.includes(verificationStatus)) {
            return res.status(400).json({
                success: false,
                message: `DigiLocker verification not completed yet (status: ${verificationStatus || 'PENDING'})`
            });
        }

        let aadhaarDocument = null;
        try {
            aadhaarDocument = await getDigilockerDocument({
                documentType: 'AADHAAR',
                verificationId: checkVerificationId,
                referenceId: checkReferenceId
            });
        } catch (docErr) {
            console.warn('owner digilocker document fetch warning:', docErr.message);
        }

        record.ownerKyc.digilockerVerified = true;
        record.ownerKyc.digilockerStatus = 'verified';
        record.ownerKyc.digilockerVerifiedAt = new Date();
        record.ownerKyc.digilockerVerificationId = checkVerificationId || '';
        record.ownerKyc.digilockerReferenceId = checkReferenceId || '';
        if (aadhaarDocument) {
            record.ownerKyc.digilockerDocument = aadhaarDocument;
        }
        await record.save();

        const owner = await Owner.findOneAndUpdate(
            { loginId: normalizedLoginId },
            {
                $set: {
                    'kyc.status': 'verified',
                    kycStatus: 'verified',
                    'kyc.provider': 'digilocker',
                    'kyc.submittedAt': new Date(),
                    'kyc.verifiedAt': new Date(),
                    isActive: true,
                    status: 'approved'
                },
            },
            { new: true }
        );

        if (owner && owner.email) {
            try {
                const ownerPassword = owner.checkinPassword || owner.credentials?.password || 'Roomhy@123';
                const APP_URL = process.env.APP_URL || process.env.CLIENT_APP_URL || 'https://app.roomhy.com';
                const fullLoginUrl = `${APP_URL}/propertyowner/ownerlogin`;
                const emailHtml = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <style>
                            body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; }
                            .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 12px; }
                            .header { background: linear-gradient(135deg, #16a34a 0%, #15803d 100%); color: white; padding: 30px; text-align: center; border-radius: 12px 12px 0 0; }
                            .header h1 { margin: 0; font-size: 26px; }
                            .content { padding: 30px; background: #ffffff; }
                            .credentials { background: #f0fdf4; border-left: 4px solid #16a34a; padding: 15px; margin: 20px 0; border-radius: 8px; }
                            .credentials p { margin: 8px 0; font-size: 15px; }
                            .label { font-weight: bold; color: #333; }
                            .value { font-family: monospace; color: #16a34a; font-weight: bold; font-size: 16px; }
                            .button { display: inline-block; background: #16a34a; color: white !important; padding: 14px 32px; text-decoration: none; border-radius: 8px; margin-top: 15px; font-weight: bold; }
                            .success { color: #16a34a; font-weight: bold; font-size: 18px; margin-bottom: 15px; }
                        </style>
                    </head>
                    <body>
                        <div class="container">
                            <div class="header">
                                <h1>✓ KYC Verification Completed!</h1>
                            </div>
                            <div class="content">
                                <p>Dear <strong>${owner.name || 'Property Owner'}</strong>,</p>
                                <div class="success">🎉 Your DigiLocker KYC Verification is Successful!</div>
                                <p>Your RoomHy Property Owner account is now active. Below are your login credentials to access the Owner Portal:</p>
                                <div class="credentials">
                                    <p><span class="label">Login ID / Username:</span> <span class="value">${owner.loginId}</span></p>
                                    <p><span class="label">Password:</span> <span class="value">${ownerPassword}</span></p>
                                </div>
                                <div style="text-align: center; margin-top: 25px;">
                                    <a href="${fullLoginUrl}" class="button">Log In to Owner Portal</a>
                                </div>
                            </div>
                        </div>
                    </body>
                    </html>
                `;
                await sendMail(owner.email, '✓ KYC Verified — Your RoomHy Owner Login Credentials', '', emailHtml);
            } catch (mErr) {
                console.error('[DIGILOCKER KYC] Email error:', mErr.message);
            }
        }

        return res.json({
            success: true,
            message: 'DigiLocker verification completed successfully',
            verificationStatus,
            record,
            owner
        });
    } catch (err) {
        console.error('owner/kyc/digilocker/complete error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/owner/terms-accept', async (req, res) => {
    try {
        const { loginId, accepted } = req.body || {};
        if (!loginId || accepted !== true) {
            return res.status(400).json({ success: false, message: 'Terms must be accepted' });
        }
        const record = await upsertRecord(loginId, 'owner', { ownerTermsAcceptedAt: new Date() });
        return res.json({ success: true, record });
    } catch (err) {
        console.error('owner/terms-accept error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/owner/final-submit', async (req, res) => {
    try {
        const { loginId, finalVerified } = req.body || {};
        if (!loginId || finalVerified !== true) {
            return res.status(400).json({ success: false, message: 'Final verification required' });
        }
        const normalizedLoginId = String(loginId).toUpperCase();
        const record = await upsertRecord(normalizedLoginId, 'owner', {});
        const ownerDoc = await Owner.findOne({ loginId: normalizedLoginId }).lean();
        const ownerModelVerified = ownerDoc?.kyc?.status === 'submitted';
        if (!record.ownerKyc || (!isOwnerKycVerified(record) && !ownerModelVerified)) {
            return res.status(400).json({ success: false, message: 'Complete KYC verification first (OTP or DigiLocker)' });
        }
        if (ownerModelVerified && !isOwnerKycVerified(record)) {
            record.ownerKyc = record.ownerKyc || {};
            record.ownerKyc.digilockerVerified = true;
            record.ownerKyc.digilockerStatus = 'verified';
            record.ownerKyc.digilockerVerifiedAt = new Date();
        }
        if (!record.ownerTermsAcceptedAt) {
            return res.status(400).json({ success: false, message: 'Accept terms and conditions first' });
        }

        record.ownerFinalVerified = true;
        record.ownerSubmittedAt = new Date();
        await record.save();

        // 🔒 FIX: Employee-submitted owners must NOT be auto-activated on KYC completion.
        // They remain inactive (isActive: false) until Superadmin explicitly approves them.
        // Only superadmin-directly-added owners get auto-activated on KYC completion.
        const freshOwner = await Owner.findOne({ loginId: normalizedLoginId });
        const isPendingApproval = freshOwner && (freshOwner.isEmployeeSubmitted === true || freshOwner.status === 'pending_approval');

        if (isPendingApproval) {
            // Employee-submitted owner: mark KYC as 'submitted' (ready for review), keep inactive
            await Owner.findOneAndUpdate(
                { loginId: normalizedLoginId },
                {
                    $set: {
                        'kyc.status': 'submitted',
                        'kyc.submittedAt': new Date(),
                        checkinSubmittedAt: new Date(),
                        isActive: false, // stays inactive until superadmin approves
                    },
                }
            );
            console.log(`⏳ [CHECKIN FINAL SUBMIT] Employee-submitted owner ${normalizedLoginId} KYC submitted — awaiting Superadmin approval.`);
        } else {
            // Superadmin-added owner: auto-activate on KYC completion (original behavior)
            await Owner.findOneAndUpdate(
                { loginId: normalizedLoginId },
                {
                    $set: {
                        'kyc.status': 'verified',
                        'kyc.verifiedAt': new Date(),
                        checkinSubmittedAt: new Date(),
                        isActive: true,
                    },
                }
            );
            console.log(`✅ [CHECKIN FINAL SUBMIT] Superadmin-added owner ${normalizedLoginId} KYC verified & activated.`);
        }

        // Send owner dashboard link email ONLY if owner account is active & approved by Superadmin.
        // For employee-submitted pending owners, login link will ONLY be sent when Superadmin approves the account!
        const owner = freshOwner || ownerDoc || await Owner.findOne({ loginId: normalizedLoginId }).lean();
        const targetEmail = (owner && owner.email) || (record.ownerProfile && record.ownerProfile.email) || '';
        const baseUrl = APP_URL;
        const dashboardUrl = `${baseUrl}/propertyowner/index`;
        let loginEmailSent = false;

        const isFullyApprovedOwner = owner && owner.isActive === true && !owner.isEmployeeSubmitted && owner.status !== 'pending_approval';

        if (targetEmail && isFullyApprovedOwner) {
            const emailHtml = `
                <div style="font-family: Arial, sans-serif; max-width: 620px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
                    <div style="background: #1d4ed8; color: white; padding: 18px 20px;">
                        <h2 style="margin: 0; font-size: 20px;">RoomHy Owner Check-in Completed</h2>
                    </div>
                    <div style="padding: 18px 20px; color: #111827; line-height: 1.55;">
                        <p style="margin-top: 0;">Your owner digital check-in is now fully submitted.</p>
                        <p style="margin: 14px 0 18px;">
                            <a href="${dashboardUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:700;">Open Login Page</a>
                        </p>
                        <p style="font-size: 12px; color: #6b7280;">If button does not work, copy this link: ${dashboardUrl}</p>
                    </div>
                </div>
            `;
            try {
                await sendMail(targetEmail, 'RoomHy Owner Login Link', '', emailHtml);
                loginEmailSent = true;
            } catch (emailErr) {
                console.error('[CHECKIN FINAL SUBMIT] Email send error:', emailErr.message);
            }
        } else {
            console.log(`ℹ️ [CHECKIN FINAL SUBMIT] Skipped dashboard link email for owner ${normalizedLoginId} (Awaiting Superadmin Approval).`);
        }

        return res.json({ success: true, message: 'Owner digital check-in submitted', record, dashboardUrl, loginEmailSent });
    } catch (err) {
        console.error('owner/final-submit error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── Test setup route for Owner Agreement ─────────────────────────────────────────────
router.get('/test-setup-owner', async (req, res) => {
    try {
        const email = req.query.email || 'harshdeepobca503@gmail.com';
        const phone = req.query.phone || '9464165010';
        const loginId = (req.query.loginId || 'ROOMHY6120').toUpperCase();

        let owner = await Owner.findOne({ loginId });
        if (!owner) {
            owner = await Owner.create({
                loginId,
                name: 'Harshdeep Kaur',
                email,
                phone,
                address: '847, Balaji Nagar, Rangbari Road, Kota, Rajasthan',
                propertyName: 'Paradise Residency Hostel',
                isActive: true,
                status: 'active'
            });
        } else {
            owner.email = email;
            owner.phone = phone;
            if (!owner.name || owner.name === 'Owner') owner.name = 'Harshdeep Kaur';
            await owner.save();
        }

        let userDoc = await User.findOne({ loginId });
        if (userDoc) {
            userDoc.email = email;
            userDoc.phone = phone;
            await userDoc.save();
        }

        let record = await CheckinRecord.findOne({ loginId, role: 'owner' });
        if (!record) {
            record = await CheckinRecord.create({
                loginId,
                role: 'owner',
                ownerProfile: { name: owner.name, email, phone, address: owner.address },
                ownerKyc: { otpVerified: true, digilockerVerified: true }
            });
        } else {
            record.ownerProfile = record.ownerProfile || {};
            record.ownerProfile.email = email;
            record.ownerProfile.phone = phone;
            record.ownerKyc = record.ownerKyc || {};
            record.ownerKyc.otpVerified = true;
            await record.save();
        }

        return res.json({
            success: true,
            message: `Owner ${loginId} updated with email ${email} and phone ${phone}`,
            loginId,
            owner,
            agreementSignLink: `/digital-checkin/owneragreement?loginId=${encodeURIComponent(loginId)}`,
            pdfViewLink: `/api/checkin/owner/agreement/pdf/${encodeURIComponent(loginId)}`
        });
    } catch (err) {
        console.error('test-setup-owner error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── Owner-Roomhy Agreement details & e-signature routes ─────────────────────────────
router.get('/owner/agreement/details/:loginId', async (req, res) => {
    try {
        const rawLoginId = String(req.params.loginId || '').trim();
        const normalizedLoginId = rawLoginId.toUpperCase();
        if (!rawLoginId) return res.status(400).json({ success: false, message: 'Missing loginId' });

        // Auto-seed / sync Sunita Shukla details if phone 8955468549, email, or loginId ROOMHY8955 is accessed
        const isSunitaShukla = rawLoginId === '8955468549' ||
            rawLoginId.toLowerCase() === 'singhsunita93938@gmail.com' ||
            normalizedLoginId === 'ROOMHY8955' ||
            normalizedLoginId === '8955468549';

        let record = await CheckinRecord.findOne({
            $or: [
                { loginId: normalizedLoginId },
                { loginId: rawLoginId },
                { 'ownerProfile.phone': rawLoginId },
                { 'ownerProfile.email': rawLoginId.toLowerCase() }
            ],
            role: 'owner'
        }).lean();

        let ownerDoc = await Owner.findOne({
            $or: [
                { loginId: normalizedLoginId },
                { loginId: rawLoginId },
                { phone: rawLoginId },
                { email: rawLoginId.toLowerCase() }
            ]
        }).lean();

        let userDoc = await User.findOne({
            $or: [
                { loginId: normalizedLoginId },
                { loginId: rawLoginId },
                { phone: rawLoginId },
                { email: rawLoginId.toLowerCase() }
            ]
        }).lean();

        let property = await Property.findOne({ ownerId: ownerDoc?._id || userDoc?._id })
                     || await Property.findOne({ ownerLoginId: normalizedLoginId }).lean();

        // If Sunita Shukla or no data found for her, auto-populate Sunita Shukla data
        if (isSunitaShukla || (!ownerDoc && !record && (rawLoginId === '8955468549' || rawLoginId.toLowerCase().includes('sunita')))) {
            const sunitaData = {
                loginId: 'ROOMHY8955',
                name: 'Sunita Shukla',
                email: 'singhsunita93938@gmail.com',
                phone: '8955468549',
                propertyName: 'HL Residency',
                companyName: 'HL Residency',
                address: 'E-24 Landmarkcity kunari Kota Rajasthan 324008 Near by Allen samayak 1',
                panNumber: 'BRGPS7399Q',
                gstinNumber: '08AAACB1534F1Z6',
                bankDetails: {
                    bankName: 'Bank of Baroda',
                    branch: 'Kothradi chouraha jhalawar road',
                    accountHolder: 'Sunita Shukla'
                }
            };

            // Update in DB asynchronously
            try {
                await Owner.findOneAndUpdate(
                    { $or: [{ phone: '8955468549' }, { email: 'singhsunita93938@gmail.com' }, { loginId: 'ROOMHY8955' }] },
                    { $set: sunitaData },
                    { upsert: true, new: true }
                );
                await CheckinRecord.findOneAndUpdate(
                    { loginId: 'ROOMHY8955', role: 'owner' },
                    {
                        $set: {
                            loginId: 'ROOMHY8955',
                            role: 'owner',
                            'ownerProfile.name': sunitaData.name,
                            'ownerProfile.email': sunitaData.email,
                            'ownerProfile.phone': sunitaData.phone,
                            'ownerProfile.address': sunitaData.address,
                            'ownerProfile.panNumber': sunitaData.panNumber,
                            'ownerProfile.gstinNumber': sunitaData.gstinNumber,
                            'ownerAgreement.agreementDetails': {
                                hostelLegalName: sunitaData.propertyName,
                                tradeName: sunitaData.propertyName,
                                propertyAddress: sunitaData.address,
                                panNumber: sunitaData.panNumber,
                                gstinNumber: sunitaData.gstinNumber,
                                representativeName: sunitaData.name,
                                ownerPhone: sunitaData.phone,
                                ownerEmail: sunitaData.email,
                                subscriptionFee: '0',
                                subscriptionFrequency: 'One-time',
                                commissionPercent: '',
                                settlementDays: '7'
                            }
                        }
                    },
                    { upsert: true, new: true }
                );
            } catch (syncErr) {
                console.error('Error auto-syncing Sunita Shukla:', syncErr.message);
            }

            return res.json({
                success: true,
                loginId: 'ROOMHY8955',
                ownerName: sunitaData.name,
                ownerEmail: sunitaData.email,
                ownerPhone: sunitaData.phone,
                hostelLegalName: sunitaData.propertyName,
                tradeName: sunitaData.propertyName,
                propertyAddress: sunitaData.address,
                panNumber: sunitaData.panNumber,
                gstinNumber: sunitaData.gstinNumber,
                agreement: record?.ownerAgreement || null,
                isSigned: Boolean(record?.ownerAgreement?.status === 'signed')
            });
        }

        const storedAgr = record?.ownerAgreement?.agreementDetails || ownerDoc?.ownerAgreement?.agreementDetails || {};

        const ownerName = storedAgr.representativeName || ownerDoc?.name || userDoc?.name || record?.ownerProfile?.name || '';
        const ownerEmail = storedAgr.ownerEmail || ownerDoc?.email || userDoc?.email || record?.ownerProfile?.email || '';
        const ownerPhone = storedAgr.ownerPhone || ownerDoc?.phone || userDoc?.phone || record?.ownerProfile?.phone || '';
        const propertyAddress = storedAgr.propertyAddress || property?.address || ownerDoc?.address || record?.ownerProfile?.address || 'Kota, Rajasthan';
        const tradeName = storedAgr.tradeName || property?.title || property?.name || ownerDoc?.propertyName || `${ownerName || 'Hostel'} Property`;
        const hostelLegalName = storedAgr.hostelLegalName || ownerDoc?.companyName || ownerDoc?.legalName || tradeName;
        const panNumber = storedAgr.panNumber || ownerDoc?.panNumber || ownerDoc?.kyc?.panNumber || '-';
        const gstinNumber = storedAgr.gstinNumber || ownerDoc?.gstinNumber || ownerDoc?.gstin || ownerDoc?.kyc?.gstin || '-';

        return res.json({
            success: true,
            loginId: normalizedLoginId,
            ownerName,
            ownerEmail,
            ownerPhone,
            hostelLegalName,
            tradeName,
            propertyAddress,
            panNumber,
            gstinNumber,
            agreement: record?.ownerAgreement || ownerDoc?.ownerAgreement || null,
            isSigned: Boolean(record?.ownerAgreement?.status === 'signed' || ownerDoc?.agreementStatus === 'signed' || record?.ownerAgreement?.acceptedAt)
        });
    } catch (err) {
        console.error('owner/agreement/details error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/owner/agreement', async (req, res) => {
    try {
        const {
            loginId, eSignName, accepted, signatureDataUrl,
            hostelLegalName, tradeName, propertyAddress, panNumber, gstinNumber, representativeName,
            subscriptionFee, subscriptionFrequency, commissionPercent, settlementDays
        } = req.body || {};

        if (!loginId || !eSignName || accepted !== true || !signatureDataUrl) {
            return res.status(400).json({ success: false, message: 'Agreement acceptance, e-sign name, and signature are required' });
        }

        const normalizedLoginId = String(loginId).toUpperCase();
        const acceptedAt = new Date();

        const ownerDoc = await Owner.findOne({ loginId: normalizedLoginId });
        const userDoc = await User.findOne({ loginId: normalizedLoginId });
        const record = await upsertRecord(normalizedLoginId, 'owner', {});

        const ownerName = representativeName || ownerDoc?.name || userDoc?.name || record?.ownerProfile?.name || 'Owner';
        const ownerEmail = ownerDoc?.email || userDoc?.email || record?.ownerProfile?.email || '';
        const ownerPhone = ownerDoc?.phone || userDoc?.phone || record?.ownerProfile?.phone || '';

        const agreementDetails = {
            hostelLegalName: hostelLegalName || ownerDoc?.companyName || tradeName || `${ownerName} Hostel`,
            tradeName: tradeName || ownerDoc?.propertyName || `${ownerName} Hostel`,
            propertyAddress: propertyAddress || ownerDoc?.address || 'Kota, Rajasthan',
            panNumber: panNumber || ownerDoc?.panNumber || '-',
            gstinNumber: gstinNumber || ownerDoc?.gstinNumber || '-',
            representativeName: ownerName,
            subscriptionFee: subscriptionFee || '0',
            subscriptionFrequency: subscriptionFrequency || 'One-time',
            commissionPercent: commissionPercent || '',
            settlementDays: settlementDays || '7'
        };

        const agreementPayload = {
            eSignName,
            signatureDataUrl,
            acceptedAt,
            status: 'signed',
            signedAt: acceptedAt,
            agreementDetails
        };

        record.ownerAgreement = agreementPayload;
        record.ownerTermsAcceptedAt = acceptedAt;
        await record.save();

        if (ownerDoc) {
            ownerDoc.agreementStatus = 'signed';
            ownerDoc.agreementSignedAt = acceptedAt;
            ownerDoc.agreementESignName = eSignName;
            ownerDoc.ownerAgreement = agreementPayload;
            await ownerDoc.save();
        }

        // Generate Owner-Roomhy Agreement PDF
        const pdfBuffer = await generateOwnerAgreementPdfBuffer({
            effectiveDay: String(acceptedAt.getDate()),
            effectiveMonth: acceptedAt.toLocaleString('en-IN', { month: 'long' }),
            effectiveYear: String(acceptedAt.getFullYear()),
            hostelLegalName: agreementDetails.hostelLegalName,
            tradeName: agreementDetails.tradeName,
            propertyAddress: agreementDetails.propertyAddress,
            panNumber: agreementDetails.panNumber,
            gstinNumber: agreementDetails.gstinNumber,
            representativeName: agreementDetails.representativeName,
            ownerPhone,
            ownerEmail,
            subscriptionFee: agreementDetails.subscriptionFee,
            subscriptionFrequency: agreementDetails.subscriptionFrequency,
            commissionPercent: agreementDetails.commissionPercent,
            settlementDays: agreementDetails.settlementDays,
            signatureDataUrl,
            eSignName,
            signedDate: acceptedAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        });

        // Email PDF to Owner and Roomhy Admin
        const emailRecipients = [ownerEmail, 'info@roomhy.com', 'roomhy@gmail.com'].filter(Boolean);
        const emailSubject = `RoomHy Hostel Onboarding & Service Agreement - ${agreementDetails.tradeName} (${normalizedLoginId})`;
        const emailHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                <div style="background: #1a237e; color: #ffffff; padding: 24px; text-align: center;">
                    <h2 style="margin: 0; font-size: 22px; font-weight: 700;">RoomHy Onboarding Agreement Signed</h2>
                    <p style="margin: 6px 0 0; font-size: 14px; opacity: 0.9;">Hostel Onboarding & Service Agreement Executed</p>
                </div>
                <div style="padding: 24px; color: #1e293b; line-height: 1.6;">
                    <p>Dear <strong>${ownerName}</strong>,</p>
                    <p>Thank you for completing your e-signature for <strong>${agreementDetails.tradeName}</strong> (${normalizedLoginId}).</p>
                    <p>Your official <strong>Hostel Onboarding & Service Agreement</strong> with <strong>Roomhy Technology</strong> has been executed successfully. A copy of the e-signed agreement PDF with official Roomhy stamp and your digital signature is attached to this email for your records.</p>
                    <div style="background: #f8fafc; border-left: 4px solid #1a237e; padding: 16px; margin: 20px 0; border-radius: 4px;">
                        <p style="margin: 0; font-size: 13px; font-weight: 600; color: #334155;">Agreement Details:</p>
                        <ul style="margin: 8px 0 0; padding-left: 20px; font-size: 13px; color: #475569;">
                            <li><strong>Hostel Trade Name:</strong> ${agreementDetails.tradeName}</li>
                            <li><strong>Legal Representative:</strong> ${agreementDetails.representativeName}</li>
                            <li><strong>Signed Date:</strong> ${acceptedAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</li>
                            <li><strong>Status:</strong> E-Signed & Active</li>
                        </ul>
                    </div>
                    <p style="font-size: 13px; color: #64748b;">Warm regards,<br/><strong>Team RoomHy Technology</strong></p>
                </div>
            </div>
        `;

        if (emailRecipients.length > 0) {
            try {
                const recipientList = [...new Set(emailRecipients)].join(', ');
                await sendMail(recipientList, emailSubject, `Your RoomHy agreement is signed. Attached is your copy.`, emailHtml, {
                    attachments: [
                        {
                            filename: `RoomHy-Owner-Agreement-${normalizedLoginId}.pdf`,
                            content: pdfBuffer,
                            contentType: 'application/pdf'
                        }
                    ]
                });
                console.log(`✅ [OWNER AGREEMENT] PDF Email sent to: ${recipientList}`);
            } catch (mailErr) {
                console.error('[OWNER AGREEMENT] Mail send error:', mailErr.message);
            }
        }

        return res.json({
            success: true,
            message: 'Hostel Onboarding & Service Agreement e-signed successfully.',
            record,
            pdfUrl: `/api/checkin/owner/agreement/pdf/${encodeURIComponent(normalizedLoginId)}`,
            nextUrl: `/digital-checkin/owner-success?loginId=${encodeURIComponent(normalizedLoginId)}&agreementSigned=1`
        });
    } catch (err) {
        console.error('owner/agreement error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Owner agreement signing failed' });
    }
});

router.get('/owner/agreement/pdf/:loginId', async (req, res) => {
    try {
        const normalizedLoginId = String(req.params.loginId || '').toUpperCase();
        if (!normalizedLoginId) return res.status(400).json({ success: false, message: 'Missing loginId' });

        const record = await CheckinRecord.findOne({ loginId: normalizedLoginId, role: 'owner' }).lean();
        const ownerDoc = await Owner.findOne({ loginId: normalizedLoginId }).lean();
        const userDoc = await User.findOne({ loginId: normalizedLoginId }).lean();

        const agr = record?.ownerAgreement || ownerDoc?.ownerAgreement || {};
        const details = agr.agreementDetails || {};

        const ownerName = details.representativeName || ownerDoc?.name || userDoc?.name || record?.ownerProfile?.name || 'Owner';
        const ownerEmail = ownerDoc?.email || userDoc?.email || record?.ownerProfile?.email || '';
        const ownerPhone = ownerDoc?.phone || userDoc?.phone || record?.ownerProfile?.phone || '';
        const acceptedAt = agr.acceptedAt ? new Date(agr.acceptedAt) : new Date();

        const pdfBuffer = await generateOwnerAgreementPdfBuffer({
            effectiveDay: String(acceptedAt.getDate()),
            effectiveMonth: acceptedAt.toLocaleString('en-IN', { month: 'long' }),
            effectiveYear: String(acceptedAt.getFullYear()),
            hostelLegalName: details.hostelLegalName || ownerDoc?.companyName || `${ownerName} Hostel`,
            tradeName: details.tradeName || ownerDoc?.propertyName || `${ownerName} Hostel`,
            propertyAddress: details.propertyAddress || ownerDoc?.address || 'Kota, Rajasthan',
            panNumber: details.panNumber || ownerDoc?.panNumber || '-',
            gstinNumber: details.gstinNumber || ownerDoc?.gstinNumber || '-',
            representativeName: ownerName,
            ownerPhone,
            ownerEmail,
            subscriptionFee: details.subscriptionFee || '0',
            subscriptionFrequency: details.subscriptionFrequency || 'One-time',
            commissionPercent: details.commissionPercent || '',
            settlementDays: details.settlementDays || '7',
            signatureDataUrl: agr.signatureDataUrl || '',
            eSignName: agr.eSignName || ownerName,
            signedDate: acceptedAt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="RoomHy-Owner-Agreement-${normalizedLoginId}.pdf"`);
        return res.send(pdfBuffer);
    } catch (err) {
        console.error('owner/agreement/pdf error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to generate owner agreement PDF' });
    }
});

// Prefill for the owner's digital check-in page.
//
// The owner opens this page from an emailed link and has no session, so the
// page cannot use GET /api/owners/:loginId — that route is behind `protect` and
// answers 401, which the page swallows, leaving every field it did not get from
// the URL blank. Hence a public route, mirroring the tenant one below.
//
// Public, but not open: a login ID is ROOMHY + 4 digits and therefore guessable,
// and the response carries the owner's address and bank details. The temporary
// password from the same emailed link has to match. Credentials are never
// returned.
router.get('/owner/profile/:loginId', async (req, res) => {
    try {
        const normalizedLoginId = String(req.params.loginId || '').trim().toUpperCase();
        if (!normalizedLoginId) return res.status(400).json({ success: false, message: 'Missing loginId' });

        const owner = await Owner.findOne({ loginId: normalizedLoginId }).lean();
        if (!owner) return res.status(404).json({ success: false, message: 'Owner not found' });

        const supplied = String(req.query.password || '').trim();
        const expected = String(owner.checkinPassword || owner.credentials?.password || '').trim();
        if (!expected || supplied !== expected) {
            return res.status(403).json({ success: false, message: 'Invalid check-in link' });
        }

        // Explicit allow-list. Returning `owner` wholesale would ship the
        // password, internal KYC payloads and audit fields to an
        // unauthenticated caller.
        return res.json({
            success: true,
            owner: {
                loginId: owner.loginId,
                name: owner.name || '',
                email: owner.email || '',
                phone: owner.phone || '',
                area: owner.area || '',
                address: owner.address || '',
                locationCode: owner.locationCode || '',
                profile: {
                    name: owner.profile?.name || '',
                    email: owner.profile?.email || '',
                    phone: owner.profile?.phone || '',
                    address: owner.profile?.address || '',
                    locationCode: owner.profile?.locationCode || ''
                },
                checkinEmail: owner.checkinEmail || '',
                checkinDob: owner.checkinDob || '',
                checkinPhone: owner.checkinPhone || '',
                checkinAddress: owner.checkinAddress || '',
                checkinArea: owner.checkinArea || '',
                checkinAccountHolderName: owner.checkinAccountHolderName || '',
                checkinUpiId: owner.checkinUpiId || '',
                checkinBankAccountNumber: owner.checkinBankAccountNumber || '',
                checkinIfscCode: owner.checkinIfscCode || '',
                checkinBankName: owner.checkinBankName || '',
                checkinBranchName: owner.checkinBranchName || '',
                bankName: owner.bankName || '',
                accountNumber: owner.accountNumber || '',
                ifscCode: owner.ifscCode || '',
                checkinAadhaarNumber: owner.checkinAadhaarNumber || '',
                checkinAadhaarLinkedPhone: owner.checkinAadhaarLinkedPhone || '',
                checkinOwnerPhoto: owner.checkinOwnerPhoto || '',
                checkinBankProof: owner.checkinBankProof || '',
                checkinAadhaarImage: owner.checkinAadhaarImage || '',
                kyc: { status: owner.kyc?.status || '' },
                vacantRooms: owner.vacantRooms ?? 0,
                vacantBeds: owner.vacantBeds ?? 0,
                occupiedRooms: owner.occupiedRooms ?? 0,
                occupiedBeds: owner.occupiedBeds ?? 0,
                roomInventory: owner.roomInventory || []
            }
        });
    } catch (err) {
        console.error('owner/profile GET error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/tenant/profile/:loginId', async (req, res) => {
    try {
        const normalizedLoginId = String(req.params.loginId || '').toUpperCase();
        if (!normalizedLoginId) return res.status(400).json({ success: false, message: 'Missing loginId' });

        const Property = require('../models/Property');
        const ApprovedProperty = require('../models/ApprovedProperty');

        let tenant = await Tenant.findOne({ loginId: normalizedLoginId })
            .select('-tempPassword')
            .populate('property', 'title securityDeposit pricing locationCode ownerLoginId')
            .lean();
        if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

        // Resolve owner name for display
        let ownerName = '';
        if (tenant.ownerLoginId) {
            try {
                const ownerDoc = await Owner.findOne({ loginId: String(tenant.ownerLoginId).toUpperCase() })
                    .select('name profile').lean();
                ownerName = ownerDoc?.name || ownerDoc?.profile?.name || '';
            } catch (_) { }
        }

        // Resolve property security deposit fallback if tenant's deposit is missing/zero or agreementDetails deposit is missing/zero
        let propSecurityDeposit = tenant.property?.pricing?.securityDeposit || tenant.property?.securityDeposit || '';
        if (!propSecurityDeposit && (tenant.propertyTitle || tenant.propertyId)) {
            try {
                const p = await Property.findOne({
                    $or: [
                        ...(tenant.propertyId ? [{ _id: tenant.propertyId }] : []),
                        { title: tenant.propertyTitle }
                    ]
                }).select('securityDeposit pricing').lean() || await ApprovedProperty.findOne({
                    $or: [
                        ...(tenant.propertyId ? [{ propertyId: tenant.propertyId }] : []),
                        { title: tenant.propertyTitle }
                    ]
                }).select('securityDeposit pricing').lean();
                propSecurityDeposit = p?.pricing?.securityDeposit || p?.securityDeposit || '';
            } catch (_) { }
        }

        if (propSecurityDeposit) {
            const propDepositNum = parseInt(propSecurityDeposit, 10);
            if (!isNaN(propDepositNum) && propDepositNum > 0) {
                if (!tenant.securityDepositTotal || tenant.securityDepositTotal === 0) {
                    tenant.securityDepositTotal = propDepositNum;
                    tenant.securityDepositBalance = Math.max(0, propDepositNum - (tenant.securityDepositPaid || 0));
                }
                tenant.digitalCheckin = tenant.digitalCheckin || {};
                tenant.digitalCheckin.agreementDetails = tenant.digitalCheckin.agreementDetails || {};
                if (!tenant.digitalCheckin.agreementDetails.securityDeposit || tenant.digitalCheckin.agreementDetails.securityDeposit === '0') {
                    tenant.digitalCheckin.agreementDetails.securityDeposit = String(propDepositNum);
                }
            }
        }

        // Ensure idProofNumber & aadhaarNumber are populated on profile response
        tenant.idProofNumber = tenant.idProofNumber || tenant.idProof?.number || tenant.aadhaarNumber || tenant.aadhar || tenant.kyc?.aadhaarNumber || tenant.kyc?.aadhar || '';
        tenant.aadhaarNumber = tenant.aadhaarNumber || tenant.idProofNumber || tenant.idProof?.number || '';

        return res.json({ success: true, tenant: { ...tenant, ownerName } });
    } catch (err) {
        console.error('tenant/profile GET error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/tenant/profile', async (req, res) => {
    try {
        const {
            loginId, name, dob, guardianNumber, moveInDate, email,
            propertyName, propertyAddress, roomNo, agreedRent,
            phone, permanentAddress, backupEmail, accommodationType,
            securityDeposit, licenseDuration, licenseEndDate, licenseFeeDueDate,
            moveOutCharges, noticePeriodCharges, inclusions,
            minimumStayDuration, gstCharges
        } = req.body || {};

        if (!loginId || !name || !dob || !guardianNumber || !moveInDate) {
            return res.status(400).json({ success: false, message: 'Missing required tenant profile fields' });
        }
        const normalizedLoginId = String(loginId).toUpperCase();
        const record = await upsertRecord(normalizedLoginId, 'tenant', {
            tenantProfile: { name, dob, guardianNumber, moveInDate, email: email || '', propertyName: propertyName || '', roomNo: roomNo || '', agreedRent: agreedRent || null }
        });

        const tenant = await Tenant.findOne({ loginId: normalizedLoginId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found for this login ID' });
        }

        // This endpoint is unauthenticated by design (a tenant reaches it with
        // only their login ID, before they have a session) — so it must not
        // double as an uncontrolled room/rent-change path. roomNo/agreedRent
        // are only settable on the tenant's FIRST profile submission; any
        // later change has to go through the authenticated transfer endpoint
        // (POST /api/tenants/:id/transfer), which is billing-period-aware.
        // Gated on digitalCheckin.profile.submittedAt (set below, at the end
        // of this same handler) rather than `profileFilled` — that field is
        // not declared on the Tenant schema, so under Mongoose's default
        // strict mode assigning it below is a no-op that never persists and
        // would always read back false, making a guard on it a no-op too.
        const isFirstSubmission = !tenant.digitalCheckin?.profile?.submittedAt;

        tenant.name = name || tenant.name;
        if (email) tenant.email = email;
        if (phone) tenant.phone = phone;
        tenant.dob = dob || tenant.dob;
        tenant.guardianNumber = guardianNumber || tenant.guardianNumber;
        tenant.profileFilled = true;
        if (propertyName) tenant.propertyTitle = propertyName;
        if (isFirstSubmission) {
            if (roomNo) tenant.roomNo = roomNo;
            if (agreedRent !== undefined && agreedRent !== null && agreedRent !== '') tenant.agreedRent = Number(agreedRent);
            if (moveInDate) tenant.moveInDate = new Date(moveInDate);
        }

        tenant.digitalCheckin = tenant.digitalCheckin || {};
        tenant.digitalCheckin.profile = {
            ...(tenant.digitalCheckin.profile || {}),
            name, dob, guardianNumber, moveInDate,
            email: email || tenant.email || '',
            phone: phone || tenant.phone || '',
            propertyName: propertyName || tenant.propertyTitle || '',
            roomNo: roomNo || tenant.roomNo || '',
            agreedRent: Number(agreedRent || tenant.agreedRent || 0),
            permanentAddress: permanentAddress || tenant.digitalCheckin?.profile?.permanentAddress || '',
            accommodationType: accommodationType || tenant.digitalCheckin?.profile?.accommodationType || '',
            securityDeposit: securityDeposit || '',
            inclusions: inclusions || '',
            submittedAt: new Date()
        };

        // All agreement fields stored in agreementDetails (Mixed) — read by PDF generator
        const prev = tenant.digitalCheckin.agreementDetails || {};
        tenant.digitalCheckin.agreementDetails = {
            ...prev,
            tenantName: name || tenant.name || '',
            tenantEmail: email || tenant.email || '',
            tenantPhone: phone || tenant.phone || '',
            backupPhone: guardianNumber || prev.backupPhone || '',
            backupEmail: backupEmail || prev.backupEmail || '',
            permanentAddress: permanentAddress || prev.permanentAddress || '',
            accommodationType: accommodationType || prev.accommodationType || '',
            propertyName: propertyName || tenant.propertyTitle || '',
            propertyAddress: propertyAddress || prev.propertyAddress || '',
            roomNumber: roomNo || tenant.roomNo || '',
            rentAmount: agreedRent ? String(agreedRent) : (tenant.agreedRent ? String(tenant.agreedRent) : ''),
            licenseStartDate: moveInDate || '',
            licenseDuration: licenseDuration || prev.licenseDuration || '',
            licenseEndDate: licenseEndDate || prev.licenseEndDate || '',
            licenseFeeDueDate: licenseFeeDueDate || prev.licenseFeeDueDate || '5',
            moveOutCharges: moveOutCharges || prev.moveOutCharges || '0',
            noticePeriodCharges: noticePeriodCharges || prev.noticePeriodCharges || '0',
            securityDeposit: securityDeposit || prev.securityDeposit || (tenant.securityDepositTotal ? String(tenant.securityDepositTotal) : ''),
            inclusions: inclusions || prev.inclusions || '',
            minimumStayDuration: minimumStayDuration || prev.minimumStayDuration || '3 Months',
            gstCharges: gstCharges || prev.gstCharges || '0',
            updatedAt: new Date()
        };

        tenant.updatedAt = new Date();
        await tenant.save();

        return res.json({ success: true, record, tenant });
    } catch (err) {
        console.error('tenant/profile error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/tenant/kyc/send-otp', otpIpLimiter, otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarLinkedPhone, aadhaarNumber } = req.body || {};
        if (!loginId || !aadhaarLinkedPhone || !aadhaarNumber) {
            return res.status(400).json({ success: false, message: 'Missing tenant KYC fields' });
        }
        const normalizedLoginId = String(loginId).toUpperCase();

        // Verhoeff checksum — reject obviously invalid Aadhaar numbers before sending OTP
        if (!/^\d{12}$/.test(aadhaarNumber) || !/^[2-9]/.test(aadhaarNumber)) {
            return res.status(400).json({ success: false, message: 'Invalid Aadhaar number format' });
        }
        if (!verhoeffCheck(aadhaarNumber)) {
            return res.status(400).json({ success: false, message: 'Aadhaar number failed checksum validation. Please re-enter.' });
        }

        // Images are NOT accepted here — they are uploaded separately via POST /tenant/documents
        await upsertRecord(normalizedLoginId, 'tenant', {
            tenantKyc: { aadhaarLinkedPhone, aadhaarNumber, otpVerified: false }
        });

        const tenant = await Tenant.findOne({ loginId: normalizedLoginId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found for this login ID' });
        }

        tenant.kyc = tenant.kyc || {};
        tenant.kyc.aadhaarNumber = aadhaarNumber;
        tenant.kyc.aadhar = aadhaarNumber;
        tenant.kyc.aadhaarLinkedPhone = aadhaarLinkedPhone;
        tenant.kyc.otpVerified = false;
        tenant.kyc.uploadedAt = new Date();
        const isFirstKycSubmission = !tenant.kycStatus || !['submitted', 'verified'].includes(tenant.kycStatus);
        tenant.kycStatus = 'submitted';

        tenant.digitalCheckin = tenant.digitalCheckin || {};
        tenant.digitalCheckin.kyc = {
            ...(tenant.digitalCheckin.kyc || {}),
            aadhaarLinkedPhone,
            aadhaarNumber,
            otpVerified: false
        };
        tenant.updatedAt = new Date();
        await tenant.save();

        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const k = keyFor('tenant', normalizedLoginId, aadhaarNumber);
        otpStore.set(k, { otp, expiresAt: Date.now() + 10 * 60 * 1000 });
        console.log('[CHECKIN OTP] tenant', normalizedLoginId, aadhaarNumber, 'internal OTP generated');

        // Send OTP via WhatsApp first, fall back to email
        let whatsappOtpSent = false;
        try {
            whatsappOtpSent = await sendTemplateToResolvedUser({
                phone: aadhaarLinkedPhone,
                email: tenant.email || '',
                userId: normalizedLoginId,
                templateName: 'roomhy_otp_verification',
                variables: [otp],
                options: { urlButtons: [[otp]] }
            });
        } catch (whatsAppErr) {
            console.warn('tenant kyc send otp whatsapp failed:', whatsAppErr.message);
        }

        if (!whatsappOtpSent && tenant.email) {
            try {
                await sendMail(
                    tenant.email,
                    'RoomHy Tenant KYC — OTP Verification',
                    `Your OTP is: ${otp}. Valid for 10 minutes.`,
                    buildOtpEmail({ otp, name: tenant.name, loginId: normalizedLoginId, role: 'Tenant' })
                );
            } catch (mailErr) {
                console.warn('tenant kyc send otp email fallback failed:', mailErr.message);
            }
        }

        // First-time KYC submission: send pending notification via WhatsApp
        if (isFirstKycSubmission) {
            try {
                await sendTemplateToResolvedUser({
                    phone: aadhaarLinkedPhone || tenant.phone || '',
                    email: tenant.email || '',
                    userId: normalizedLoginId,
                    templateName: 'roomhy_kyc_pending',
                    options: {
                        namedParams: {
                            tenant_name: tenant.name || 'Tenant',
                            kyc_url: `${DIGITAL_CHECKIN_URL}/digital-checkin/tenantkyc?loginId=${encodeURIComponent(normalizedLoginId)}`
                        }
                    }
                });
            } catch (whatsAppErr) {
                console.warn('tenant kyc pending whatsapp failed:', whatsAppErr.message);
            }
        }

        return res.json({
            success: true,
            message: 'OTP sent to Aadhaar linked mobile number',
            provider: 'internal'
        });
    } catch (err) {
        console.error('tenant/kyc/send-otp error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/tenant/kyc/verify-otp', otpIpLimiter, otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarNumber, otp, aadhaarFront, aadhaarBack, tenantPhoto, kycStatus, mismatchReasons: clientMismatch } = req.body || {};
        const normalizedLoginId = String(loginId || '').toUpperCase();
        const k = keyFor('tenant', normalizedLoginId, aadhaarNumber);
        const entry = otpStore.get(k);
        if (!entry || Date.now() > entry.expiresAt) {
            return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
        }
        if (String(otp).trim() !== String(entry.otp).trim()) {
            return res.status(400).json({ success: false, message: 'Incorrect OTP. Please try again.' });
        }
        otpStore.delete(k);

        const tenant = await Tenant.findOne({ loginId: normalizedLoginId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found for this login ID' });
        }

        // Compare scanned/entered Aadhaar vs owner-set expected Aadhaar number
        const ownerSetAadhaar = (
            tenant.idProofNumber ||
            tenant.aadhaarNumber ||
            tenant.idProof?.number ||
            tenant.kyc?.aadhaarNumber ||
            tenant.kyc?.aadhar ||
            tenant.kycVerificationData?.adminEnteredAadhaar ||
            ''
        );

        const isAadhaarMatch = (expected, scanned) => {
            if (!expected || !scanned) return true;
            const expClean = String(expected).replace(/\D/g, '');
            const scnClean = String(scanned).replace(/\D/g, '');
            if (!expClean || !scnClean) return true;
            if (expClean === scnClean) return true;
            if (scnClean.length === 8 && expClean.length === 12) {
                return expClean.startsWith(scnClean.slice(0, 4)) && expClean.endsWith(scnClean.slice(4, 8));
            }
            if (expClean.length === 8 && scnClean.length === 12) {
                return scnClean.startsWith(expClean.slice(0, 4)) && scnClean.endsWith(expClean.slice(4, 8));
            }
            return false;
        };

        const mismatchReasons = [];
        if (clientMismatch && !clientMismatch.includes('mismatch: Owner Record () vs') && !clientMismatch.includes('mismatch: Owner set () vs')) {
            mismatchReasons.push(clientMismatch);
        }

        if (ownerSetAadhaar && aadhaarNumber && !isAadhaarMatch(ownerSetAadhaar, aadhaarNumber)) {
            mismatchReasons.push(`Aadhaar Number mismatch: Owner set (${ownerSetAadhaar}) vs Tenant uploaded (${aadhaarNumber})`);
        }

        const isMismatch = mismatchReasons.length > 0;
        const targetKycStatus = isMismatch ? 'mismatch_review' : 'audit_pending';

        tenant.kyc = tenant.kyc || {};
        tenant.kyc.otpVerified = true;
        tenant.kyc.otpVerifiedAt = new Date();
        tenant.kyc.aadhaarNumber = aadhaarNumber;
        tenant.kyc.aadhar = aadhaarNumber;
        if (aadhaarFront) tenant.kyc.aadhaarFront = aadhaarFront;
        if (aadhaarBack) tenant.kyc.aadhaarBack = aadhaarBack;
        if (mismatchReasons.length > 0) tenant.kyc.mismatchReasons = mismatchReasons.join('; ');

        tenant.kycStatus = targetKycStatus;

        if (tenantPhoto) tenant.photo = tenantPhoto;

        tenant.digitalCheckin = tenant.digitalCheckin || {};
        tenant.digitalCheckin.kyc = {
            ...(tenant.digitalCheckin.kyc || {}),
            otpVerified: true,
            otpVerifiedAt: new Date(),
            ...(aadhaarFront && { aadhaarFront }),
            ...(aadhaarBack && { aadhaarBack }),
            ...(tenantPhoto && { tenantPhoto }),
            mismatchReasons: mismatchReasons.join('; ')
        };
        tenant.updatedAt = new Date();
        await tenant.save();

        const record = await upsertRecord(normalizedLoginId, 'tenant', {
            'tenantKyc.otpVerified': true,
            'tenantKyc.kycStatus': targetKycStatus,
            'tenantKyc.mismatchReasons': mismatchReasons.join('; ')
        });


        // WhatsApp: notify tenant that KYC is verified
        try {
            await sendTemplateToResolvedUser({
                phone: tenant.phone || tenant.kyc?.aadhaarLinkedPhone || '',
                email: tenant.email || '',
                userId: normalizedLoginId,
                templateName: 'roomhy_kyc_verified',
                variables: [tenant.name || 'Tenant']
            });
        } catch (whatsAppErr) {
            console.warn('tenant kyc verified whatsapp failed:', whatsAppErr.message);
        }

        return res.json({ success: true, record, tenant });
    } catch (err) {
        console.error('tenant/kyc/verify-otp error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/tenant/kyc/digilocker/start', otpIpLimiter, otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarLinkedPhone, aadhaarNumber, aadhaarFront, aadhaarBack, redirectUrl: clientRedirectUrl } = req.body || {};
        if (!loginId || !aadhaarNumber) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        if (!/^\d{12}$/.test(String(aadhaarNumber))) {
            return res.status(400).json({ success: false, message: 'Aadhaar must be 12 digits' });
        }
        const normalizedLoginId = String(loginId).toUpperCase();
        const ref = createDigilockerRef(normalizedLoginId);
        const redirectUrl = clientRedirectUrl || process.env.DIGILOCKER_REDIRECT_URL || `${DIGITAL_CHECKIN_URL}/digital-checkin/tenantkyc`;

        const accountCheck = await verifyDigilockerAccount({
            verificationId: ref,
            mobileNumber: aadhaarLinkedPhone,
            aadhaarNumber
        });
        const userFlow = accountCheck?.account_exists ? 'signin' : 'signup';
        const digilockerInit = await createDigilockerUrl({
            verificationId: ref,
            redirectUrl,
            userFlow,
            documents: ['AADHAAR']
        });

        const cashfreeVerificationId = digilockerInit?.verification_id || ref;
        const cashfreeReferenceId = digilockerInit?.reference_id || digilockerInit?.ref_id || '';
        const verifyUrl = digilockerInit?.url || digilockerInit?.verification_url || digilockerInit?.link || '';

        await upsertRecord(normalizedLoginId, 'tenant', {
            tenantKyc: {
                aadhaarLinkedPhone: aadhaarLinkedPhone || '',
                aadhaarNumber: String(aadhaarNumber),
                aadhaarFront: aadhaarFront || null,
                aadhaarBack: aadhaarBack || null,
                otpVerified: false,
                digilockerVerified: false,
                digilockerStatus: 'pending',
                digilockerRef: ref,
                digilockerVerificationId: cashfreeVerificationId,
                digilockerReferenceId: cashfreeReferenceId,
                digilockerUrl: verifyUrl,
                digilockerStartedAt: new Date()
            }
        });

        const tenant = await Tenant.findOne({ loginId: normalizedLoginId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found for this login ID' });
        }

        tenant.kyc = tenant.kyc || {};
        tenant.kyc.aadhaarNumber = String(aadhaarNumber);
        tenant.kyc.aadhar = String(aadhaarNumber);
        tenant.kyc.aadhaarLinkedPhone = aadhaarLinkedPhone || '';
        tenant.kyc.aadhaarFront = aadhaarFront || tenant.kyc.aadhaarFront || null;
        tenant.kyc.aadhaarBack = aadhaarBack || tenant.kyc.aadhaarBack || null;
        tenant.kyc.otpVerified = false;
        tenant.kyc.digilockerVerified = false;
        tenant.kycStatus = 'submitted';
        tenant.digitalCheckin = tenant.digitalCheckin || {};
        tenant.digitalCheckin.kyc = {
            ...(tenant.digitalCheckin.kyc || {}),
            aadhaarLinkedPhone: aadhaarLinkedPhone || '',
            aadhaarNumber: String(aadhaarNumber),
            aadhaarFront: aadhaarFront || tenant.digitalCheckin?.kyc?.aadhaarFront || null,
            aadhaarBack: aadhaarBack || tenant.digitalCheckin?.kyc?.aadhaarBack || null,
            digilockerRef: ref,
            digilockerVerificationId: cashfreeVerificationId,
            digilockerReferenceId: cashfreeReferenceId,
            digilockerUrl: verifyUrl,
            digilockerStatus: 'pending',
            digilockerVerified: false
        };
        await tenant.save();

        return res.json({
            success: true,
            provider: 'digilocker',
            referenceId: cashfreeReferenceId || ref,
            verificationId: cashfreeVerificationId,
            verifyUrl,
            userFlow,
            message: 'DigiLocker verification initiated. Complete DigiLocker auth and return to this page.'
        });
    } catch (err) {
        console.error('tenant/kyc/digilocker/start error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/tenant/kyc/digilocker/complete', otpIpLimiter, otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarNumber, referenceId, verificationId } = req.body || {};
        if (!loginId || !aadhaarNumber || (!referenceId && !verificationId)) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }
        const normalizedLoginId = String(loginId).toUpperCase();
        const record = await CheckinRecord.findOne({ loginId: normalizedLoginId, role: 'tenant' });
        if (!record || !record.tenantKyc) {
            return res.status(404).json({ success: false, message: 'Tenant KYC record not found' });
        }
        if (String(record.tenantKyc.aadhaarNumber || '') !== String(aadhaarNumber)) {
            return res.status(400).json({ success: false, message: 'Aadhaar mismatch' });
        }
        const storedVerificationId = record.tenantKyc.digilockerVerificationId || record.tenantKyc.digilockerRef;
        const storedReferenceId = record.tenantKyc.digilockerReferenceId || record.tenantKyc.digilockerRef;
        const checkVerificationId = verificationId || storedVerificationId;
        const checkReferenceId = referenceId || storedReferenceId;
        if (!checkVerificationId && !checkReferenceId) {
            return res.status(400).json({ success: false, message: 'Missing DigiLocker verification context' });
        }

        const statusResp = await getDigilockerVerificationStatus({
            verificationId: checkVerificationId,
            referenceId: checkReferenceId
        });
        const verificationStatus = String(
            statusResp?.status ||
            statusResp?.verification_status ||
            statusResp?.data?.status ||
            ''
        ).toUpperCase();
        const validStatuses = ['AUTHENTICATED', 'SUCCESS', 'COMPLETED', 'VERIFIED'];
        if (!validStatuses.includes(verificationStatus)) {
            return res.status(400).json({
                success: false,
                message: `DigiLocker verification not completed yet (status: ${verificationStatus || 'PENDING'})`
            });
        }

        let aadhaarDocument = null;
        try {
            aadhaarDocument = await getDigilockerDocument({
                documentType: 'AADHAAR',
                verificationId: checkVerificationId,
                referenceId: checkReferenceId
            });
        } catch (docErr) {
            console.warn('tenant digilocker document fetch warning:', docErr.message);
        }

        record.tenantKyc.digilockerVerified = true;
        record.tenantKyc.digilockerStatus = 'verified';
        record.tenantKyc.digilockerVerifiedAt = new Date();
        record.tenantKyc.digilockerVerificationId = checkVerificationId || '';
        record.tenantKyc.digilockerReferenceId = checkReferenceId || '';
        if (aadhaarDocument) {
            record.tenantKyc.digilockerDocument = aadhaarDocument;
        }
        await record.save();

        const tenant = await Tenant.findOne({ loginId: normalizedLoginId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found for this login ID' });
        }
        tenant.kyc = tenant.kyc || {};
        tenant.kyc.digilockerVerified = true;
        tenant.kyc.digilockerVerifiedAt = new Date();
        tenant.kyc.otpVerified = Boolean(tenant.kyc.otpVerified);
        tenant.kycStatus = 'verified';
        tenant.digitalCheckin = tenant.digitalCheckin || {};
        tenant.digitalCheckin.kyc = {
            ...(tenant.digitalCheckin.kyc || {}),
            digilockerVerified: true,
            digilockerVerifiedAt: new Date(),
            digilockerStatus: 'verified',
            digilockerVerificationId: checkVerificationId || '',
            digilockerReferenceId: checkReferenceId || ''
        };
        await tenant.save();

        return res.json({ success: true, message: 'DigiLocker verification completed successfully', verificationStatus, record, tenant });
    } catch (err) {
        console.error('tenant/kyc/digilocker/complete error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/tenant/agreement', async (req, res) => {
    try {
        const { loginId, eSignName, accepted, signatureDataUrl, frontendUrl, origin } = req.body || {};
        if (!loginId || !eSignName || accepted !== true || !signatureDataUrl) {
            return res.status(400).json({ success: false, message: 'Agreement acceptance, e-sign, and tenant signature are required' });
        }
        const normalizedLoginId = String(loginId).toUpperCase();
        const acceptedAt = new Date();
        const existingRecord = await CheckinRecord.findOne({ loginId: normalizedLoginId, role: 'tenant' }).lean();
        let record = await upsertRecord(normalizedLoginId, 'tenant', {
            tenantAgreement: {
                ...((existingRecord && existingRecord.tenantAgreement) || {}),
                eSignName,
                acceptedAt,
                signatureDataUrl,
                provider: 'roomhy-esign',
                status: 'signed',
                signedAt: acceptedAt,
                completedAt: acceptedAt
            }
        });

        const tenant = await Tenant.findOne({ loginId: normalizedLoginId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found for this login ID' });
        }
        const isMismatch = tenant?.kycStatus === 'mismatch_review' || record?.tenantKyc?.kycStatus === 'mismatch_review';
        if (isMismatch) {
            return res.status(400).json({
                success: false,
                message: "Data mismatch detected. Please check if you have uploaded the correct Aadhaar Card. If you are still facing a data mismatch issue, please contact your property owner."
            });
        }

        const kycVerified = Boolean(
            record?.tenantKyc?.otpVerified ||
            record?.tenantKyc?.digilockerVerified ||
            tenant?.kyc?.otpVerified ||
            tenant?.kyc?.digilockerVerified ||
            tenant?.kycStatus === 'verified'
        );
        if (!kycVerified) {
            return res.status(400).json({ success: false, message: 'Complete tenant KYC verification first' });
        }

        tenant.agreementESignName = eSignName;
        tenant.digitalCheckin = tenant.digitalCheckin || {};
        tenant.digitalCheckin.agreement = {
            ...(tenant.digitalCheckin.agreement || {}),
            eSignName,
            acceptedAt,
            signatureDataUrl
        };
        tenant.agreementSigned = true;
        tenant.agreementSignedAt = acceptedAt;
        tenant.agreementStatus = 'signed';
        tenant.updatedAt = new Date();
        await tenant.save();

        const completion = await completeTenantAgreementAndNotify(normalizedLoginId, {
            requestId: '',
            provider: 'roomhy-esign',
            callbackPayload: { source: 'roomhy-custom-esign' },
            frontendOrigin: frontendUrl || origin || ''
        });
        record = completion.record;

        return res.json({
            success: true,
            message: 'Tenant rental agreement completed successfully.',
            record,
            tenant: completion.tenant,
            agreementStatus: 'signed',
            provider: 'roomhy-esign',
            nextUrl: `${DIGITAL_CHECKIN_URL}/digital-checkin/tenant-confirmation?loginId=${encodeURIComponent(normalizedLoginId)}&agreementSigned=1`
        });
    } catch (err) {
        console.error('tenant/agreement error:', err);
        return res.status(err.status || 500).json({
            success: false,
            message: err?.data?.message || err?.data?.error || err.message || 'Tenant agreement request failed',
            details: err?.data || null
        });
    }
});

router.post('/tenant/final-submit', async (req, res) => {
    try {
        const { loginId } = req.body || {};
        if (!loginId) return res.status(400).json({ success: false, message: 'Missing loginId' });
        const normalizedLoginId = String(loginId).toUpperCase();
        const record = await CheckinRecord.findOne({ loginId: normalizedLoginId, role: 'tenant' });
        if (!record) return res.status(404).json({ success: false, message: 'Tenant check-in record not found' });
        const tenantModel = await Tenant.findOne({ loginId: normalizedLoginId });
        if (!record.tenantAgreement || !record.tenantAgreement.acceptedAt) {
            return res.status(400).json({ success: false, message: 'Accept rental agreement first' });
        }
        if (record.tenantAgreement?.status !== 'signed' && !(tenantModel && tenantModel.agreementSigned)) {
            return res.status(400).json({ success: false, message: 'Tenant rental agreement signature is still pending' });
        }

        const result = await completeTenantAgreementAndNotify(normalizedLoginId, {
            requestId: record.tenantAgreement?.requestId || tenantModel?.agreementRequestId || '',
            provider: record.tenantAgreement?.provider || tenantModel?.agreementStatus || 'roomhy-esign',
            callbackPayload: { source: 'tenant-final-submit' }
        });

        return res.json({
            success: true,
            message: 'Tenant digital check-in submitted',
            ...result
        });
    } catch (err) {
        console.error('tenant/final-submit error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/tenant/agreement/complete', async (req, res) => {
    try {
        const { loginId, requestId, provider, callbackPayload } = req.body || {};
        if (!loginId) {
            return res.status(400).json({ success: false, message: 'Missing loginId' });
        }
        const result = await completeTenantAgreementAndNotify(loginId, {
            requestId,
            provider,
            callbackPayload
        });
        return res.json({
            success: true,
            message: 'Tenant agreement completed',
            ...result
        });
    } catch (err) {
        console.error('tenant/agreement/complete error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// ── Cloudinary document uploads ──────────────────────────────────────────────
//
// The document endpoints below take base64 data URLs and push them to
// Cloudinary. Two things about that were biting users on a domestic uplink:
//
//  1. The SDK's default socket timeout is 60s (node_modules/cloudinary/lib/
//     uploader.js), far past any request budget, so a stalled upload held the
//     request open for a minute before failing.
//  2. It rejects with a PLAIN OBJECT — { error: { message, http_code, name } } —
//     not an Error. `err.message` on that is undefined, so the handlers'
//     `res.status(500).json({ message: err.message })` sent a body with no
//     message at all and the browser fell back to rendering a bare "HTTP 500".
//     The actual cause ("Request Timeout", http_code 499) was in the server log
//     and nowhere else.
//
// Both endpoints are exempt from the request deadline (config/timeouts.js), so
// this timeout is what bounds them. It is generous because the whole point of
// the exemption is that a large upload on a slow link is legitimate.
const CLOUDINARY_UPLOAD_TIMEOUT_MS = Number.parseInt(
    process.env.CLOUDINARY_UPLOAD_TIMEOUT_MS || '', 10) || 45000;

/** Upload one data URL, turning Cloudinary's non-Error rejection into an Error. */
const uploadDoc = async (dataUrl, folder) => {
    try {
        const uploaded = await cloudinary.uploader.upload(dataUrl, {
            folder,
            resource_type: 'image',
            timeout: CLOUDINARY_UPLOAD_TIMEOUT_MS,
        });
        return uploaded.secure_url;
    } catch (err) {
        // Unwrap { error: { message, http_code, name } } into something whose
        // .message survives the trip to the browser.
        const inner = err?.error || err;
        const detail = inner?.message || inner?.name || 'unknown error';
        const wrapped = new Error(
            inner?.http_code === 499 || inner?.name === 'TimeoutError'
                ? `Upload timed out after ${Math.round(CLOUDINARY_UPLOAD_TIMEOUT_MS / 1000)}s — the image may be too large for this connection. Try a smaller photo.`
                : `Image upload failed: ${detail}`
        );
        wrapped.cloudinary = inner;
        throw wrapped;
    }
};

// POST /owner/documents — upload owner documents to Cloudinary + run Aadhaar OCR
router.post('/owner/documents', async (req, res) => {
    try {
        const { loginId, ownerPhoto, bankProof, aadhaarImage } = req.body || {};
        if (!loginId) return res.status(400).json({ success: false, message: 'loginId required' });

        const upper = String(loginId).toUpperCase();
        const update = {};
        const result = {};

        // Upload the documents concurrently. Awaited one after another, three
        // photos on a slow uplink took three times as long as the slowest one
        // for no reason — they are independent, and it is the wall-clock time
        // here that the user experiences as "the upload hangs".
        const [ownerPhotoUrl, bankProofUrl, aadhaarImageUrl] = await Promise.all([
            ownerPhoto?.dataUrl ? uploadDoc(ownerPhoto.dataUrl, 'owner_documents/photos') : null,
            bankProof?.dataUrl ? uploadDoc(bankProof.dataUrl, 'owner_documents/bank') : null,
            aadhaarImage?.dataUrl ? uploadDoc(aadhaarImage.dataUrl, 'owner_documents/aadhaar') : null,
        ]);

        if (ownerPhotoUrl) {
            update.checkinOwnerPhoto = ownerPhotoUrl;
            update.checkinOwnerPhotoName = ownerPhoto.name || '';
            result.ownerPhotoUrl = ownerPhotoUrl;
        }

        if (bankProofUrl) {
            update.checkinBankProof = bankProofUrl;
            update.checkinBankProofName = bankProof.name || '';
            result.bankProofUrl = bankProofUrl;
        }

        if (aadhaarImageUrl) {
            update.checkinAadhaarImage = aadhaarImageUrl;
            update.checkinAadhaarImageName = aadhaarImage.name || '';
            update['kyc.documentImage'] = aadhaarImageUrl;
            result.aadhaarImageUrl = aadhaarImageUrl;

            try {
                const base64Only = aadhaarImage.dataUrl.replace(/^data:[^;]+;base64,/, '');
                const ocrData = await aadhaarOcr(base64Only);
                result.ocrResult = ocrData;
                if (ocrData && !ocrData.sandbox) {
                    const extractedNum = extractAadhaarNumber(ocrData);
                    if (extractedNum) {
                        update.checkinAadhaarNumber = extractedNum;
                        update['kyc.aadharNumber'] = extractedNum;
                    }
                }
            } catch (ocrErr) {
                console.warn('Aadhaar OCR failed:', ocrErr.message);
                result.ocrError = ocrErr.message;
            }
        }

        if (Object.keys(update).length > 0) {
            await Owner.findOneAndUpdate(
                { loginId: upper },
                { $set: update },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }

        return res.json({ success: true, ...result });
    } catch (err) {
        console.error('owner/documents error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// POST /tenant/documents — upload tenant Aadhaar images + photo to Cloudinary, run OCR on front
router.post('/tenant/documents', async (req, res) => {
    try {
        const { loginId, aadhaarFront, aadhaarBack, tenantPhoto } = req.body || {};
        if (!loginId) return res.status(400).json({ success: false, message: 'loginId required' });

        const upper = String(loginId).toUpperCase();
        const update = {};
        const result = {};

        const toDataUrl = (v) => (typeof v === 'object' && v?.dataUrl ? v.dataUrl : typeof v === 'string' ? v : null);

        // Upload Aadhaar front + run OCR to extract number
        const frontDataUrl = toDataUrl(aadhaarFront);
        if (frontDataUrl) {
            const url = await uploadDoc(frontDataUrl, 'tenant_documents/aadhaar');
            update['kyc.aadhaarFront'] = url;
            update['digitalCheckin.kyc.aadhaarFront'] = url;
            result.aadhaarFrontUrl = url;

            try {
                const base64Only = frontDataUrl.replace(/^data:[^;]+;base64,/, '');
                const ocrData = await aadhaarOcr(base64Only);
                result.ocrFrontResult = ocrData;
                if (ocrData && !ocrData.sandbox) {
                    const extractedNum = extractAadhaarNumber(ocrData);
                    if (extractedNum) {
                        result.ocrExtractedAadhaar = extractedNum;
                        update['kyc.aadhaarNumber'] = extractedNum;
                        update['kyc.aadhar'] = extractedNum;
                    }
                }
            } catch (ocrErr) {
                console.warn('[tenant/documents] Aadhaar front OCR failed:', ocrErr.message);
                result.ocrError = ocrErr.message;
            }
        }

        // Upload Aadhaar back
        const backDataUrl = toDataUrl(aadhaarBack);
        if (backDataUrl) {
            const url = await uploadDoc(backDataUrl, 'tenant_documents/aadhaar');
            update['kyc.aadhaarBack'] = url;
            update['digitalCheckin.kyc.aadhaarBack'] = url;
            result.aadhaarBackUrl = url;
        }

        // Upload tenant photo
        const photoDataUrl = toDataUrl(tenantPhoto);
        if (photoDataUrl) {
            const url = await uploadDoc(photoDataUrl, 'tenant_documents/photos');
            update.photo = url;
            result.tenantPhotoUrl = url;
        }

        if (Object.keys(update).length > 0) {
            await Tenant.findOneAndUpdate(
                { loginId: upper },
                { $set: update },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        }

        return res.json({ success: true, ...result });
    } catch (err) {
        console.error('tenant/documents error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

// POST /owner/aadhaar/ocr — Cashfree OCR + Verhoeff checksum verdict
router.post('/owner/aadhaar/ocr', async (req, res) => {
    try {
        const { image } = req.body || {};
        if (!image) return res.status(400).json({ success: false, message: 'image is required' });

        const env = String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
        if (env === 'sandbox') {
            return res.json({ success: true, verdict: 'sandbox' });
        }

        let ocrData;
        try {
            ocrData = await aadhaarOcr(image);
        } catch (ocrErr) {
            return res.json({ success: true, verdict: 'invalid', message: ocrErr.message });
        }

        if (!ocrData || ocrData.sandbox) {
            return res.json({ success: true, verdict: 'sandbox' });
        }

        const aadhaarNum = extractAadhaarNumber(ocrData);
        if (!aadhaarNum) {
            return res.json({ success: true, verdict: 'unreadable' });
        }

        if (!verhoeffCheck(aadhaarNum)) {
            return res.json({ success: true, verdict: 'checksum_failed', aadhaarNumber: aadhaarNum });
        }

        return res.json({ success: true, verdict: 'verified', aadhaarNumber: aadhaarNum });
    } catch (err) {
        console.error('owner/aadhaar/ocr error:', err);
        return res.status(500).json({ success: false, verdict: 'invalid', message: err.message });
    }
});

// POST /owner/aadhaar/validate — Verhoeff checksum validation only
router.post('/owner/aadhaar/validate', async (req, res) => {
    try {
        const { aadhaarNumber } = req.body || {};
        const raw = String(aadhaarNumber || '').replace(/\D/g, '');
        if (!/^\d{12}$/.test(raw)) {
            return res.status(400).json({ success: false, error: 'Aadhaar must be 12 digits' });
        }
        if (!/^[2-9]/.test(raw)) {
            return res.status(400).json({ success: false, error: 'Invalid Aadhaar number — must start with 2–9' });
        }
        if (!verhoeffCheck(raw)) {
            return res.status(400).json({ success: false, error: 'Aadhaar checksum validation failed' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('owner/aadhaar/validate error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// POST /tenant/aadhaar/ocr — same OCR + Verhoeff verdict for tenant side
router.post('/tenant/aadhaar/ocr', async (req, res) => {
    try {
        const { image } = req.body || {};
        if (!image) return res.status(400).json({ success: false, message: 'image is required' });

        const env = String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
        if (env === 'sandbox') {
            return res.json({ success: true, verdict: 'sandbox' });
        }

        let ocrData;
        try {
            ocrData = await aadhaarOcr(image);
        } catch (ocrErr) {
            return res.json({ success: true, verdict: 'invalid', message: ocrErr.message });
        }

        if (!ocrData || ocrData.sandbox) {
            return res.json({ success: true, verdict: 'sandbox' });
        }

        const aadhaarNum = extractAadhaarNumber(ocrData);
        if (!aadhaarNum) {
            return res.json({ success: true, verdict: 'unreadable' });
        }

        if (!verhoeffCheck(aadhaarNum)) {
            return res.json({ success: true, verdict: 'checksum_failed', aadhaarNumber: aadhaarNum });
        }

        return res.json({ success: true, verdict: 'verified', aadhaarNumber: aadhaarNum });
    } catch (err) {
        console.error('tenant/aadhaar/ocr error:', err);
        return res.status(500).json({ success: false, verdict: 'invalid', message: err.message });
    }
});

// POST /tenant/aadhaar/validate — Verhoeff checksum validation for tenant
router.post('/tenant/aadhaar/validate', async (req, res) => {
    try {
        const { aadhaarNumber } = req.body || {};
        const raw = String(aadhaarNumber || '').replace(/\D/g, '');
        if (!/^\d{12}$/.test(raw)) {
            return res.status(400).json({ success: false, error: 'Aadhaar must be 12 digits' });
        }
        if (!/^[2-9]/.test(raw)) {
            return res.status(400).json({ success: false, error: 'Invalid Aadhaar number — must start with 2–9' });
        }
        if (!verhoeffCheck(raw)) {
            return res.status(400).json({ success: false, error: 'Aadhaar checksum validation failed' });
        }
        return res.json({ success: true });
    } catch (err) {
        console.error('tenant/aadhaar/validate error:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/tenant/agreement/pdf/:loginId', async (req, res) => {
    try {
        const normalizedLoginId = String(req.params.loginId || '').toUpperCase();
        if (!normalizedLoginId) {
            return res.status(400).json({ success: false, message: 'Missing loginId' });
        }
        const record = await CheckinRecord.findOne({ loginId: normalizedLoginId, role: 'tenant' }).lean();
        const tenant = await Tenant.findOne({ loginId: normalizedLoginId }).lean();
        if (!record || !tenant) {
            return res.status(404).json({ success: false, message: 'Tenant agreement not found' });
        }
        if (record?.tenantAgreement?.status !== 'signed' && !tenant.agreementSigned) {
            return res.status(400).json({ success: false, message: 'Tenant agreement is not signed yet' });
        }
        const pdfBuffer = await generateTenantAgreementPdfBuffer(tenant, record);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="RoomHy-Tenant-Agreement-${normalizedLoginId}.pdf"`);
        return res.send(pdfBuffer);
    } catch (err) {
        console.error('tenant/agreement/pdf error:', err);
        return res.status(500).json({ success: false, message: err.message || 'Failed to generate tenant agreement PDF' });
    }
});

router.get('/:role/:loginId', async (req, res) => {
    try {
        const { role, loginId } = req.params;
        if (!ensureRole(role)) return res.status(400).json({ success: false, message: 'Invalid role' });
        const record = await CheckinRecord.findOne({ loginId: String(loginId).toUpperCase(), role }).lean();
        return res.json({ success: true, record: record || null });
    } catch (err) {
        console.error('checkin get error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;
