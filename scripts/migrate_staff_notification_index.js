'use strict';
/**
 * Migration: add the composite recipient index on `notifications`.
 *
 * Adds: { toLoginId: 1, read: 1, createdAt: -1 }
 *
 * Why: the paginated recipient query
 *      find({ toLoginId, read? }).sort({ createdAt: -1 })
 * previously fell back to the single-field { toLoginId, createdAt } index and
 * an in-memory read filter. The composite index serves the scope + read filter
 * + ordering in one B-tree traversal, eliminating collection scans as the
 * notifications collection grows.
 *
 * Mongoose autoIndex creates this on boot in dev, but production commonly runs
 * with autoIndex disabled — this script makes the index explicit + idempotent.
 *
 * Usage:    node scripts/migrate_staff_notification_index.js
 * Rollback: node scripts/migrate_staff_notification_index.js --rollback
 */

const mongoose = require('mongoose');
const path     = require('path');
const dotenv   = require('dotenv');

dotenv.config({ path: path.join(__dirname, '../.env') });

const COLLECTION = 'notifications';
const INDEX_KEY  = { toLoginId: 1, read: 1, createdAt: -1 };
const INDEX_NAME = 'toLoginId_1_read_1_createdAt_-1';

const isRollback = process.argv.includes('--rollback');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const collection = mongoose.connection.db.collection(COLLECTION);
  const indexNames = (await collection.indexes()).map(i => i.name);

  console.log('\nCurrent indexes on', COLLECTION + ':');
  (await collection.indexes()).forEach(i => console.log(' •', i.name, JSON.stringify(i.key)));

  if (isRollback) {
    if (indexNames.includes(INDEX_NAME)) {
      console.log(`\nDropping "${INDEX_NAME}"...`);
      await collection.dropIndex(INDEX_NAME);
      console.log('  ✅ Dropped.');
    } else {
      console.log(`\n"${INDEX_NAME}" not found — nothing to drop.`);
    }
  } else {
    if (indexNames.includes(INDEX_NAME)) {
      console.log(`\n"${INDEX_NAME}" already exists — nothing to create.`);
    } else {
      console.log(`\nCreating "${INDEX_NAME}"...`);
      await collection.createIndex(INDEX_KEY, { name: INDEX_NAME, background: true });
      console.log('  ✅ Created.');
    }
  }

  await mongoose.disconnect();
  console.log('\n✅ Done. Disconnected.');
}

run().catch(err => {
  console.error('\n❌ Migration failed:', err.message);
  process.exitCode = 1;
  mongoose.disconnect().catch(() => {});
});
