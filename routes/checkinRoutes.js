const express = require('express');
const router = express.Router();
const CheckinRecord = require('../models/CheckinRecord');
const Owner = require('../models/Owner');
const Tenant = require('../models/Tenant');
const { sendMail } = require('../utils/mailer');
const { sendDocumentToResolvedUser, sendTemplateToResolvedUser } = require('../utils/whatsappBot');
const { otpLimiter } = require('../middleware/security');
const { requestAadhaarOtp, verifyAadhaarOtp, aadhaarOcr } = require('../services/cashfreeKycService');
const { generateAgreementPdfBuffer } = require('../utils/generateAgreementPdf');
const cloudinary = require('../utils/cloudinary');
const {
    verifyDigilockerAccount,
    createDigilockerUrl,
    getDigilockerVerificationStatus,
    getDigilockerDocument
} = require('../services/cashfreeDigilockerService');

const WEBSITE_URL = process.env.WEBSITE_URL || 'https://roomhy.com';
const ADMIN_URL = process.env.ADMIN_URL || process.env.FRONTEND_URL || 'https://admin.roomhy.com';
const APP_URL = process.env.APP_URL || process.env.APP_BASE_URL || process.env.WEB_APP_URL || 'https://app.roomhy.com';
const DIGITAL_CHECKIN_URL = process.env.DIGITAL_CHECKIN_URL || ADMIN_URL;
const BACKEND_URL = process.env.BACKEND_URL || process.env.API_BASE_URL || 'https://api.roomhy.com';

const otpStore = new Map();

// Verhoeff checksum tables — used by UIDAI for all 12-digit Aadhaar numbers
const _VD = [
    [0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],
    [3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],
    [6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],
    [9,8,7,6,5,4,3,2,1,0]
];
const _VP = [
    [0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],
    [8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],
    [2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]
];

function verhoeffCheck(number) {
    const digits = String(number).replace(/\D/g, '').split('').reverse().map(Number);
    if (digits.length !== 12) return false;
    let c = 0;
    for (let i = 0; i < digits.length; i++) c = _VD[c][_VP[i % 8][digits[i]]];
    return c === 0;
}

function extractAadhaarNumber(value) {
    if (!value) return '';
    if (typeof value === 'string') {
        const digits = value.replace(/\D/g, '');
        return digits.length === 12 ? digits : '';
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const extracted = extractAadhaarNumber(item);
            if (extracted) return extracted;
        }
        return '';
    }
    if (typeof value === 'object') {
        const priorityKeys = [
            'aadhaar_number','aadhaarNumber','aadhar_number','aadharNumber',
            'document_number','documentNumber','id_number','idNumber','uid','number','value'
        ];
        for (const key of priorityKeys) {
            const extracted = extractAadhaarNumber(value[key]);
            if (extracted) return extracted;
        }
        for (const nested of Object.values(value)) {
            const extracted = extractAadhaarNumber(nested);
            if (extracted) return extracted;
        }
    }
    return '';
}

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

async function generateTenantAgreementPdfBuffer(tenant, record = {}) {
    const agreement = record?.tenantAgreement || {};
    const profile   = tenant?.digitalCheckin?.profile || {};
    const details   = tenant?.digitalCheckin?.agreementDetails || {};

    // Resolve owner name from Owner model if not already in details
    let resolvedOwnerName = details.ownerName || tenant.ownerName || '';
    if (!resolvedOwnerName && tenant.ownerLoginId) {
        try {
            const ownerDoc = await Owner.findOne({ loginId: String(tenant.ownerLoginId).toUpperCase() })
                .select('name profile').lean();
            resolvedOwnerName = ownerDoc?.name || ownerDoc?.profile?.name || '';
        } catch (_) {}
    }

    // Security deposit: prefer stored value, then sum from tenant model
    const secDeposit = details.securityDeposit ||
        (tenant.securityDepositTotal ? String(tenant.securityDepositTotal) : '') ||
        (profile.securityDeposit ? String(profile.securityDeposit) : '-');

    // License end date: prefer stored, else compute 11 months from start
    let licenseEndDate = details.licenseEndDate || '-';
    if (licenseEndDate === '-' && tenant.moveInDate) {
        try {
            const end = new Date(tenant.moveInDate);
            end.setMonth(end.getMonth() + 11);
            licenseEndDate = end.toISOString().slice(0, 10);
        } catch (_) {}
    }

    return generateAgreementPdfBuffer({
        tenantName:          details.tenantName          || tenant.name                          || profile.name            || 'Tenant',
        tenantAddress:       details.permanentAddress    || details.tenantAddress                || profile.permanentAddress || tenant.address || '-',
        tenantEmail:         details.tenantEmail         || tenant.email                         || '-',
        tenantPhone:         details.tenantPhone         || tenant.phone                         || profile.phone           || '-',
        backupEmail:         details.backupEmail         || '-',
        backupPhone:         details.backupPhone         || tenant.guardianNumber                || profile.guardianNumber   || '-',
        propertyName:        details.propertyName        || tenant.propertyTitle                 || profile.propertyName    || 'RoomHy Property',
        propertyAddress:     details.propertyAddress     || '-',
        accommodationType:   details.accommodationType   || profile.accommodationType            || tenant.roomType         || (tenant.roomNo ? `Room ${tenant.roomNo}` : '-'),
        roomNumber:          details.roomNumber          || tenant.roomNo                        || profile.roomNo          || '-',
        ownerName:           resolvedOwnerName || '-',
        rentAmount:          details.rentAmount          || String(tenant.agreedRent || profile.agreedRent || '-'),
        duration:            details.licenseDuration     || details.duration || '-',
        licenseStartDate:    details.licenseStartDate    || (tenant.moveInDate ? new Date(tenant.moveInDate).toISOString().slice(0, 10) : '-'),
        licenseEndDate,
        licenseFeeDueDate:   details.licenseFeeDueDate   || '5',
        moveOutCharges:      details.moveOutCharges      || '-',
        noticePeriodCharges: details.noticePeriodCharges || '-',
        securityDeposit:     secDeposit,
        inclusions:          details.inclusions          || profile.inclusions                   || '-',
        minimumStayDuration: details.minimumStayDuration || '3 Months',
        gstCharges:          details.gstCharges          || '0',
        signatureDataUrl:    agreement.signatureDataUrl  || tenant?.digitalCheckin?.agreement?.signatureDataUrl || '',
        eSignName:           tenant.agreementESignName   || agreement.eSignName                  || tenant.name || '',
        signedDate:          agreement.signedAt ? new Date(agreement.signedAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
    });
}

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

function buildOwnerTenantSignedEmail(ownerName, tenant) {
    const logoUrl = `${APP_URL}/website/images/roomhy.png`;
    const year = new Date().getFullYear();
    const tenantName = tenant.name || tenant.loginId || 'Tenant';
    const propertyName = tenant.propertyTitle || 'your property';
    const roomNo = tenant.roomNo || '';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Tenant Agreement Signed — RoomHy</title>
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
                <td align="right" style="vertical-align:middle;font-size:11px;color:#999999;font-family:Arial,Helvetica,sans-serif;">Property Owner Portal</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 8px;">
            <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#111111;font-family:Arial,Helvetica,sans-serif;">Tenant Agreement Signed</h1>
            <p style="margin:0 0 8px;font-size:15px;color:#333333;font-family:Arial,Helvetica,sans-serif;">Dear <strong>${ownerName}</strong>,</p>
            <p style="margin:0 0 24px;font-size:14px;color:#555555;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">
              Your tenant <strong style="color:#111111;">${tenantName}</strong> has completed the digital check-in process and signed the Licence &amp; Subscription Agreement for <strong style="color:#111111;">${propertyName}</strong>${roomNo ? `, Room ${roomNo}` : ''}.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dddddd;">
              <tr>
                <td colspan="2" style="padding:12px 18px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#888888;background-color:#f4f4f4;border-bottom:1px solid #dddddd;font-family:Arial,Helvetica,sans-serif;">Tenant Details</td>
              </tr>
              <tr>
                <td style="padding:11px 18px;font-size:13px;color:#888888;border-bottom:1px solid #eeeeee;width:150px;font-family:Arial,Helvetica,sans-serif;">Tenant Name</td>
                <td style="padding:11px 18px;font-size:13px;font-weight:700;color:#111111;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">${tenantName}</td>
              </tr>
              <tr>
                <td style="padding:11px 18px;font-size:13px;color:#888888;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">Property</td>
                <td style="padding:11px 18px;font-size:13px;font-weight:700;color:#111111;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">${propertyName}</td>
              </tr>
              ${roomNo ? `<tr>
                <td style="padding:11px 18px;font-size:13px;color:#888888;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">Room</td>
                <td style="padding:11px 18px;font-size:13px;font-weight:700;color:#111111;border-bottom:1px solid #eeeeee;font-family:Arial,Helvetica,sans-serif;">${roomNo}</td>
              </tr>` : ''}
              <tr>
                <td style="padding:11px 18px;font-size:13px;color:#888888;font-family:Arial,Helvetica,sans-serif;">Login ID</td>
                <td style="padding:11px 18px;font-size:13px;font-weight:700;color:#111111;font-family:'Courier New',Courier,monospace;">${tenant.loginId || '—'}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #dddddd;border-left:3px solid #111111;background-color:#f9f9f9;">
              <tr>
                <td style="padding:14px 18px;font-size:13px;color:#333333;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">
                  The signed Tenant Agreement has been generated and is attached to this email as a PDF document. Please retain this document for your records.
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 32px;">
            <p style="margin:0;font-size:13px;color:#555555;line-height:1.7;font-family:Arial,Helvetica,sans-serif;">
              This is a system-generated legal record. For any queries regarding this agreement or the tenant account, please contact RoomHy support at <strong>support@roomhy.com</strong>.
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

async function completeTenantAgreementAndNotify(loginId, { requestId = '', provider = '', callbackPayload = null } = {}) {
    const normalizedLoginId = String(loginId || '').toUpperCase();
    const record = await CheckinRecord.findOne({ loginId: normalizedLoginId, role: 'tenant' });
    if (!record) throw new Error('Tenant check-in record not found');

    const tenant = await Tenant.findOne({ loginId: normalizedLoginId });
    if (!tenant) throw new Error('Tenant not found');

    record.tenantAgreement = {
        ...(record.tenantAgreement || {}),
        provider: provider || record.tenantAgreement?.provider || 'roomhy-esign',
        requestId: requestId || record.tenantAgreement?.requestId || '',
        status: 'signed',
        signedAt: record.tenantAgreement?.signedAt || new Date(),
        completedAt: new Date(),
        callbackPayload: callbackPayload || record.tenantAgreement?.callbackPayload || null
    };
    record.tenantSubmittedAt = new Date();
    await record.save();

    tenant.agreementSigned = true;
    tenant.agreementSignedAt = tenant.agreementSignedAt || new Date();
    tenant.agreementRequestId = requestId || tenant.agreementRequestId || '';
    tenant.agreementStatus = 'signed';
    tenant.digitalCheckin = tenant.digitalCheckin || {};
    tenant.digitalCheckin.agreement = {
        ...(tenant.digitalCheckin.agreement || {}),
        acceptedAt: tenant.digitalCheckin.agreement?.acceptedAt || record.tenantAgreement?.acceptedAt || new Date(),
        eSignName: tenant.agreementESignName || record.tenantAgreement?.eSignName || tenant.name || '',
        signatureDataUrl: record.tenantAgreement?.signatureDataUrl || tenant.digitalCheckin.agreement?.signatureDataUrl || ''
    };
    tenant.digitalCheckin.submittedAt = new Date();
    tenant.status = 'active';
    tenant.kycStatus = tenant.kycStatus || 'submitted';
    tenant.updatedAt = new Date();
    await tenant.save();

    const dashboardUrl = `${APP_URL}/tenant/tenantdashboard`;
    const tenantLoginUrl = `${APP_URL}/tenant/tenantlogin`;
    let loginEmailSent = false;

    // Generate PDF once — used for Cloudinary storage + both emails
    let agreementPdfBuffer = null;
    try {
        agreementPdfBuffer = await generateTenantAgreementPdfBuffer(tenant, record);
    } catch (pdfErr) {
        console.error('[TENANT AGREEMENT COMPLETE] PDF generation error:', pdfErr.message);
    }

    // Upload signed agreement PDF to Cloudinary for persistent access
    if (agreementPdfBuffer) {
        try {
            const base64Data = agreementPdfBuffer.toString('base64');
            const uploadResult = await cloudinary.uploader.upload(
                `data:application/pdf;base64,${base64Data}`,
                {
                    folder: 'roomhy/agreements',
                    resource_type: 'raw',
                    public_id: `agreement-${normalizedLoginId}`,
                    overwrite: true,
                    use_filename: false
                }
            );
            tenant.digitalCheckin.agreement = {
                ...(tenant.digitalCheckin.agreement || {}),
                pdfUrl: uploadResult.secure_url,
                pdfUploadedAt: new Date()
            };
            await tenant.save();
        } catch (uploadErr) {
            console.error('[TENANT AGREEMENT COMPLETE] Cloudinary PDF upload error:', uploadErr.message);
        }
    }

    if (tenant.email && agreementPdfBuffer) {
        try {
            await sendMail(
                tenant.email,
                'RoomHy Tenant Agreement & Login Details',
                '',
                buildTenantLoginEmail(tenant, dashboardUrl, record),
                {
                    attachments: [
                        {
                            filename: `RoomHy-Tenant-Agreement-${tenant.loginId || normalizedLoginId}.pdf`,
                            content: agreementPdfBuffer,
                            contentType: 'application/pdf'
                        }
                    ]
                }
            );
            loginEmailSent = true;
        } catch (emailErr) {
            console.error('[TENANT AGREEMENT COMPLETE] Email send error:', emailErr.message);
        }
    }

    // Send signed agreement PDF copy to owner
    try {
        const ownerLoginId = tenant.ownerLoginId ? String(tenant.ownerLoginId).toUpperCase() : null;
        if (ownerLoginId) {
            const ownerDoc = await Owner.findOne({ loginId: ownerLoginId });
            if (ownerDoc && ownerDoc.email) {
                const ownerPdfBuffer = agreementPdfBuffer || await generateTenantAgreementPdfBuffer(tenant, record);
                const ownerName = ownerDoc.name || ownerDoc.profile?.name || 'Owner';
                await sendMail(
                    ownerDoc.email,
                    `Tenant Agreement Signed — ${tenant.propertyTitle || 'RoomHy Property'}`,
                    `Your tenant ${tenant.name || normalizedLoginId} has signed their agreement. Please find the signed agreement PDF attached.`,
                    buildOwnerTenantSignedEmail(ownerName, tenant),
                    {
                        attachments: [
                            {
                                filename: `RoomHy-Tenant-Agreement-${tenant.loginId || normalizedLoginId}.pdf`,
                                content: ownerPdfBuffer,
                                contentType: 'application/pdf'
                            }
                        ]
                    }
                );
            }
        }
    } catch (ownerEmailErr) {
        console.error('[TENANT AGREEMENT COMPLETE] Owner email send error:', ownerEmailErr.message);
    }

    // WhatsApp: notify tenant of completion
    const aadhaarPhone = tenant.kyc?.aadhaarLinkedPhone || tenant.digitalCheckin?.kyc?.aadhaarLinkedPhone || tenant.phone || '';
    try {
        await sendTemplateToResolvedUser({
            phone: aadhaarPhone,
            email: tenant.email || '',
            userId: tenant.loginId || '',
            templateName: 'roomhy_tenant_checkin_complete',
            options: {
                namedParams: {
                    tenant_name: tenant.name || 'Tenant',
                    login_id: tenant.loginId || '',
                    login_url: tenantLoginUrl
                }
            }
        });
    } catch (whatsAppErr) {
        console.error('[TENANT AGREEMENT COMPLETE] WhatsApp send error:', whatsAppErr.message);
    }

    // WhatsApp: send agreement PDF document
    try {
        await sendDocumentToResolvedUser({
            phone: aadhaarPhone,
            email: tenant.email || '',
            userId: tenant.loginId || '',
            link: `${BACKEND_URL}/api/checkin/tenant/agreement/pdf/${encodeURIComponent(normalizedLoginId)}`,
            filename: `RoomHy-Licence-Subscription-Agreement-${tenant.loginId || normalizedLoginId}.pdf`,
            caption: [
                'RoomHy Licence & Subscription Agreement',
                `Tenant: ${tenant.name || normalizedLoginId}`,
                tenant.propertyTitle ? `Property: ${tenant.propertyTitle}` : '',
                tenant.roomNo ? `Room: ${tenant.roomNo}` : '',
                `Login ID: ${tenant.loginId || normalizedLoginId}`,
                'Please retain this document for your records.'
            ].filter(Boolean).join('\n')
        });
    } catch (whatsAppDocErr) {
        console.error('[TENANT AGREEMENT COMPLETE] WhatsApp PDF send error:', whatsAppDocErr.message);
    }

    return { record, tenant, dashboardUrl, tenantLoginUrl, loginEmailSent };
}

function isTenantKycVerified(record) {
    return Boolean(record?.tenantKyc?.otpVerified || record?.tenantKyc?.digilockerVerified);
}

router.post('/owner/profile', async (req, res) => {
    try {
        const { loginId, name, dob, email, phone, address, area, password, payment = {} } = req.body || {};
        if (!loginId || !name || !dob || !email || !phone || !address || !area || !payment.bankAccountNumber || !payment.ifscCode || !payment.accountHolderName) {
            return res.status(400).json({ success: false, message: 'Missing required owner profile fields' });
        }
        const record = await upsertRecord(loginId, 'owner', {
            ownerProfile: { name, dob, email, phone, address, area, password, payment }
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

router.post('/owner/kyc/send-otp', otpLimiter, async (req, res) => {
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

router.post('/owner/kyc/verify-otp', otpLimiter, async (req, res) => {
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
        const owner = await Owner.findOne({ loginId: String(loginId).toUpperCase() }).lean();
        
        const updatedOwner = await Owner.findOneAndUpdate(
            { loginId: String(loginId).toUpperCase() },
            { $set: { 'kyc.status': 'submitted', 'kyc.submittedAt': new Date() } },
            { new: true }
        );

        // Send login credentials email
        if (owner && owner.email) {
            const baseUrl = APP_URL;
            const ownerPassword = owner.checkinPassword || owner.credentials?.password || 'default';
            const fullLoginUrl = `${baseUrl}/propertyowner/index`;
            
            const emailHtml = `
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <style>
                        body { font-family: 'Arial', sans-serif; line-height: 1.6; color: #333; }
                        .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
                        .header { background: linear-gradient(135deg, #2563eb 0%, #3b82f6 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
                        .header h1 { margin: 0; font-size: 28px; }
                        .content { padding: 30px; background: #f8fafc; }
                        .credentials { background: white; border-left: 4px solid #4caf50; padding: 15px; margin: 20px 0; border-radius: 4px; }
                        .credentials p { margin: 8px 0; }
                        .label { font-weight: bold; color: #333; }
                        .value { font-family: monospace; color: #2563eb; }
                        .button { display: inline-block; background: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 4px; margin-top: 15px; font-weight: bold; }
                        .footer { text-align: center; padding: 20px; font-size: 12px; color: #999; border-top: 1px solid #eee; }
                        .success { color: #4caf50; font-weight: bold; font-size: 18px; margin-bottom: 15px; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>✓ KYC Verified Successfully!</h1>
                        </div>
                        <div class="content">
                            <p>Hi <strong>${owner.name || 'Owner'}</strong>,</p>
                            
                            <div class="success">🎉 Your Aadhaar verification is complete!</div>
                            
                            <p>Your RoomHy owner account has been activated. You can now log in to manage your properties and respond to tenant inquiries.</p>
                            
                            <div class="credentials">
                                <p><span class="label">Login ID:</span> <span class="value">${owner.loginId}</span></p>
                                <p><span class="label">Password:</span> <span class="value">${owner.checkinPassword || owner.credentials?.password || '[Set during registration]'}</span></p>
                                <p><span class="label">Email:</span> <span class="value">${owner.email}</span></p>
                                <p><span class="label">Area:</span> <span class="value">${owner.checkinArea || '-'}</span></p>
                            </div>

                            <p style="color: #d32f2f; font-weight: bold;">⚠️ Important:</p>
                            <ul>
                                <li>Keep your login credentials secure</li>
                                <li>You can change your password after first login</li>
                                <li>For security, sign out from shared devices</li>
                            </ul>

                            <p style="margin-top: 20px;">
                                <a href="${fullLoginUrl}" class="button">🔓 Go to Owner Dashboard</a>
                            </p>

                            <p style="margin-top: 20px; font-size: 12px;">
                                Or copy and paste this link in your browser:<br>
                                <span class="value">${fullLoginUrl}</span>
                            </p>

                            <p>What's next?</p>
                            <ol>
                                <li>Log in to your owner dashboard</li>
                                <li>Add your property details</li>
                                <li>Complete bank account verification</li>
                                <li>Start receiving tenant inquiries!</li>
                            </ol>

                            <p>If you have any questions or need support, contact us at <strong>support@roomhy.com</strong></p>
                        </div>
                        <div class="footer">
                            <p>&copy; 2025 RoomHy Owner Platform. All rights reserved.</p>
                            <p>Made with ❤️ for property owners in India</p>
                        </div>
                    </div>
                </body>
                </html>
            `;

            try {
                await sendMail(owner.email, '✓ Welcome to RoomHy Owner Platform - Your login details', '', emailHtml);
                console.log('[CHECKIN KYC] Sent login email to:', owner.email);
            } catch (emailErr) {
                console.error('[CHECKIN KYC] Email send error:', emailErr.message);
            }
        }

        return res.json({ success: true, record, owner: updatedOwner, message: 'OTP verified. Check your email for login details.' });
    } catch (err) {
        console.error('owner/kyc/verify-otp error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.post('/owner/kyc/digilocker/start', otpLimiter, async (req, res) => {
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

router.post('/owner/kyc/digilocker/complete', otpLimiter, async (req, res) => {
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
            { $set: { 'kyc.status': 'submitted', 'kyc.provider': 'digilocker', 'kyc.submittedAt': new Date() } },
            { new: true }
        );

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

        // Send owner dashboard link email after final submit
        const owner = ownerDoc || await Owner.findOne({ loginId: normalizedLoginId }).lean();
        const targetEmail = (owner && owner.email) || (record.ownerProfile && record.ownerProfile.email) || '';
        const baseUrl = APP_URL;
        const dashboardUrl = `${baseUrl}/propertyowner/index`;
        let loginEmailSent = false;

        if (targetEmail) {
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
        }

        return res.json({ success: true, message: 'Owner digital check-in submitted', record, dashboardUrl, loginEmailSent });
    } catch (err) {
        console.error('owner/final-submit error:', err);
        return res.status(500).json({ success: false, message: err.message });
    }
});

router.get('/tenant/profile/:loginId', async (req, res) => {
    try {
        const normalizedLoginId = String(req.params.loginId || '').toUpperCase();
        if (!normalizedLoginId) return res.status(400).json({ success: false, message: 'Missing loginId' });

        const tenant = await Tenant.findOne({ loginId: normalizedLoginId })
            .select('-tempPassword')
            .lean();
        if (!tenant) return res.status(404).json({ success: false, message: 'Tenant not found' });

        // Resolve owner name for display
        let ownerName = '';
        if (tenant.ownerLoginId) {
            try {
                const ownerDoc = await Owner.findOne({ loginId: String(tenant.ownerLoginId).toUpperCase() })
                    .select('name profile').lean();
                ownerName = ownerDoc?.name || ownerDoc?.profile?.name || '';
            } catch (_) {}
        }

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

        tenant.name = name || tenant.name;
        if (email) tenant.email = email;
        if (phone) tenant.phone = phone;
        tenant.dob = dob || tenant.dob;
        tenant.guardianNumber = guardianNumber || tenant.guardianNumber;
        tenant.profileFilled = true;
        if (propertyName) tenant.propertyTitle = propertyName;
        if (roomNo) tenant.roomNo = roomNo;
        if (agreedRent !== undefined && agreedRent !== null && agreedRent !== '') tenant.agreedRent = Number(agreedRent);
        if (moveInDate) tenant.moveInDate = new Date(moveInDate);

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
            tenantName:          name || tenant.name || '',
            tenantEmail:         email || tenant.email || '',
            tenantPhone:         phone || tenant.phone || '',
            backupPhone:         guardianNumber || prev.backupPhone || '',
            backupEmail:         backupEmail || prev.backupEmail || '',
            permanentAddress:    permanentAddress || prev.permanentAddress || '',
            accommodationType:   accommodationType || prev.accommodationType || '',
            propertyName:        propertyName || tenant.propertyTitle || '',
            propertyAddress:     propertyAddress || prev.propertyAddress || '',
            roomNumber:          roomNo || tenant.roomNo || '',
            rentAmount:          agreedRent ? String(agreedRent) : (tenant.agreedRent ? String(tenant.agreedRent) : ''),
            licenseStartDate:    moveInDate || '',
            licenseDuration:     licenseDuration || prev.licenseDuration || '',
            licenseEndDate:      licenseEndDate || prev.licenseEndDate || '',
            licenseFeeDueDate:   licenseFeeDueDate || prev.licenseFeeDueDate || '5',
            moveOutCharges:      moveOutCharges || prev.moveOutCharges || '0',
            noticePeriodCharges: noticePeriodCharges || prev.noticePeriodCharges || '0',
            securityDeposit:     securityDeposit || prev.securityDeposit || (tenant.securityDepositTotal ? String(tenant.securityDepositTotal) : ''),
            inclusions:          inclusions || prev.inclusions || '',
            minimumStayDuration: minimumStayDuration || prev.minimumStayDuration || '3 Months',
            gstCharges:          gstCharges || prev.gstCharges || '0',
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

router.post('/tenant/kyc/send-otp', otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarLinkedPhone, aadhaarNumber, aadhaarFront, aadhaarBack } = req.body || {};
        if (!loginId || !aadhaarLinkedPhone || !aadhaarNumber) {
            return res.status(400).json({ success: false, message: 'Missing tenant KYC fields' });
        }
        const normalizedLoginId = String(loginId).toUpperCase();
        await upsertRecord(normalizedLoginId, 'tenant', {
            tenantKyc: { aadhaarLinkedPhone, aadhaarNumber, aadhaarFront, aadhaarBack, otpVerified: false }
        });

        const tenant = await Tenant.findOne({ loginId: normalizedLoginId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found for this login ID' });
        }

        tenant.kyc = tenant.kyc || {};
        tenant.kyc.aadhaarNumber = aadhaarNumber;
        tenant.kyc.aadhar = aadhaarNumber;
        tenant.kyc.aadhaarLinkedPhone = aadhaarLinkedPhone;
        tenant.kyc.aadhaarFront = aadhaarFront || tenant.kyc.aadhaarFront || null;
        tenant.kyc.aadhaarBack = aadhaarBack || tenant.kyc.aadhaarBack || null;
        tenant.kyc.otpVerified = false;
        tenant.kyc.uploadedAt = new Date();
        const isFirstKycSubmission = !tenant.kycStatus || !['submitted', 'verified'].includes(tenant.kycStatus);
        tenant.kycStatus = 'submitted';

        tenant.digitalCheckin = tenant.digitalCheckin || {};
        tenant.digitalCheckin.kyc = {
            ...(tenant.digitalCheckin.kyc || {}),
            aadhaarLinkedPhone,
            aadhaarNumber,
            aadhaarFront: aadhaarFront || tenant.digitalCheckin?.kyc?.aadhaarFront || null,
            aadhaarBack: aadhaarBack || tenant.digitalCheckin?.kyc?.aadhaarBack || null,
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

router.post('/tenant/kyc/verify-otp', otpLimiter, async (req, res) => {
    try {
        const { loginId, aadhaarNumber, otp, aadhaarFront, aadhaarBack, tenantPhoto } = req.body || {};
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
        const record = await upsertRecord(normalizedLoginId, 'tenant', { 'tenantKyc.otpVerified': true });

        const tenant = await Tenant.findOne({ loginId: normalizedLoginId });
        if (!tenant) {
            return res.status(404).json({ success: false, message: 'Tenant not found for this login ID' });
        }

        tenant.kyc = tenant.kyc || {};
        tenant.kyc.otpVerified = true;
        tenant.kyc.otpVerifiedAt = new Date();
        if (aadhaarFront) tenant.kyc.aadhaarFront = aadhaarFront;
        if (aadhaarBack)  tenant.kyc.aadhaarBack  = aadhaarBack;
        tenant.kycStatus = 'verified';

        if (tenantPhoto) tenant.photo = tenantPhoto;

        tenant.digitalCheckin = tenant.digitalCheckin || {};
        tenant.digitalCheckin.kyc = {
            ...(tenant.digitalCheckin.kyc || {}),
            otpVerified: true,
            otpVerifiedAt: new Date(),
            ...(aadhaarFront && { aadhaarFront }),
            ...(aadhaarBack  && { aadhaarBack }),
            ...(tenantPhoto  && { tenantPhoto })
        };
        tenant.updatedAt = new Date();
        await tenant.save();

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

router.post('/tenant/kyc/digilocker/start', otpLimiter, async (req, res) => {
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

router.post('/tenant/kyc/digilocker/complete', otpLimiter, async (req, res) => {
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
        const { loginId, eSignName, accepted, signatureDataUrl } = req.body || {};
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
            callbackPayload: { source: 'roomhy-custom-esign' }
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

// POST /owner/documents — upload owner documents to Cloudinary + run Aadhaar OCR
router.post('/owner/documents', async (req, res) => {
    try {
        const { loginId, ownerPhoto, bankProof, aadhaarImage } = req.body || {};
        if (!loginId) return res.status(400).json({ success: false, message: 'loginId required' });

        const upper = String(loginId).toUpperCase();
        const update = {};
        const result = {};

        const uploadDoc = async (dataUrl, folder) => {
            const uploaded = await cloudinary.uploader.upload(dataUrl, { folder, resource_type: 'image' });
            return uploaded.secure_url;
        };

        if (ownerPhoto && ownerPhoto.dataUrl) {
            const url = await uploadDoc(ownerPhoto.dataUrl, 'owner_documents/photos');
            update.checkinOwnerPhoto = url;
            update.checkinOwnerPhotoName = ownerPhoto.name || '';
            result.ownerPhotoUrl = url;
        }

        if (bankProof && bankProof.dataUrl) {
            const url = await uploadDoc(bankProof.dataUrl, 'owner_documents/bank');
            update.checkinBankProof = url;
            update.checkinBankProofName = bankProof.name || '';
            result.bankProofUrl = url;
        }

        if (aadhaarImage && aadhaarImage.dataUrl) {
            const url = await uploadDoc(aadhaarImage.dataUrl, 'owner_documents/aadhaar');
            update.checkinAadhaarImage = url;
            update.checkinAadhaarImageName = aadhaarImage.name || '';
            result.aadhaarImageUrl = url;

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
