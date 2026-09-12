require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const Owner = require('../models/Owner');
const Property = require('../models/Property');
const ApprovedProperty = require('../models/ApprovedProperty');
const Room = require('../models/Room');
const Tenant = require('../models/Tenant');
const Rent = require('../models/Rent');
const User = require('../models/user');
const BookingRequest = require('../models/BookingRequest');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/roomhy';

async function seedTenantForOwner6120() {
  try {
    console.log('Connecting to MongoDB database...');
    await mongoose.connect(MONGO_URI);
    console.log('Connected to MongoDB successfully.');

    const targetOwnerId = 'ROOMHY6120';

    // 1. Find or create Owner
    let ownerDoc = await Owner.findOne({ loginId: { $regex: new RegExp(`^${targetOwnerId}$`, 'i') } });
    if (!ownerDoc) {
      console.log(`Owner ${targetOwnerId} not found in Owner collection. Creating owner doc...`);
      const hashedPassword = await bcrypt.hash('Roomhy@123', 10);
      ownerDoc = await Owner.create({
        loginId: targetOwnerId,
        name: 'Live Owner 6120',
        phone: '9876543210',
        email: 'owner6120@roomhy.com',
        status: 'approved',
        isApproved: true,
        isActive: true,
        password: hashedPassword
      });
    }

    let ownerUser = await User.findOne({ loginId: { $regex: new RegExp(`^${targetOwnerId}$`, 'i') } });
    if (!ownerUser) {
      const hashedPassword = await bcrypt.hash('Roomhy@123', 10);
      ownerUser = await User.create({
        name: ownerDoc.name || 'Live Owner 6120',
        loginId: targetOwnerId,
        phone: ownerDoc.phone || '9876543210',
        email: ownerDoc.email || 'owner6120@roomhy.com',
        role: 'owner',
        password: hashedPassword,
        status: 'active',
        isActive: true
      });
    }

    console.log(`Owner Found/Created: ID = ${targetOwnerId}, Name = ${ownerDoc.name}`);

    // 2. Find or Create Property for ROOMHY6120
    let property = await Property.findOne({ ownerLoginId: { $regex: new RegExp(`^${targetOwnerId}$`, 'i') } });
    if (!property) {
      property = await ApprovedProperty.findOne({ ownerLoginId: { $regex: new RegExp(`^${targetOwnerId}$`, 'i') } });
    }

    if (!property) {
      console.log(`No property found for owner ${targetOwnerId}. Creating new property...`);
      property = await Property.create({
        title: 'Roomhy Premium Stay (6120)',
        ownerLoginId: targetOwnerId,
        owner_id: targetOwnerId,
        owner: ownerDoc._id,
        status: 'approved',
        isApproved: true,
        city: 'Jaipur',
        address: 'Sector 6, Main Road',
        propertyType: 'PG'
      });
      // Also add to ApprovedProperty for compatibility
      await ApprovedProperty.create({
        title: 'Roomhy Premium Stay (6120)',
        ownerLoginId: targetOwnerId,
        owner_id: targetOwnerId,
        owner: ownerDoc._id,
        status: 'approved',
        city: 'Jaipur',
        address: 'Sector 6, Main Road',
        propertyType: 'PG'
      }).catch(() => null);
    }

    console.log(`Property Found/Created: "${property.title}" (ID: ${property._id})`);

    // 3. Find or Create Room
    const roomNumber = '101';
    let room = await Room.findOne({ property: property._id, title: roomNumber });
    if (!room) {
      room = await Room.create({
        property: property._id,
        title: roomNumber,
        type: 'Single Sharing',
        beds: 1,
        price: 8500,
        status: 'occupied'
      });
    } else {
      room.status = 'occupied';
      await room.save();
    }
    console.log(`Room Found/Created: Room #${roomNumber} (ID: ${room._id})`);

    // 4. Create Tenant User & Tenant Record
    const tenantPhone = '9876506120';
    const tenantEmail = 'tenant6120@roomhy.com';
    const tenantLoginId = 'ROOMHYTNT6120';
    const tenantName = 'Amit Verma (Live)';
    const tenantPasswordRaw = 'Tenant@123';
    const hashedPassword = await bcrypt.hash(tenantPasswordRaw, 10);

    // Clean old tenant with this loginId or phone if exists
    await User.deleteMany({ loginId: tenantLoginId });
    await Tenant.deleteMany({ loginId: tenantLoginId });

    const tenantUser = await User.create({
      name: tenantName,
      phone: tenantPhone,
      email: tenantEmail,
      loginId: tenantLoginId,
      password: hashedPassword,
      role: 'tenant',
      status: 'active',
      isActive: true
    });

    const tenantDoc = await Tenant.create({
      name: tenantName,
      phone: tenantPhone,
      email: tenantEmail,
      property: property._id,
      room: room._id,
      roomNo: roomNumber,
      baseRoomRent: 8500,
      agreedRent: 8500,
      ownerLoginId: targetOwnerId,
      propertyTitle: property.title,
      status: 'active',
      moveInDate: new Date(),
      loginId: tenantLoginId,
      user: tenantUser._id,
      tempPassword: tenantPasswordRaw
    });

    console.log(`Tenant User & Record Created: ${tenantName} (${tenantLoginId})`);

    // 5. Create BookingRequest Record
    const bookingDoc = await BookingRequest.create({
      user_id: tenantUser._id.toString(),
      name: tenantName,
      phone: tenantPhone,
      email: tenantEmail,
      property_id: property._id.toString(),
      property_name: property.title,
      owner_id: targetOwnerId,
      owner_name: ownerDoc.name || 'Live Owner 6120',
      rent_amount: 8500,
      total_amount: 500, // Dynamic booking token
      status: 'confirmed',
      booking_status: 'confirmed',
      bookingStatus: 'confirmed',
      move_in_date: new Date(),
      check_in_date: new Date()
    });

    console.log(`BookingRequest Created: ID = ${bookingDoc._id}`);

    // 6. Create Rent Record
    const collectionMonth = new Date().toLocaleString('default', { month: 'short', year: 'numeric' });
    
    // Clean previous test rent for this tenant if any
    await Rent.deleteMany({ tenantLoginId });

    const rentDoc = await Rent.create({
      propertyName: property.title,
      roomNumber: roomNumber,
      tenantName: tenantName,
      tenantPhone: tenantPhone,
      tenantLoginId: tenantLoginId,
      ownerLoginId: targetOwnerId,
      ownerName: ownerDoc.name || 'Live Owner 6120',
      rentAmount: 8500,
      totalDue: 8500,
      paidAmount: 8500,
      dueAmount: 0,
      paymentStatus: 'paid',
      collectionMonth: collectionMonth,
      moveInDate: new Date()
    });

    console.log(`Rent Record Created: Month = ${collectionMonth}, Status = paid`);

    console.log('\n======================================================');
    console.log('✅ LIVE TENANT SEED COMPLETED SUCCESSFULLY FOR ROOMHY6120');
    console.log('======================================================');
    console.log(`Owner Login ID : ${targetOwnerId}`);
    console.log(`Property Title : ${property.title}`);
    console.log(`Room Number    : ${roomNumber}`);
    console.log(`Tenant Name    : ${tenantName}`);
    console.log(`Tenant Login ID: ${tenantLoginId}`);
    console.log(`Tenant Phone   : ${tenantPhone}`);
    console.log(`Tenant Password: ${tenantPasswordRaw}`);
    console.log(`Agreed Rent    : ₹8,500`);
    console.log(`Rent Status    : Paid (₹8,500)`);
    console.log('======================================================\n');

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error seeding tenant data:', err);
    process.exit(1);
  }
}

seedTenantForOwner6120();
