const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');

router.post('/generate', reportController.generateReport);
router.get('/owner/:ownerLoginId', reportController.getPastReports);

module.exports = router;
