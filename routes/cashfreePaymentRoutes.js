'use strict';
// DEPRECATED & REMOVED — Replaced by routes/payuPaymentRoutes.js
const express = require('express');
const router = express.Router();
const payuRoutes = require('./payuPaymentRoutes');
router.use('/', payuRoutes);
module.exports = router;
