const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');

// ─── OWNER WALLET & INSTANT PAYOUT ─────────────────────────────────────────
router.get('/owner/balance', walletController.getOwnerWalletBalance);
router.post('/owner/withdraw-instant', walletController.withdrawOwnerFundsInstant);

// ─── ADMIN WALLET & PLATFORM COMMISSION PAYOUT ──────────────────────────────
router.get('/admin/balance', walletController.getAdminWalletBalance);
router.post('/admin/withdraw-instant', walletController.withdrawAdminEarningsInstant);

module.exports = router;
