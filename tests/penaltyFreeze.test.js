'use strict';

// Late fee must stop changing once the rent it is charged on is paid. Uses
// evaluateInvoice's `prefetch.config` so no database is needed.

const test = require('node:test');
const assert = require('node:assert');

const { evaluateInvoice } = require('../services/invoiceService');

const dueDate = new Date('2026-09-05T00:00:00+05:30');
const later = new Date('2026-09-25T12:00:00+05:30');
const muchLater = new Date('2026-10-20T12:00:00+05:30');

const perDayConfig = {
  minorPenaltyDay: 3,
  majorPenaltyDay: 8,
  minorPenalty: { enabled: true, type: 'per_day', value: 100 },
  majorPenalty: { enabled: true, type: 'per_day', value: 400 },
};

const percentConfig = {
  minorPenaltyDay: 3,
  majorPenaltyDay: 8,
  minorPenalty: { enabled: true, type: 'percentage', value: 5 },
  majorPenalty: { enabled: true, type: 'percentage', value: 10 },
};

function unpaidInvoice() {
  return { _id: 'inv1', rentAmount: 3000, paidAmount: 0, rentPaidAmount: 0, dueDate, electricityBill: 0 };
}

test('unpaid rent: late fee keeps accruing with time', async () => {
  const a = await evaluateInvoice(unpaidInvoice(), later, { config: perDayConfig });
  const b = await evaluateInvoice(unpaidInvoice(), muchLater, { config: perDayConfig });
  assert.ok(a.updates.totalPenalty > 0);
  assert.ok(b.updates.totalPenalty > a.updates.totalPenalty);
});

test('rent settled: per-day late fee is frozen, does not grow after payment', async () => {
  const inv = {
    ...unpaidInvoice(),
    paidAmount: 8700, rentPaidAmount: 3000,
    totalPenalty: 5700, minorPenaltyAmount: 500, majorPenaltyAmount: 5200, currentPhase: 3,
    electricityBill: 333,
  };
  const { updates } = await evaluateInvoice(inv, muchLater, { config: perDayConfig });
  assert.strictEqual(updates.totalPenalty, 5700);
  assert.strictEqual(updates.totalDue, 3000 + 5700 + 333);
  assert.strictEqual(updates.outstandingAmount, 333); // only the electricity added later
});

test('rent settled: percentage late fee does not collapse to ₹0', async () => {
  const inv = {
    ...unpaidInvoice(),
    paidAmount: 3450, rentPaidAmount: 3000,
    totalPenalty: 450, minorPenaltyAmount: 150, majorPenaltyAmount: 300, currentPhase: 3,
  };
  const { updates } = await evaluateInvoice(inv, muchLater, { config: percentConfig });
  assert.strictEqual(updates.totalPenalty, 450);
  assert.strictEqual(updates.outstandingAmount, 0);
});

test('rent settled with electricity + late fee all paid: nothing outstanding', async () => {
  const inv = {
    ...unpaidInvoice(),
    paidAmount: 9033, rentPaidAmount: 3000,
    totalPenalty: 5700, minorPenaltyAmount: 500, majorPenaltyAmount: 5200, currentPhase: 3,
    electricityBill: 333,
  };
  const { updates } = await evaluateInvoice(inv, muchLater, { config: perDayConfig });
  assert.strictEqual(updates.outstandingAmount, 0);
  assert.strictEqual(updates.totalDue, 9033);
});
