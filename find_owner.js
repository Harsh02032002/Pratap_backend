const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const dbUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/roomhy';

async function run() {
  await mongoose.connect(dbUri);

  const Owner = mongoose.model('Owner', new mongoose.Schema({}, { strict: false }), 'owners');
  const User = mongoose.model('User', new mongoose.Schema({}, { strict: false }), 'users');
  const ApprovedProperty = mongoose.model('ApprovedProperty', new mongoose.Schema({}, { strict: false }), 'approvedproperties');

  const ownerDocs = await Owner.find({
    $or: [
      { loginId: '9000000021' },
      { phone: '9000000021' },
      { mobile: '9000000021' },
      { email: /9000000021/i }
    ]
  }).lean();

  const userDocs = await User.find({
    $or: [
      { loginId: '9000000021' },
      { phone: '9000000021' },
      { mobile: '9000000021' }
    ]
  }).lean();

  const apDocs = await ApprovedProperty.find({ visitId: 'SEED_INDORE_01' }).lean();

  console.log('=== OWNER DOCUMENTS ===');
  console.log(JSON.stringify(ownerDocs, null, 2));

  console.log('=== USER DOCUMENTS ===');
  console.log(JSON.stringify(userDocs, null, 2));

  console.log('=== APPROVED PROPERTY CREDS ===');
  console.log(JSON.stringify(apDocs.map(d => ({ visitId: d.visitId, generatedCredentials: d.generatedCredentials, ownerLoginId: d.ownerLoginId })), null, 2));

  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
