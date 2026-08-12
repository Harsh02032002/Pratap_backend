const CheckinRecord = require('../models/CheckinRecord');
const Owner = require('../models/Owner');
const Tenant = require('../models/Tenant');
const { sendMail } = require('../utils/mailer');
const { sendDocumentToResolvedUser, sendTemplateToResolvedUser } = require('../utils/whatsappBot');
const { generateAgreementPdfBuffer } = require('../utils/generateAgreementPdf');
const cloudinary = require('../utils/cloudinary');

const APP_URL = process.env.APP_URL || process.env.APP_BASE_URL || process.env.WEB_APP_URL || 'https://app.roomhy.com';
const BACKEND_URL = process.env.BACKEND_URL || process.env.API_BASE_URL || 'https://api.roomhy.com';

// Tenant-facing hosts the payment link is allowed to point at. This is checked
// against the `frontendUrl`/`origin` a client submits so a local dev run emails
// a localhost link while a deployed run always emails the real tenant domain —
// admin.roomhy.com is deliberately excluded (that's the staff app, not tenant-facing).
const TENANT_PAYMENT_HOSTS = new Set(['localhost', '127.0.0.1', 'roomhy.com', 'www.roomhy.com', 'app.roomhy.com', 'www.app.roomhy.com']);

function resolvePaymentAppBase(frontendOrigin) {
    if (frontendOrigin) {
        try {
            const u = new URL(frontendOrigin);
            if (TENANT_PAYMENT_HOSTS.has(u.hostname.toLowerCase())) {
                return u.origin;
            }
        } catch (_) { /* ignore invalid/untrusted origin */ }
    }
    let appBase = process.env.FRONTEND_URL || 'https://www.roomhy.com';
    if (appBase.endsWith('/')) appBase = appBase.slice(0, -1);
    return appBase;
}

async function generateTenantAgreementPdfBuffer(tenant, record = {}) {
    const agreement = record?.tenantAgreement || {};
    const profile = tenant?.digitalCheckin?.profile || {};
    const details = tenant?.digitalCheckin?.agreementDetails || {};

    // Resolve owner name from Owner model if not already in details
    let resolvedOwnerName = details.ownerName || tenant.ownerName || '';
    if (!resolvedOwnerName && tenant.ownerLoginId) {
        try {
            const ownerDoc = await Owner.findOne({ loginId: String(tenant.ownerLoginId).toUpperCase() })
                .select('name profile').lean();
            resolvedOwnerName = ownerDoc?.name || ownerDoc?.profile?.name || '';
        } catch (_) { }
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
        } catch (_) { }
    }

    return generateAgreementPdfBuffer({
        tenantName: details.tenantName || tenant.name || profile.name || 'Tenant',
        tenantAddress: details.permanentAddress || details.tenantAddress || profile.permanentAddress || tenant.address || '-',
        tenantEmail: details.tenantEmail || tenant.email || '-',
        tenantPhone: details.tenantPhone || tenant.phone || profile.phone || '-',
        backupEmail: details.backupEmail || '-',
        backupPhone: details.backupPhone || tenant.guardianNumber || profile.guardianNumber || '-',
        propertyName: details.propertyName || tenant.propertyTitle || profile.propertyName || 'RoomHy Property',
        propertyAddress: details.propertyAddress || '-',
        accommodationType: details.accommodationType || profile.accommodationType || tenant.roomType || (tenant.roomNo ? `Room ${tenant.roomNo}` : '-'),
        roomNumber: details.roomNumber || tenant.roomNo || profile.roomNo || '-',
        ownerName: resolvedOwnerName || '-',
        rentAmount: details.rentAmount || String(tenant.agreedRent || profile.agreedRent || '-'),
        duration: details.licenseDuration || details.duration || '-',
        licenseStartDate: details.licenseStartDate || (tenant.moveInDate ? new Date(tenant.moveInDate).toISOString().slice(0, 10) : '-'),
        licenseEndDate,
        licenseFeeDueDate: details.licenseFeeDueDate || '5',
        moveOutCharges: details.moveOutCharges || '-',
        noticePeriodCharges: details.noticePeriodCharges || '-',
        securityDeposit: secDeposit,
        inclusions: details.inclusions || profile.inclusions || '-',
        minimumStayDuration: details.minimumStayDuration || '3 Months',
        gstCharges: details.gstCharges || '0',
        signatureDataUrl: agreement.signatureDataUrl || tenant?.digitalCheckin?.agreement?.signatureDataUrl || '',
        eSignName: tenant.agreementESignName || agreement.eSignName || tenant.name || '',
        signedDate: agreement.signedAt ? new Date(agreement.signedAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)
    });
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

exports.completeTenantAgreementAndNotify = async (loginId, { requestId = '', provider = '', callbackPayload = null, frontendOrigin = '', ensureCheckinRecord = false } = {}) => {
    const normalizedLoginId = String(loginId || '').toUpperCase();
    let record = await CheckinRecord.findOne({ loginId: normalizedLoginId, role: 'tenant' });
    // The alternate-ID-proof path never sends the tenant through the check-in
    // portal, so no CheckinRecord exists yet — create it on demand instead of
    // aborting. Defaults to false so the Aadhaar-OTP flow still fails loudly
    // when a record it expects to exist is missing.
    if (!record && ensureCheckinRecord) {
        record = await CheckinRecord.create({ loginId: normalizedLoginId, role: 'tenant' });
    }
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
    // After e-sign: preserve mismatch_review; otherwise mark KYC as verified automatically
    if (tenant.kycStatus === 'mismatch_review') {
        // preserve mismatch_review flag — superadmin must review manually
    } else if (tenant.kycStatus !== 'verified') {
        tenant.kycStatus = 'verified';
    }

    // Status remains 'pending' until onboarding payment is completed
    tenant.status = 'pending';
    tenant.updatedAt = new Date();
    await tenant.save();

    // [PHASE 3 HOOK — Agreement Complete -> Payment Link]
    // After tenant signs the agreement, generate a tokenized payment link and email it.
    try {
        if (tenant.paymentLinkStatus !== 'sent' && tenant.paymentLinkStatus !== 'paid') {
            const Rent = require('../models/Rent');
            let rent = await Rent.findOne({ tenantId: tenant._id, paymentStatus: 'pending' }).sort({ createdAt: -1 });
            if (!rent) {
                const rentAmount = tenant.agreedRent || 0;
                const advanceChargeAmount = Math.max(0, parseInt(tenant.digitalCheckin?.agreementDetails?.advanceCharge, 10) || 0);
                rent = new Rent({
                    tenantId: tenant._id,
                    tenantLoginId: tenant.loginId,
                    tenantName: tenant.name,
                    tenantEmail: tenant.email,
                    tenantPhone: tenant.phone,
                    ownerLoginId: tenant.ownerLoginId,
                    propertyName: tenant.propertyTitle || 'RoomHy Property',
                    roomNumber: tenant.roomNo || '',
                    rentAmount,
                    advanceChargeAmount,
                    totalDue: rentAmount + advanceChargeAmount,
                    paymentStatus: 'pending'
                });
                await rent.save();
                console.log(`[PAYMENT LINK] Rent record created: ${rent._id}, advance: ${advanceChargeAmount}`);
            }
            const rentRecordId = rent._id;
            const jwtSecret = process.env.JWT_SECRET;
            if (!jwtSecret) throw new Error('JWT_SECRET missing');

            const jwt = require('jsonwebtoken');
            const token = jwt.sign(
                { loginId: tenant.loginId, rentRecordId, purpose: 'onboarding_payment' },
                jwtSecret,
                { expiresIn: '72h' }
            );
            const appBase = resolvePaymentAppBase(frontendOrigin);
            const paymentUrl = `${appBase}/payment/gateway?token=${token}`;
            tenant._paymentUrl = paymentUrl;

            console.log(`[PAYMENT LINK] Generated payment URL: ${paymentUrl}`);

            if (tenant.paymentLinkStatus !== 'sent') {
                console.log(`[PAYMENT LINK] Sending email to: ${tenant.email}`);

                const subject = `RoomHy Onboarding — ${tenant.propertyTitle || 'RoomHy Property'}`;
                const paymentHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f4;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #dddddd;">
        <tr><td style="padding:24px 32px;border-bottom:1px solid #dddddd;">
          <p style="margin:0;font-size:20px;font-weight:700;color:#111111;">RoomHy</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:15px;color:#333333;">Dear <strong>${tenant.name || 'Tenant'}</strong>,</p>
          <p style="margin:0 0 16px;font-size:14px;color:#555555;line-height:1.7;">Your KYC verification and rental agreement have been completed successfully for <strong>${tenant.propertyTitle || 'RoomHy Property'}</strong>${tenant.roomNo ? ', Room ' + tenant.roomNo : ''}.</p>
          <p style="margin:0 0 24px;font-size:14px;color:#555555;line-height:1.7;">To complete your onboarding, please proceed with the security deposit and first month payment using the link below.</p>
          <table cellpadding="0" cellspacing="0" border="0">
            <tr><td style="background:#111111;">
              <a href="${paymentUrl}" style="display:inline-block;background:#111111;color:#ffffff;text-decoration:none;padding:13px 28px;font-size:14px;font-weight:600;font-family:Arial,Helvetica,sans-serif;">Proceed to Payment</a>
            </td></tr>
          </table>
          <p style="margin:20px 0 0;font-size:12px;color:#888888;">If the button does not work, copy and paste this link in your browser:<br><span style="color:#333333;word-break:break-all;">${paymentUrl}</span></p>
          <p style="margin:20px 0 0;font-size:12px;color:#888888;">This link is valid for 72 hours. Please do not share it with anyone.</p>
        </td></tr>
        <tr><td style="border-top:1px solid #dddddd;padding:20px 32px;background:#f9f9f9;">
          <p style="margin:0;font-size:12px;color:#888888;line-height:1.8;"><strong style="color:#555555;">RoomHy Support Team</strong><br>Email: support@roomhy.com | Website: www.roomhy.com<br>&copy; ${new Date().getFullYear()} RoomHy. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
                const paymentText = `Dear ${tenant.name || 'Tenant'},\n\nYour KYC and rental agreement for ${tenant.propertyTitle || 'RoomHy Property'} are complete.\n\nPlease proceed with your onboarding payment using the link below:\n${paymentUrl}\n\nThis link is valid for 72 hours.\n\nRoomHy Support Team\nsupport@roomhy.com`;
                await sendMail(tenant.email, subject, paymentText, paymentHtml);
                tenant.paymentLinkStatus = 'sent';
                await tenant.save();
                console.log(`[PAYMENT LINK] ✓ Successfully sent to ${tenant.email} for ${tenant.loginId}`);
            } // end if not already sent
        } else {
            console.log(`[PAYMENT LINK] Skipped - paymentLinkStatus is paid`);
            console.log(`[PAYMENT LINK] Skipped - paymentLinkStatus is ${tenant.paymentLinkStatus}`);
        }
    } catch (paymentLinkErr) {
        console.error('[PAYMENT LINK ERROR] Hook (agreement-complete) Failed:', paymentLinkErr.message);
        console.error('[PAYMENT LINK ERROR] Stack:', paymentLinkErr.stack);
    }

    try {
        const bookingController = require('../controllers/bookingController');
        if (typeof bookingController.settleTransactionMoveIn === 'function') {
            await bookingController.settleTransactionMoveIn(normalizedLoginId);
        }
    } catch (settleErr) {
        console.error('[TENANT AGREEMENT COMPLETE] Settle payment transaction error:', settleErr.message);
    }

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

    // Phase 6.5 Fix: DO NOT send tenant login credentials here!
    // Credentials are strictly gated behind finalizeOnboardingPayment (post-payment).
    // BUT the signed agreement PDF copy MUST still go to the tenant.
    if (tenant.email && agreementPdfBuffer) {
        try {
            await sendMail(
                tenant.email,
                `Your Signed Agreement — ${tenant.propertyTitle || 'RoomHy Property'}`,
                `Hi ${tenant.name || 'Tenant'}, your signed agreement is attached. Please retain this for your records.`,
                buildOwnerTenantSignedEmail(tenant.name || 'Tenant', tenant),
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
            console.log(`[TENANT AGREEMENT COMPLETE] Agreement PDF emailed to tenant ${tenant.email} for ${normalizedLoginId}.`);
        } catch (tenantEmailErr) {
            console.error(`[TENANT AGREEMENT COMPLETE] Tenant agreement email error:`, tenantEmailErr.message);
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

    return { record, tenant, dashboardUrl, tenantLoginUrl, loginEmailSent, paymentUrl: tenant._paymentUrl || null };
};

exports.generateTenantAgreementPdfBuffer = generateTenantAgreementPdfBuffer;
