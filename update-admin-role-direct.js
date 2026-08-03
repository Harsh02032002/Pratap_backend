const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load backend .env
dotenv.config({ path: path.join(__dirname, 'Roomhy-Backend/.env') });

async function updateAdminRole() {
  try {
    // Try direct connection to shard
    const MONGO_URI = 'mongodb://Harsh:Harsh%402925@ac-dxh54g9-shard-00-00.hddqr9e.mongodb.net:27017,ac-dxh54g9-shard-00-01.hddqr9e.mongodb.net:27017,ac-dxh54g9-shard-00-02.hddqr9e.mongodb.net:27017/roohmy?ssl=true&replicaSet=atlas-acdh54g9-shard-0&authSource=admin&retryWrites=true&w=majority';
    
    console.log('Connecting to MongoDB (direct)...');
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    
    console.log('Connected!');
    const User = mongoose.model('User');
    
    const user = await User.findOne({ email: 'admin@roomhy.com' });
    if (!user) {
      console.log('User not found');
      await mongoose.disconnect();
      return;
    }
    
    console.log('Found user:', user.loginId, user.email, 'current role:', user.role);
    
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
    console.log('Role updated to: admin');
    
    await mongoose.disconnect();
    console.log('Done!');
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

updateAdminRole();
