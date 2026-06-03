const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');

// Configure Cloudinary
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'your-cloud-name',
    api_key: process.env.CLOUDINARY_API_KEY || 'your-api-key',
    api_secret: process.env.CLOUDINARY_API_SECRET || 'your-api-secret'
});

/**
 * Upload image to Cloudinary
 * @param {Buffer} fileBuffer - Image file buffer
 * @param {String} folder - Cloudinary folder path (e.g., 'roomhy/cities')
 * @param {String} publicId - Optional public ID for the resource
 * @returns {Promise} - { url, publicId }
 */
exports.uploadImage = (fileBuffer, folder, publicId = null) => {
    return new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            {
                folder: folder,
                resource_type: 'auto',
                public_id: publicId,
                quality: 'auto',
                fetch_format: 'auto',
                overwrite: publicId ? true : false
            },
            (error, result) => {
                if (error) return reject(error);
                resolve({
                    url: result.secure_url,
                    publicId: result.public_id
                });
            }
        );

        streamifier.createReadStream(fileBuffer).pipe(uploadStream);
    });
};

/**
 * Delete image from Cloudinary
 * @param {String} publicId - Cloudinary public ID
 * @returns {Promise}
 */
exports.deleteImage = async (publicId) => {
    try {
        await cloudinary.uploader.destroy(publicId);
        return { success: true };
    } catch (error) {
        console.error('Error deleting image from Cloudinary:', error);
        return { success: false, error: error.message };
    }
};

/**
 * Get Cloudinary configuration for client-side upload widget
 * @returns {Object} - { cloudName, uploadPreset }
 */
exports.getCloudinaryConfig = () => {
    return {
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || 'roomhy_locations'
    };
};
