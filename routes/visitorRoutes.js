const express = require('express');
const router = express.Router();
const visitorController = require('../controllers/visitorController');

router.get('/owner/:ownerLoginId', visitorController.getOwnerVisitors);
router.post('/', visitorController.createVisitor);
router.patch('/:id/status', visitorController.updateVisitorStatus);

module.exports = router;
