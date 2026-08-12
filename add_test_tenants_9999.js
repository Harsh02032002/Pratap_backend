const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1']);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

require('dotenv').config();
const mongoose = require('mongoose');
const Tenant = require('./models/Tenant');
const Rent = require('./models/Rent');
const RentInvoice = require('./models/RentInvoice');
const Property = require('./models/Property');
const ApprovedProperty = require('./models/ApprovedProperty');
const Room = require('./models/Room');
const Owner = require('./models/Owner');
const User = require('./models/user');

async function main() {
    const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!MONGO_URI) {
        console.error('❌ MONGO_URI is missing');
        process.exit(1);
    }

    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected.');

    const ownerLoginId = 'ROOMHY9999';

    // 1. Get Owner User
    let ownerUser = await User.findOne({ loginId: ownerLoginId });
    if (!ownerUser) {
        ownerUser = await User.create({
            loginId: ownerLoginId,
            name: 'Harsh Owner',
            email: 'owner9999@roomhy.com',
            phone: '9876543210',
            password: 'ownerpassword123',
            role: 'owner',
            isActive: true
        });
        console.log('✅ Created Owner User:', ownerUser._id);
    } else {
        console.log('✅ Found existing Owner User:', ownerUser._id);
    }

    // 2. Ensure Owner exists
    let owner = await Owner.findOne({ loginId: ownerLoginId });
    if (!owner) {
        owner = await Owner.create({
            loginId: ownerLoginId,
            name: 'Harsh Owner',
            email: 'owner9999@roomhy.com',
            phone: '9876543210',
            checkinUpiId: 'owner9999@upi',
            checkinBankAccountNumber: '9999123456789',
            checkinIfscCode: 'HDFC0001234',
            checkinBankName: 'HDFC Bank',
            checkinAccountHolderName: 'Harsh Owner',
            isActive: true
        });
        console.log('✅ Created mock Owner profile:', owner.loginId);
    }

    // 3. Find or Create Property
    let property = await Property.findOne({ ownerLoginId });
    if (!property) {
        property = await Property.create({
            ownerLoginId,
            title: 'Roomhy Gold Residency',
            address: 'Sector 62, Noida',
            city: 'Noida',
            locality: 'Sector 62',
            monthlyRent: 8000,
            bedCount: 10,
            occupiedBeds: 0,
            views: 120,
            clicks: 15,
            isPublished: true,
            isLiveOnWebsite: true,
            status: 'active'
        });
        console.log('✅ Created mock Property:', property.title);
    } else {
        console.log('✅ Found existing Property:', property.title);
    }

    // 4. Ensure Rooms exist for the Property
    const roomsToCreate = [
        { title: 'Room 101', type: 'AC Double', beds: 2, price: 8500 },
        { title: 'Room 102', type: 'Non-AC Double', beds: 2, price: 7000 },
        { title: 'Room 201', type: 'AC Single', beds: 1, price: 12000 },
        { title: 'Room 202', type: 'AC Double', beds: 2, price: 8500 },
        { title: 'Room 203', type: 'Non-AC Triple', beds: 3, price: 6000 }
    ];

    const roomDocs = [];
    for (const rDef of roomsToCreate) {
        let roomDoc = await Room.findOne({ property: property._id, title: rDef.title });
        if (!roomDoc) {
            roomDoc = await Room.create({
                property: property._id,
                title: rDef.title,
                type: rDef.type,
                beds: rDef.beds,
                price: rDef.price,
                ownerLoginId,
                propertyName: property.title,
                isAvailable: true,
                vacantBeds: rDef.beds,
                bedAssignments: [],
                status: 'active'
            });
            console.log(`✅ Created Room: ${rDef.title}`);
        } else {
            console.log(`✅ Found existing Room: ${rDef.title}`);
        }
        roomDocs.push(roomDoc);
    }

    // 5. Define Tenants to Add
    const tenantsList = [
        { name: 'Karan Malhotra', email: 'karan.malhotra@example.com', phone: '9876543201', roomNo: 'Room 101', bedNo: 'A', rent: 8500, due: 8500, electricity: 320, phase: 1, daysSinceDue: 2 },
        { name: 'Rohan Mehra', email: 'rohan.mehra@example.com', phone: '9876543202', roomNo: 'Room 101', bedNo: 'B', rent: 8500, due: 0, electricity: 0, phase: 1, daysSinceDue: 0 },
        { name: 'Aditya Sen', email: 'aditya.sen@example.com', phone: '9876543203', roomNo: 'Room 102', bedNo: 'A', rent: 7000, due: 7000, electricity: 410, phase: 2, daysSinceDue: 12 },
        { name: 'Vikram Joshi', email: 'vikram.joshi@example.com', phone: '9876543204', roomNo: 'Room 201', bedNo: 'A', rent: 12000, due: 12000, electricity: 580, phase: 3, daysSinceDue: 24 },
        { name: 'Siddharth Roy', email: 'siddharth.roy@example.com', phone: '9876543205', roomNo: 'Room 202', bedNo: 'A', rent: 8500, due: 8500, electricity: 250, phase: 3, daysSinceDue: 18 }
    ];

    let occupiedBedsCount = 0;
    const currentMonth = new Date().toISOString().slice(0, 7); // e.g. "2026-07"

    for (let i = 0; i < tenantsList.length; i++) {
        const tDef = tenantsList[i];
        
        // Find matching room
        const roomDoc = roomDocs.find(r => r.title === tDef.roomNo);
        const roomId = roomDoc ? roomDoc._id : new mongoose.Types.ObjectId();

        // Ensure user account exists for this tenant
        const tenantLoginId = `ROOMHYTNT${8000 + i}`;
        let tUser = await User.findOne({ loginId: tenantLoginId });
        if (!tUser) {
            tUser = await User.create({
                loginId: tenantLoginId,
                name: tDef.name,
                email: tDef.email,
                phone: tDef.phone,
                password: 'tenantpassword123',
                role: 'tenant',
                isActive: true
            });
            console.log(`✅ Created User for Tenant: ${tDef.name} (${tenantLoginId})`);
        }

        // Find or create Tenant document
        let tenantDoc = await Tenant.findOne({ email: tDef.email });
        if (!tenantDoc) {
            tenantDoc = await Tenant.create({
                name: tDef.name,
                email: tDef.email,
                phone: tDef.phone,
                ownerLoginId,
                property: property._id,
                propertyTitle: property.title,
                room: roomId,
                roomNo: tDef.roomNo,
                bedNo: tDef.bedNo,
                status: 'active',
                agreedRent: tDef.rent,
                loginId: tenantLoginId,
                tempPassword: 'tenantpassword123',
                assignedBy: ownerUser._id,
                user: tUser._id,
                kycStatus: 'verified',
                agreementStatus: 'signed',
                agreementSigned: true
            });
            console.log(`✅ Created Tenant document: ${tDef.name}`);
        } else {
            tenantDoc.ownerLoginId = ownerLoginId;
            tenantDoc.property = property._id;
            tenantDoc.propertyTitle = property.title;
            tenantDoc.room = roomId;
            tenantDoc.roomNo = tDef.roomNo;
            tenantDoc.bedNo = tDef.bedNo;
            tenantDoc.status = 'active';
            tenantDoc.agreedRent = tDef.rent;
            tenantDoc.loginId = tenantLoginId;
            tenantDoc.user = tUser._id;
            await tenantDoc.save();
            console.log(`✅ Updated Tenant document: ${tDef.name}`);
        }

        // Add bed assignment to room doc
        if (roomDoc && !roomDoc.bedAssignments.includes(tenantDoc._id.toString())) {
            roomDoc.bedAssignments.push(tenantDoc._id.toString());
            roomDoc.vacantBeds = Math.max(0, roomDoc.beds - roomDoc.bedAssignments.length);
            roomDoc.isAvailable = roomDoc.vacantBeds > 0;
            await roomDoc.save();
        }

        occupiedBedsCount++;

        // Setup Invoices
        // If due > 0, create a pending RentInvoice
        if (tDef.due > 0) {
            const invoiceNumber = `INV-${currentMonth}-${tenantLoginId}-SEED`;
            let invoice = await RentInvoice.findOne({ tenantId: tenantDoc._id, billingMonth: currentMonth });
            if (invoice) {
                await RentInvoice.deleteOne({ _id: invoice._id });
            }

            const dueDate = new Date();
            dueDate.setDate(dueDate.getDate() - tDef.daysSinceDue);

            invoice = await RentInvoice.create({
                invoiceNumber,
                ownerId: ownerUser._id,
                propertyId: property._id,
                tenantId: tenantDoc._id,
                tenantName: tenantDoc.name,
                tenantEmail: tenantDoc.email,
                tenantPhone: tenantDoc.phone,
                billingMonth: currentMonth,
                rentAmount: tDef.rent,
                dueDate,
                electricityBill: tDef.electricity,
                electricityUnitsConsumed: Math.round(tDef.electricity / 8),
                electricityReadingAdded: tDef.electricity > 0,
                totalDue: tDef.due + tDef.electricity,
                outstandingAmount: tDef.due + tDef.electricity,
                paidAmount: 0,
                currentPhase: tDef.phase,
                daysSinceDue: tDef.daysSinceDue,
                status: 'PENDING'
            });
            console.log(`✅ Created Invoice: ${invoiceNumber} for ₹${invoice.totalDue}`);
        } else {
            // Paid Invoice
            const invoiceNumber = `INV-${currentMonth}-${tenantLoginId}-PAID`;
            let invoice = await RentInvoice.findOne({ tenantId: tenantDoc._id, billingMonth: currentMonth });
            if (invoice) {
                await RentInvoice.deleteOne({ _id: invoice._id });
            }

            invoice = await RentInvoice.create({
                invoiceNumber,
                ownerId: ownerUser._id,
                propertyId: property._id,
                tenantId: tenantDoc._id,
                tenantName: tenantDoc.name,
                tenantEmail: tenantDoc.email,
                tenantPhone: tenantDoc.phone,
                billingMonth: currentMonth,
                rentAmount: tDef.rent,
                dueDate: new Date(),
                totalDue: tDef.rent,
                outstandingAmount: 0,
                paidAmount: tDef.rent,
                currentPhase: 1,
                daysSinceDue: 0,
                status: 'PAID'
            });
            console.log(`✅ Created PAID Invoice: ${invoiceNumber}`);
        }
    }

    // Update Property Occupied Beds Count
    property.occupiedBeds = occupiedBedsCount;
    await property.save();

    // Re-sync to ApprovedProperty for superadmin analytics
    const syncToApprovedProperty = async (property) => {
        try {
            const vId = property.visitId || property._id.toString();
            const approvedPropertyData = {
                visitId: vId,
                propertyId: property._id.toString(),
                enquiry_id: property._id.toString(),
                propertyCategory: property.propertyCategory || "pg",
                state: property.state || "Noida",
                pincode: property.pincode || "201301",
                contact: property.contact || {},
                images: property.images || [],
                featuredImage: property.featuredImage || (property.images && property.images[0]) || "https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?w=400&h=300&fit=crop",
                propertyInfo: {
                    name: property.title,
                    city: property.city,
                    area: property.locality || 'Sector 62',
                    address: property.address,
                    rent: property.monthlyRent,
                    propertyType: 'pg',
                    genderSuitability: 'any',
                    amenities: ['wifi', 'parking', 'cctv', 'powerbackup'],
                    description: 'Roomhy Gold Residency PG'
                },
                generatedCredentials: {
                    ownerName: 'Harsh Owner',
                    loginId: ownerLoginId
                },
                isLiveOnWebsite: true,
                status: 'approved',
                updatedAt: new Date()
            };

            await ApprovedProperty.findOneAndUpdate(
                { propertyId: property._id.toString() },
                approvedPropertyData,
                { upsert: true, new: true }
            );
            console.log(`✅ Synced property "${property.title}" to ApprovedProperty`);
        } catch (err) {
            console.error('❌ ApprovedProperty Sync failed:', err);
        }
    };
    await syncToApprovedProperty(property);

    console.log('\n🎉 ALL TENANTS SUCCESSFULLY ADDED TO ROOMHY9999!');
    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('Error during seeding:', err);
    process.exit(1);
});
