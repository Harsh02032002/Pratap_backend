'use strict';

/**
 * Tests for electricity billing eligibility: a tenant who moved into a room
 * during a given billing month must not be charged for that month, and must
 * become eligible starting the following month. Covers the rule added to
 * services/tenantDuesService.js (isEligibleForBillingMonth, syncElectricityToInvoice's
 * per-tenant filtering).
 *
 * Pure-logic tests only — isEligibleForBillingMonth takes plain objects and a
 * string, no DB involved, so these run without a MongoDB connection.
 */

const test = require('node:test');
const assert = require('node:assert');

const { isEligibleForBillingMonth } = require('../services/tenantDuesService');

test('Test 1 — new tenant: moved in during the billing month is NOT eligible', () => {
  const tenant = { moveInDate: '2026-09-10T00:00:00.000Z' };
  assert.strictEqual(isEligibleForBillingMonth(tenant, '2026-09'), false);
});

test('Test 1 — new tenant becomes eligible the following month', () => {
  const tenant = { moveInDate: '2026-09-10T00:00:00.000Z' };
  assert.strictEqual(isEligibleForBillingMonth(tenant, '2026-10'), true);
});

test('Test 2 — existing tenant (moved in before the billing month) is eligible', () => {
  const tenant = { moveInDate: '2026-08-01T00:00:00.000Z' };
  assert.strictEqual(isEligibleForBillingMonth(tenant, '2026-09'), true);
});

test('Test 3 — mixed room: existing tenant eligible, same-month tenant excluded', () => {
  const tenantA = { moveInDate: '2026-08-15T00:00:00.000Z' }; // existing
  const tenantB = { moveInDate: '2026-09-05T00:00:00.000Z' }; // joined this month
  const eligible = [tenantA, tenantB].filter(t => isEligibleForBillingMonth(t, '2026-09'));
  assert.strictEqual(eligible.length, 1);
  assert.strictEqual(eligible[0], tenantA);
});

test('Test 3 — next month both tenants are eligible', () => {
  const tenantA = { moveInDate: '2026-08-15T00:00:00.000Z' };
  const tenantB = { moveInDate: '2026-09-05T00:00:00.000Z' };
  const eligible = [tenantA, tenantB].filter(t => isEligibleForBillingMonth(t, '2026-10'));
  assert.strictEqual(eligible.length, 2);
});

test('Test 5 — split amount only divides among eligible tenants', () => {
  const tenantA = { moveInDate: '2026-08-15T00:00:00.000Z' };
  const tenantB = { moveInDate: '2026-09-05T00:00:00.000Z' };
  const totalBill = 900;
  const eligible = [tenantA, tenantB].filter(t => isEligibleForBillingMonth(t, '2026-09'));
  const perTenantShare = Math.round(totalBill / eligible.length);
  assert.strictEqual(eligible.length, 1);
  assert.strictEqual(perTenantShare, 900); // full bill to the one eligible tenant, not split with the newcomer
});

test('Test 7 — moved in on the first day of the billing month is NOT eligible', () => {
  const tenant = { moveInDate: '2026-09-01T00:00:00.000Z' };
  assert.strictEqual(isEligibleForBillingMonth(tenant, '2026-09'), false);
});

test('Test 7 — moved in on the last day of the billing month is NOT eligible', () => {
  const tenant = { moveInDate: '2026-09-30T23:59:59.000Z' };
  assert.strictEqual(isEligibleForBillingMonth(tenant, '2026-09'), false);
});

test('Test 7 — moved in the last day of the PREVIOUS month is eligible', () => {
  const tenant = { moveInDate: '2026-08-31T23:59:59.000Z' };
  assert.strictEqual(isEligibleForBillingMonth(tenant, '2026-09'), true);
});

test('falls back to createdAt when moveInDate is missing', () => {
  const tenant = { createdAt: '2026-09-12T00:00:00.000Z' };
  assert.strictEqual(isEligibleForBillingMonth(tenant, '2026-09'), false);
});

test('no moveInDate and no createdAt — does not block billing', () => {
  const tenant = {};
  assert.strictEqual(isEligibleForBillingMonth(tenant, '2026-09'), true);
});
