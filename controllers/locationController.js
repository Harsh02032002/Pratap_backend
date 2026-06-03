const express = require('express');
const City = require('../models/City');
const Area = require('../models/Area');
const { uploadImage, deleteImage, getCloudinaryConfig } = require('../utils/cloudinaryService');

// ==================== CITY OPERATIONS ====================

/**
 * GET ALL CITIES
 */
exports.getCities = async (req, res) => {
    try {
        const cities = await City.find({ status: 'Active' }).select('_id name state colleges population imageUrl propertyCount status').sort({ createdAt: -1 });
        
        res.status(200).json({
            success: true,
            data: cities
        });
    } catch (error) {
        console.error('Error fetching cities:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * GET CITY BY ID
 */
exports.getCityById = async (req, res) => {
    try {
        const { id } = req.params;
        const city = await City.findById(id);
        
        if (!city) {
            return res.status(404).json({
                success: false,
                message: 'City not found'
            });
        }
        
        res.status(200).json({
            success: true,
            data: city
        });
    } catch (error) {
        console.error('Error fetching city:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * CREATE CITY
 */
exports.createCity = async (req, res) => {
    try {
        const { name, state } = req.body;

        if (!name || !state) {
            return res.status(400).json({
                success: false,
                message: 'Name and state are required'
            });
        }

        // Check if city already exists
        const existingCity = await City.findOne({ name });
        if (existingCity) {
            return res.status(409).json({
                success: false,
                message: 'City already exists'
            });
        }

        let imageUrl = null;
        let imagePublicId = null;

        // Upload image if provided
        if (req.file) {
            try {
                const result = await uploadImage(req.file.buffer, 'roomhy/cities', name.toLowerCase());
                imageUrl = result.url;
                imagePublicId = result.publicId;
            } catch (uploadError) {
                console.error('Error uploading image:', uploadError);
                return res.status(400).json({
                    success: false,
                    message: 'Error uploading image: ' + uploadError.message
                });
            }
        }

        const city = new City({
            name,
            state,
            imageUrl,
            imagePublicId,
            status: 'Active'
        });

        await city.save();

        res.status(201).json({
            success: true,
            message: 'City created successfully',
            data: city
        });
    } catch (error) {
        console.error('Error creating city:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * UPDATE CITY
 */
exports.updateCity = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, state, status } = req.body;

        const city = await City.findById(id);
        if (!city) {
            return res.status(404).json({
                success: false,
                message: 'City not found'
            });
        }

        // Update fields
        if (name && name !== city.name) {
            const exists = await City.findOne({ name });
            if (exists) {
                return res.status(409).json({
                    success: false,
                    message: 'City with this name already exists'
                });
            }
            city.name = name;
        }
        if (state) city.state = state;
        if (status) city.status = status;

        // Handle image update
        if (req.file) {
            try {
                // Delete old image if exists
                if (city.imagePublicId) {
                    await deleteImage(city.imagePublicId);
                }

                // Upload new image
                const result = await uploadImage(req.file.buffer, 'roomhy/cities', name?.toLowerCase() || id);
                city.imageUrl = result.url;
                city.imagePublicId = result.publicId;
            } catch (uploadError) {
                console.error('Error uploading image:', uploadError);
                return res.status(400).json({
                    success: false,
                    message: 'Error uploading image: ' + uploadError.message
                });
            }
        }

        city.lastModifiedBy = req.user?.email || 'superadmin';
        await city.save();

        res.status(200).json({
            success: true,
            message: 'City updated successfully',
            data: city
        });
    } catch (error) {
        console.error('Error updating city:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * DELETE CITY
 */
exports.deleteCity = async (req, res) => {
    try {
        const { id } = req.params;

        const city = await City.findById(id);
        if (!city) {
            return res.status(404).json({
                success: false,
                message: 'City not found'
            });
        }

        // Delete image from Cloudinary if exists
        if (city.imagePublicId) {
            await deleteImage(city.imagePublicId);
        }

        // Delete associated areas
        await Area.deleteMany({ city: id });

        await City.findByIdAndDelete(id);

        res.status(200).json({
            success: true,
            message: 'City deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting city:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// ==================== AREA OPERATIONS ====================

/**
 * GET ALL AREAS
 */
exports.getAreas = async (req, res) => {
    try {
        const areas = await Area.find({ status: 'Active' })
            .populate('city')
            .sort({ createdAt: -1 });

        res.status(200).json({
            success: true,
            data: areas
        });
    } catch (error) {
        console.error('Error fetching areas:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * GET AREAS BY CITY
 * Returns areas filtered by city name
 */
exports.getAreasByCity = async (req, res) => {
    try {
        const { city } = req.params;
        console.log('getAreasByCity called with city:', city);

        if (!city) {
            return res.status(400).json({
                success: false,
                message: 'City parameter is required'
            });
        }

        // Search areas by cityName (case-insensitive) - uses denormalized field
        const areas = await Area.find({
            cityName: new RegExp(`^${city}$`, 'i'),
            status: 'Active'
        }).sort({ createdAt: -1 });

        console.log('Areas found:', areas.length, areas.map(a => a.name));

        res.status(200).json({
            success: true,
            data: areas
        });
    } catch (error) {
        console.error('Error fetching areas by city:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * CREATE AREA
 */
exports.createArea = async (req, res) => {
    try {
        const { name, cityId, city: cityBodyId } = req.body;
        const targetCityId = cityId || cityBodyId;
        
        if (!name || !targetCityId) {
            return res.status(400).json({
                success: false,
                message: 'Name and cityId are required'
            });
        }

        const cityObj = await City.findById(targetCityId);
        if (!cityObj) {
            return res.status(404).json({
                success: false,
                message: 'City not found'
            });
        }

        // Check if area already exists for this city
        const existingArea = await Area.findOne({ name, city: cityId });
        if (existingArea) {
            return res.status(409).json({
                success: false,
                message: 'Area already exists in this city'
            });
        }

        let imageUrl = null;
        let imagePublicId = null;

        // Upload image if provided
        if (req.file) {
            try {
                const result = await uploadImage(req.file.buffer, 'roomhy/areas', `${cityObj.name.toLowerCase()}_${name.toLowerCase()}`);
                imageUrl = result.url;
                imagePublicId = result.publicId;
            } catch (uploadError) {
                console.error('Error uploading image:', uploadError);
                return res.status(400).json({
                    success: false,
                    message: 'Error uploading image: ' + uploadError.message
                });
            }
        }

        const area = new Area({
            name,
            city: cityObj._id,
            cityId: cityObj._id, // Added for schema requirement
            cityName: cityObj.name,
            imageUrl,
            imagePublicId,
            status: 'Active'
        });

        await area.save();

        res.status(201).json({
            success: true,
            message: 'Area created successfully',
            data: area
        });
    } catch (error) {
        console.error('Error creating area:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * UPDATE AREA
 */
exports.updateArea = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, status } = req.body;

        const area = await Area.findById(id).populate('city');
        if (!area) {
            return res.status(404).json({
                success: false,
                message: 'Area not found'
            });
        }

        if (name && name !== area.name) {
            const exists = await Area.findOne({ name, city: area.city });
            if (exists) {
                return res.status(409).json({
                    success: false,
                    message: 'Area with this name already exists in this city'
                });
            }
            area.name = name;
        }
        if (status) area.status = status;

        // Handle image update
        if (req.file) {
            try {
                // Delete old image if exists
                if (area.imagePublicId) {
                    await deleteImage(area.imagePublicId);
                }

                // Upload new image
                const result = await uploadImage(
                    req.file.buffer,
                    'roomhy/areas',
                    `${area.cityName.toLowerCase()}_${name?.toLowerCase() || id}`
                );
                area.imageUrl = result.url;
                area.imagePublicId = result.publicId;
            } catch (uploadError) {
                console.error('Error uploading image:', uploadError);
                return res.status(400).json({
                    success: false,
                    message: 'Error uploading image: ' + uploadError.message
                });
            }
        }

        area.lastModifiedBy = req.user?.email || 'superadmin';
        await area.save();

        res.status(200).json({
            success: true,
            message: 'Area updated successfully',
            data: area
        });
    } catch (error) {
        console.error('Error updating area:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * DELETE AREA
 */
exports.deleteArea = async (req, res) => {
    try {
        const { id } = req.params;

        const area = await Area.findById(id);
        if (!area) {
            return res.status(404).json({
                success: false,
                message: 'Area not found'
            });
        }

        // Delete image from Cloudinary if exists
        if (area.imagePublicId) {
            await deleteImage(area.imagePublicId);
        }

        await Area.findByIdAndDelete(id);

        res.status(200).json({
            success: true,
            message: 'Area deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting area:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

/**
 * GET CLOUDINARY CONFIG
 */
exports.getCloudinaryConfig = async (req, res) => {
    try {
        const config = getCloudinaryConfig();
        res.status(200).json({
            success: true,
            data: config
        });
    } catch (error) {
        console.error('Error getting Cloudinary config:', error);
        res.status(500).json({
            success: false,
            message: error.message
        });
    }
};