const mongoose = require('mongoose');
require('dotenv').config({ path: 'd:/hello-roomhy/Roomhy-Backend/.env' });
const { maskPhoneNumbers } = require('./utils/maskPhoneNumbers');

async function maskExistingChats() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/roomhy';
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;

    const messages = await db.collection('chatmessages').find({}).toArray();
    let updatedCount = 0;

    for (const msg of messages) {
      if (msg.message && typeof msg.message === 'string') {
        const masked = maskPhoneNumbers(msg.message);
        if (masked !== msg.message) {
          await db.collection('chatmessages').updateOne({ _id: msg._id }, { $set: { message: masked } });
          updatedCount++;
          console.log(`🔒 Masked chat message [${msg._id}]: "${msg.message}" -> "${masked}"`);
        }
      }
    }

    console.log(`✅ Total existing chat messages updated & masked: ${updatedCount}`);

  } catch (err) {
    console.error('Error:', err);
  } finally {
    await mongoose.disconnect();
  }
}

maskExistingChats();
