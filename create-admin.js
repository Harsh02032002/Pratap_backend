const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const path = require('path');

// Load backend .env
dotenv.config({ path: path.join(__dirname, 'Roomhy-Backend/.env') });

async function createAdmin() {
  try {
    const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://Harsh:Harsh%402925@cluster0.hddqr9e.mongodb.net/roohmy?retryWrites=true&w=majority&appName=Cluster0';
    
    console.log('Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
    });
    
    console.log('MongoDB connected successfully');
    const User = mongoose.model('User');
    
    const loginId = 'ADMIN001';
    const email = 'admin@roomhy.com';
    const name = 'Admin User';
    const password = 'Admin@Roomhy2025';
    const phone = '8764425030';
    
    // Check if already exists
    const existing = await User.findOne({ $or: [{ loginId }, { email }] });
    if (existing) {
      console.log('User already exists:', { loginId: existing.loginId, email: existing.email, role: existing.role });
      await mongoose.disconnect();
      return;
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const user = new User({
      loginId,
      email,
      password: hashedPassword,
      role: 'admin',
      name,
      phone,
      isActive: true,
      requirePasswordReset: false
    });
    
    await user.save();
    console.log('');
    console.log('========================================');
    console.log('ADMIN USER CREATED SUCCESSFULLY');
    console.log('========================================');
    console.log('Login ID:', loginId);
    console.log('Email:', email);
    console.log('Password:', password);
    console.log('Role: admin');
    console.log('');
    console.log('Use these credentials for admin panel:');
    console.log('Email:', email);
    console.log('Password:', password);
    console.log('========================================');
    await mongoose.disconnect();
  } catch (error) {
    console.error('');
    console.error('========================================');
    console.error('ERROR:', error.message);
    console.error('========================================');
    process.exit(1);
  }
}

createAdmin();
