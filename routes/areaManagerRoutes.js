const express = require('express');
const router = express.Router();
const areaManagerController = require('../controllers/areaManagerController');

// Get all area managers
router.get('/', areaManagerController.getAllAreaManagers);

// Search area managers
router.get('/search', areaManagerController.searchAreaManagers);

// Get area manager by email
router.get('/email/:email', areaManagerController.getAreaManagerByEmail);

// Get managers by area
router.get('/area/:area', areaManagerController.getManagersByArea);

// Get specific area manager by ID
router.get('/:id', areaManagerController.getAreaManagerById);

// Create new area manager
router.post('/', areaManagerController.createAreaManager);

// Bulk import area managers
router.post('/bulk/import', areaManagerController.bulkImportAreaManagers);

// Update area manager
router.put('/:id', areaManagerController.updateAreaManager);

// Update password
router.patch('/:id/password', areaManagerController.updatePassword);

// Delete area manager (soft delete)
router.delete('/:id', areaManagerController.deleteAreaManager);

module.exports = router;
