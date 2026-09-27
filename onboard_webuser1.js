const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const mongoose = require('mongoose');

async function onboardWebUser1() {
    const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!MONGO_URI) {
        console.error('❌ MONGO_URI is missing');
        process.exit(1);
    }

    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected.');

    const email = 'webuser1@roomhy.com';
    const phone = '9876543219';

    const User = mongoose.models.User || require('./models/user');
    const Tenant = mongoose.models.Tenant || require('./models/Tenant');
    const Property = mongoose.models.Property || require('./models/Property');
    const ApprovedProperty = mongoose.models.ApprovedProperty || require('./models/ApprovedProperty');
    const Room = mongoose.models.Room || require('./models/Room');

    // 1. Find User
    let user = await User.findOne({ email });
    if (!user) {
        user = await User.create({
            name: 'Web User One',
            email,
            phone,
            password: 'userpassword123',
            role: 'tenant',
            loginId: email,
            isActive: true
        });
        console.log('✅ Created User document:', user._id);
    }

    // 2. Find any active Property or ApprovedProperty
    let property = await Property.findOne({ status: { $ne: 'deleted' } });
    if (!property) {
        property = await ApprovedProperty.findOne({});
    }

    if (!property) {
        property = await Property.create({
            title: 'Roomhy Demo Residency',
            ownerLoginId: 'ROOMHY9999',
            address: 'Sector 62, Noida',
            city: 'Noida',
            monthlyRent: 8000,
            status: 'active',
            isPublished: true,
            isLiveOnWebsite: true
        });
        console.log('✅ Created fallback Property:', property.title);
    } else {
        console.log('✅ Found Property for onboarding:', property.title, `(_id: ${property._id})`);
    }

    // 3. Find or Create Room
    let room = await Room.findOne({ property: property._id });
    if (!room) {
        room = await Room.create({
            property: property._id,
            title: '101',
            type: 'Single Sharing',
            beds: 2,
            price: 8000,
            status: 'active',
            isAvailable: true
        });
        console.log('✅ Created Room:', room.title);
    }

    // 4. Create or Update Tenant record for webuser1@roomhy.com
    let tenant = await Tenant.findOne({ email });
    if (!tenant) {
        tenant = await Tenant.create({
            name: user.name || 'Web User One',
            email,
            phone,
            user: user._id,
            property: property._id,
            propertyTitle: property.title,
            room: room._id,
            roomNo: room.title || '101',
            bedNo: 'A',
            ownerLoginId: property.ownerLoginId || 'ROOMHY9999',
            agreedRent: 8000,
            baseRoomRent: 8000,
            status: 'active',
            moveInDate: new Date(),
            kycStatus: 'verified',
            agreementStatus: 'signed',
            agreementSigned: true,
            loginId: user.loginId || email
        });
        console.log('✅ Created Active Tenant record:', tenant._id);
    } else {
        tenant.user = user._id;
        tenant.property = property._id;
        tenant.propertyTitle = property.title;
        tenant.room = room._id;
        tenant.roomNo = room.title || '101';
        tenant.bedNo = 'A';
        tenant.ownerLoginId = property.ownerLoginId || 'ROOMHY9999';
        tenant.agreedRent = 8000;
        tenant.status = 'active';
        tenant.moveInDate = new Date();
        tenant.kycStatus = 'verified';
        tenant.agreementStatus = 'signed';
        tenant.agreementSigned = true;
        await tenant.save();
        console.log('✅ Updated Tenant record to active status:', tenant._id);
    }

    console.log('\n=============================================');
    console.log('🎉 WEBUSER1@ROOMHY.COM ONBOARDED SUCCESSFULLY 🎉');
    console.log('=============================================');
    console.log(`Tenant Name   : ${tenant.name}`);
    console.log(`Email         : ${tenant.email}`);
    console.log(`Phone         : ${tenant.phone}`);
    console.log(`Property Title: ${property.title}`);
    console.log(`Property ID   : ${property._id}`);
    console.log(`Room Number   : ${tenant.roomNo}`);
    console.log(`Status        : ${tenant.status} (Active Moved-In Tenant)`);
    console.log(`Move-In Date  : ${tenant.moveInDate}`);
    console.log('=============================================\n');

    process.exit(0);
}

onboardWebUser1().catch(err => {
    console.error('❌ Error onboarding tenant:', err);
    process.exit(1);
});
