/**
 * Quick seed script: Add test tenants to vacant rooms for owner ROOMHY9602
 * Run with: node scripts/seedTestTenants9602.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/roomhy';

async function seed() {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB');

    const Room     = require('../models/Room');
    const Tenant   = require('../models/Tenant');
    const Property = require('../models/Property');

    const ownerLoginId = 'ROOMHY9602';

    // Step 1: Find owner's properties (Property model has ownerLoginId, Room does NOT)
    const properties = await Property.find({
        ownerLoginId: { $regex: new RegExp(`^${ownerLoginId}$`, 'i') }
    }).lean();

    console.log(`Found ${properties.length} property(ies) for owner ${ownerLoginId}`);
    if (properties.length === 0) {
        console.log('❌ No properties found. Check ownerLoginId.');
        process.exit(0);
    }

    const propIds = properties.map(p => p._id);

    // Step 2: Find all rooms under these properties
    const rooms = await Room.find({
        property: { $in: propIds },
        isDeleted: { $ne: true }
    }).lean();

    console.log(`Found ${rooms.length} room(s)`);
    if (rooms.length === 0) {
        console.log('❌ No rooms found for these properties.');
        process.exit(0);
    }

    // Step 3: Filter rooms with at least one vacant bed
    const vacantRooms = rooms.filter(r => {
        const assignments = r.bedAssignments || [];
        const totalBeds = Math.max(r.beds || 1, 1);
        for (let b = 0; b < totalBeds; b++) {
            if (!assignments[b] || !assignments[b].tenantId) return true;
        }
        return false;
    });

    console.log(`Found ${vacantRooms.length} room(s) with vacant beds`);
    if (vacantRooms.length === 0) {
        console.log('⚠️  All rooms are fully occupied! Use Remove Tenants first.');
        process.exit(0);
    }

    const hashedPwd = await bcrypt.hash('Test@123', 10);
    const created = [];

    for (let i = 0; i < vacantRooms.length; i++) {
        const room = vacantRooms[i];
        const assignments = room.bedAssignments || [];
        const totalBeds = Math.max(room.beds || 1, 1);

        // Find first vacant bed index
        let bedIndex = 0;
        for (let b = 0; b < totalBeds; b++) {
            if (!assignments[b] || !assignments[b].tenantId) { bedIndex = b; break; }
        }

        const ts = Date.now();
        const suffix = `${ts}${i}`.slice(-6);
        const loginId = `TEST${suffix}`;
        const tenantName = `Test Tenant ${i + 1}`;

        const tenant = await Tenant.create({
            name: tenantName,
            phone: `9${String(ts).slice(-9)}`,
            email: `test${suffix}@roomhy.test`,
            loginId,
            password: hashedPwd,
            ownerLoginId,
            property: room.property,
            room: room._id,
            roomNo: room.title,
            bedNo: bedIndex + 1,
            agreedRent: room.price || 2000,
            status: 'active',
            moveInDate: new Date(),
            kycStatus: 'pending',
        });

        // Update room bedAssignments
        const updatedAssignments = [...assignments];
        while (updatedAssignments.length <= bedIndex) updatedAssignments.push({});
        updatedAssignments[bedIndex] = {
            tenantId: tenant._id,
            tenantName,
            tenantLoginId: loginId,
            assignedAt: new Date(),
        };
        await Room.findByIdAndUpdate(room._id, { $set: { bedAssignments: updatedAssignments } });

        created.push({ room: room.title, bed: bedIndex + 1, tenant: tenantName, loginId });
        console.log(`✅ Room "${room.title}" → Bed ${bedIndex + 1} → "${tenantName}" (${loginId})`);
    }

    console.log(`\n🎉 Done! ${created.length} test tenant(s) created`);
    console.log('🔑 Password for all: Test@123');
    console.table(created);
    await mongoose.disconnect();
    process.exit(0);
}

seed().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
