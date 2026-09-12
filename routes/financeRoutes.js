'use strict';
const express = require('express');
const router = express.Router();
const financeController = require('../controllers/financeController');

// Tenant routes
router.get('/tenant/receipts', financeController.getTenantReceipts);
router.get('/tenant/history', financeController.getTenantHistory);
router.get('/tenant/other-charges', financeController.getTenantOtherCharges);
router.get('/tenant/tracking', financeController.getTenantTracking);

// Owner routes
router.get('/owner/receipts', financeController.getOwnerReceipts);
router.get('/owner/history', financeController.getOwnerHistory);
router.get('/owner/service-fees', financeController.getOwnerServiceFees);

// Payout routes
router.get('/payouts/cycle', financeController.getPayoutCycle);
router.post('/payouts/cycle', financeController.updatePayoutCycle);
router.get('/payouts/options', financeController.getPayoutOptions);
router.post('/payouts/options', financeController.updateOwnerPayoutOption);
router.get('/payouts/pending', financeController.getPendingPayouts);
router.post('/payouts/process', financeController.processPayout);
router.get('/payouts/failed', financeController.getFailedPayouts);
router.get('/payouts/bank-transfer', financeController.getBankTransferTracking);
router.get('/payouts/cash-received', financeController.getCashReceivedTracking);

// Revenue routes
router.get('/revenue/fees', financeController.getPlatformFees);
router.post('/revenue/fees', financeController.updatePlatformFees);
router.get('/revenue/commission', financeController.getCommissionDetails);
router.post('/revenue/commission', financeController.updateCommissionDetails);
router.get('/revenue/discounts', financeController.getDiscounts);
router.post('/revenue/discounts', financeController.createDiscount);
router.get('/revenue/tracking', financeController.getRevenueTracking);

// Invoices routes
router.get('/invoices/generation', financeController.getInvoiceGenerationSettings);
router.post('/invoices/generation', financeController.triggerInvoicesGeneration);
router.get('/invoices/gst', financeController.getInvoiceGstBreakdown);
router.post('/invoices/numbering', financeController.updateInvoiceNumbering);
router.get('/invoices/history', financeController.getInvoiceHistory);

// Refunds routes
router.get('/refunds/history', financeController.getRefundHistory);
router.get('/refunds/approvals', financeController.getRefundApprovals);
router.post('/refunds/process', financeController.processRefundRequest);
router.post('/refunds/approve', financeController.approveRefund);

// Automation routes
router.get('/automation/settings', financeController.getAutomationSettings);
router.post('/automation/settings', financeController.updateAutomationSettings);

// Analytics routes
router.get('/analytics/roomhy-revenue', financeController.getRoomhyMonthlyRevenue);
router.get('/analytics/owner-revenue', financeController.getOwnerMonthlyRevenue);
router.get('/analytics/due-rents', financeController.getDueRentReports);
router.get('/analytics/profit-loss', financeController.getProfitLoss);
router.get('/analytics/cashflow', financeController.getCashflowDashboard);
router.get('/analytics/transactions-report', financeController.getTransactionsReport);

// Alerts routes
router.get('/alerts/rent-due-reminders', financeController.getRentDueRemindersAlerts);
router.get('/alerts/payments', financeController.getPaymentAlerts);
router.get('/alerts/payouts', financeController.getPayoutAlerts);

// ─── Manual Payment + Wallet ────────────────────────────────
router.post('/manual-payment',  financeController.recordManualPayment);
router.get('/admin-wallet',     financeController.getAdminWallet);
router.post('/manual-transfer', financeController.manualTransferToOwner);
router.post('/bulk-transfer',   financeController.bulkManualTransfer);

module.exports = router;

