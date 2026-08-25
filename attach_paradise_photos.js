'use strict';
/**
 * attach_paradise_photos.js
 * ─────────────────────────────────────────────────────────────
 * Attaches the 8 photos from public/website/Dheeraj Sir/ to
 * PARADISE RESIDENCY in both Property & ApprovedProperty collections.
 *
 * Usage:
 *   node attach_paradise_photos.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');

const Property = require('./models/Property');
const ApprovedProperty = require('./models/ApprovedProperty');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DB_URI;

const photos = [
  '/website/Dheeraj Sir/WhatsApp Image 2026-07-21 at 14.47.07.jpeg',
  '/website/Dheeraj Sir/WhatsApp Image 2026-07-21 at 14.47.08.jpeg',
  '/website/Dheeraj Sir/WhatsApp Image 2026-07-21 at 14.47.08 (1).jpeg',
  '/website/Dheeraj Sir/WhatsApp Image 2026-07-21 at 14.47.09.jpeg',
  '/website/Dheeraj Sir/WhatsApp Image 2026-07-21 at 14.47.09 (1).jpeg',
  '/website/Dheeraj Sir/WhatsApp Image 2026-07-21 at 14.47.09 (2).jpeg',
  '/website/Dheeraj Sir/WhatsApp Image 2026-07-21 at 14.47.10 (1).jpeg',
  '/website/Dheeraj Sir/WhatsApp Image 2026-07-21 at 14.47.10 (2).jpeg'
];

const featuredImage = photos[0];

async function main() {
  if (!MONGO_URI) {
    console.error('❌ MONGO_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('🔗 Connected to MongoDB');

  // 1. Update Property model
  const propResult = await Property.updateMany(
    { title: /PARADISE RESIDENCY/i },
    {
      $set: {
        images: photos,
        featuredImage: featuredImage
      }
    }
  );
  console.log(`✅ Property model updated: ${propResult.modifiedCount} documents updated with ${photos.length} photos`);

  // 2. Update ApprovedProperty model
  const appResult = await ApprovedProperty.updateMany(
    { $or: [{ 'propertyInfo.name': /PARADISE RESIDENCY/i }, { title: /PARADISE RESIDENCY/i }] },
    {
      $set: {
        images: photos,
        featuredImage: featuredImage,
        'propertyInfo.photos': photos
      }
    }
  );
  console.log(`✅ ApprovedProperty model updated: ${appResult.modifiedCount} documents updated with ${photos.length} photos`);

  await mongoose.disconnect();
  console.log('🎉 Photos attached successfully!');
}

main().catch(err => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
