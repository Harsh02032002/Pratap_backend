const mongoose = require('mongoose');
require('dotenv').config({ path: 'd:/hello-roomhy/Roomhy-Backend/.env' });

async function checkAllVisits() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/roomhy';
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;

    const visits = await db.collection('visitdatas').find({}).toArray();
    console.log(`TOTAL VISITS IN DATABASE: ${visits.length}`);
    visits.forEach((v, idx) => {
      console.log(`[${idx+1}] ID: ${v.visitId || v._id} | Property: ${v.propertyName || v.name} | StaffId: ${v.staffId} | StaffName: ${v.staffName} | SubmittedBy: ${v.submittedBy} | VisitorName: ${v.visitorName} | Owner: ${v.ownerName}`);
    });

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

checkAllVisits();
