'use strict';

// buildInvoicePaymentUpdate: recording a payment adds to what was already paid and
// never zeroes the late fee. prefetch.config keeps it DB-free.

const test = require('node:test');
const assert = require('node:assert');

const { buildInvoicePaymentUpdate } = require('../controllers/rentController');

const config = {
  minorPenaltyDay: 3,
  majorPenaltyDay: 8,
  minorPenalty: { enabled: true, type: 'per_day', value: 100 },
  majorPenalty: { enabled: true, type: 'per_day', value: 400 },
};
const prefetch = { config };

// Rent + late fee paid (₹8,700), electricity ₹333 added afterwards.
function screenshotInvoice() {
  return {
    _id: 'inv', rentAmount: 3000, electricityBill: 333,
    totalPenalty: 5700, minorPenaltyAmount: 500, majorPenaltyAmount: 5200, currentPhase: 3,
    paidAmount: 8700, rentPaidAmount: 3000, penaltyPaidAmount: 5700,
    dueDate: new Date('2026-09-05T00:00:00+05:30'),
  };
}

test('electricity top-up after rent + late fee: everything paid, late fee kept', async () => {
  const set = await buildInvoicePaymentUpdate(screenshotInvoice(), 333, new Date(), prefetch);
  assert.strictEqual(set.paidAmount, 9033);
  assert.strictEqual(set.totalPenalty, 5700);
  assert.strictEqual(set.totalDue, 9033);
  assert.strictEqual(set.outstandingAmount, 0);
  assert.strictEqual(set.status, 'PAID');
});

test('partial top-up: stays PARTIAL, late fee not zeroed', async () => {
  const set = await buildInvoicePaymentUpdate(screenshotInvoice(), 100, new Date(), prefetch);
  assert.strictEqual(set.paidAmount, 8800);
  assert.strictEqual(set.totalPenalty, 5700);
  assert.strictEqual(set.outstandingAmount, 233);
  assert.strictEqual(set.status, 'PARTIAL');
});

test('late rent paid in one go: live late fee is locked in and covered', async () => {
  const dueDate = new Date(Date.now() - 20 * 86400000);
  const inv = { _id: 'inv2', rentAmount: 3000, paidAmount: 0, rentPaidAmount: 0, dueDate };
  const first = await buildInvoicePaymentUpdate(inv, 0, new Date(), prefetch);
  assert.ok(first.totalPenalty > 0, 'late fee should be computed live');
  const set = await buildInvoicePaymentUpdate(inv, 3000 + first.totalPenalty, new Date(), prefetch);
  assert.strictEqual(set.totalPenalty, first.totalPenalty);
  assert.strictEqual(set.outstandingAmount, 0);
  assert.strictEqual(set.status, 'PAID');
  assert.strictEqual(set.rentPaidAmount, 3000);
  assert.strictEqual(set.penaltyPaidAmount, first.totalPenalty);
});
