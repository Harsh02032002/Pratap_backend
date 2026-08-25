'use strict';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const { normalizeLoginId, normalizeLoginIdList, escapeRegex } = require('../utils/normalizeId');

// ── normalizeLoginId ─────────────────────────────────────────────────────────

test('normalizeLoginId uppercases a lowercase identifier', () => {
  assert.strictEqual(normalizeLoginId('roomhy123'), 'ROOMHY123');
});

test('normalizeLoginId uppercases a mixed-case identifier', () => {
  assert.strictEqual(normalizeLoginId('RoomHy123'), 'ROOMHY123');
});

test('normalizeLoginId trims surrounding whitespace', () => {
  assert.strictEqual(normalizeLoginId('  ROOMHY123  '), 'ROOMHY123');
  assert.strictEqual(normalizeLoginId('\troomhy123\n'), 'ROOMHY123');
});

test('normalizeLoginId leaves an already-canonical identifier untouched', () => {
  assert.strictEqual(normalizeLoginId('ROOMHY123'), 'ROOMHY123');
  assert.strictEqual(normalizeLoginId('ROOMHYTNT4821'), 'ROOMHYTNT4821');
});

test('normalizeLoginId passes non-strings through unchanged', () => {
  const id = new mongoose.Types.ObjectId();
  assert.strictEqual(normalizeLoginId(id), id);
  assert.strictEqual(normalizeLoginId(null), null);
  assert.strictEqual(normalizeLoginId(undefined), undefined);
  assert.strictEqual(normalizeLoginId(42), 42);
});

test('normalizeLoginId is idempotent', () => {
  const once = normalizeLoginId('  roomhy123 ');
  assert.strictEqual(normalizeLoginId(once), once);
});

// ── normalizeLoginIdList ─────────────────────────────────────────────────────

test('normalizeLoginIdList normalizes, dedupes and drops empties', () => {
  assert.deepStrictEqual(
    normalizeLoginIdList(['roomhy1', 'ROOMHY1', ' RoomHy1 ', '', null, 'roomhy2']),
    ['ROOMHY1', 'ROOMHY2']
  );
});

test('normalizeLoginIdList returns [] for non-array input', () => {
  assert.deepStrictEqual(normalizeLoginIdList(null), []);
  assert.deepStrictEqual(normalizeLoginIdList('roomhy1'), []);
});

// ── escapeRegex ──────────────────────────────────────────────────────────────

test('escapeRegex neutralizes regex metacharacters', () => {
  const escaped = escapeRegex('(A+)+$');
  assert.ok(!new RegExp(`^${escaped}$`).test('AAAA'), 'must not match as a pattern');
  assert.ok(new RegExp(`^${escaped}$`).test('(A+)+$'), 'must match the literal');
});

test('escapeRegex handles null and undefined without throwing', () => {
  assert.strictEqual(escapeRegex(null), '');
  assert.strictEqual(escapeRegex(undefined), '');
});

// ── Mongoose schema safety net ───────────────────────────────────────────────
// The migration relies on Mongoose applying `uppercase`/`trim` setters to query
// FILTERS, not just to writes. If that ever stops being true, a caller that
// forgets to normalize would silently miss rows — so pin the behaviour here.

test('schema setters normalize query filters (equality, $in, $or)', () => {
  const schema = new mongoose.Schema({
    ownerLoginId: { type: String, trim: true, uppercase: true },
  });
  const Model = mongoose.models.__NormalizeIdTest__
    || mongoose.model('__NormalizeIdTest__', schema);

  assert.deepStrictEqual(
    Model.find({ ownerLoginId: '  roomhy123 ' }).cast(Model),
    { ownerLoginId: 'ROOMHY123' }
  );

  assert.deepStrictEqual(
    Model.find({ ownerLoginId: { $in: ['roomhy1', 'RoomHy2'] } }).cast(Model),
    { ownerLoginId: { $in: ['ROOMHY1', 'ROOMHY2'] } }
  );

  assert.deepStrictEqual(
    Model.findOne({ ownerLoginId: 'roomhy999' }).cast(Model),
    { ownerLoginId: 'ROOMHY999' }
  );

  assert.deepStrictEqual(
    Model.find({ $or: [{ ownerLoginId: 'roomhy1' }, { ownerLoginId: 'RoomHy2' }] }).cast(Model),
    { $or: [{ ownerLoginId: 'ROOMHY1' }, { ownerLoginId: 'ROOMHY2' }] }
  );
});

test('identifier fields on the hot-path models declare the uppercase setter', () => {
  const cases = [
    ['../models/Property.js', 'ownerLoginId'],
    ['../models/Tenant.js', 'ownerLoginId'],
    ['../models/Tenant.js', 'loginId'],
    ['../models/Enquiry.js', 'ownerLoginId'],
    ['../models/Complaint.js', 'ownerLoginId'],
    ['../models/Owner.js', 'loginId'],
    ['../models/MaintenanceTask.js', 'ownerLoginId'],
    ['../models/StaffAttendance.js', 'ownerLoginId'],
    ['../models/StaffSalary.js', 'ownerLoginId'],
    ['../models/StaffShift.js', 'ownerLoginId'],
  ];

  for (const [modulePath, field] of cases) {
    const Model = require(modulePath);
    const path = Model.schema.path(field);
    assert.ok(path, `${modulePath} has no path "${field}"`);
    assert.strictEqual(
      path.options.uppercase, true,
      `${modulePath}.${field} is missing \`uppercase: true\``
    );
  }
});

test('Notification.toLoginId is deliberately NOT uppercased', () => {
  // It doubles as a role sentinel ('superadmin', 'admin'). Uppercasing it would
  // break every superadmin notification lookup, so this exclusion is load-bearing.
  const Notification = require('../models/Notification');
  assert.notStrictEqual(Notification.schema.path('toLoginId').options.uppercase, true);
});

test('User.loginId is deliberately NOT uppercased', () => {
  // Website/tenant accounts store an email address in this field.
  const User = require('../models/user');
  assert.notStrictEqual(User.schema.path('loginId').options.uppercase, true);
});

// ── Regression guard: no exact-match regex left on the owner hot path ─────────

test('owner-scoped hot-path files contain no case-insensitive identifier regex', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  const files = [
    'routes/dashboardRoutes.js',
    'routes/ownerRoutes.js',
    'controllers/maintenanceController.js',
    'controllers/hrController.js',
    'controllers/leaveRequestController.js',
    'controllers/tenantAttendanceController.js',
    'controllers/visitorController.js',
    'controllers/complaintController.js',
    'controllers/enquiryController.js',
    'utils/scopeHelpers.js',
  ];

  // Anchored ^...$ with the 'i' flag — the pattern that cannot use an index.
  const banned = /new RegExp\((?:'\^'|`\^)[^)]*\$[^)]*,\s*['"]i['"]\)/;

  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const offending = src
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => banned.test(line) && !line.trim().startsWith('*') && !line.trim().startsWith('//'));

    assert.deepStrictEqual(
      offending, [],
      `${rel} still uses an anchored case-insensitive regex for an exact match`
    );
  }
});
