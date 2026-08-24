const mongoose = require('mongoose');
async function checkData() {
  try {
    const uri = 'mongodb://Harsh:Harsh%402925@ac-dxh54g9-shard-00-00.hddqr9e.mongodb.net:27017,ac-dxh54g9-shard-00-01.hddqr9e.mongodb.net:27017,ac-dxh54g9-shard-00-02.hddqr9e.mongodb.net:27017/team_roomhy?retryWrites=true&w=majority&appName=Cluster0';
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000, socketTimeoutMS: 30000 });
    
    const ApprovedProperty = mongoose.model('ApprovedProperty', new mongoose.Schema({}, { strict: false }));
    const Property = mongoose.model('Property', new mongoose.Schema({}, { strict: false }));
    const Area = mongoose.model('Area', new mongoose.Schema({}, { strict: false }));
    
    const areaCount = await Area.countDocuments();
    const approvedCount = await ApprovedProperty.countDocuments();
    const propCount = await Property.countDocuments();
    
    console.log('Area count:', areaCount);
    console.log('ApprovedProperty count:', approvedCount);
    console.log('Property count:', propCount);
    
    if (approvedCount > 0) {
      const sample = await ApprovedProperty.find({}).limit(3).select('area city').lean();
      console.log('Sample approved properties:', JSON.stringify(sample, null, 2));
    }
    
    if (propCount > 0) {
      const sample = await Property.find({}).limit(3).select('area city').lean();
      console.log('Sample properties:', JSON.stringify(sample, null, 2));
    }
    
    await mongoose.disconnect();
  } catch (err) {
    console.error('Error:', err.message);
  }
}
checkData();
