const mongoose = require('mongoose');
async function checkAreas() {
  try {
    const uri = 'mongodb://Harsh:Harsh%402925@ac-dxh54g9-shard-00-00.hddqr9e.mongodb.net:27017,ac-dxh54g9-shard-00-01.hddqr9e.mongodb.net:27017,ac-dxh54g9-shard-00-02.hddqr9e.mongodb.net:27017/team_roomhy?retryWrites=true&w=majority&appName=Cluster0';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, socketTimeoutMS: 30000 });
    const Area = mongoose.model('Area', new mongoose.Schema({}, { strict: false }));
    const count = await Area.countDocuments();
    console.log('Total areas in DB:', count);
    const sample = await Area.find({}).limit(5).lean();
    console.log('Sample areas:', JSON.stringify(sample, null, 2));
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err.message);
  }
}
checkAreas();
