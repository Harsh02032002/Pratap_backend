const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

// Load backend .env
dotenv.config({ path: path.join(__dirname, 'Roomhy-Backend/.env') });

async function fixAdminRole() {
  try {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://Harsh:Harsh%402925@cluster0.hddqr9e.mongodb.net/roohmy?retryWrites=true&w=majority&appName=Cluster0';
    
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    
    console.log('Connected!');
    const User = mongoose.model('User');
    
    // Find admin user
    const user = await User.findOne({ email: 'admin@roomhy.com' });
    if (!user) {
      console.log('Admin user not found. Creating new one...');
      
      const crypto = require('crypto');
      const tempPassword = crypto.randomBytes(12).toString('base64');
      const hashedPassword = require('bcryptjs').hashSync(tempPassword, 12);
      
      const newUser = new User({
        loginId: 'ADMIN001',
        email: 'admin@roomhy.com',
        password: hashedPassword,
        role: 'admin',
        name: 'Admin User',
        phone: '8764425030',
        isActive: true
      });
      
      await newUser.save();
      console.log('NEW ADMIN CREATED:');
      console.log('Email: admin@roomhy.com');
      console.log('Password:', tempPassword);
    } else {
      console.log('Found existing user:', user.loginId, user.email, user.role);
      
      // Update role to admin
      await User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
      console.log('Role updated to: admin');
    }
    
    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

fixAdminRole();
