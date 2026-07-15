/**
 * One-off migration: drop the stale unique index `tenantId_1` on the
 * tenantattendances collection.
 *
 * Background: an earlier schema enforced one attendance record per tenant
 * (unique on tenantId alone). The current schema stores one record per
 * tenant PER DAY (unique on { tenantId, date }). The leftover tenantId_1
 * index makes marking a tenant on a new day fail with E11000 duplicate key.
 *
 * Run once:  node scripts/fixTenantAttendanceIndex.js
 */
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('❌ MONGO_URI not set'); process.exit(1); }

  await mongoose.connect(uri);
  const coll = mongoose.connection.collection('tenantattendances');

  const indexes = await coll.indexes();
  console.log('Existing indexes:', indexes.map(i => i.name).join(', '));

  // Drop the stale single-field unique index if present
  if (indexes.some(i => i.name === 'tenantId_1')) {
    await coll.dropIndex('tenantId_1');
    console.log('🗑️  Dropped stale index tenantId_1');
  } else {
    console.log('ℹ️  No tenantId_1 index found (already clean)');
  }

  // Ensure the correct compound unique index exists
  await coll.createIndex({ tenantId: 1, date: 1 }, { unique: true });
  console.log('✅ Ensured compound unique index { tenantId: 1, date: 1 }');

  console.log('Final indexes:', (await coll.indexes()).map(i => i.name).join(', '));
  await mongoose.disconnect();
  process.exit(0);
})().catch(err => { console.error('Migration failed:', err); process.exit(1); });
