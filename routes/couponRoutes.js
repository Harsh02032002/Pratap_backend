const express = require('express');
const router = express.Router();
const couponController = require('../controllers/couponController');

router.get('/owner/:ownerLoginId', couponController.getCouponsByOwner);
router.post('/', couponController.createCoupon);
router.put('/:id/deactivate', couponController.deactivateCoupon);

module.exports = router;
