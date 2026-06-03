const express = require('express');
const router = express.Router();
const visitController = require('../controllers/visitController');

// Public endpoints for demo UI (no auth)
router.get('/pending', visitController.getPendingVisits);
router.put('/:id/approve', visitController.approveVisitPublic);
router.put('/:id/reject', visitController.rejectVisitPublic);
// Allow public submissions from demo UI (no auth) - creates/fetches area manager user if needed
router.post('/submit', visitController.submitVisitPublic);

module.exports = router;
