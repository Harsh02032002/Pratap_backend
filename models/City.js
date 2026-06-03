const mongoose = require('mongoose');

const CitySchema = new mongoose.Schema(
    {
        name: { type: String, required: true, unique: true, trim: true, index: true },
        state: { type: String, required: true, trim: true },
        country: { type: String, default: 'India' },
        colleges: [{ type: String }], // List of colleges/institutions
        population: { type: Number, default: 0 },
        imageUrl: { type: String, default: null }, // Cloudinary image URL
        imagePublicId: { type: String, default: null }, // Cloudinary public ID for deletion
        propertyCount: { type: Number, default: 0 },
        description: { type: String, default: '' },
        coordinates: {
            latitude: { type: Number, default: 0 },
            longitude: { type: Number, default: 0 }
        },
        status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
        createdBy: { type: String, default: 'superadmin' },
        lastModifiedBy: { type: String, default: 'superadmin' }
    },
    { timestamps: true }
);

// Static methods
CitySchema.statics.getPopularCities = function(limit = 10) {
    return this.find({ status: 'Active' })
        .sort({ propertyCount: -1 })
        .limit(limit);
};

CitySchema.statics.getCitiesWithAreas = function() {
    return this.find({ status: 'Active' })
        .populate('areas')
        .sort({ name: 1 });
};

CitySchema.statics.searchCities = function(query) {
    return this.find({ 
        status: 'Active',
        name: { $regex: query, $options: 'i' }
    }).sort({ propertyCount: -1 });
};

// Virtual for areas
CitySchema.virtual('areas', {
    ref: 'Area',
    localField: '_id',
    foreignField: 'cityId'
});

module.exports = mongoose.model('City', CitySchema);
