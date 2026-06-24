'use strict';
const express = require('express');
const router  = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { rentAuditMiddleware } = require('../middleware/rentAuditMiddleware');
const ctrl = require('../controllers/rentCollectionController');

// All rent collection routes require a valid JWT
router.use(protect);
router.use(rentAuditMiddleware);

// Invoices
router.post('/invoices/generate',    ctrl.generateInvoices);
router.get('/invoices',              ctrl.listInvoices);
router.get('/invoices/:id',          ctrl.getInvoiceById);
router.post('/invoices/:id/remind',  ctrl.sendReminder);
router.patch('/invoices/:id/waive',  ctrl.waivePenaltyHandler);

// Payments
router.post('/payments',             ctrl.recordPaymentHandler);
router.get('/payments/daily-summary', ctrl.getDailyPaymentSummary);
router.get('/payments',              ctrl.listPaymentsHandler);

// Penalty
router.post('/penalty/calculate',    ctrl.previewPenaltyCalculation);

// Dashboard
router.get('/dashboard',             ctrl.getDashboard);
router.get('/monthly-summary',       ctrl.getMonthlySummary);

// Config
router.get('/configs',               ctrl.getPenaltyConfigs);
router.post('/configs',              ctrl.savePenaltyConfig);

// Cron health (Feature 2)
router.get('/cron-health',           ctrl.getCronHealth);

// Missing contact report (Feature 4)
router.get('/missing-contacts',      ctrl.getMissingContacts);

// WhatsApp template diagnostic — returns exact name + language codes from Meta
router.get('/wa-templates',          ctrl.getWhatsAppTemplates);

module.exports = router;
