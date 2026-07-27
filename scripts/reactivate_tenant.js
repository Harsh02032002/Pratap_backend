const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');

const loginId = process.argv[2] || 'ROOMHYTNT4575';

async function reactivate() {
    try {
        console.log(`Connecting to MongoDB...`);
        await mongoose.connect(process.env.MONGO_URI);
        
        const Tenant = require('../models/Tenant');
        const User = require('../models/user');

        const tenant = await Tenant.findOne({ loginId: String(loginId).toUpperCase() });
        if (!tenant) {
            console.error(`❌ Tenant ${loginId} not found!`);
            process.exit(1);
        }

        tenant.status = 'active';
        tenant.kycStatus = 'verified';
        tenant.isDeleted = false;
        tenant.moveoutRequest = { status: 'none', requestedDate: null, reason: '', submittedAt: null, duesAtMoveout: 0, refundAmount: 0, refundStatus: '' };
        await tenant.save();

        const user = await User.findOne({ loginId: String(loginId).toUpperCase() });
        if (user) {
            user.status = 'active';
            user.isActive = true;
            user.isDeleted = false;
            await user.save();
        }

        console.log(`✅ Tenant ${loginId} (${tenant.name}) reactivated successfully!`);
        console.log(`   Tenant status: ${tenant.status}`);
        console.log(`   User isActive: ${user ? user.isActive : false}`);

        process.exit(0);
    } catch (err) {
        console.error('❌ Reactivate error:', err.message);
        process.exit(1);
    }
}

reactivate();
