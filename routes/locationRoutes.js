const express = require('express');
const router = express.Router();
const multer = require('multer');
const locationController = require('../controllers/locationController');

// Configure multer for image upload (in-memory storage)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed'), false);
        }
    }
});

// Multer error handling middleware
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: 'File too large. Maximum size is 5MB'
            });
        }
        return res.status(400).json({
            success: false,
            message: 'File upload error: ' + err.message
        });
    } else if (err) {
        return res.status(400).json({
            success: false,
            message: err.message
        });
    }
    next();
};

// ================== CITY ROUTES ==================

// Get all cities
router.get('/cities', locationController.getCities);

// Get city by ID
router.get('/cities/:id', locationController.getCityById);

// Create city (with optional image upload)
router.post('/cities', (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            return handleMulterError(err, req, res, next);
        }
        next();
    });
}, locationController.createCity);

// Update city (with optional image upload)
router.put('/cities/:id', (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            return handleMulterError(err, req, res, next);
        }
        next();
    });
}, locationController.updateCity);

// Delete city
router.delete('/cities/:id', locationController.deleteCity);

// ================== AREA ROUTES ==================

// Get all areas
router.get('/areas', locationController.getAreas);

// Get areas by city
router.get('/areas/city/:city', locationController.getAreasByCity);

// Create area (with optional image upload)
router.post('/areas', (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            return handleMulterError(err, req, res, next);
        }
        next();
    });
}, locationController.createArea);

// Update area (with optional image upload)
router.put('/areas/:id', (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            return handleMulterError(err, req, res, next);
        }
        next();
    });
}, locationController.updateArea);

// Delete area
router.delete('/areas/:id', locationController.deleteArea);

// ================== CONFIG ROUTES ==================

// Get Cloudinary configuration
router.get('/config/cloudinary', locationController.getCloudinaryConfig);

module.exports = router;