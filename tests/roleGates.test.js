// Unit tests for the three role gates in middleware/authMiddleware.js.
//
// No database and no server: a role gate is a pure function of (named roles,
// req.user.role, AUTHZ_MODE), so it is tested directly with a fake req/res.
// Run with:  node --test tests/roleGates.test.js
//
// What these pin down, and why it matters: authorize('superadmin') expands to
// admit employee/areamanager/manager/staff/field_executive/
// verification_officer. That expansion is invisible at the call site, and it
// is what let a field employee walk past handlers whose own ownership check
// reads `if (req.user.role === 'owner') { … }`. These tests make the
// difference between the permissive and strict gates explicit, so a future
// change to the expansion list cannot pass silently.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-role-gates';

const { authorize, authorizeStrict, authorizeAdminOnly } = require('../middleware/authMiddleware');

/** Runs a gate against a role and reports what happened. */
function run(gate, role, { loginId = 'TEST001' } = {}) {
    const req = {
        user: role === null ? null : { role, loginId },
        method: 'POST',
        originalUrl: '/api/test'
    };
    const result = { status: null, body: null, nexted: false };
    const res = {
        status(code) { result.status = code; return this; },
        json(payload) { result.body = payload; return this; }
    };
    gate(req, res, () => { result.nexted = true; });
    return result;
}

const STAFF_ROLES = [
    'employee', 'areamanager', 'area_manager', 'area_admin',
    'manager', 'staff', 'field_executive', 'verification_officer'
];

// ── The permissive gate: unchanged legacy behaviour ─────────────────────────

test('authorize("superadmin") admits every staff role (the legacy expansion)', () => {
    for (const role of STAFF_ROLES) {
        const r = run(authorize('superadmin'), role);
        assert.equal(r.nexted, true, `${role} should be admitted by the permissive gate`);
    }
});

test('authorize("superadmin") still rejects roles outside the expansion', () => {
    for (const role of ['owner', 'tenant', 'website_user']) {
        const r = run(authorize('superadmin'), role);
        assert.equal(r.nexted, false, `${role} must not be admitted`);
        assert.equal(r.status, 403);
    }
});

// ── The strict gate: the actual Phase 0b change ─────────────────────────────

test('authorizeStrict("superadmin") rejects every staff role', () => {
    delete process.env.AUTHZ_MODE;
    process.env.AUTHZ_MODE = 'enforce';
    for (const role of STAFF_ROLES) {
        const r = run(authorizeStrict('superadmin'), role);
        assert.equal(r.nexted, false, `${role} must NOT reach a strict superadmin route`);
        assert.equal(r.status, 403);
    }
});

test('authorizeStrict admits exactly the roles it names', () => {
    process.env.AUTHZ_MODE = 'enforce';
    // Named explicitly => allowed, even though it is a staff role.
    assert.equal(run(authorizeStrict('superadmin', 'areamanager'), 'areamanager').nexted, true);
    // Not named => denied.
    assert.equal(run(authorizeStrict('superadmin', 'areamanager'), 'employee').nexted, false);
});

test('superadmin and admin are one tier; owner spellings are synonyms', () => {
    process.env.AUTHZ_MODE = 'enforce';
    assert.equal(run(authorizeStrict('superadmin'), 'admin').nexted, true);
    assert.equal(run(authorizeStrict('admin'), 'superadmin').nexted, true);
    for (const spelling of ['owner', 'propertyowner', 'property_owner']) {
        assert.equal(run(authorizeStrict('owner'), spelling).nexted, true, `${spelling} is an owner`);
    }
});

test('role matching ignores case and surrounding whitespace', () => {
    process.env.AUTHZ_MODE = 'enforce';
    assert.equal(run(authorizeStrict('owner'), '  Owner ').nexted, true);
    assert.equal(run(authorize('superadmin'), 'EMPLOYEE').nexted, true);
});

// ── AUTHZ_MODE: narrow by construction ──────────────────────────────────────

test('AUTHZ_MODE=report lets a staff role through the strict gate, with a log line', () => {
    process.env.AUTHZ_MODE = 'report';
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
        const r = run(authorizeStrict('superadmin'), 'employee');
        assert.equal(r.nexted, true, 'report mode must not block');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /\[AUTHZ\] would deny employee/);
    } finally {
        console.warn = realWarn;
        process.env.AUTHZ_MODE = 'enforce';
    }
});

test('AUTHZ_MODE=report does NOT soften a role that was never allowed', () => {
    process.env.AUTHZ_MODE = 'report';
    try {
        for (const role of ['tenant', 'owner', 'website_user']) {
            const r = run(authorizeStrict('superadmin'), role);
            assert.equal(r.nexted, false, `${role} must be denied even in report mode`);
            assert.equal(r.status, 403);
        }
    } finally {
        process.env.AUTHZ_MODE = 'enforce';
    }
});

test('authorizeAdminOnly ignores AUTHZ_MODE=report entirely', () => {
    process.env.AUTHZ_MODE = 'report';
    try {
        for (const role of STAFF_ROLES) {
            const r = run(authorizeAdminOnly('superadmin', 'areamanager', 'owner'), role);
            if (role === 'areamanager' || role === 'area_manager') continue; // named explicitly
            assert.equal(r.nexted, false, `${role} must be denied on a Tier-0 route even in report mode`);
            assert.equal(r.status, 403);
        }
        // The roles it does name still get through.
        assert.equal(run(authorizeAdminOnly('superadmin', 'areamanager', 'owner'), 'owner').nexted, true);
        assert.equal(run(authorizeAdminOnly('superadmin', 'areamanager', 'owner'), 'superadmin').nexted, true);
    } finally {
        process.env.AUTHZ_MODE = 'enforce';
    }
});

// ── Information disclosure in the denial body ───────────────────────────────

test('a 403 body does not enumerate the roles that would have worked', () => {
    process.env.AUTHZ_MODE = 'enforce';
    for (const gate of [authorize('superadmin'), authorizeStrict('superadmin'), authorizeAdminOnly('superadmin')]) {
        const r = run(gate, 'tenant');
        assert.equal(r.status, 403);
        const body = JSON.stringify(r.body);
        assert.ok(!body.includes('field_executive'), 'must not leak the expanded role list');
        assert.ok(!body.includes('areamanager'), 'must not leak the expanded role list');
        assert.ok(!body.includes('tenant'), "must not echo the caller's own role back");
    }
});

test('no req.user is 401, not 403', () => {
    for (const gate of [authorize('superadmin'), authorizeStrict('superadmin'), authorizeAdminOnly('superadmin')]) {
        const r = run(gate, null);
        assert.equal(r.nexted, false);
        assert.equal(r.status, 401);
    }
});
