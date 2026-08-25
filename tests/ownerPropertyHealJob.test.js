'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const job = require('../jobs/ownerPropertyHealJob');
const Property = require('../models/Property');
const Owner = require('../models/Owner');
const User = require('../models/user');
const cronLockService = require('../services/cronLockService');
const CronHealth = require('../models/CronHealth');

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET path is read-only — regression guards
// ─────────────────────────────────────────────────────────────────────────────

const REPAIR_SYMBOLS = [
  'healOwnerProperties',
  'healTenantInvoices',
  'fireHeal',
  'syncPropertyOccupancyData',
  'autoHealMoveInInvoices',
];

// Files that used to invoke repair from a request path.
const CLEANED_FILES = [
  'routes/dashboardRoutes.js',
  'routes/ownerRoutes.js',
  'controllers/roomController.js',
  'controllers/rentCollectionController.js',
  'controllers/ownercontroller.js',
];

const isCode = (line) => {
  const t = line.trim();
  return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
};

test('no route or controller invokes a repair function', () => {
  // ownercontroller keeps thin re-export/no-op definitions; those are
  // declarations, not invocations, so allow `exports.<symbol> =` lines.
  const invocation = new RegExp(`(?<!exports\\.)\\b(${REPAIR_SYMBOLS.join('|')})\\s*\\(`);

  for (const rel of CLEANED_FILES) {
    const offenders = read(rel)
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => isCode(line) && invocation.test(line))
      // The re-export body legitimately forwards to the job module.
      .filter(([, line]) => !line.includes("require('../jobs/ownerPropertyHealJob')"));

    assert.deepStrictEqual(
      offenders.map(([n, l]) => `${rel}:${n} ${l.trim()}`),
      [],
      `${rel} still invokes a repair function on the request path`
    );
  }
});

test('dashboard route no longer fires the heal', () => {
  const src = read('routes/dashboardRoutes.js');
  assert.ok(!/^\s*ownerController\.healOwnerProperties\(/m.test(src));
});

test('ownerRoutes GET handlers no longer await heal or fan out occupancy syncs', () => {
  const src = read('routes/ownerRoutes.js');
  assert.ok(!src.includes('await ownerController.healOwnerProperties'));
  assert.ok(!src.includes('ownerController.fireHeal('));
  assert.ok(!src.includes('ownerController.syncPropertyOccupancyData('));
});

test('rentCollection GET handlers no longer await the move-in invoice backfill', () => {
  const src = read('controllers/rentCollectionController.js');
  assert.ok(!src.includes('await autoHealMoveInInvoices('));
});

test('fireHeal is a no-op so a straggling caller cannot reintroduce writes', () => {
  const ownerController = require('../controllers/ownercontroller');
  assert.strictEqual(ownerController.fireHeal('ROOMHY1'), undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. enrichTenantsWithDues defaults to read-only
// ─────────────────────────────────────────────────────────────────────────────

test('enrichTenantsWithDues only repairs when explicitly asked', () => {
  const src = read('services/tenantDuesService.js');
  // The backfill must sit behind the opt-in flag, not run unconditionally.
  assert.match(src, /if \(options\.repair === true\) \{[\s\S]*?backfillMissingElectricity/);
  assert.ok(
    !/\n  await backfillMissingElectricity\(tenants, invoices\);/.test(src),
    'backfillMissingElectricity must not run unconditionally'
  );
});

test('no GET caller of enrichTenantsWithDues opts into repair', () => {
  for (const rel of ['routes/ownerRoutes.js', 'controllers/tenantController.js', 'utils/reportDataHelpers.js']) {
    assert.ok(
      !/enrichTenantsWithDues\([^)]*repair/.test(read(rel)),
      `${rel} must not pass { repair: true }`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Candidate query — correctness and idempotency selector
// ─────────────────────────────────────────────────────────────────────────────

test('buildCandidateQuery returns null when the owner has no email or phone', () => {
  assert.strictEqual(job.buildCandidateQuery({ loginId: 'ROOMHY1' }), null);
  assert.strictEqual(job.buildCandidateQuery({ email: '', phone: '  ' }), null);
});

test('buildCandidateQuery only targets unlinked properties (idempotency selector)', () => {
  const q = job.buildCandidateQuery({ email: 'a@b.com' });
  const unlinked = q.$and[0].$or.map((c) => JSON.stringify(c));
  // A property already carrying a real ownerLoginId can never match, which is
  // what makes a second run a no-op.
  assert.ok(unlinked.includes(JSON.stringify({ ownerLoginId: { $exists: false } })));
  assert.ok(unlinked.includes(JSON.stringify({ ownerLoginId: null })));
  assert.ok(unlinked.includes(JSON.stringify({ ownerLoginId: '' })));
  assert.ok(unlinked.includes(JSON.stringify({ ownerLoginId: 'TEMP' })));
  assert.ok(unlinked.includes(JSON.stringify({ ownerLoginId: 'GEN' })));
  assert.deepStrictEqual(q.$and[1], { isDeleted: { $ne: true } });
});

test('buildCandidateQuery lowercases emails and matches both email fields', () => {
  const q = job.buildCandidateQuery({ email: '  Owner@Example.COM ' });
  const conds = q.$and[2].$or;
  assert.deepStrictEqual(conds[0], { 'contact.email': { $in: ['owner@example.com'] } });
  assert.deepStrictEqual(conds[1], { email: { $in: ['owner@example.com'] } });
});

test('buildCandidateQuery reduces phones to a digits-only 10-char suffix', () => {
  const q = job.buildCandidateQuery({ phone: '+91 98765-43210' });
  const conds = q.$and[2].$or;
  assert.strictEqual(conds.length, 3, 'one condition per phone field');
  for (const cond of conds) {
    const rx = Object.values(cond)[0];
    assert.ok(rx instanceof RegExp);
    assert.strictEqual(rx.source, '9876543210$');
    assert.ok(rx.test('+919876543210'));
    assert.ok(rx.test('09876543210'));
    assert.ok(!rx.test('9876543211'));
  }
});

test('buildCandidateQuery cannot be regex-injected through a phone number', () => {
  const q = job.buildCandidateQuery({ phone: '(1+)+2222222222' });
  const rx = Object.values(q.$and[2].$or[0])[0];
  // Metacharacters are stripped by the digits-only reduction, not escaped —
  // so the pattern is always a literal digit run.
  assert.match(rx.source, /^\d{10}\$$/);
});

test('buildCandidateQuery dedupes repeated phone numbers', () => {
  const q = job.buildCandidateQuery({
    phone: '9876543210',
    profile: { phone: '+919876543210' },
    checkinPhone: '09876543210',
  });
  // All three normalize to the same suffix → one set of 3 field conditions.
  assert.strictEqual(q.$and[2].$or.length, 3);
});

test('buildCandidateQuery ignores phone numbers shorter than 10 digits', () => {
  assert.strictEqual(job.buildCandidateQuery({ phone: '12345' }), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Repair behaviour — idempotency, batching, no needless writes
// ─────────────────────────────────────────────────────────────────────────────

const OWNER = {
  _id: new mongoose.Types.ObjectId(),
  loginId: 'ROOMHY1234',
  name: 'Test Owner',
  email: 'owner@example.com',
  phone: '9876543210',
};
const OWNER_USER_ID = new mongoose.Types.ObjectId();

/** Minimal stand-in for the lean cursor the job consumes. */
function fakeCursor(docs) {
  let i = 0;
  return {
    next: async () => (i < docs.length ? docs[i++] : null),
    close: async () => {},
  };
}

/**
 * Point the job's model calls at in-memory fixtures and capture bulkWrite ops.
 * Returns the captured op batches.
 */
function stubModels(t, properties) {
  const batches = [];

  // readyState is a getter on the connection, so it is overridden rather than mocked.
  Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

  t.mock.method(Owner, 'findOne', () => ({
    select: () => ({ lean: async () => OWNER }),
  }));
  t.mock.method(User, 'findOne', () => ({
    select: () => ({ lean: async () => ({ _id: OWNER_USER_ID }) }),
  }));
  t.mock.method(Property, 'find', () => ({
    select: () => ({
      limit: () => ({
        lean: () => ({ cursor: () => fakeCursor(properties) }),
      }),
    }),
  }));
  t.mock.method(Property, 'bulkWrite', async (ops) => {
    batches.push(ops);
    return { modifiedCount: ops.length };
  });

  return batches;
}

test('repairs an unlinked property and sets every missing owner field', async (t) => {
  const propId = new mongoose.Types.ObjectId();
  const batches = stubModels(t, [{ _id: propId, ownerLoginId: '', owner: null, ownerName: '', ownerPhone: '' }]);

  const stats = await job.healOwnerProperties('roomhy1234');

  assert.strictEqual(stats.owner, 'ROOMHY1234');
  assert.strictEqual(stats.scanned, 1);
  assert.strictEqual(stats.repaired, 1);
  assert.strictEqual(stats.skipped, 0);

  assert.strictEqual(batches.length, 1);
  const { filter, update } = batches[0][0].updateOne;
  assert.deepStrictEqual(filter, { _id: propId });
  assert.strictEqual(update.$set.ownerLoginId, 'ROOMHY1234');
  assert.strictEqual(String(update.$set.owner), String(OWNER_USER_ID));
  assert.strictEqual(update.$set.ownerName, 'Test Owner');
  assert.strictEqual(update.$set.ownerPhone, '9876543210');
  // Replicates the pre('save') hook's timestamp, which bulkWrite bypasses.
  assert.ok(update.$set.updatedAt instanceof Date);
});

test('IDEMPOTENT: an already-correct property produces no write', async (t) => {
  const batches = stubModels(t, [{
    _id: new mongoose.Types.ObjectId(),
    ownerLoginId: 'ROOMHY1234',
    owner: OWNER_USER_ID,
    ownerName: 'Test Owner',
    ownerPhone: '9876543210',
  }]);

  const stats = await job.healOwnerProperties('ROOMHY1234');

  assert.strictEqual(stats.scanned, 1);
  assert.strictEqual(stats.skipped, 1, 'should be skipped, not rewritten');
  assert.strictEqual(stats.repaired, 0);
  assert.strictEqual(batches.length, 0, 'bulkWrite must not be called at all');
});

test('IDEMPOTENT: running three times in a row is stable', async (t) => {
  const docs = [{
    _id: new mongoose.Types.ObjectId(),
    ownerLoginId: 'ROOMHY1234',
    owner: OWNER_USER_ID,
    ownerName: 'Test Owner',
    ownerPhone: '9876543210',
  }];
  const batches = stubModels(t, docs);

  const runs = [
    await job.healOwnerProperties('ROOMHY1234'),
    await job.healOwnerProperties('ROOMHY1234'),
    await job.healOwnerProperties('ROOMHY1234'),
  ];

  for (const r of runs) assert.strictEqual(r.repaired, 0);
  assert.strictEqual(batches.length, 0);
});

test('only the fields that actually differ are written', async (t) => {
  // ownerName/ownerPhone already present → must not be overwritten.
  const batches = stubModels(t, [{
    _id: new mongoose.Types.ObjectId(),
    ownerLoginId: '',
    owner: OWNER_USER_ID,
    ownerName: 'Existing Name',
    ownerPhone: '1111111111',
  }]);

  await job.healOwnerProperties('ROOMHY1234');

  const $set = batches[0][0].updateOne.update.$set;
  assert.strictEqual($set.ownerLoginId, 'ROOMHY1234');
  assert.ok(!('ownerName' in $set), 'existing ownerName must be preserved');
  assert.ok(!('ownerPhone' in $set), 'existing ownerPhone must be preserved');
  assert.ok(!('owner' in $set), 'owner already correct — must not be re-set');
});

test('BATCHING: writes flush in fixed-size batches, not one giant call', async (t) => {
  const docs = Array.from({ length: 1200 }, () => ({
    _id: new mongoose.Types.ObjectId(), ownerLoginId: '', owner: null, ownerName: 'n', ownerPhone: 'p',
  }));
  const batches = stubModels(t, docs);

  const stats = await job.healOwnerProperties('ROOMHY1234');

  assert.strictEqual(stats.scanned, 1200);
  assert.strictEqual(stats.repaired, 1200);
  assert.strictEqual(batches.length, 3, 'expected 500 + 500 + 200');
  assert.deepStrictEqual(batches.map((b) => b.length), [500, 500, 200]);
});

test('ERROR HANDLING: a failed batch is counted, not swallowed as success', async (t) => {
  const docs = Array.from({ length: 3 }, () => ({
    _id: new mongoose.Types.ObjectId(), ownerLoginId: '', owner: null, ownerName: 'n', ownerPhone: 'p',
  }));
  stubModels(t, docs);
  t.mock.method(Property, 'bulkWrite', async () => {
    const err = new Error('duplicate key');
    err.result = { nModified: 1 };
    throw err;
  });

  const stats = await job.healOwnerProperties('ROOMHY1234');

  assert.strictEqual(stats.repaired, 1, 'partial success is counted');
  assert.strictEqual(stats.failed, 2, 'the rest is reported as failed');
});

test('an unknown owner is a clean no-op', async (t) => {
  stubModels(t, []);
  t.mock.method(Owner, 'findOne', () => ({ select: () => ({ lean: async () => null }) }));

  const stats = await job.healOwnerProperties('ROOMHY9999');
  assert.deepStrictEqual(stats, { owner: 'ROOMHY9999', scanned: 0, repaired: 0, skipped: 0, failed: 0 });
});

test('a blank loginId is rejected before any query runs', async () => {
  const stats = await job.healOwnerProperties('   ');
  assert.strictEqual(stats.scanned, 0);
  assert.strictEqual(stats.owner, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Multi-instance safety
// ─────────────────────────────────────────────────────────────────────────────

test('LOCKING: a second instance skips while the first holds the lock', async (t) => {
  Object.defineProperty(mongoose.connection, 'readyState', { value: 1, configurable: true });

  // The job destructures acquireLock/releaseLock at require time, so the service
  // has to be stubbed before a fresh copy of the module is loaded.
  let held = false;
  const realAcquire = cronLockService.acquireLock;
  const realRelease = cronLockService.releaseLock;
  cronLockService.acquireLock = async () => {
    if (held) return false; // instance B
    held = true;            // instance A
    return true;
  };
  cronLockService.releaseLock = async () => {};

  const jobPath = require.resolve('../jobs/ownerPropertyHealJob');
  delete require.cache[jobPath];
  const freshJob = require(jobPath);

  // Instance B must bail out without doing any work.
  const ownerFind = t.mock.method(Owner, 'find', () => ({
    select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => [] }) }) }) }),
  }));
  t.mock.method(CronHealth, 'create', async () => ({ _id: new mongoose.Types.ObjectId() }));
  t.mock.method(CronHealth, 'updateOne', () => ({ catch: () => Promise.resolve() }));

  try {
    const a = await freshJob.runOwnerPropertyHealJob();
    const callsAfterA = ownerFind.mock.callCount();
    const b = await freshJob.runOwnerPropertyHealJob();

    assert.notStrictEqual(a, null, 'instance A should run');
    assert.strictEqual(b, null, 'instance B must skip');
    assert.strictEqual(ownerFind.mock.callCount(), callsAfterA, 'instance B must not query owners');
  } finally {
    cronLockService.acquireLock = realAcquire;
    cronLockService.releaseLock = realRelease;
    delete require.cache[jobPath];
  }
});

test('the job reuses the shared CronLock service rather than a private lock', () => {
  const src = read('jobs/ownerPropertyHealJob.js');
  assert.match(src, /require\('\.\.\/services\/cronLockService'\)/);
  assert.ok(!/new Set\(\)|let\s+isRunning|global\./.test(src), 'must not use an in-memory lock');
});

test('the lock is released even when the sweep throws', () => {
  const src = read('jobs/ownerPropertyHealJob.js');
  assert.match(src, /finally \{\s*await releaseLock\(JOB_NAME\)/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Scheduling / serverless fallback
// ─────────────────────────────────────────────────────────────────────────────

test('the job is registered on a cron schedule in server.js', () => {
  const src = read('server.js');
  assert.match(src, /registerOwnerPropertyHealJob/);
  assert.match(read('jobs/ownerPropertyHealJob.js'), /cron\.schedule\('[\d\s*/,-]+',\s*runOwnerPropertyHealJob\)/);
});

test('the on-demand fallback is opt-in and never awaited by callers', () => {
  const src = read('jobs/ownerPropertyHealJob.js');
  assert.match(src, /HEAL_ON_DEMAND/, 'must be gated behind an env flag');
  assert.match(src, /void acquireLock\(/, 'must be detached, not awaited');
});

test('ensureDailyOwnerPropertyHeal returns immediately when the flag is off', () => {
  const prev = process.env.HEAL_ON_DEMAND;
  delete process.env.HEAL_ON_DEMAND;
  try {
    assert.strictEqual(job.ensureDailyOwnerPropertyHeal(), undefined);
  } finally {
    if (prev !== undefined) process.env.HEAL_ON_DEMAND = prev;
  }
});
