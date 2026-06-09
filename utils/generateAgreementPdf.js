'use strict';
const PDFDocument = require('pdfkit');
const path = require('path');

// ======================================================
// ROOMHY SEAL / SIGN IMAGE
// Current image paths (tried in order, first success wins):
//   1. react-app/public/image/website/roomhy.png
//   2. react-app/public/website/images/logoroomhy.jpg
// To change the RoomHy seal/sign in future,
// replace the image file or update LOGO_PATHS below.
// ======================================================
const LOGO_PATHS = [
    path.join(__dirname, '../../Roohmy-Frontend/public/website/images/seal1.png'),
    path.join(__dirname, '../../Roohmy-Frontend/public/website/images/seal1.png'),
    path.join(__dirname, '../public/website/images/seal1.png')
];

// ======================================================
// AGREEMENT TEMPLATE SECTION
// If agreement clauses/content need to be updated in future,
// modify the text inside the sectionHeader/sub/para/bullet
// calls below only. Clause numbers, headings, and legal
// wording are preserved verbatim from the official RoomHy
// Licence & Subscription Agreement template.
// ======================================================

/**
 * Generates the official RoomHy Licence & Subscription Agreement PDF buffer.
 *
 * ======================================================
 * DYNAMIC FIELD MAPPING
 * All tenant/owner/property runtime values are passed via
 * the fields object below. Update mappings carefully to
 * avoid breaking agreement generation.
 * ======================================================
 *
 * @param {Object} fields
 * @returns {Promise<Buffer>}
 */
function generateAgreementPdfBuffer({
    tenantName        = '-',
    tenantAddress     = '-',
    tenantEmail       = '-',
    tenantPhone       = '-',
    backupEmail       = '-',
    backupPhone       = '-',
    propertyName      = '-',
    propertyAddress   = '-',
    accommodationType = '-',
    roomNumber        = '-',
    ownerName         = '-',
    rentAmount        = '-',
    duration          = '-',
    licenseStartDate  = '-',
    licenseEndDate    = '-',
    licenseFeeDueDate = '5',
    moveOutCharges    = '-',
    noticePeriodCharges = '-',
    securityDeposit   = '-',
    inclusions        = '-',
    minimumStayDuration = '3 Months',
    gstCharges        = '0',
    signatureDataUrl  = '',
    eSignName         = '',
    signedDate        = ''
} = {}) {
    return new Promise((resolve, reject) => {
        try {
            const today = signedDate || new Date().toISOString().slice(0, 10);
            const v  = (x) => String(x && x !== 'undefined' ? x : '-');
            const Rs = (x) => (x && x !== '-' && x !== 'undefined') ? `₹${x}` : '₹-';

            const doc = new PDFDocument({ size: 'A4', margin: 72, autoFirstPage: true });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const M  = 72;                          // page margin
            const PW = doc.page.width - 2 * M;     // printable width

            // ── Drawing helpers ──────────────────────────────────

            const hLine = () => {
                doc.moveTo(M, doc.y)
                   .lineTo(M + PW, doc.y)
                   .lineWidth(0.5).strokeColor('#000000').stroke();
            };

            const sectionHeader = (title) => {
                doc.moveDown(0.4);
                hLine();
                doc.moveDown(0.15);
                doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(title);
                hLine();
                doc.moveDown(0.3);
            };

            const para = (text, opts = {}) => {
                doc.font('Helvetica').fontSize(10).fillColor('#000000')
                   .text(text, { align: 'justify', lineGap: 2, ...opts });
                doc.moveDown(0.3);
            };

            const sub = (num, text) => {
                doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
                   .text(`${num} `, { continued: true });
                doc.font('Helvetica').fillColor('#000000')
                   .text(text, { align: 'justify', lineGap: 2 });
                doc.moveDown(0.3);
            };

            const bullet = (text) => {
                doc.font('Helvetica').fontSize(10).fillColor('#000000')
                   .text(`•  ${text}`, { indent: 20, align: 'justify', lineGap: 2 });
                doc.moveDown(0.2);
            };

            // Draws one row of the Annexure A table
            const tableRow = (label, value) => {
                const colW = PW / 2;
                doc.font('Helvetica').fontSize(9);
                let lH = 20, vH = 20;
                try { lH = doc.heightOfString(v(label), { width: colW - 10 }); } catch (_) {}
                try { vH = doc.heightOfString(v(value), { width: colW - 10 }); } catch (_) {}
                const rH = Math.max(lH, vH, 18) + 14;

                if (doc.y + rH > doc.page.height - M) doc.addPage();
                const rY = doc.y;

                doc.rect(M,        rY, colW, rH).stroke('#000000');
                doc.rect(M + colW, rY, colW, rH).stroke('#000000');
                doc.font('Helvetica').fontSize(9).fillColor('#000000')
                   .text(v(label), M + 5,        rY + 7, { width: colW - 10, lineGap: 1 });
                doc.font('Helvetica').fontSize(9).fillColor('#000000')
                   .text(v(value), M + colW + 5, rY + 7, { width: colW - 10, lineGap: 1 });
                doc.y = rY + rH;
            };

            // ── End helpers ──────────────────────────────────────


            // ====================================================
            // TITLE
            // ====================================================
            doc.font('Helvetica-Bold').fontSize(14).fillColor('#000000')
               .text('ROOMHY ACCOMODATION  AGREEMENT', { align: 'center' });
            doc.moveDown(0.8);

            doc.font('Helvetica').fontSize(10)
               .text('This Licence & Subscription Agreement ', { continued: true });
            doc.font('Helvetica-Bold').text('("Agreement")', { continued: true });
            doc.font('Helvetica').text(` is executed on this ${today}.`);
            doc.moveDown(0.8);

            doc.font('Helvetica-Bold').fontSize(10).text('BY AND BETWEEN');
            doc.moveDown(0.5);

            doc.font('Helvetica-Bold').fontSize(10).text('Roomhy Technology,', { continued: true });
            doc.font('Helvetica').fontSize(10)
               .text(' a company incorporated under the Companies Act, 2013, having its registered office at ', { continued: true });
            doc.font('Helvetica-Bold').text('Roomhy Office Address', { continued: true });
            doc.font('Helvetica').text(' (hereinafter referred to as "Roomhy", which expression shall, unless repugnant to the context, include its successors and assigns);');
            doc.moveDown(0.5);

            doc.font('Helvetica-Bold').fontSize(10).text('AND', { align: 'center' });
            doc.moveDown(0.5);

            doc.font('Helvetica').fontSize(10).text('Mr./Ms. ', { continued: true });
            doc.font('Helvetica-Bold').text(`${v(tenantName)},`, { continued: true });
            doc.font('Helvetica').text(' residing at ', { continued: true });
            doc.font('Helvetica-Bold').text(v(tenantAddress), { continued: true });
            doc.font('Helvetica').text(' (hereinafter referred to as the "Tenant", which expression shall include his/her heirs, executors, administrators and permitted assigns).');
            doc.moveDown(0.5);

            para('Roomhy and Tenant shall hereinafter be collectively referred to as the "Parties" and individually as a "Party".');

            doc.font('Helvetica-Bold').fontSize(10).text('WHEREAS');
            doc.moveDown(0.4);
            para('A. Roomhy operates a technology-based marketplace platform enabling third-party property owners to list their properties and prospective tenants to discover, bid, and book such properties.');
            para('B. Roomhy is solely an intermediary platform and does not own, lease, control, or manage any of the listed properties and does not create any tenancy rights.');
            para('C. The Tenant, being fully aware of the nature of the platform, has voluntarily agreed to book a property through Roomhy subject to the terms and conditions contained herein.');
            doc.moveDown(0.3);

            hLine();
            doc.moveDown(0.2);
            doc.font('Helvetica-Bold').fontSize(11)
               .text('NOW THIS AGREEMENT WITNESSETH AS FOLLOWS', { align: 'center' });
            doc.moveDown(0.2);
            hLine();
            doc.moveDown(0.4);


            // ====================================================
            // SECTION 1 — NATURE OF AGREEMENT
            // ====================================================
            sectionHeader('1. NATURE OF AGREEMENT');
            sub('1.1', 'This Agreement constitutes a limited, revocable, and conditional license granted to the Tenant to occupy the premises identified below:');
            doc.font('Helvetica-Bold').fontSize(10).text(`      Property Name: ${v(propertyName)}`);
            doc.font('Helvetica-Bold').fontSize(10).text(`      Room Number: ${v(roomNumber)}`);
            doc.font('Helvetica-Bold').fontSize(10).text(`      Owner Name: ${v(ownerName)}`);
            doc.moveDown(0.3);
            sub('1.2', 'Roomhy acts solely as a technology intermediary and payment facilitator and shall not be deemed as landlord or owner of the premises. All representations, warranties, and conditions concerning the property are that of the Property Owner.');
            sub('1.3', 'All rights relating to occupation and use shall strictly arise between the Tenant and the Property Owner. Roomhy shall bear no liability for any disputes between the Tenant and the Property Owner.');

            // ====================================================
            // SECTION 2 — PREMISES
            // ====================================================
            sectionHeader('2. PREMISES');
            sub('2.1', 'The Tenant agrees to occupy the premises for residential purposes only and shall not use the premises for any commercial, illegal, or immoral activities.');
            sub('2.2', 'Roomhy does not guarantee the condition, suitability, legality, habitability, or fitness of the premises for any purpose whatsoever.');
            sub('2.3', 'The Tenant shall abide by all house rules, regulations, and instructions issued by the Property Owner from time to time.');

            // ====================================================
            // SECTION 3 — BOOKING & ESCROW MECHANISM
            // ====================================================
            sectionHeader('3. BOOKING & ESCROW MECHANISM');
            sub('3.1', 'The Tenant shall pay the booking amount as specified on the Roomhy platform at the time of booking. The booking shall be confirmed only upon receipt of payment.');
            sub('3.2', 'Payments collected shall be held in escrow and shall be released to the Property Owner only after the Tenant has successfully completed check-in and confirmed satisfactory occupancy.');
            sub('3.3', 'Roomhy reserves the right to deduct applicable service charges, platform fees, GST, and any other statutory levies from the amounts held in escrow before disbursing the balance to the Property Owner.');

            // ====================================================
            // SECTION 4 — PRE-CHECK-IN PROTECTION
            // ====================================================
            sectionHeader('4. PRE-CHECK-IN PROTECTION');
            sub('4.1', 'In the event that the property is found to be unsuitable, unavailable, or significantly different from its listing on the Roomhy platform at the time of check-in, Roomhy shall make reasonable efforts to provide the Tenant with suitable alternative accommodation options.');
            sub('4.2', 'If the Tenant rejects all alternative options provided by Roomhy, a full refund of the booking amount shall be initiated by Roomhy within twenty-one (21) working days from the date of rejection.');
            sub('4.3', 'The Tenant agrees that the above remedies constitute the full and final remedy against Roomhy in case of pre-check-in issues.');

            // ====================================================
            // SECTION 5 — POST CHECK-IN DISCLAIMER
            // ====================================================
            sectionHeader('5. POST CHECK-IN DISCLAIMER');
            sub('5.1', "Upon successful check-in by the Tenant, Roomhy's obligations and responsibilities as a platform facilitator shall stand fully discharged. Roomhy shall bear no further liability after check-in.");
            sub('5.2', 'All disputes, grievances, claims, or issues arising after check-in, including but not limited to maintenance, amenities, safety, services, or any other matter pertaining to the premises, shall be exclusively between the Tenant and the Property Owner.');
            sub('5.3', 'Roomhy shall not be required to mediate, arbitrate, or resolve any post check-in disputes between the Tenant and the Property Owner.');

            // ====================================================
            // SECTION 6 — RENT PAYMENT TERMS
            // ====================================================
            sectionHeader('6. RENT PAYMENT TERMS');
            doc.font('Helvetica-Bold').fontSize(10)
               .text(`Monthly Rent: ${Rs(rentAmount)}   Duration: ${v(duration)}`);
            doc.moveDown(0.3);
            sub('6.1', 'The Tenant shall pay the monthly license fee/rent by the 5th day of each calendar month, failing which it shall be treated as a default. Rent must be paid between the 1st and 5th of each month.');
            sub('6.2', 'In the event of delay beyond the 5th of a month, a late payment penalty of ₹100 (Rupees One Hundred) per day shall be levied and shall be payable by the Tenant in addition to the monthly rent.');
            sub('6.3', 'All payments must be made through the Roomhy platform only. Payments made directly to the Property Owner outside the platform shall not be the responsibility of Roomhy.');
            sub('6.4', 'Roomhy reserves the right to revise the rent or platform charges upon reasonable notice to the Tenant.');

            // ====================================================
            // SECTION 7 — SECURITY DEPOSIT
            // ====================================================
            sectionHeader('7. SECURITY DEPOSIT');
            sub('7.1', 'The security deposit amount shall be as mutually agreed between the Tenant and the Property Owner at the time of booking and as specified in Annexure A.');
            sub('7.2', 'Roomhy shall have no role in the collection, management, or refund of the security deposit unless it is explicitly collected through the Roomhy platform.');
            sub('7.3', 'Any disputes arising out of deductions from or non-refund of the security deposit shall be resolved directly between the Tenant and the Property Owner.');

            // ====================================================
            // SECTION 8 — LOCK-IN PERIOD & MINIMUM STAY
            // ====================================================
            sectionHeader('8. LOCK-IN PERIOD & MINIMUM STAY');
            sub('8.1', `The minimum stay duration under this Agreement shall be ${v(minimumStayDuration)} from the date of check-in, unless otherwise specified in Annexure A.`);
            sub('8.2', 'In the event that the Tenant vacates the premises before the completion of the minimum lock-in period, the Tenant shall be liable to pay a penalty as specified by the Property Owner or as agreed upon at the time of booking.');
            sub('8.3', 'Roomhy shall not be responsible for any penalties imposed by the Property Owner for early vacation of the premises.');

            // ====================================================
            // SECTION 9 — NOTICE PERIOD
            // ====================================================
            sectionHeader('9. NOTICE PERIOD');
            sub('9.1', 'The Tenant must provide a written notice of at least thirty (30) days prior to vacating the premises. Such notice must be submitted through the Roomhy platform or in writing to the Property Owner.');
            sub('9.2', 'Failure to provide adequate notice may result in forfeiture of the security deposit or imposition of additional charges by the Property Owner.');
            sub('9.3', 'The notice period shall commence from the date of receipt of notice by the Property Owner or Roomhy, whichever is earlier.');

            // ====================================================
            // SECTION 10 — TERMINATION
            // ====================================================
            sectionHeader('10. TERMINATION');
            para("Roomhy may, at its sole discretion and without prior notice, terminate this Agreement and revoke the Tenant's access to the platform in the following cases:");
            bullet('Non-payment of rent, platform fees, or any other dues for a period exceeding fifteen (15) days from the due date.');
            bullet('Fraud, misrepresentation, or submission of false documents by the Tenant.');
            bullet('Misuse, damage, or illegal activity at the licensed premises.');
            bullet('Breach of any terms and conditions of this Agreement or the Roomhy platform policies.');
            bullet('Any conduct that is harmful, disruptive, or detrimental to other residents or the Property Owner.');
            sub('10.1', 'Upon termination, the Tenant shall vacate the premises immediately and all outstanding dues shall become payable forthwith.');

            // ====================================================
            // SECTION 11 — INDEMNITY
            // ====================================================
            sectionHeader('11. INDEMNITY');
            sub('11.1', 'The Tenant hereby agrees to indemnify, defend, and hold harmless Roomhy, its officers, directors, employees, agents, and affiliates from and against any and all claims, liabilities, damages, losses, costs, and expenses (including legal fees) arising out of or in connection with:');
            bullet("The Tenant's use of the licensed premises.");
            bullet('Any breach by the Tenant of the terms of this Agreement.');
            bullet('Any acts or omissions of the Tenant or persons associated with the Tenant.');
            bullet('Any disputes between the Tenant and the Property Owner.');

            // ====================================================
            // SECTION 12 — LIMITATION OF LIABILITY
            // ====================================================
            sectionHeader('12. LIMITATION OF LIABILITY');
            sub('12.1', "Roomhy shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including loss of profits, data, or goodwill, arising out of or in connection with this Agreement or the use of Roomhy's platform.");
            sub('12.2', "Roomhy's total aggregate liability to the Tenant in connection with this Agreement shall not exceed the total platform fees paid by the Tenant in the three (3) months preceding the event giving rise to the claim.");
            sub('12.3', 'Roomhy makes no warranties, express or implied, regarding the accuracy, reliability, or completeness of property listings on the platform.');

            // ====================================================
            // SECTION 13 — DISPUTE RESOLUTION
            // ====================================================
            sectionHeader('13. DISPUTE RESOLUTION');
            sub('13.1', 'All disputes, claims, or controversies arising between the Tenant and the Property Owner shall be resolved directly between them. Roomhy shall not be a party to such disputes.');
            sub('13.2', 'Any dispute between the Tenant and Roomhy regarding this Agreement shall be first attempted to be resolved through mutual negotiation and mediation.');
            sub('13.3', "If mediation fails, the dispute shall be submitted to binding arbitration in accordance with the Arbitration and Conciliation Act, 1996. The seat of arbitration shall be as per Roomhy's registered office location.");

            // ====================================================
            // SECTION 14 — GOVERNING LAW
            // ====================================================
            sectionHeader('14. GOVERNING LAW');
            sub('14.1', "This Agreement shall be governed by and construed in accordance with the laws of India. The courts of the city in which Roomhy's registered office is situated shall have exclusive jurisdiction over all matters arising under this Agreement.");

            // ====================================================
            // SECTION 15 — DATA PRIVACY
            // ====================================================
            sectionHeader('15. DATA PRIVACY');
            sub('15.1', 'The Tenant consents to Roomhy collecting, storing, and using personal data for the purposes of facilitating the booking, communication, and platform operations.');
            sub('15.2', 'Roomhy shall handle all personal data in accordance with applicable data protection laws of India.');

            // ====================================================
            // SECTION 16 — ENTIRE AGREEMENT & AMENDMENTS
            // ====================================================
            sectionHeader('16. ENTIRE AGREEMENT & AMENDMENTS');
            sub('16.1', 'This Agreement, together with Annexure A, constitutes the entire understanding between the Parties with respect to its subject matter and supersedes all prior negotiations, understandings, agreements, or representations.');
            sub('16.2', 'Any amendments to this Agreement shall be valid only if made in writing and duly signed by both Parties or through the Roomhy platform.');
            sub('16.3', 'If any provision of this Agreement is found to be unenforceable or invalid, such provision shall be modified to the minimum extent necessary to make it enforceable, and the remaining provisions shall continue in full force and effect.');

            // ====================================================
            // SECTION 17 — FORCE MAJEURE
            // ====================================================
            sectionHeader('17. FORCE MAJEURE');
            sub('17.1', 'Neither Party shall be liable for any failure or delay in performance under this Agreement to the extent caused by circumstances beyond their reasonable control, including but not limited to acts of God, natural disasters, epidemics, pandemics, government orders, or civil unrest.');


            // ====================================================
            // ANNEXURE A
            // ====================================================
            doc.addPage();
            doc.font('Helvetica-Bold').fontSize(14).fillColor('#000000')
               .text('ANNEXURE A', { align: 'center' });
            doc.moveDown(0.8);

            const backupContact = [v(backupEmail), v(backupPhone)].filter(x => x !== '-').join(' / ') || '-';
            const premises = [v(propertyName), v(propertyAddress)].filter(x => x !== '-').join(', ');

            // ======================================================
            // DYNAMIC FIELD MAPPING — Annexure A table
            // All variable data from tenant/booking is inserted here.
            // ======================================================
            tableRow('Name of Tenant', v(tenantName));
            tableRow('Permanent Address', v(tenantAddress));
            tableRow('Tenant Email (will be used for communication and notices)', v(tenantEmail));
            tableRow('Tenant Phone Number (will be used for communication and notices)', v(tenantPhone));
            tableRow('Back up email and phone number for emergency', backupContact);
            tableRow('Roomhy Premises name and address', premises);
            tableRow('Type of accommodation', v(accommodationType));
            tableRow('Monthly License Fee/Rent', Rs(rentAmount));
            tableRow('License Start Date', v(licenseStartDate));
            tableRow('License Duration', v(duration));
            tableRow('License End Date', v(licenseEndDate));
            tableRow('License Fee Due Date', v(licenseFeeDueDate));
            tableRow('Move Out Charges', v(moveOutCharges));
            tableRow('Notice Period Charges', v(noticePeriodCharges));
            tableRow('Security Deposit', v(securityDeposit));
            tableRow('Inclusions', v(inclusions));
            tableRow('Minimum Stay Duration', v(minimumStayDuration));
            tableRow('GST Charges', v(gstCharges) || '0');

            doc.moveDown(1.5);

            // ====================================================
            // SIGNATURE SECTION
            // ====================================================
            if (doc.y + 110 > doc.page.height - M) doc.addPage();

            const sigY   = doc.y;
            const halfPW = PW / 2;
            const rightX = M + halfPW + 10;

            // Left — Tenant signature
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
               .text('Tenant Signature:', M, sigY);

            let sigDrawn = false;
            if (signatureDataUrl && signatureDataUrl.startsWith('data:image/')) {
                try {
                    const b64 = signatureDataUrl.split(',')[1] || '';
                    if (b64) {
                        doc.image(Buffer.from(b64, 'base64'), M, sigY + 18, { fit: [160, 50] });
                        sigDrawn = true;
                    }
                } catch (_) {}
            }
            // Signature underline
            doc.moveTo(M, sigY + 72).lineTo(M + halfPW - 20, sigY + 72)
               .lineWidth(0.5).strokeColor('#000000').stroke();
            if (eSignName && sigDrawn) {
                doc.font('Helvetica').fontSize(8).fillColor('#64748b')
                   .text(`Signed by ${eSignName} on ${today}`, M, sigY + 76, { width: halfPW - 20 });
            }

            // Right — RoomHy authorized signatory
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
               .text('Roomhy Authorized Signatory', rightX, sigY);

            // ======================================================
            // ROOMHY SEAL / SIGN IMAGE
            // To change the RoomHy seal/sign in future,
            // update the LOGO_PATHS array at the top of this file.
            // ======================================================
            const logoWidth = 90;
            const logoHeight = 60;
            const logoX = rightX + Math.max(0, ((halfPW - 10) - logoWidth) / 2);
            const logoY = sigY + 18;

            let logoDrawn = false;
            for (const lp of LOGO_PATHS) {
                try {
                    doc.image(lp, logoX, logoY, {
                        fit: [logoWidth, logoHeight],
                        align: 'center',
                        valign: 'center'
                    });
                    logoDrawn = true;
                    break;
                } catch (_) {}
            }
            if (!logoDrawn) {
                doc.font('Helvetica-Bold').fontSize(16).fillColor('#1d4ed8')
                   .text('ROOMHY', logoX, sigY + 30, { width: logoWidth, align: 'center' });
            }
            doc.moveTo(rightX, sigY + 76).lineTo(rightX + halfPW - 10, sigY + 76)
               .lineWidth(0.5).strokeColor('#000000').stroke();

            const dateLineY = sigY + 90;
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
               .text('Date:', M, dateLineY);
            doc.moveTo(M + 40, dateLineY + 14).lineTo(M + halfPW - 20, dateLineY + 14)
               .lineWidth(0.5).strokeColor('#000000').stroke();

            doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000')
               .text('Date:', rightX, dateLineY);
            doc.font('Helvetica').fontSize(10).fillColor('#000000')
               .text(today, rightX + 44, dateLineY);
            doc.moveTo(rightX + 40, dateLineY + 14).lineTo(rightX + halfPW - 10, dateLineY + 14)
               .lineWidth(0.5).strokeColor('#000000').stroke();

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generateAgreementPdfBuffer };
