const PDFDocument = require('pdfkit');
const { sendMail } = require('./mailer');

function val(v, fallback = '-') {
    const s = String(v || '').trim();
    return s || fallback;
}

function buildFields(tenant, loginId, eSignName) {
    const ad = tenant?.digitalCheckin?.profile?.agreementDetails || {};
    const profile = tenant?.digitalCheckin?.profile || {};
    const tenantName = val(ad.tenantName || tenant.name);
    const moveInDate = val(ad.licenseStartDate || profile.moveInDate || tenant.moveInDate
        ? new Date(ad.licenseStartDate || profile.moveInDate || tenant.moveInDate).toISOString().slice(0, 10)
        : '');
    return {
        tenantName,
        loginId: val(loginId),
        tenantEmail: val(ad.tenantEmail || tenant.email),
        tenantPhone: val(ad.tenantPhone || tenant.phone),
        tenantAddress: val(ad.tenantAddress || tenant.permanentAddress),
        propertyName: val(ad.propertyName || tenant.propertyTitle),
        propertyAddress: val(ad.propertyAddress),
        accommodationType: val(ad.accommodationType),
        roomNumber: val(ad.roomNumber || tenant.roomNo || profile.roomNo),
        ownerName: val(ad.ownerName),
        rentAmount: val(ad.rentAmount || tenant.agreedRent),
        duration: val(ad.duration),
        licenseStartDate: moveInDate,
        licenseEndDate: val(ad.licenseEndDate),
        licenseFeeDueDate: val(ad.licenseFeeDueDate, '5'),
        moveOutCharges: val(ad.moveOutCharges),
        noticePeriodCharges: val(ad.noticePeriodCharges),
        securityDeposit: val(ad.securityDeposit || tenant.securityDepositTotal),
        inclusions: val(ad.inclusions),
        minimumStayDuration: val(ad.minimumStayDuration, '3 Months'),
        gstCharges: val(ad.gstCharges, '0'),
        electricityCharge: val(tenant.electricityCharge),
        maintenanceCharge: val(tenant.maintenanceCharge),
        eSignName: val(eSignName || tenantName),
        signedAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
    };
}

function generateAgreementPdfBuffer(tenant, loginId, eSignName, signatureDataUrl) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        const f = buildFields(tenant, loginId, eSignName);

        // Header
        doc.fontSize(18).font('Helvetica-Bold').text('ROOMHY', { align: 'center' });
        doc.fontSize(13).font('Helvetica').text('LICENCE & SUBSCRIPTION AGREEMENT', { align: 'center' });
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.8);

        // Annexure A details box
        doc.fontSize(11).font('Helvetica-Bold').text('ANNEXURE A — TENANT & PROPERTY DETAILS');
        doc.moveDown(0.4);

        const rows = [
            ['Tenant Name', f.tenantName, 'Login ID', f.loginId],
            ['Email', f.tenantEmail, 'Phone', f.tenantPhone],
            ['Tenant Address', f.tenantAddress, 'Accommodation Type', f.accommodationType],
            ['Property Name', f.propertyName, 'Room Number', f.roomNumber],
            ['Property Address', f.propertyAddress, 'Owner Name', f.ownerName],
            ['License Start Date', f.licenseStartDate, 'License End Date', f.licenseEndDate],
            ['Monthly Rent (₹)', f.rentAmount, 'Due Date (day of month)', f.licenseFeeDueDate],
            ['Security Deposit (₹)', f.securityDeposit, 'Minimum Stay', f.minimumStayDuration],
            ['Electricity Charge', f.electricityCharge, 'Maintenance Charge', f.maintenanceCharge],
            ['GST Charges', f.gstCharges, 'Inclusions', f.inclusions],
            ['Move-Out Charges', f.moveOutCharges, 'Notice Period Charges', f.noticePeriodCharges],
            ['Duration', f.duration, '', ''],
        ];

        const col1 = 50, col2 = 175, col3 = 330, col4 = 455;
        const rowH = 20;
        doc.fontSize(9).font('Helvetica');

        for (const [l1, v1, l2, v2] of rows) {
            const y = doc.y;
            doc.font('Helvetica-Bold').text(l1, col1, y, { width: 120 });
            doc.font('Helvetica').text(v1, col2, y, { width: 150 });
            if (l2) {
                doc.font('Helvetica-Bold').text(l2, col3, y, { width: 120 });
                doc.font('Helvetica').text(v2, col4, y, { width: 90 });
            }
            doc.moveDown(0.55);
        }

        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.8);

        // Agreement clauses
        doc.fontSize(11).font('Helvetica-Bold').text('TERMS AND CONDITIONS');
        doc.moveDown(0.4);
        doc.fontSize(9).font('Helvetica');

        const clauses = [
            ['1. Term', 'As per Annexure A.'],
            ['2. Premises', 'As per Annexure A.'],
            ['3. License Fee / Rent', 'Rent must be paid in advance on or before the due date as per Annexure A.'],
            ['4. Refundable Security Deposit', 'Deposit is refundable after deductions for dues or damages as per Annexure A.'],
            ['5. Minimum Stay Duration', 'Early move-out before minimum stay can result in deposit withholding.'],
            ['6. Limited License', 'Use of the premises is subject to timely payment and compliance with RoomHy rules.'],
            ['7. Rent Default', 'Delay or default in rent can lead to service restrictions, lockout, penalties, and termination.'],
            ['8. Termination Without Cause', 'Either party may terminate with prior notice, subject to lock-in and notice conditions.'],
            ['9. Termination For Cause', 'RoomHy may terminate immediately for illegal activity, non-payment, damage, or violation of rules.'],
            ['10. Maintenance', 'Tenant must maintain the premises and bears cost for damages beyond normal wear and tear.'],
            ['11. Renewal', 'Agreement may renew with revised rent and terms based on market conditions.'],
            ['12. Notices', 'Notices may be sent by email or written communication.'],
            ['13. Entire Agreement', 'This agreement with annexures forms the complete understanding between parties.'],
            ['14. Severability', 'If any clause is invalid, the rest of the agreement remains effective.'],
            ['15. Governing Law & Jurisdiction', 'Laws of India apply and jurisdiction lies where the premises are located.'],
            ['16. Assignment Of Receivables', 'RoomHy may assign receivables under this agreement.'],
            ['17. Stamp Duty', 'Applicable stamp duty obligations, if any, are the responsibility of the tenant.'],
            ['18. Other Terms & Conditions', 'RoomHy may revise operating policies and tenant rules from time to time.'],
        ];

        for (const [title, text] of clauses) {
            doc.font('Helvetica-Bold').text(title + ': ', { continued: true }).font('Helvetica').text(text);
            doc.moveDown(0.3);
        }

        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
        doc.moveDown(0.8);

        // Signature section
        doc.fontSize(11).font('Helvetica-Bold').text('TENANT E-SIGNATURE');
        doc.moveDown(0.4);
        doc.fontSize(9).font('Helvetica').text(`E-Sign Name: ${f.eSignName}`);
        doc.text(`Login ID: ${f.loginId}`);
        doc.text(`Signed On: ${f.signedAt} IST`);
        doc.moveDown(0.5);

        // Embed signature image if present
        if (signatureDataUrl && signatureDataUrl.startsWith('data:image/png;base64,')) {
            try {
                const base64Data = signatureDataUrl.replace(/^data:image\/png;base64,/, '');
                const imgBuffer = Buffer.from(base64Data, 'base64');
                doc.text('Signature:');
                doc.moveDown(0.2);
                doc.image(imgBuffer, { width: 220, height: 70 });
                doc.moveDown(0.5);
            } catch (_) {
                doc.text('Signature: [unable to render]');
            }
        }

        doc.moveTo(50, doc.y).lineTo(270, doc.y).stroke();
        doc.fontSize(8).text('Tenant Signature', 50, doc.y + 2);

        doc.moveDown(2);
        doc.fontSize(8).fillColor('#6b7280')
            .text('This is a digitally executed agreement. Generated by RoomHy platform.', { align: 'center' });

        doc.end();
    });
}

async function generateAndSendAgreementEmail({ tenant, loginId, eSignName, signatureDataUrl }) {
    const pdfBuffer = await generateAgreementPdfBuffer(tenant, loginId, eSignName, signatureDataUrl);

    const tenantEmail = (tenant?.email || '').trim();
    if (!tenantEmail) {
        console.warn('[AgreementPdf] No tenant email — skipping email send');
        return { sent: false, reason: 'no_tenant_email' };
    }

    const tenantName = (tenant?.name || eSignName || 'Tenant').trim();
    const subject = 'RoomHy Rental Agreement — Your Signed Copy';
    const text = `Dear ${tenantName},\n\nThank you for completing your RoomHy digital check-in. Please find your signed rental agreement attached.\n\nLogin ID: ${loginId}\n\nFor any queries, contact support@roomhy.com.\n\nRegards,\nRoomHy Team`;
    const html = `
<div style="font-family:sans-serif;max-width:540px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px;">
  <div style="background:#1d4ed8;padding:20px 24px;border-radius:8px 8px 0 0;text-align:center;">
    <h2 style="color:#fff;margin:0;font-size:20px;">RoomHy Rental Agreement</h2>
  </div>
  <div style="background:#fff;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;">
    <p style="margin:0 0 12px;">Dear <strong>${tenantName}</strong>,</p>
    <p style="margin:0 0 12px;">Thank you for completing your RoomHy digital check-in. Your signed rental agreement is attached to this email as a PDF.</p>
    <p style="margin:0 0 4px;color:#475569;font-size:13px;">Login ID: <strong>${loginId}</strong></p>
    <p style="margin:16px 0 0;color:#6b7280;font-size:12px;">For any queries, contact <a href="mailto:support@roomhy.com">support@roomhy.com</a>.</p>
    <p style="margin:4px 0 0;color:#6b7280;font-size:12px;">— RoomHy Team</p>
  </div>
</div>`;

    await sendMail(tenantEmail, subject, text, html, {
        attachments: [
            {
                filename: `RoomHy_Agreement_${loginId}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf'
            }
        ]
    });

    console.log(`[AgreementPdf] Agreement PDF emailed to ${tenantEmail} for ${loginId}`);
    return { sent: true, email: tenantEmail };
}

module.exports = { generateAndSendAgreementEmail };
