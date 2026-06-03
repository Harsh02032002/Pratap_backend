// Cloudinary configuration utility
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dpwgvcibj',
  api_key: process.env.CLOUDINARY_API_KEY || '797434474725911',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'T2F9BtUmk_ZpHxZLZD3OTAVNTb4',
});

module.exports = cloudinary;
