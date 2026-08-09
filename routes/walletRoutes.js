const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');

// ─── OWNER WALLET & INSTANT PAYOUT ─────────────────────────────────────────
router.get('/owner/balance', walletController.getOwnerWalletBalance);
router.post('/owner/withdraw-instant', walletController.withdrawOwnerFundsInstant);

// ─── ADMIN WALLET & PLATFORM COMMISSION PAYOUT ──────────────────────────────
router.get('/admin/balance', walletController.getAdminWalletBalance);
router.post('/admin/withdraw-instant', walletController.withdrawAdminEarningsInstant);

// ─── AUTO-RELEASE HELD BALANCE TRIGGER ─────────────────────────────────────
router.post('/release-held-now', walletController.triggerHeldRelease);
router.get('/release-held-now', walletController.triggerHeldRelease);

module.exports = router;
