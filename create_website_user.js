const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const mongoose = require('mongoose');

async function createWebsiteUser() {
    const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!MONGO_URI) {
        console.error('❌ MONGO_URI is missing');
        process.exit(1);
    }

    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected.');

    const name = 'Web User One';
    const email = 'webuser1@roomhy.com';
    const phone = '9876543219';
    const password = 'userpassword123';
    const role = 'tenant';

    const User = mongoose.models.User || require('./models/user') || require('./models/User');
    const KYCVerification = mongoose.models.KYCVerification || require('./models/KYCVerification');

    // 1. Create or Update User document
    let user = await User.findOne({ $or: [{ email }, { phone }] });
    if (!user) {
        user = await User.create({
            name,
            email,
            phone,
            password,
            role,
            loginId: email,
            isActive: true
        });
        console.log('✅ Created User document in Roomhy-Backend:', user._id);
    } else {
        user.name = name;
        user.email = email;
        user.phone = phone;
        user.password = password;
        user.role = role;
        user.loginId = email;
        user.isActive = true;
        await user.save();
        console.log('✅ Updated User document in Roomhy-Backend:', user._id);
    }

    // 2. Ensure KYCVerification entry
    const signupId = `roomhyweb${String(Date.now()).slice(-6)}`;
    await KYCVerification.findOneAndUpdate(
        { email },
        {
            $set: {
                loginId: email,
                firstName: 'Web User',
                lastName: 'One',
                phone,
                role: 'tenant',
                status: 'pending',
                kycStatus: 'pending',
                password: user.password
            },
            $setOnInsert: {
                id: signupId,
                createdAt: new Date()
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    console.log('✅ Synced website signup in KYCVerification collection');

    console.log('\n=============================================');
    console.log('🎉 WEBSITE USER 1 CREATED SUCCESSFULLY 🎉');
    console.log('=============================================');
    console.log(`Name     : ${name}`);
    console.log(`Email    : ${email}`);
    console.log(`Phone    : ${phone}`);
    console.log(`Password : ${password}`);
    console.log(`Role     : ${role}`);
    console.log(`Login ID : ${user.loginId}`);
    console.log('=============================================\n');

    process.exit(0);
}

createWebsiteUser().catch((err) => {
    console.error('❌ Error creating website user:', err);
    process.exit(1);
});
