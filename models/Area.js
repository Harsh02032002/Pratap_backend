const mongoose = require('mongoose');

const AreaSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        cityId: { type: mongoose.Schema.Types.ObjectId, ref: 'City' },
        city: { type: mongoose.Schema.Types.ObjectId, ref: 'City' }, // Backward compatibility
        cityName: { type: String, required: true }, // Denormalized for easier querying
        zone: { type: String, default: '' }, // North, South, East, West, Central
        landmarks: [{ type: String }], // Nearby landmarks (temples, stations, etc.)
        imageUrl: { type: String, default: null }, // Cloudinary image URL
        imagePublicId: { type: String, default: null }, // Cloudinary public ID for deletion
        propertyCount: { type: Number, default: 0 },
        description: { type: String, default: '' },
        status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
        createdBy: { type: String, default: 'superadmin' },
        lastModifiedBy: { type: String, default: 'superadmin' }
    },
    { timestamps: true }
);

// Compound index for unique area per city
AreaSchema.index({ name: 1, city: 1 }, { unique: true });
AreaSchema.index({ name: 1, cityId: 1 }, { unique: true });

// Static methods
AreaSchema.statics.getAreasByCity = function(cityId) {
    return this.find({ 
        $or: [{ city: cityId }, { cityId: cityId }],
        status: 'Active' 
    }).sort({ name: 1 });
};

AreaSchema.statics.searchAreas = function(query, cityId = null) {
    const searchQuery = {
        status: 'Active',
        name: { $regex: query, $options: 'i' }
    };
    
    if (cityId) {
        searchQuery.$or = [
            { city: cityId },
            { cityId: cityId }
        ];
    }
    
    return this.find(searchQuery).sort({ name: 1 });
};

module.exports = mongoose.model('Area', AreaSchema);
