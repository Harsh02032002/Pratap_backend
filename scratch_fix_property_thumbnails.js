const mongoose = require('mongoose');
require('dotenv').config({ path: 'd:/hello-roomhy/Roomhy-Backend/.env' });

async function fixPropertyThumbnails() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/roomhy';
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;

    const { flattenListingImages } = require('./utils/propertyGallery');

    console.log('--- Cleaning Property collection ---');
    const properties = await db.collection('properties').find({}).toArray();
    for (const prop of properties) {
      const publicImages = flattenListingImages(prop);
      const featuredImage = publicImages[0] || '';

      await db.collection('properties').updateOne(
        { _id: prop._id },
        {
          $set: {
            images: publicImages,
            featuredImage: featuredImage,
            updatedAt: new Date()
          }
        }
      );
    }
    console.log(`✅ Cleaned ${properties.length} Property documents.`);

    console.log('--- Cleaning ApprovedProperty collection ---');
    const approvedProps = await db.collection('approvedproperties').find({}).toArray();
    for (const prop of approvedProps) {
      const publicImages = flattenListingImages(prop);
      const featuredImage = publicImages[0] || '';
      
      const cleanViews = (prop.propertyViews || []).filter(v => {
        const label = String(v?.label || '').toLowerCase();
        return !label.includes('camera') && !label.includes('live');
      });

      await db.collection('approvedproperties').updateOne(
        { _id: prop._id },
        {
          $set: {
            images: publicImages,
            featuredImage: featuredImage,
            'propertyInfo.photos': publicImages,
            propertyViews: cleanViews,
            updatedAt: new Date()
          }
        }
      );
    }
    console.log(`✅ Cleaned ${approvedProps.length} ApprovedProperty documents.`);

  } catch (err) {
    console.error('Error fixing property thumbnails:', err);
  } finally {
    await mongoose.disconnect();
  }
}

fixPropertyThumbnails();
