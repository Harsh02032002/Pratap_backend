const fs = require('fs');
const path = require('path');
const { generateOwnerAgreementPdfBuffer } = require('../utils/generateOwnerAgreementPdf');

async function testPdf() {
  try {
    const pdfBuffer = await generateOwnerAgreementPdfBuffer({
      effectiveDay: '26',
      effectiveMonth: 'September',
      effectiveYear: '2026',
      hostelLegalName: 'Paradise Residency Pvt Ltd',
      tradeName: 'Paradise Residency PG & Hostel',
      propertyAddress: '847, Balaji Nagar, Rangbari Road, Kota, Rajasthan - 324005',
      panNumber: 'ABCDE1234F',
      gstinNumber: '08ABCDE1234F1Z5',
      representativeName: 'Rajesh Kumar Sharma',
      ownerPhone: '9876543210',
      ownerEmail: 'owner@paradise.com',
      subscriptionFee: '5000',
      subscriptionFrequency: 'Annual',
      commissionPercent: '10',
      settlementDays: '7',
      eSignName: 'Rajesh Kumar Sharma',
      signedDate: '26 Sep 2026'
    });

    const outPath = 'C:\\Users\\HP\\.gemini\\antigravity-ide\\brain\\de21a4b8-2c4e-4e7e-ba44-072cc5d81125\\scratch\\test_owner_agreement.pdf';
    fs.writeFileSync(outPath, pdfBuffer);
    console.log(`PDF successfully written to ${outPath}, size: ${pdfBuffer.length} bytes`);
  } catch (e) {
    console.error('Error generating PDF:', e);
  }
}

testPdf();
