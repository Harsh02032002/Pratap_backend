const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const Owner = require('../models/Owner');
const User = require('../models/User');
const CheckinRecord = require('../models/CheckinRecord');

async function setupSunitaShukla() {
    try {
        const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/roomhy';
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB');

        const phone = '8955468549';
        const email = 'singhsunita93938@gmail.com';
        const name = 'Sunita Shukla';
        const propertyName = 'HL Residency';
        const address = 'E-24 Landmarkcity kunari Kota Rajasthan 324008 Near by Allen samayak 1';
        const panNumber = 'BRGPS7399Q';
        const gstinNumber = '08AAACB1534F1Z6';
        const bankName = 'Bank of Baroda';
        const bankBranch = 'Kothradi chouraha jhalawar road';
        const bankAccountHolder = 'Sunita Shukla';

        // Check if owner with phone or email exists
        let owner = await Owner.findOne({ $or: [{ email }, { phone }] });
        let loginId = owner ? owner.loginId : 'ROOMHY8955';

        if (!owner) {
            owner = await Owner.findOne({ loginId });
        }

        if (owner) {
            owner.name = name;
            owner.email = email;
            owner.phone = phone;
            owner.propertyName = propertyName;
            owner.companyName = propertyName;
            owner.address = address;
            owner.panNumber = panNumber;
            owner.gstinNumber = gstinNumber;
            owner.bankDetails = {
                bankName,
                branch: bankBranch,
                accountHolder: bankAccountHolder
            };
            owner.isActive = true;
            owner.status = 'active';
            await owner.save();
            console.log(`✅ Updated existing owner ${owner.loginId} (${owner.name})`);
        } else {
            owner = await Owner.create({
                loginId,
                name,
                email,
                phone,
                propertyName,
                companyName: propertyName,
                address,
                panNumber,
                gstinNumber,
                bankDetails: {
                    bankName,
                    branch: bankBranch,
                    accountHolder: bankAccountHolder
                },
                isActive: true,
                status: 'active'
            });
            console.log(`✅ Created new owner ${owner.loginId} (${owner.name})`);
        }

        // Also update / create User model
        let user = await User.findOne({ $or: [{ loginId: owner.loginId }, { phone }, { email }] });
        if (user) {
            user.name = name;
            user.email = email;
            user.phone = phone;
            user.role = 'owner';
            await user.save();
        } else {
            await User.create({
                loginId: owner.loginId,
                name,
                email,
                phone,
                role: 'owner',
                isActive: true
            });
        }

        // Upsert CheckinRecord for owner
        let record = await CheckinRecord.findOne({ loginId: owner.loginId, role: 'owner' });
        const agreementDetails = {
            hostelLegalName: propertyName,
            tradeName: propertyName,
            propertyAddress: address,
            panNumber,
            gstinNumber,
            representativeName: name,
            subscriptionFee: '0',
            subscriptionFrequency: 'One-time',
            commissionPercent: '',
            settlementDays: '7',
            totalRooms: '54',
            roomTypes: "Single room (Girls & Boys both, 10 month compulsory stay)",
            bankDetails: {
                bankName,
                branch: bankBranch,
                accountHolder: bankAccountHolder
            }
        };

        if (!record) {
            record = await CheckinRecord.create({
                loginId: owner.loginId,
                role: 'owner',
                ownerProfile: {
                    name,
                    email,
                    phone,
                    address,
                    panNumber,
                    gstinNumber
                },
                ownerKyc: {
                    otpVerified: true,
                    digilockerVerified: true
                },
                ownerAgreement: {
                    status: 'pending',
                    agreementDetails
                }
            });
        } else {
            record.ownerProfile = record.ownerProfile || {};
            record.ownerProfile.name = name;
            record.ownerProfile.email = email;
            record.ownerProfile.phone = phone;
            record.ownerProfile.address = address;
            record.ownerProfile.panNumber = panNumber;
            record.ownerProfile.gstinNumber = gstinNumber;
            record.ownerKyc = record.ownerKyc || {};
            record.ownerKyc.otpVerified = true;
            record.ownerKyc.digilockerVerified = true;
            record.ownerAgreement = record.ownerAgreement || {};
            record.ownerAgreement.agreementDetails = agreementDetails;
            await record.save();
        }

        console.log('\n==================================================');
        console.log('🎉 OWNER & PROPERTY SUCCESSFULLY CONFIGURED');
        console.log('==================================================');
        console.log(`Login ID:          ${owner.loginId}`);
        console.log(`Owner Name:        ${name}`);
        console.log(`Hostel Name:       ${propertyName}`);
        console.log(`Phone:             ${phone}`);
        console.log(`Email:             ${email}`);
        console.log(`PAN:               ${panNumber}`);
        console.log(`GSTIN:             ${gstinNumber}`);
        console.log(`Address:           ${address}`);
        console.log(`Bank:              ${bankName}, ${bankBranch}`);
        console.log('==================================================\n');

        console.log('📌 OWNER E-SIGN AGREEMENT LINKS:');
        console.log(`1. Live Web Link:  https://roomhy.com/digital-checkin/owneragreement?loginId=${encodeURIComponent(owner.loginId)}`);
        console.log(`2. Local Dev Link: http://localhost:5173/digital-checkin/owneragreement?loginId=${encodeURIComponent(owner.loginId)}`);
        console.log(`3. PDF Direct Link: http://localhost:5002/api/checkin/owner/agreement/pdf/${encodeURIComponent(owner.loginId)}`);

        process.exit(0);
    } catch (err) {
        console.error('❌ Error setting up owner:', err);
        process.exit(1);
    }
}

setupSunitaShukla();
