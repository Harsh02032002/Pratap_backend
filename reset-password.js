const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function resetPassword() {
  try {
    await mongoose.connect('mongodb://localhost:27017/roomhy');
    const User = require('./models/user');
    
    const user = await User.findOne({ email: 'harshdeepbca503@gmail.com' });
    if (!user) {
      console.log('User not found');
      process.exit(1);
    }
    
    const newPassword = '123456';
    user.password = newPassword;
    await user.save();
    
    console.log('Password reset successful for:', user.email);
    console.log('LoginId:', user.loginId);
    console.log('Role:', user.role);
    
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

resetPassword();
