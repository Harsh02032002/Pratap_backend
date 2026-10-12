'use strict';

/**
 * walletRoutes.js — mounted at /api/wallet
 *
 * SECURITY: every route here reads or MOVES MONEY, and until now the whole
 * router carried no authentication middleware at all: GET /owner/balance,
 * POST /owner/withdraw-instant, GET /admin/balance and
 * POST /admin/withdraw-instant were callable by anyone on the internet.
 *
 * Two rules apply to everything below:
 *
 *  1. The caller's identity comes from req.user (set by protect from the
 *     database-resolved account), never from the request body or query. The
 *     controller enforces this; see the note in walletController.js.
 *  2. Admin routes use requirePlatformAdmin, NOT authorize('superadmin') on its
 *     own, because that helper also admits employee/staff/manager roles.
 */

const express = require('express');
const router = express.Router();
const walletController = require('../controllers/walletController');
const { protect, authorize, requirePlatformAdmin } = require('../middleware/authMiddleware');

// ─── OWNER WALLET & INSTANT PAYOUT ─────────────────────────────────────────
// An owner may only ever see and withdraw their OWN balance.
router.get('/owner/balance', protect, authorize('owner'), walletController.getOwnerWalletBalance);
router.post('/owner/withdraw-instant', protect, authorize('owner'), walletController.withdrawOwnerFundsInstant);

// ─── ADMIN WALLET & PLATFORM COMMISSION PAYOUT ──────────────────────────────
router.get('/admin/balance', protect, requirePlatformAdmin, walletController.getAdminWalletBalance);
router.post('/admin/withdraw-instant', protect, requirePlatformAdmin, walletController.withdrawAdminEarningsInstant);

module.exports = router;
