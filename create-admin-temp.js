const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function createAdmin() {
  try {
    const MONGO_URI = 'mongodb+srv://Harsh:Harsh%402925@cluster0.hddqr9e.mongodb.net/roohmy?retryWrites=true&w=majority&appName=Cluster0';
    await mongoose.connect(MONGO_URI);
    const User = mongoose.model('User');
    
    const loginId = 'ADMIN001';
    const email = 'admin@roomhy.com';
    const name = 'Admin User';
    const password = 'Admin@Roomhy2025';
    
    const existing = await User.findOne({ $or: [{ loginId }, { email }] });
    if (existing) {
      console.log('User already exists:', { loginId: existing.loginId, email: existing.email, role: existing.role });
      await mongoose.disconnect();
      return;
    }
    
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const user = new User({
      loginId,
      email,
      password: hashedPassword,
      role: 'admin',
      name,
      isActive: true,
      requirePasswordReset: false
    });
    
    await user.save();
    console.log('ADMIN USER CREATED SUCCESSFULLY');
    console.log('Login ID:', loginId);
    console.log('Email:', email);
    console.log('Password:', password);
    console.log('');
    console.log('Credentials for admin panel:');
    console.log('Email:', email);
    console.log('Password:', password);
    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

createAdmin();
