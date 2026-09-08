const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cashRetrySecondsRemaining } = require('../controllers/rentController');

test('cash retry cooldown lasts exactly two minutes after rejection', () => {
  const rejectedAt = 1_000_000;
  assert.equal(cashRetrySecondsRemaining(rejectedAt, rejectedAt), 120);
  assert.equal(cashRetrySecondsRemaining(rejectedAt, rejectedAt + 119_001), 1);
  assert.equal(cashRetrySecondsRemaining(rejectedAt, rejectedAt + 120_000), 0);
});

test('cash request approval validates the owner email before generating an OTP', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'rentController.js'),
    'utf8',
  );
  const approval = source.slice(source.indexOf('exports.approveCashRequest'));
  assert.ok(approval.indexOf('const ownerEmail = await resolveOwnerEmail(ownerId)') < approval.indexOf('const otp = String('));
  assert.match(approval, /OTP email could not be sent/);
  assert.match(approval, /rent\.cashRequestStatus = "pending_approval"/);
});

test('cash rejection tells the tenant about the two-minute retry wait', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'controllers', 'rentController.js'),
    'utf8',
  );
  const rejection = source.slice(source.indexOf('exports.rejectCashRequest'));
  assert.match(rejection, /after 2 minutes/);
  assert.match(rejection, /type: "cash_payment_rejected"/);
});
