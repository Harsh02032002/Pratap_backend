const mongoose = require('mongoose');
require('dotenv').config({ path: 'd:/hello-roomhy/Roomhy-Backend/.env' });

async function check() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/roomhy';
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;
    
    const visit = await db.collection('visitdatas').findOne({ 
      $or: [
        { 'generatedCredentials.loginId': 'ROOMHY4541' },
        { ownerEmail: 'harsh20020203@gmail.com' }
      ]
    });
    console.log('--- VISIT DATA ---');
    console.log(JSON.stringify(visit, null, 2));

    const owner = await db.collection('owners').findOne({ loginId: 'ROOMHY4541' });
    console.log('--- OWNER DATA ---');
    console.log(JSON.stringify(owner, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}
check();
