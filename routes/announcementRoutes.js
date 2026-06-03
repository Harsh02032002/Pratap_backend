const express = require('express');
const router = express.Router();
const announcementController = require('../controllers/announcementController');

router.get('/owner/:ownerLoginId', announcementController.getAnnouncementsByOwner);
router.post('/', announcementController.createAnnouncement);
router.delete('/:id', announcementController.deleteAnnouncement);

module.exports = router;
