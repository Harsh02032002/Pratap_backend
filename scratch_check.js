const mongoose = require('mongoose');
require('dotenv').config();
const Room = require('./models/Room');
const Property = require('./models/Property');
const Tenant = require('./models/Tenant');

async function check() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB.');

  const propertyId = '6a301000a819d1881c501d2f';
  console.log('\n--- Property Info ---');
  const prop = await Property.findById(propertyId).lean();
  console.log(JSON.stringify(prop, null, 2));

  console.log('\n--- Rooms in Database for this property ---');
  const rooms = await Room.find({ property: new mongoose.Types.ObjectId(propertyId) }).lean();
  console.log(`Found ${rooms.length} rooms in DB:`);
  rooms.forEach(r => {
    console.log(`Room: ${r.title}, Type: ${r.type}, Beds: ${r.beds}, isDeleted: ${r.isDeleted}, isAvailable: ${r.isAvailable}`);
  });

  console.log('\n--- Tenants in Database for this property ---');
  const tenants = await Tenant.find({ property: new mongoose.Types.ObjectId(propertyId) }).lean();
  console.log(`Found ${tenants.length} tenants in DB:`);
  tenants.forEach(t => {
    console.log(`Tenant: ${t.name}, RoomName: ${t.roomNo}, RoomIdRef: ${t.room}, Status: ${t.status}`);
  });

  await mongoose.disconnect();
}

check().catch(console.error);
