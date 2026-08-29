'use strict';

/**
 * Property isolation for maintenance tasks.
 *
 * The reported bug: a Warden assigned to property A could pick staff from
 * property B in the "Assign To Staff" dropdown. The root cause was wider —
 * MaintenanceTask had no propertyId at all, so the whole task list was scoped
 * by ownerLoginId alone, and the routes had no auth middleware.
 *
 * These cover the decision logic. Handler-level behaviour against a real
 * database is not covered here (no DB in this environment).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MaintenanceTask = require('../models/MaintenanceTask');
const Employee = require('../models/Employee');
const ctrl = require('../controllers/maintenanceController');
const { staffPropertyIds, buildTaskScope, assertStaffAllowedOnProperty, resolveCreateProperty } = ctrl._internals;

const PROP_A = new mongoose.Types.ObjectId();
const PROP_B = new mongoose.Types.ObjectId();
const OWNER = 'ROOMHY3259';

const warden = (props) => ({ role: 'employee', parentLoginId: OWNER, assignedProperties: props });
const owner = () => ({ role: 'owner', loginId: OWNER });

// ─────────────────────────────────────────────────────────────────────────────
// 1. Model
// ─────────────────────────────────────────────────────────────────────────────

test('MaintenanceTask now carries a propertyId', () => {
  const p = MaintenanceTask.schema.path('propertyId');
  assert.ok(p, 'propertyId must exist — without it nothing can be isolated');
  assert.strictEqual(p.instance, 'ObjectId');
  assert.strictEqual(p.options.ref, 'Property');
});

test('propertyId is optional so legacy tasks still load', () => {
  assert.notStrictEqual(MaintenanceTask.schema.path('propertyId').isRequired, true);
});

test('the owner+property+recency query is indexed', () => {
  const idx = MaintenanceTask.schema.indexes().map(([f]) => JSON.stringify(f));
  assert.ok(idx.some((i) => i.includes('ownerLoginId') && i.includes('propertyId')),
    `expected a compound index, got ${idx.join(' | ')}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. staffPropertyIds — reads the whole array, not just [0]
// ─────────────────────────────────────────────────────────────────────────────

test('BUG FIXED: staff assigned to several properties expose all of them', () => {
  // Existing filters elsewhere only read assignedProperties[0], hiding staff
  // from their second property onwards.
  assert.deepStrictEqual(staffPropertyIds(warden([PROP_A, PROP_B])), [String(PROP_A), String(PROP_B)]);
});

test('staffPropertyIds handles populated docs, raw ids and empties', () => {
  assert.deepStrictEqual(staffPropertyIds(warden([{ _id: PROP_A }])), [String(PROP_A)]);
  assert.deepStrictEqual(staffPropertyIds(warden([])), []);
  assert.deepStrictEqual(staffPropertyIds({}), []);
  assert.deepStrictEqual(staffPropertyIds(null), []);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. buildTaskScope — what a caller may READ
// ─────────────────────────────────────────────────────────────────────────────

const reqFor = (user, query = {}) => ({ user, query, body: {}, params: {} });

test('THE BUG: a Warden can no longer read every property\'s tasks', () => {
  const { scope } = buildTaskScope(reqFor(warden([PROP_A])), OWNER);
  assert.strictEqual(scope.ownerLoginId, OWNER);
  assert.ok(scope.propertyId?.$in, 'staff must be constrained to a property set');
  assert.deepStrictEqual(scope.propertyId.$in.map(String), [String(PROP_A)]);
});

test('a Warden asking for another property is forced back to their own', () => {
  // The escalation attempt: ?propertyId=<property B>
  const { scope } = buildTaskScope(reqFor(warden([PROP_A]), { propertyId: String(PROP_B) }), OWNER);
  assert.deepStrictEqual(scope.propertyId.$in.map(String), [String(PROP_A)],
    'must ignore the requested property, not honour it');
});

test('a Warden asking for a property they DO hold gets exactly that one', () => {
  const { scope } = buildTaskScope(reqFor(warden([PROP_A, PROP_B]), { propertyId: String(PROP_B) }), OWNER);
  assert.deepStrictEqual(scope.propertyId.$in.map(String), [String(PROP_B)]);
});

test('a Warden with no property assignment sees nothing, not everything', () => {
  const { scope } = buildTaskScope(reqFor(warden([])), OWNER);
  assert.strictEqual(scope, null, 'null scope means the handler returns an empty list');
});

test('legacy tasks (propertyId null) are never visible to staff', () => {
  const { scope } = buildTaskScope(reqFor(warden([PROP_A])), OWNER);
  // An $in over concrete ObjectIds cannot match a null propertyId.
  assert.ok(!('$or' in scope), 'no null-matching branch may leak in');
  assert.ok(scope.propertyId.$in.every((id) => id instanceof mongoose.Types.ObjectId));
});

test('the owner still sees everything, legacy included, on All Properties', () => {
  const { scope } = buildTaskScope(reqFor(owner()), OWNER);
  assert.deepStrictEqual(scope, { ownerLoginId: OWNER }, 'no property constraint for the owner');
});

test('the owner can narrow to one property', () => {
  const { scope } = buildTaskScope(reqFor(owner(), { propertyId: String(PROP_A) }), OWNER);
  assert.strictEqual(String(scope.propertyId), String(PROP_A));
});

test('a junk propertyId is ignored rather than crashing the query', () => {
  const { scope } = buildTaskScope(reqFor(owner(), { propertyId: 'not-an-objectid' }), OWNER);
  assert.ok(!('propertyId' in scope));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. assertStaffAllowedOnProperty — what a caller may ASSIGN
// ─────────────────────────────────────────────────────────────────────────────

function stubEmployee(t, doc) {
  t.mock.method(Employee, 'findById', () => ({ select: () => ({ lean: async () => doc }) }));
}

test('THE REPORTED BUG: property B staff cannot be assigned to a property A task', async (t) => {
  const id = new mongoose.Types.ObjectId();
  stubEmployee(t, { _id: id, name: 'suresh', parentLoginId: OWNER, assignedProperties: [PROP_B] });

  const r = await assertStaffAllowedOnProperty(id, OWNER, String(PROP_A));
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /not assigned to this property/);
});

test('property A staff CAN be assigned to a property A task', async (t) => {
  const id = new mongoose.Types.ObjectId();
  stubEmployee(t, { _id: id, name: 'Rampal', parentLoginId: OWNER, assignedProperties: [PROP_A] });

  const r = await assertStaffAllowedOnProperty(id, OWNER, String(PROP_A));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.employee.name, 'Rampal');
});

test('multi-property staff are allowed on either of their properties', async (t) => {
  const id = new mongoose.Types.ObjectId();
  stubEmployee(t, { _id: id, name: 'pankaj', parentLoginId: OWNER, assignedProperties: [PROP_A, PROP_B] });

  assert.strictEqual((await assertStaffAllowedOnProperty(id, OWNER, String(PROP_A))).ok, true);
  assert.strictEqual((await assertStaffAllowedOnProperty(id, OWNER, String(PROP_B))).ok, true);
});

test('owner-level staff (no property) are allowed anywhere — e.g. the Accountant', async (t) => {
  const id = new mongoose.Types.ObjectId();
  stubEmployee(t, { _id: id, name: 'Ramesh', role: 'Accountant', parentLoginId: OWNER, assignedProperties: [] });

  assert.strictEqual((await assertStaffAllowedOnProperty(id, OWNER, String(PROP_A))).ok, true);
  assert.strictEqual((await assertStaffAllowedOnProperty(id, OWNER, String(PROP_B))).ok, true);
});

test('another owner\'s staff can never be assigned, whatever the property', async (t) => {
  const id = new mongoose.Types.ObjectId();
  stubEmployee(t, { _id: id, name: 'outsider', parentLoginId: 'ROOMHY9999', assignedProperties: [PROP_A] });

  const r = await assertStaffAllowedOnProperty(id, OWNER, String(PROP_A));
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /does not belong to this account/);
});

test('a deleted staff member cannot be assigned', async (t) => {
  const id = new mongoose.Types.ObjectId();
  stubEmployee(t, { _id: id, name: 'gone', parentLoginId: OWNER, assignedProperties: [PROP_A], isDeleted: true });
  assert.strictEqual((await assertStaffAllowedOnProperty(id, OWNER, String(PROP_A))).ok, false);
});

test('property-bound staff cannot be attached to a legacy task with no property', async (t) => {
  const id = new mongoose.Types.ObjectId();
  stubEmployee(t, { _id: id, name: 'sf', parentLoginId: OWNER, assignedProperties: [PROP_A] });

  const r = await assertStaffAllowedOnProperty(id, OWNER, null);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Select a property/);
});

test('unassigning is always permitted', async () => {
  assert.strictEqual((await assertStaffAllowedOnProperty(null, OWNER, String(PROP_A))).ok, true);
  assert.strictEqual((await assertStaffAllowedOnProperty('', OWNER, String(PROP_A))).ok, true);
});

test('a malformed staff id is rejected before any query runs', async () => {
  const r = await assertStaffAllowedOnProperty('not-an-id', OWNER, String(PROP_A));
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /Invalid staff/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. resolveCreateProperty — which property a new task lands on
// ─────────────────────────────────────────────────────────────────────────────

test('a Warden creating a task is pinned to their own property', async () => {
  const req = { user: warden([PROP_A]), body: {}, query: {}, params: {} };
  const r = await resolveCreateProperty(req, OWNER);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.propertyId, String(PROP_A));
});

test('a Warden cannot create a task on someone else\'s property', async () => {
  const req = { user: warden([PROP_A]), body: { propertyId: String(PROP_B) }, query: {}, params: {} };
  const r = await resolveCreateProperty(req, OWNER);
  assert.strictEqual(r.propertyId, String(PROP_A), 'the requested property must be ignored');
});

test('the owner must choose a property — All Properties is rejected', async () => {
  for (const body of [{}, { propertyId: 'all' }, { propertyId: '' }]) {
    const r = await resolveCreateProperty({ user: owner(), body, query: {}, params: {} }, OWNER);
    assert.strictEqual(r.ok, false);
    assert.match(r.message, /Select a property/);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Route hardening
// ─────────────────────────────────────────────────────────────────────────────

test('every maintenance route now requires authentication', () => {
  const src = read('routes/maintenanceRoutes.js');
  assert.match(src, /router\.use\(protect\)/, 'these routes previously had NO auth at all');
  assert.match(src, /router\.use\(authorize\(/);
});

test('owner scope is taken from the token, not from request params', () => {
  const src = read('routes/maintenanceRoutes.js');
  assert.match(src, /function scopeOwnerLoginId/);
  assert.match(src, /req\.effectiveOwnerLoginId = req\.user\.loginId/);
  assert.match(src, /req\.effectiveOwnerLoginId = req\.user\.parentLoginId/);
  for (const route of ['getOwnerTasks', 'createTask', 'updateTaskStatus', 'assignStaff', 'deleteTask']) {
    assert.match(src, new RegExp(`scopeOwnerLoginId, maintenanceController\\.${route}`), `${route} unscoped`);
  }
});

test('the controller never reads ownerLoginId straight from the request body', () => {
  const src = read('controllers/maintenanceController.js');
  assert.ok(!/ownerLoginId:\s*ownerLoginId\s*\?\s*String\(ownerLoginId\)/.test(src),
    'must use req.effectiveOwnerLoginId, which comes from the verified token');
  assert.match(src, /req\.effectiveOwnerLoginId/);
});
