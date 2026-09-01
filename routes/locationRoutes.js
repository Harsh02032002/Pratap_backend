const express = require('express');
const router = express.Router();
const multer = require('multer');
const locationController = require('../controllers/locationController');
const { protect, authorize } = require('../middleware/authMiddleware');
const { reverseGeocode, locateCity, distanceKm } = require('../utils/geocode');

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
// ── Reverse geocoding ────────────────────────────────────────────────────────
// GET /api/locations/reverse-geocode?lat=&lon=
//
// Backs the visit-report live camera, which burns the place name onto the photo
// as evidence of where it was taken. Authenticated because it proxies a
// rate-limited third party — left open it would be an easy way for anyone to
// spend our Nominatim budget and get the origin blocked.
// A fix worse than this is not evidence of standing anywhere in particular.
const MAX_TRUSTED_ACCURACY_M = 250;
// Beyond this from the property's own city, the fix is describing a different
// place entirely — which is what a laptop does when it has no GPS and the
// browser guesses from the Wi-Fi/IP registration instead.
const MAX_CITY_DISTANCE_KM = 40;

router.get('/reverse-geocode', protect, async (req, res) => {
    const { lat, lon, expectedCity, accuracy } = req.query;
    try {
        const place = await reverseGeocode(lat, lon);

        // Cross-check the fix against where the property is supposed to be.
        //
        // Network positioning reports high confidence for answers that are
        // hundreds of km wrong — it is confident about its DATABASE ENTRY for
        // the access point, not about a measurement. Accuracy alone therefore
        // cannot catch it; distance from the expected city can.
        const verification = { trusted: true, reasons: [] };

        const acc = Number(accuracy);
        if (Number.isFinite(acc) && acc > MAX_TRUSTED_ACCURACY_M) {
            verification.trusted = false;
            verification.reasons.push(`Fix is only accurate to ±${Math.round(acc)}m`);
        }

        if (expectedCity) {
            const city = await locateCity(expectedCity);
            if (city) {
                const km = Math.round(distanceKm(Number(lat), Number(lon), city.latitude, city.longitude));
                verification.distanceKm = km;
                verification.expectedCity = expectedCity;
                if (km > MAX_CITY_DISTANCE_KM) {
                    verification.trusted = false;
                    verification.reasons.push(`${km}km from ${expectedCity}`);
                }
            }
        }

        return res.json({ success: true, ...place, verification });
    } catch (err) {
        // A missing place name must never block a capture — the photo still
        // carries its coordinates and timestamp. 200 with resolved:false says
        // "this worked, there is just no name", which the client treats as
        // different from a transport failure.
        console.warn('[locations/reverse-geocode] failed:', err.message);
        return res.json({ success: true, resolved: false, message: err.message });
    }
});

router.get('/cities', locationController.getCities);

// Get city by ID
router.get('/cities/:id', locationController.getCityById);

// Create city (with optional image upload)
router.post('/cities', protect, authorize('superadmin'), (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            return handleMulterError(err, req, res, next);
        }
        next();
    });
}, locationController.createCity);

// Update city (with optional image upload)
router.put('/cities/:id', protect, authorize('superadmin'), (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            return handleMulterError(err, req, res, next);
        }
        next();
    });
}, locationController.updateCity);

// Delete city
router.delete('/cities/:id', protect, authorize('superadmin'), locationController.deleteCity);

// ================== AREA ROUTES ==================

// Get all areas
router.get('/areas', locationController.getAreas);

// Get areas by city
router.get('/areas/city/:city', locationController.getAreasByCity);

// Create area (with optional image upload)
router.post('/areas', protect, authorize('superadmin'), (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            return handleMulterError(err, req, res, next);
        }
        next();
    });
}, locationController.createArea);

// Update area (with optional image upload)
router.put('/areas/:id', protect, authorize('superadmin'), (req, res, next) => {
    upload.single('image')(req, res, (err) => {
        if (err) {
            return handleMulterError(err, req, res, next);
        }
        next();
    });
}, locationController.updateArea);

// Delete area
router.delete('/areas/:id', protect, authorize('superadmin'), locationController.deleteArea);

// ================== CONFIG ROUTES ==================

// Get Cloudinary configuration
router.get('/config/cloudinary', protect, locationController.getCloudinaryConfig);

module.exports = router;