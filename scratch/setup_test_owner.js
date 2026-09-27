const mongoose = require('mongoose');
require('dotenv').config({ path: '../.env' });
const Owner = require('../models/Owner');
const User = require('../models/User');
const CheckinRecord = require('../models/CheckinRecord');

async function setupOwner() {
    try {
        const mongoUri = process.env.MONGO_URI || process.env.DATABASE_URL || 'mongodb://localhost:27017/roomhy';
        await mongoose.connect(mongoUri);
        console.log('Connected to MongoDB');

        const email = 'harshdeeobca503@gmail.com';
        const phone = '9464165010';

        // Check if owner with phone or email exists
        let owner = await Owner.findOne({ $or: [{ email }, { phone }] });
        let loginId = owner ? owner.loginId : 'ROOMHY6120';

        if (!owner) {
            owner = await Owner.findOne({ loginId: 'ROOMHY6120' });
        }

        if (owner) {
            owner.email = email;
            owner.phone = phone;
            owner.name = owner.name || 'Harshdeep Kaur';
            await owner.save();
            console.log(`Updated owner ${owner.loginId} with email ${email} and phone ${phone}`);
        } else {
            owner = await Owner.create({
                loginId: 'ROOMHY6120',
                name: 'Harshdeep Kaur',
                email: email,
                phone: phone,
                address: '847, Balaji Nagar, Rangbari Road, Kota, Rajasthan',
                propertyName: 'Paradise Residency Hostel',
                isActive: true,
                status: 'active'
            });
            console.log(`Created new owner ROOMHY6120`);
        }

        // Also update User model if exists
        let user = await User.findOne({ loginId: owner.loginId });
        if (user) {
            user.email = email;
            user.phone = phone;
            await user.save();
        }

        // Upsert CheckinRecord for owner
        let record = await CheckinRecord.findOne({ loginId: owner.loginId, role: 'owner' });
        if (!record) {
            record = await CheckinRecord.create({
                loginId: owner.loginId,
                role: 'owner',
                ownerProfile: {
                    name: owner.name,
                    email: email,
                    phone: phone,
                    address: owner.address
                },
                ownerKyc: {
                    otpVerified: true,
                    digilockerVerified: true
                }
            });
        } else {
            record.ownerProfile = record.ownerProfile || {};
            record.ownerProfile.email = email;
            record.ownerProfile.phone = phone;
            record.ownerKyc = record.ownerKyc || {};
            record.ownerKyc.otpVerified = true;
            await record.save();
        }

        console.log('\n================ OWNER DETAILS ================');
        console.log(`Login ID: ${owner.loginId}`);
        console.log(`Name: ${owner.name}`);
        console.log(`Email: ${email}`);
        console.log(`Phone: ${phone}`);
        console.log('================================================\n');

        console.log('Digital Check-In & Agreement Links:');
        console.log(`1. Agreement E-Sign Link (Live App): https://app.roomhy.com/digital-checkin/owneragreement?loginId=${encodeURIComponent(owner.loginId)}`);
        console.log(`2. Agreement E-Sign Link (Local Dev): http://localhost:5173/digital-checkin/owneragreement?loginId=${encodeURIComponent(owner.loginId)}`);
        console.log(`3. Owner Terms & Agreement Link: http://localhost:5173/digital-checkin/ownerterms?loginId=${encodeURIComponent(owner.loginId)}`);
        console.log(`4. Direct PDF View Link: http://localhost:5002/api/checkin/owner/agreement/pdf/${encodeURIComponent(owner.loginId)}`);

        process.exit(0);
    } catch (err) {
        console.error('Error setting up owner:', err);
        process.exit(1);
    }
}

setupOwner();
