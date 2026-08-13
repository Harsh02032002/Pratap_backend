const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function resetPassword() {
  try {
    const uri = 'mongodb://Harsh:Harsh%402925@ac-dxh54g9-shard-00-00.hddqr9e.mongodb.net:27017,ac-dxh54g9-shard-00-01.hddqr9e.mongodb.net:27017,ac-dxh54g9-shard-00-02.hddqr9e.mongodb.net:27017/team_roomhy?retryWrites=true&w=majority&appName=Cluster0';
    console.log('Connecting to MongoDB Atlas (direct)...');
    await mongoose.connect(uri, { 
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 30000 
    });
    console.log('Connected!');
    
    const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }));
    
    const user = await User.findOne({ email: 'harshdeepbca503@gmail.com' });
    if (!user) {
      console.log('User not found');
      process.exit(1);
    }
    
    const newPassword = '123456';
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    
    user.password = hashedPassword;
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
