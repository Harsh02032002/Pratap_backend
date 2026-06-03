const express = require('express');
const router = express.Router();
const marketingAssetController = require('../controllers/marketingAssetController');

router.get('/owner/:ownerLoginId', marketingAssetController.getAssetsByOwner);
router.post('/', marketingAssetController.createAsset);
router.delete('/:id', marketingAssetController.deleteAsset);

module.exports = router;
