const mongoose = require('mongoose');
require('dotenv').config({ path: 'd:/hello-roomhy/Roomhy-Backend/.env' });

async function cleanLiveCameraPhotos() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/roomhy';
    await mongoose.connect(mongoUri);
    const db = mongoose.connection.db;

    const { flattenListingImages } = require('./utils/propertyGallery');

    const approvedList = await db.collection('approvedproperties').find({}).toArray();
    console.log(`Found ${approvedList.length} approved properties to sanitize...`);

    for (const prop of approvedList) {
      const publicImages = flattenListingImages(prop);
      const featuredImage = prop.featuredImage || publicImages[0] || '';
      
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
    console.log('✅ Cleaned all live camera photos from public ApprovedProperty listings!');
  } catch (err) {
    console.error('Error cleaning photos:', err);
  } finally {
    await mongoose.disconnect();
  }
}

cleanLiveCameraPhotos();
