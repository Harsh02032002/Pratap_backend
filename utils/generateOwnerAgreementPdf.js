'use strict';
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

// RoomHy seal/stamp paths
const SEAL_PATHS = [
    path.join(__dirname, '../../Roomhy-Frontend/public/website/images/seal1.png'),
    path.join(__dirname, '../../Roomhy-Frontend/public/website/images/sealroomhy-removebg-preview.png'),
    path.join(__dirname, '../public/website/images/seal1.png')
];

/**
 * Helper to convert text to words for Indian Rupees / Numbers if needed
 */
function numberToWords(num) {
    if (!num || isNaN(num)) return 'Zero';
    const n = parseInt(num, 10);
    if (n === 0) return 'Zero';
    
    const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function inWords(number) {
        let str = '';
        if (number >= 10000000) {
            str += inWords(Math.floor(number / 10000000)) + 'Crore ';
            number %= 10000000;
        }
        if (number >= 100000) {
            str += inWords(Math.floor(number / 100000)) + 'Lakh ';
            number %= 100000;
        }
        if (number >= 1000) {
            str += inWords(Math.floor(number / 1000)) + 'Thousand ';
            number %= 1000;
        }
        if (number >= 100) {
            str += inWords(Math.floor(number / 100)) + 'Hundred ';
            number %= 100;
        }
        if (number > 0) {
            if (number < 20) {
                str += a[number];
            } else {
                str += b[Math.floor(number / 10)] + (number % 10 !== 0 ? ' ' + a[number % 10] : ' ');
            }
        }
        return str;
    }
    return inWords(n).trim();
}

/**
 * Generates the official Hostel Onboarding & Service Agreement PDF matching template DOC-20260925-WA0006.pdf
 *
 * @param {Object} data
 * @returns {Promise<Buffer>}
 */
function generateOwnerAgreementPdfBuffer({
    effectiveDate = '',
    effectiveDay = '',
    effectiveMonth = '',
    effectiveYear = '',
    hostelLegalName = '-',
    tradeName = '-',
    propertyAddress = '-',
    panNumber = '-',
    gstinNumber = '-',
    representativeName = '-',
    ownerPhone = '-',
    ownerEmail = '-',
    subscriptionFee = '0',
    subscriptionFrequency = 'One-time',
    commissionPercent = '',
    settlementDays = '7',
    delayDays = '15',
    interestPercent = '1.5',
    termDuration = '1',
    signatureDataUrl = '',
    eSignName = '',
    signedDate = ''
} = {}) {
    return new Promise((resolve, reject) => {
        try {
            const today = signedDate || new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
            
            // Resolve day, month, year if not explicitly provided
            const now = new Date();
            const dayStr = effectiveDay || String(now.getDate());
            const monthStr = effectiveMonth || now.toLocaleString('en-IN', { month: 'long' });
            const yearStr = effectiveYear || String(now.getFullYear());

            const val = (x) => String(x && x !== 'undefined' ? x : '-');
            const subFeeVal = subscriptionFee && subscriptionFee !== '0' ? subscriptionFee : 'Nil / Included';
            const subWordsVal = subscriptionFee && !isNaN(subscriptionFee) && parseInt(subscriptionFee, 10) > 0 
                ? numberToWords(subscriptionFee) 
                : 'Zero';

            const doc = new PDFDocument({ size: 'A4', margin: 54, autoFirstPage: true });
            const chunks = [];
            doc.on('data', c => chunks.push(c));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const M = 54;                          // page margin (0.75 in)
            const PW = doc.page.width - 2 * M;     // printable width

            // Find seal image
            let sealPath = null;
            for (const p of SEAL_PATHS) {
                if (fs.existsSync(p)) {
                    sealPath = p;
                    break;
                }
            }

            // ── Helpers ──────────────────────────────────
            const hLine = (color = '#1a237e', width = 1) => {
                doc.moveTo(M, doc.y)
                   .lineTo(M + PW, doc.y)
                   .lineWidth(width).strokeColor(color).stroke();
            };

            const sectionHeader = (title) => {
                if (doc.y + 40 > doc.page.height - M) doc.addPage();
                doc.moveDown(0.4);
                doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#1a237e').text(title);
                doc.moveDown(0.2);
            };

            const para = (text, opts = {}) => {
                if (doc.y + 35 > doc.page.height - M) doc.addPage();
                doc.font('Helvetica').fontSize(9.5).fillColor('#222222')
                   .text(text, { align: 'justify', lineGap: 2.5, ...opts });
                doc.moveDown(0.3);
            };

            const sub = (num, text) => {
                if (doc.y + 35 > doc.page.height - M) doc.addPage();
                doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#222222')
                   .text(`${num} `, { continued: true });
                doc.font('Helvetica').fillColor('#222222')
                   .text(text, { align: 'justify', lineGap: 2.5 });
                doc.moveDown(0.3);
            };

            const bullet = (text) => {
                if (doc.y + 20 > doc.page.height - M) doc.addPage();
                doc.font('Helvetica').fontSize(9.5).fillColor('#222222')
                   .text(`•  ${text}`, { indent: 15, align: 'justify', lineGap: 2 });
                doc.moveDown(0.2);
            };

            // ── Header / Title ──────────────────────────────────
            doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a237e')
               .text('HOSTEL ONBOARDING & SERVICE AGREEMENT', { align: 'center' });
            doc.moveDown(0.2);
            doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('#444444')
               .text('(Platform Access, Lead Generation & Non-Circumvention Agreement)', { align: 'center' });
            doc.moveDown(0.6);
            hLine('#1a237e', 1.5);
            doc.moveDown(0.6);

            // Intro text
            doc.font('Helvetica').fontSize(9.5).fillColor('#222222')
               .text(`This Hostel Onboarding & Service Agreement ("Agreement") is made and entered into on this `, { continued: true });
            doc.font('Helvetica-Bold').text(`${dayStr}`, { continued: true });
            doc.font('Helvetica').text(` day of `, { continued: true });
            doc.font('Helvetica-Bold').text(`${monthStr}, ${yearStr}`, { continued: true });
            doc.font('Helvetica').text(` ("Effective Date"), by and between:`);
            doc.moveDown(0.5);

            // Party 1 (Roomhy)
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1a237e').text('Roomhy Technology', { continued: true });
            doc.font('Helvetica').fillColor('#222222')
               .text(' , a Proprietorship concern owned by Mr. Dasrath Singh, engaged in providing hostel management software and lead-generation services, having its registered/principal place of business at 847, Balaji Nagar, Rangbari, Pani Ki Tanki Ke Pass, Kota, Rajasthan – 324005, GSTIN: 08SLWPS2629G1ZZ (hereinafter referred to as “Roomhy” / “Company”, which expression shall, unless repugnant to the context, include its successors, affiliates, and permitted assigns), represented by its Proprietor/Authorised Signatory, Mr. Dasrath Singh;');
            doc.moveDown(0.5);

            doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a237e').text('AND', { align: 'center' });
            doc.moveDown(0.5);

            // Party 2 (Hostel Owner / Client)
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#222222').text('The Hostel Owner / Client ', { continued: true });
            doc.font('Helvetica').text(', namely M/s. ', { continued: true });
            doc.font('Helvetica-Bold').text(`${val(hostelLegalName)}`, { continued: true });
            doc.font('Helvetica').text(' ("Hostel"), operating under the trade name ', { continued: true });
            doc.font('Helvetica-Bold').text(`${val(tradeName)}`, { continued: true });
            doc.font('Helvetica').text(', having its office/property address at ', { continued: true });
            doc.font('Helvetica-Bold').text(`${val(propertyAddress)}`, { continued: true });
            doc.font('Helvetica').text(', PAN: ', { continued: true });
            doc.font('Helvetica-Bold').text(`${val(panNumber)}`, { continued: true });
            doc.font('Helvetica').text(', GSTIN: ', { continued: true });
            doc.font('Helvetica-Bold').text(`${val(gstinNumber)}`, { continued: true });
            doc.font('Helvetica').text(', represented by Mr./Ms. ', { continued: true });
            doc.font('Helvetica-Bold').text(`${val(representativeName)}`, { continued: true });
            doc.font('Helvetica').text(', (hereinafter referred to as the “Client” / “Hostel Owner” / “Partner”, which expression shall, unless repugnant to the context, include its heirs, legal representatives, and permitted assigns).');
            doc.moveDown(0.5);

            para('Roomhy and the Client shall hereinafter be individually referred to as a “Party” and collectively as the “Parties”.');

            // ── Recitals ──────────────────────────────────
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a237e').text('A. RECITALS');
            doc.moveDown(0.3);
            sub('A.1', 'Roomhy owns, operates, and maintains a proprietary technology platform, mobile/web application, and back-office software system designed to enable hostel and PG (paying-guest) properties to manage bookings, inventory, pricing, guest communication, payments, and related operations (the “Platform”/“Software”).');
            sub('A.2', 'Roomhy has additionally developed a unique, proprietary bidding mechanism through which verified guest/customer leads seeking hostel accommodation are allocated to onboarded hostel properties (the “Bidding Process”), as more particularly described in Clause 3 below.');
            sub('A.3', 'The Client owns/operates the hostel property described above and wishes to be onboarded onto the Platform to avail of the Software and the leads generated through the Bidding Process, on the terms and conditions recorded in this Agreement.');
            sub('A.4', 'The Parties, having read and understood the contents of this Agreement and intending to be legally bound, agree as follows.');

            // ── Section 1 ──────────────────────────────────
            sectionHeader('1. DEFINITIONS AND INTERPRETATION');
            sub('1.1', '“Software” / “Platform” means the hostel management software system provided by Roomhy, including all modules for booking management, room/bed inventory, front-desk operations, payment collection, guest verification, reporting/analytics, and any updates, upgrades, or new features released by Roomhy from time to time.');
            sub('1.2', '“Lead(s)” means any prospective guest/customer enquiry, booking request, or contact detail generated through the Platform and allocated to the Client through the Bidding Process.');
            sub('1.3', '“Bidding Process” means Roomhy\'s proprietary, algorithm-based mechanism by which Leads are offered/allocated amongst competing onboarded hostels based on parameters determined solely by Roomhy, including but not limited to price, availability, ratings, response time, and bid value.');
            sub('1.4', '“Circumvention” or “Bypass” means any act by the Client, or its owners, staff, agents, or representatives, of directly or indirectly contacting, soliciting, negotiating, confirming a booking with, or accepting payment from any Lead outside the Platform, with the intent or effect of avoiding payment of Roomhy\'s commission/fee that would otherwise be due on such Lead.');
            sub('1.5', '“Confidential Information” has the meaning assigned in Clause 9.');
            sub('1.6', 'Words importing the singular include the plural and vice versa; headings are for convenience only and shall not affect interpretation.');

            // ── Section 2 ──────────────────────────────────
            sectionHeader('2. SOFTWARE & PLATFORM SERVICES');
            sub('2.1', 'Roomhy shall provide the Client with access to the full Hostel Management Software, which shall include, without limitation, the following facilities required to manage the Client\'s hostel:');
            bullet('Bed/room inventory and occupancy management');
            bullet('Online and walk-in booking management with real-time calendar sync');
            bullet('Guest check-in/check-out, ID verification, and digital records');
            bullet('Payment collection, invoicing, and settlement reporting');
            bullet('Staff/front-desk user access with role-based permissions');
            bullet('Dashboard, occupancy and revenue analytics/reports');
            bullet('Guest communication tools (notifications/messages)');
            bullet('Any additional modules Roomhy may introduce from time to time as part of the Platform');
            sub('2.2', 'Roomhy shall use reasonable commercial efforts to ensure the Software remains operational, subject to scheduled maintenance, updates, and circumstances beyond its reasonable control. Roomhy does not guarantee uninterrupted or error-free operation of the Software.');
            sub('2.3', 'The Client is granted a non-exclusive, non-transferable, revocable right to access and use the Software solely for managing its own hostel property/properties named in this Agreement, for the Term of this Agreement.');

            // ── Section 3 ──────────────────────────────────
            sectionHeader('3. LEAD GENERATION THROUGH BIDDING PROCESS');
            sub('3.1', 'Roomhy shall generate and channel prospective guest Leads to onboarded hostels through its unique Bidding Process.');
            sub('3.2', 'The manner of allocation of Leads, the criteria/weightage applied in the Bidding Process, and the frequency/volume of Leads made available to the Client shall be at Roomhy\'s sole discretion and may be modified by Roomhy from time to time, with or without prior notice, to improve platform efficiency.');
            sub('3.3', 'Roomhy does not guarantee any minimum number of Leads, bookings, occupancy, or revenue to the Client. Participation in the Bidding Process does not create any right, title, entitlement, or expectation of guaranteed business.');
            sub('3.4', 'All bookings arising out of a Lead shall be processed, confirmed, and paid for through the Platform only, unless otherwise expressly permitted by Roomhy in writing.');

            // ── Section 4 ──────────────────────────────────
            sectionHeader('4. OBLIGATIONS OF ROOMHY');
            sub('4.1', 'Provide the Client with login credentials/access to the Software upon successful onboarding and verification.');
            sub('4.2', 'Provide reasonable training/onboarding assistance and customer support for use of the Platform.');
            sub('4.3', 'Process payments/settlements due to the Client in accordance with the payment cycle agreed under Clause 7, subject to deduction of applicable commission, fees, and statutory dues.');
            sub('4.4', 'Maintain reasonable data security measures to protect Client and guest data uploaded onto the Platform, in accordance with Roomhy\'s prevailing privacy policy.');

            // ── Section 5 ──────────────────────────────────
            sectionHeader('5. OBLIGATIONS OF THE CLIENT / HOSTEL OWNER');
            sub('5.1', 'Provide accurate, complete, and updated information regarding the hostel property, room/bed inventory, pricing, photographs, amenities, and availability at the time of onboarding and on an ongoing basis.');
            sub('5.2', 'Honour all confirmed bookings made through the Platform at the price and terms displayed at the time of booking, subject to genuine unavailability beyond the Client\'s control, which must be promptly communicated to Roomhy.');
            sub('5.3', 'Maintain the hostel property in accordance with applicable safety, hygiene, fire-safety, and local municipal/police regulations, and hold all licences/registrations required to operate a hostel/PG accommodation in its jurisdiction.');
            sub('5.4', 'Use the Software only for its own hostel operations and not sub-license, share credentials with, or permit use of the Software by any unauthorised third party.');
            sub('5.5', 'Not engage, directly or indirectly, in any act of Circumvention/Bypass as defined and governed under Clause 6 below.');
            sub('5.6', 'Promptly pay all commissions, fees, and charges due to Roomhy as per Clause 7.');

            // ── Section 6 ──────────────────────────────────
            sectionHeader('6. NON-CIRCUMVENTION / ANTI-BYPASS POLICY');
            sub('6.1', 'The Client acknowledges that all Leads made available through the Platform are the proprietary business asset of Roomhy, generated at Roomhy\'s cost and effort through the Bidding Process, and that Roomhy\'s commercial model depends on bookings arising from such Leads being concluded and paid for through the Platform.');
            sub('6.2', 'The Client shall not, whether directly or through any employee, agent, or representative, contact a guest/Lead introduced by Roomhy outside the Platform with a view to inducing the guest to cancel, avoid, or rebook outside the Platform, or otherwise Circumvent/Bypass Roomhy so as to avoid payment of the commission/fee due to Roomhy.');
            sub('6.3', 'First Violation: Where Roomhy determines, based on reasonable evidence (including guest complaints, communication records, payment mismatches, or platform analytics), that the Client has committed an act of Circumvention/Bypass, Roomhy shall issue a written warning to the Client and shall be entitled to temporarily suspend/block the Client\'s account and access to the Platform (including allocation of further Leads) for such period as Roomhy may determine, until the matter is resolved to Roomhy\'s satisfaction and any commission due is settled.');
            sub('6.4', 'Second/Subsequent Violation: In the event of a second or any subsequent act of Circumvention/Bypass by the Client, Roomhy shall be entitled, without further notice, to permanently and irrevocably block the Client\'s account and terminate this Agreement with immediate effect, without any obligation to refund any subscription/onboarding fee paid, and without prejudice to Roomhy\'s right to recover the commission/fee that would have been payable had the transaction been routed through the Platform, along with any other losses/damages suffered.');
            sub('6.5', 'The determination of whether an act constitutes Circumvention/Bypass, and the severity/duration of suspension under Clause 6.3, shall rest with Roomhy, acting reasonably and in good faith. Roomhy shall communicate the basis of any such determination to the Client in writing.');

            // ── Section 7 ──────────────────────────────────
            sectionHeader('7. FEES, COMMISSION & PAYMENT TERMS');
            sub('7.1', `Onboarding/Subscription Fee: The Client shall pay a one-time/recurring onboarding or subscription fee of ₹${subFeeVal} (Rupees ${subWordsVal} only), payable ${val(subscriptionFrequency)}, for access to the Software.`);
            const commissionText = commissionPercent && String(commissionPercent).trim() && String(commissionPercent).trim() !== '-'
                ? `Roomhy shall be entitled to a commission of ${commissionPercent}% (percent) on the gross booking value of every booking confirmed through the Platform, or such other amount as may be mutually agreed and recorded in writing from time to time.`
                : `Roomhy shall be entitled to a commission on the gross booking value of every booking confirmed through the Platform as mutually agreed between the Parties in writing from time to time.`;
            sub('7.2', `Commission on Bookings: ${commissionText}`);
            sub('7.3', `Settlement Cycle: Amounts collected on behalf of the Client (net of Roomhy's commission and applicable statutory deductions/taxes) shall be settled to the Client's designated bank account within ${val(settlementDays)} days of the guest's check-in/check-out, as per Roomhy's standard settlement policy.`);
            sub('7.4', 'All fees/commissions stated are exclusive of applicable taxes (including GST), which shall be borne by the Client as per law.');
            sub('7.5', `Any delay in payment of dues by the Client to Roomhy beyond ${val(delayDays)} days shall attract interest @ ${val(interestPercent)}% per month and shall entitle Roomhy to suspend the Client's Platform access until dues are cleared.`);

            // ── Section 8 ──────────────────────────────────
            sectionHeader('8. TERM & TERMINATION');
            sub('8.1', `This Agreement shall commence on the Effective Date and shall remain in force for a period of ${val(termDuration)} year(s)/months, unless terminated earlier in accordance with this Agreement (“Term”), and shall thereafter renew automatically for successive like periods unless either Party gives written notice of non-renewal at least 30 (thirty) days prior to expiry.`);
            sub('8.2', 'Either Party may terminate this Agreement for convenience by giving 30 (thirty) days\' prior written notice to the other Party.');
            sub('8.3', 'Roomhy may terminate this Agreement with immediate effect, in addition to its rights under Clause 6.4, if the Client: (a) commits a material breach of this Agreement which remains uncured for 15 (fifteen) days after written notice; (b) is found operating the hostel without requisite legal licences; (c) engages in fraud, misrepresentation, or conduct harmful to Roomhy\'s brand or its guests; or (d) becomes insolvent or ceases business.');
            sub('8.4', 'Upon termination, the Client\'s access to the Software shall be revoked, all outstanding dues shall become immediately payable, and each Party shall return/destroy the other\'s Confidential Information. Clauses 6, 7 (accrued dues), 9, 10, 11, 12, 13, and 15 shall survive termination.');

            // ── Section 9 ──────────────────────────────────
            sectionHeader('9. CONFIDENTIALITY');
            sub('9.1', '“Confidential Information” means all business, technical, financial, guest, and pricing information disclosed by either Party to the other, whether orally or in writing, that is designated confidential or ought reasonably to be understood as confidential given the nature of the information.');
            sub('9.2', 'Each Party shall keep the other\'s Confidential Information strictly confidential and shall not disclose it to any third party, except to employees/advisors on a need-to-know basis, or as required by law or a competent court/authority.');
            sub('9.3', 'This obligation shall survive the termination or expiry of this Agreement for a period of 2 (two) years.');

            // ── Section 10 ──────────────────────────────────
            sectionHeader('10. INTELLECTUAL PROPERTY');
            sub('10.1', 'The Software, Platform, Bidding Process, related algorithms, trademarks, logos, and all underlying source code, technology, and documentation are and shall remain the sole and exclusive property of Roomhy.');
            sub('10.2', 'Nothing in this Agreement shall be construed as transferring any ownership right in the Software/Platform to the Client. The Client is granted only a limited right of use as set out in Clause 2.3.');
            sub('10.3', 'The Client shall not reverse-engineer, copy, modify, or create derivative works of the Software, nor use Roomhy\'s brand name/trademarks without prior written consent.');

            // ── Section 11 ──────────────────────────────────
            sectionHeader('11. REPRESENTATIONS & WARRANTIES');
            sub('11.1', 'Each Party represents that it has full power and authority to enter into this Agreement and that the person executing this Agreement on its behalf is duly authorised to do so.');
            sub('11.2', 'The Client represents and warrants that it is the lawful owner/operator of the hostel property named herein, holds all necessary permissions/licences to operate the same, and that all information provided to Roomhy is true and accurate.');

            // ── Section 12 ──────────────────────────────────
            sectionHeader('12. INDEMNIFICATION & LIMITATION OF LIABILITY');
            sub('12.1', 'The Client shall indemnify and keep indemnified Roomhy, its directors, officers, and employees against any loss, claim, damage, or expense arising out of: (a) the Client\'s breach of this Agreement; (b) any act of Circumvention/Bypass; (c) the condition, safety, or legality of the hostel property; or (d) any claim brought by a guest against the Client.');
            sub('12.2', 'Save in cases of fraud, wilful misconduct, or breach of Clause 6 (Non-Circumvention), the aggregate liability of Roomhy under this Agreement shall not exceed the total commission/fee paid by the Client to Roomhy in the 3 (three) months preceding the event giving rise to the claim.');
            sub('12.3', 'Neither Party shall be liable to the other for any indirect, incidental, or consequential loss, including loss of profit or business opportunity.');

            // ── Section 13 ──────────────────────────────────
            sectionHeader('13. FORCE MAJEURE');
            sub('13.1', 'Neither Party shall be liable for any failure or delay in performance caused by circumstances beyond its reasonable control, including natural disasters, pandemics, government orders, internet/server outages of third-party providers, strikes, or civil disturbance, provided the affected Party notifies the other promptly and uses reasonable efforts to mitigate the impact.');

            // ── Section 14 ──────────────────────────────────
            sectionHeader('14. GOVERNING LAW & JURISDICTION');
            sub('14.1', 'This Agreement shall be governed by and construed in accordance with the laws of India.');
            sub('14.2', 'Subject to Clause 14.3, the courts at Kota, Rajasthan alone shall have exclusive jurisdiction to entertain any suit, application, or proceeding arising out of or in connection with this Agreement, and both Parties expressly submit to the exclusive jurisdiction of the courts at Kota.');
            sub('14.3', 'Dispute Resolution: In the event of any dispute, the Parties shall first attempt to resolve it amicably through good-faith negotiation within 15 (fifteen) days of written notice by either Party. Failing amicable resolution, the dispute may, at either Party\'s option, be referred to arbitration by a sole arbitrator mutually appointed by the Parties, under the Arbitration and Conciliation Act, 1996, with the seat and venue of arbitration at Kota, Rajasthan, and the proceedings conducted in English/Hindi. This clause is without prejudice to Clause 14.2 for matters not referred to arbitration.');

            // ── Section 15 ──────────────────────────────────
            sectionHeader('15. GENERAL / MISCELLANEOUS');
            sub('15.1', 'Entire Agreement: This Agreement, along with any annexures/schedules, constitutes the entire understanding between the Parties and supersedes all prior discussions, understandings, or agreements, oral or written, on the subject matter hereof.');
            sub('15.2', 'Amendment: No amendment or modification to this Agreement shall be valid unless made in writing and signed by authorised representatives of both Parties.');
            sub('15.3', 'Assignment: The Client shall not assign or transfer its rights/obligations under this Agreement without Roomhy\'s prior written consent. Roomhy may assign this Agreement to any affiliate or successor in business.');
            sub('15.4', 'Severability: If any provision of this Agreement is held invalid or unenforceable, the remaining provisions shall continue in full force and effect.');
            sub('15.5', 'Waiver: No failure or delay by either Party in exercising any right under this Agreement shall operate as a waiver thereof.');
            sub('15.6', 'Notices: All notices under this Agreement shall be in writing and sent by email/registered post/courier to the addresses of the Parties mentioned in this Agreement (or as updated in writing), and shall be deemed served on delivery/acknowledgment.');
            sub('15.7', 'Relationship of Parties: Nothing in this Agreement shall be construed to create a partnership, joint venture, agency, or employer-employee relationship between the Parties. The Client operates as an independent hostel owner/operator.');
            sub('15.8', 'Counterparts: This Agreement may be executed in counterparts (including scanned/electronic copies), each of which shall be deemed an original, and together shall constitute one and the same instrument.');

            // ── Execution & Signature Box ──────────────────────────────────
            if (doc.y + 220 > doc.page.height - M) doc.addPage();
            doc.moveDown(0.8);

            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1a237e')
               .text('IN WITNESS WHEREOF, the Parties hereto have set their hands on the day, month, and year first above written.');
            doc.moveDown(0.6);

            const tableY = doc.y;
            const boxWidth = PW / 2;
            const boxHeight = 185;

            // Draw border boxes
            doc.rect(M, tableY, boxWidth, boxHeight).lineWidth(0.8).strokeColor('#1a237e').stroke();
            doc.rect(M + boxWidth, tableY, boxWidth, boxHeight).lineWidth(0.8).strokeColor('#1a237e').stroke();

            // Left Box (FOR ROOMHY TECHNOLOGY)
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a237e')
               .text('FOR ROOMHY TECHNOLOGY', M + 10, tableY + 10);
            
            doc.font('Helvetica').fontSize(9).fillColor('#222222');
            doc.text('Name: Dasrath Singh', M + 10, tableY + 30);
            doc.text('Designation: Proprietor, Roomhy Technology', M + 10, tableY + 44);
            doc.text('GSTIN: 08SLWPS2629G1ZZ', M + 10, tableY + 58);

            // Draw Roomhy Official Stamp & Seal Image
            if (sealPath) {
                try {
                    doc.image(sealPath, M + 65, tableY + 70, { width: 75, height: 75 });
                } catch (e) {
                    console.error('Error embedding seal image:', e.message);
                }
            }

            doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a237e')
               .text('Signature:', M + 10, tableY + 130);

            doc.font('Helvetica').fontSize(9).fillColor('#222222')
               .text(`Date: ${today}`, M + 10, tableY + 155);


            // Right Box (FOR THE HOSTEL / CLIENT)
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a237e')
               .text('FOR THE HOSTEL / CLIENT', M + boxWidth + 10, tableY + 10);

            doc.font('Helvetica').fontSize(9).fillColor('#222222');
            doc.text(`Name: ${val(representativeName)}`, M + boxWidth + 10, tableY + 30);
            doc.text(`Hostel Name: ${val(tradeName)}`, M + boxWidth + 10, tableY + 44);

            // Draw Owner E-signature image if provided
            if (signatureDataUrl && signatureDataUrl.startsWith('data:image/')) {
                try {
                    const base64Data = signatureDataUrl.replace(/^data:image\/\w+;base64,/, '');
                    const imgBuffer = Buffer.from(base64Data, 'base64');
                    doc.image(imgBuffer, M + boxWidth + 20, tableY + 65, { width: 140, height: 50, fit: [160, 55] });
                } catch (e) {
                    console.error('Error rendering owner e-signature buffer:', e.message);
                }
            }

            doc.font('Helvetica-Bold').fontSize(9).fillColor('#1a237e')
               .text('Signature:', M + boxWidth + 10, tableY + 130);
            doc.font('Helvetica-Oblique').fontSize(11).fillColor('#1b5e20')
               .text(eSignName || val(representativeName), M + boxWidth + 65, tableY + 128);

            doc.font('Helvetica').fontSize(9).fillColor('#222222')
               .text(`Date: ${today}`, M + boxWidth + 10, tableY + 155);

            doc.y = tableY + boxHeight + 15;

            // Witnesses Section
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1a237e').text('Witnesses:');
            doc.moveDown(0.3);

            doc.font('Helvetica').fontSize(9).fillColor('#222222');
            doc.text('1. Name: __________________________        Signature: __________________________');
            doc.moveDown(0.4);
            doc.text('2. Name: __________________________        Signature: __________________________');

            doc.end();
        } catch (err) {
            reject(err);
        }
    });
}

module.exports = { generateOwnerAgreementPdfBuffer };
