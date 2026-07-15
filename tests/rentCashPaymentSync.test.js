const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCashPaymentReceipt } = require('../controllers/rentController');

test('buildCashPaymentReceipt includes tenant phone and payment metadata', () => {
  const paidAt = new Date('2026-07-14T10:00:00.000Z');
  const receipt = buildCashPaymentReceipt({
    rent: {
      _id: '64f000000000000000000001',
      tenantName: 'Asha',
      tenantPhone: '+919999999999',
      tenantEmail: 'asha@example.com',
      propertyName: 'Skyline',
      roomNumber: 'A1',
      collectionMonth: '2026-07',
      ownerLoginId: 'OWNER1',
    },
    invoice: {
      _id: '64f000000000000000000002',
      billingMonth: '2026-07',
      rentAmount: 1200,
      totalDue: 1200,
      totalPenalty: 0,
    },
    paidAt,
  });

  assert.match(receipt.receiptNumber, /^RCPT-/);
  assert.equal(receipt.paymentMethod, 'cash');
  assert.equal(receipt.tenantPhone, '+919999999999');
  assert.equal(receipt.amount, 1200);
  assert.equal(receipt.status, 'PAID');
  assert.equal(receipt.verifiedAt, paidAt.toISOString());
});
