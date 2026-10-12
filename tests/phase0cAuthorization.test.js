'use strict';

/**
 * phase0cAuthorization.test.js — adversarial HTTP tests for Phase 0c:
 *
 *   C  digital check-in: Aadhaar never leaves the anonymous profile route;
 *      the OTP-issued access proof works only for its own tenant and session
 *   R  GET /api/checkin/:role/:loginId — the employee/manager role bypass
 *   O  PATCH /api/owners/:loginId — password, bank and recovery-contact writes
 *   T  GET /api/tenants/:tenantId/kyc — raw Aadhaar, ownership-scoped
 *
 *   node --test --test-force-exit tests/phase0cAuthorization.test.js
 *
 * Same harness as phase0Security.test.js: an in-memory replica set, routers
 * mounted into throwaway Express apps (never server.js, which connects to the
 * real database on require), and real session tokens from signSessionToken.
 *
 * Outbound email and WhatsApp are stubbed BEFORE any router is required:
 * checkinRoutes destructures them at load time.
 *
 * Each request carries a unique X-Forwarded-For. The OTP rate limiters key on
 * that header (middleware/security.js getClientIp trusts it — a known, separate
 * weakness), and without this the attack tests would trip the limiter and
 * "pass" for the wrong reason. It is also why the per-OTP attempt cap (C-07)
 * matters: IP limits alone do not stop OTP guessing.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-not-a-real-key';
process.env.AUTHZ_MODE = 'enforce';

const mailer = require('../utils/mailer');
mailer.sendMail = async () => ({ stubbed: true });
const whatsapp = require('../utils/whatsappBot');
whatsapp.sendTemplateToResolvedUser = async () => ({ stubbed: true });
whatsapp.sendDocumentToResolvedUser = async () => ({ stubbed: true });

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mongoose = require('mongoose');
const express = require('express');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

let replSet;
test.before(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replSet.getUri('phase0cAuthorizationTest'));
});
test.after(async () => {
    await mongoose.disconnect();
    await replSet.stop();
});

const User = require('../models/user');
const Owner = require('../models/Owner');
const Employee = require('../models/Employee');
const Tenant = require('../models/Tenant');
const CheckinRecord = require('../models/CheckinRecord');
const { signSessionToken } = require('../utils/sessionToken');
const { verhoeffCheck } = require('../utils/aadhaarUtils');

let seq = 0;
const uid = (p) => `${p}-${process.pid}-${++seq}`.toUpperCase();
const nextIp = () => `10.${(seq >> 8) & 255}.${seq & 255}.${(++seq) & 255}`;

/** A synthetic number that passes the Verhoeff checksum send-otp enforces. */
function syntheticAadhaar(prefix11) {
    for (let d = 0; d <= 9; d += 1) {
        const candidate = `${prefix11}${d}`;
        if (verhoeffCheck(candidate)) return candidate;
    }
    throw new Error('no Verhoeff digit found');
}

const leaks = (body, digits) => JSON.stringify(body).replace(/[\s-]/g, '').includes(digits);

async function mount(path, routerPath) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use(path, require(routerPath));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function call(base, path, { token, method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': nextIp(),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

async function world() {
    const ownerA = await Owner.create({ name: 'Owner A', loginId: uid('RH-C-OA'), email: 'a@owner.test', phone: '9811111111',
        checkinBankAccountNumber: '111122223333', checkinIfscCode: 'HDFC0001234', credentials: { password: 'owner-a-pass' },
        kyc: { status: 'pending' } });
    const ownerB = await Owner.create({ name: 'Owner B', loginId: uid('RH-C-OB'), email: 'b@owner.test', phone: '9822222222' });

    const aadhaarA = syntheticAadhaar(`23456789${String(seq % 1000).padStart(3, '0')}`);
    const aadhaarB = syntheticAadhaar(`34567891${String(seq % 1000).padStart(3, '0')}`);

    const tenantA = await Tenant.create({
        name: 'Tenant A', phone: '9700000001', email: 'tenant.a@example.test', loginId: uid('RH-C-TA'),
        ownerLoginId: ownerA.loginId, kycStatus: 'pending',
        kyc: { aadhaarNumber: aadhaarA, aadhar: aadhaarA, aadhaarFront: 'https://cdn.test/a-front.jpg', aadhaarBack: 'https://cdn.test/a-back.jpg', aadhaarData: { raw: aadhaarA } },
        kycVerificationData: { adminEnteredName: 'Tenant A', adminEnteredAadhaar: aadhaarA },
    });
    const tenantB = await Tenant.create({
        name: 'Tenant B', phone: '9700000002', email: 'tenant.b@example.test', loginId: uid('RH-C-TB'),
        ownerLoginId: ownerB.loginId,
        kyc: { aadhaarNumber: aadhaarB, aadhaarFront: 'https://cdn.test/b-front.jpg' },
    });

    const staffOfA = await Employee.create({ name: 'Staff of A', phone: '9100000001', loginId: uid('RH-C-SA'), role: 'employee', parentLoginId: ownerA.loginId });
    const outsider = await Employee.create({ name: 'Unrelated employee', phone: '9100000002', loginId: uid('RH-C-EX'), role: 'employee' });
    const superadmin = await User.create({ name: 'SA', phone: `9${Date.now() % 1e9}`.slice(0, 10), password: 'x', role: 'superadmin', loginId: uid('RH-C-SADM'), status: 'active' });
    const admin = await User.create({ name: 'Admin', phone: `8${Date.now() % 1e9}`.slice(0, 10), password: 'x', role: 'admin', loginId: uid('RH-C-ADM'), status: 'active' });

    const tok = {
        ownerA: signSessionToken({ id: ownerA._id, role: 'owner' }, ownerA),
        ownerB: signSessionToken({ id: ownerB._id, role: 'owner' }, ownerB),
        tenantA: signSessionToken({ id: tenantA._id, role: 'tenant' }, tenantA),
        tenantB: signSessionToken({ id: tenantB._id, role: 'tenant' }, tenantB),
        staffOfA: signSessionToken({ id: staffOfA._id }, staffOfA),
        outsider: signSessionToken({ id: outsider._id }, outsider),
        superadmin: signSessionToken({ id: superadmin._id, role: 'superadmin' }, superadmin),
        admin: signSessionToken({ id: admin._id, role: 'admin' }, admin),
    };
    return { ownerA, ownerB, tenantA, tenantB, aadhaarA, aadhaarB, tok };
}

/** send-otp with a known OTP (the route draws it from crypto.randomInt). */
async function sendOtp(base, tenant, aadhaar, otp = 424242) {
    const real = crypto.randomInt;
    crypto.randomInt = () => otp;
    try {
        return await call(base, '/api/checkin/tenant/kyc/send-otp', {
            method: 'POST', body: { loginId: tenant.loginId, aadhaarLinkedPhone: tenant.phone, aadhaarNumber: aadhaar },
        });
    } finally {
        crypto.randomInt = real;
    }
}

const verifyOtp = (base, tenant, aadhaar, otp) => call(base, '/api/checkin/tenant/kyc/verify-otp', {
    method: 'POST', body: { loginId: tenant.loginId, aadhaarNumber: aadhaar, otp: String(otp) },
});

const profile = (base, loginId, proof) => call(base, `/api/checkin/tenant/profile/${encodeURIComponent(loginId)}`, {
    headers: proof ? { 'X-Checkin-Access': proof } : {},
});

/** Runs the real OTP flow for a tenant and returns the issued proof. */
async function proofFor(base, tenant, aadhaar, otp = 424242) {
    assert.equal((await sendOtp(base, tenant, aadhaar, otp)).status, 200, 'send-otp');
    const res = await verifyOtp(base, tenant, aadhaar, otp);
    assert.equal(res.status, 200, `verify-otp: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.checkinAccess && res.body.checkinAccess.token, 'a proof must be issued on success');
    return res.body.checkinAccess.token;
}

// ════════════════════════════════════════════════════════════════════════════
// C — digital check-in
// ════════════════════════════════════════════════════════════════════════════

test('C-01 ANONYMOUS profile: no Aadhaar number, no card images — onboarding fields intact', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const res = await profile(base, w.tenantA.loginId);
    assert.equal(res.status, 200, 'the check-in link must keep working without a login');
    assert.ok(!leaks(res.body, w.aadhaarA), 'full Aadhaar leaked to an anonymous caller');
    assert.ok(!JSON.stringify(res.body).includes('a-front.jpg'), 'card image leaked');
    assert.equal(res.body.tenant.aadhaarMasked, `XXXX XXXX ${w.aadhaarA.slice(-4)}`);
    assert.equal(res.body.tenant.sensitiveAccess, false);
    assert.equal(res.body.tenant.phone, '9700000001', 'KYC step needs the linked phone');
    assert.equal(res.body.tenant.name, 'Tenant A');
    assert.equal(res.headers === undefined, true); // (fetch headers not captured; see C-08 for no-store)
});

test('C-02 the anonymous onboarding round trip still works, and its responses carry no Aadhaar', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const sent = await sendOtp(base, w.tenantA, w.aadhaarA);
    assert.equal(sent.status, 200, 'send-otp is a public onboarding step');
    assert.ok(!leaks(sent.body, w.aadhaarA));

    const verified = await verifyOtp(base, w.tenantA, w.aadhaarA, 424242);
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.ok(!leaks(verified.body, w.aadhaarA), 'verify-otp used to echo the whole tenant');
    assert.ok(!JSON.stringify(verified.body).includes('a-front.jpg'));
    assert.equal(verified.body.tenant, undefined);
    assert.equal(verified.body.record, undefined);

    const stored = await Tenant.findById(w.tenantA._id).lean();
    assert.equal(stored.kyc.otpVerified, true, 'KYC must still be recorded');
    assert.equal(stored.kyc.aadhaarNumber, w.aadhaarA, 'the real number is still stored for KYC review');
});

test('C-03 a valid proof returns the tenant\'s OWN card images — and still never the number', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const proof = await proofFor(base, w.tenantA, w.aadhaarA);
    const res = await profile(base, w.tenantA.loginId, proof);
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.sensitiveAccess, true);
    assert.equal(res.body.tenant.kycDocuments.aadhaarFront, 'https://cdn.test/a-front.jpg');
    assert.ok(!leaks(res.body, w.aadhaarA), 'the full number must not be returned even with a proof');
});

test('C-04 ATTACK: tenant A\'s proof on tenant B\'s loginId unlocks nothing', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const proofA = await proofFor(base, w.tenantA, w.aadhaarA);
    const res = await profile(base, w.tenantB.loginId, proofA);
    assert.equal(res.status, 200, 'degrades to the public view rather than breaking the page');
    assert.equal(res.body.tenant.sensitiveAccess, false);
    assert.equal(res.body.checkinAccess, 'denied');
    assert.equal(res.body.tenant.kycDocuments, undefined);
    assert.ok(!JSON.stringify(res.body).includes('b-front.jpg'), 'B\'s card image leaked via A\'s proof');
    assert.ok(!leaks(res.body, w.aadhaarB));
    // Changing the loginId case/whitespace does not help either.
    const res2 = await profile(base, ` ${w.tenantB.loginId.toLowerCase()} `.trim(), proofA);
    assert.equal(res2.body.tenant.sensitiveAccess, false);
});

test('C-05 forged, malformed and expired proofs are rejected', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    for (const forged of [
        crypto.randomBytes(32).toString('base64url'),   // well-formed, never issued
        'abc',                                          // malformed
        w.tenantA.loginId,                              // "proof" = the client-known id
        signSessionToken({ id: w.tenantA._id, role: 'tenant' }, w.tenantA), // a SESSION token is not a proof
    ]) {
        const res = await profile(base, w.tenantA.loginId, forged);
        assert.equal(res.body.tenant.sensitiveAccess, false, `accepted: ${forged.slice(0, 12)}…`);
        assert.equal(res.body.tenant.kycDocuments, undefined);
    }

    const proof = await proofFor(base, w.tenantA, w.aadhaarA);
    const realNow = Date.now;
    Date.now = () => realNow() + 31 * 60 * 1000; // past the 30-minute lifetime
    try {
        const res = await profile(base, w.tenantA.loginId, proof);
        assert.equal(res.body.tenant.sensitiveAccess, false, 'expired proof accepted');
        assert.equal(res.body.checkinAccess, 'denied');
    } finally {
        Date.now = realNow;
    }
});

test('C-06 a newer verification revokes the older proof (one live proof per tenant)', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const first = await proofFor(base, w.tenantA, w.aadhaarA, 111111);
    const second = await proofFor(base, w.tenantA, w.aadhaarA, 222222);
    assert.notEqual(first, second);
    assert.equal((await profile(base, w.tenantA.loginId, first)).body.tenant.sensitiveAccess, false, 'superseded proof still works');
    assert.equal((await profile(base, w.tenantA.loginId, second)).body.tenant.sensitiveAccess, true);
});

test('C-07 ATTACK: OTP guessing is capped per OTP — even with the rate limiters sidestepped', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    // What an attacker can do today: otpLimiter keys anonymous requests on
    // body.identifier BEFORE body.loginId (security.js getRateLimitKey), and
    // verify-otp ignores `identifier`; otpIpLimiter keys on the client-supplied
    // X-Forwarded-For. A fresh value of each per request means neither limiter
    // ever counts. The per-OTP attempt cap is what must stop the guessing.
    const guess = (otp) => call(base, '/api/checkin/tenant/kyc/verify-otp', {
        method: 'POST',
        body: { identifier: crypto.randomUUID(), loginId: w.tenantA.loginId, aadhaarNumber: w.aadhaarA, otp: String(otp) },
    });

    assert.equal((await sendOtp(base, w.tenantA, w.aadhaarA, 424242)).status, 200);
    for (let i = 0; i < 5; i += 1) {
        const wrong = await guess(100000 + i);
        assert.equal(wrong.status, 400, `attempt ${i + 1}: limiter should not be what stops this — got ${wrong.status}`);
        assert.equal(wrong.body.checkinAccess, undefined);
    }
    const late = await guess(424242);
    assert.notEqual(late.status, 200, 'a correct OTP after 5 misses must not be accepted');
    assert.equal(late.body.checkinAccess, undefined, 'no proof may be issued');
    assert.equal((await Tenant.findById(w.tenantA._id).lean()).kyc.otpVerified, false);
});

test('C-08 no Aadhaar number, OTP or proof is written to the logs', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const lines = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    let proof;
    try {
        proof = await proofFor(base, w.tenantA, w.aadhaarA, 535353);
        await profile(base, w.tenantA.loginId, proof);
        await call(base, '/api/checkin/owner/kyc/send-otp', {
            method: 'POST', body: { loginId: w.ownerA.loginId, aadhaarLinkedPhone: '9811111111', aadhaarNumber: w.aadhaarA, email: 'a@owner.test' },
        });
    } finally {
        Object.assign(console, orig);
    }
    const all = lines.join('\n');
    assert.ok(!all.replace(/[\s-]/g, '').includes(w.aadhaarA), 'Aadhaar number logged');
    assert.ok(!all.includes('535353'), 'OTP logged');
    assert.ok(!all.includes(proof), 'access proof logged');
});

// ════════════════════════════════════════════════════════════════════════════
// R — GET /api/checkin/:role/:loginId (the role bypass)
// ════════════════════════════════════════════════════════════════════════════

test('R-01 the check-in record is ownership-scoped, and its Aadhaar is masked for everyone', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();
    await CheckinRecord.create({ loginId: w.tenantA.loginId, role: 'tenant', tenantKyc: { aadhaarNumber: w.aadhaarA, aadhaarLinkedPhone: '9700000001' } });
    const path = `/api/checkin/tenant/${w.tenantA.loginId}`;

    assert.equal((await call(base, path)).status, 401, 'anonymous');
    // THE BYPASS: an employee was "privileged" and skipped every check.
    assert.equal((await call(base, path, { token: w.tok.outsider })).status, 403, 'unrelated employee');
    assert.equal((await call(base, path, { token: w.tok.ownerB })).status, 403, 'another owner');
    assert.equal((await call(base, path, { token: w.tok.tenantB })).status, 403, 'another tenant');

    for (const who of ['ownerA', 'staffOfA', 'superadmin', 'admin', 'tenantA']) {
        const res = await call(base, path, { token: w.tok[who] });
        assert.equal(res.status, 200, `${who} should be allowed`);
        assert.ok(!leaks(res.body, w.aadhaarA), `${who} received the raw number from the record route`);
        assert.equal(res.body.record.tenantKyc.aadhaarNumber, `XXXX XXXX ${w.aadhaarA.slice(-4)}`);
    }
});

test('R-02 owner records: only that owner (or someone with access to them)', async (t) => {
    const { server, base } = await mount('/api/checkin', '../routes/checkinRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();
    await CheckinRecord.create({ loginId: w.ownerA.loginId, role: 'owner', ownerKyc: { aadhaarNumber: w.aadhaarA } });
    const path = `/api/checkin/owner/${w.ownerA.loginId}`;

    assert.equal((await call(base, path, { token: w.tok.outsider })).status, 403);
    assert.equal((await call(base, path, { token: w.tok.ownerB })).status, 403);
    assert.equal((await call(base, path, { token: w.tok.tenantA })).status, 403, 'a tenant never reads owner records');
    const own = await call(base, path, { token: w.tok.ownerA });
    assert.equal(own.status, 200);
    assert.ok(!leaks(own.body, w.aadhaarA));
});

// ════════════════════════════════════════════════════════════════════════════
// O — PATCH /api/owners/:loginId
// ════════════════════════════════════════════════════════════════════════════

test('O-01 ATTACK: an unrelated employee cannot update ANY owner', async (t) => {
    const { server, base } = await mount('/api/owners', '../routes/ownerRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const res = await call(base, `/api/owners/${w.ownerA.loginId}`, { token: w.tok.outsider, method: 'PATCH', body: { address: 'pwned', checkinBankAccountNumber: '999988887777' } });
    assert.equal(res.status, 403);
    const after = await Owner.findById(w.ownerA._id).lean();
    assert.equal(after.checkinBankAccountNumber, '111122223333');
    assert.notEqual(after.address, 'pwned');
});

test('O-02 ATTACK: another owner cannot update owner A', async (t) => {
    const { server, base } = await mount('/api/owners', '../routes/ownerRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const res = await call(base, `/api/owners/${w.ownerA.loginId}`, { token: w.tok.ownerB, method: 'PATCH', body: { address: 'pwned' } });
    assert.equal(res.status, 403);
    // …also when addressed by _id instead of loginId.
    const byId = await call(base, `/api/owners/${w.ownerA._id}`, { token: w.tok.ownerB, method: 'PATCH', body: { address: 'pwned' } });
    assert.equal(byId.status, 403);
});

test('O-03 owner A\'s own staff: profile edits yes; password, bank and recovery contact NO', async (t) => {
    const { server, base } = await mount('/api/owners', '../routes/ownerRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();
    const path = `/api/owners/${w.ownerA.loginId}`;
    const before = await Owner.findById(w.ownerA._id).lean();

    const ok = await call(base, path, { token: w.tok.staffOfA, method: 'PATCH', body: { address: 'New address' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    for (const body of [
        { checkinBankAccountNumber: '999988887777' },
        { credentials: { password: 'staff-chosen-pass' } },
        { email: 'staff@attacker.test' },
        { profile: { email: 'staff@attacker.test' } },
    ]) {
        const res = await call(base, path, { token: w.tok.staffOfA, method: 'PATCH', body });
        assert.equal(res.status, 403, `staff allowed to write ${JSON.stringify(body)}`);
        assert.ok(!JSON.stringify(res.body).includes('999988887777'), 'denial echoed the submitted value');
    }
    const after = await Owner.findById(w.ownerA._id).lean();
    assert.equal(after.checkinBankAccountNumber, '111122223333', 'bank changed');
    assert.equal(after.credentials.password, before.credentials.password, 'password changed');
    assert.equal(after.email, 'a@owner.test', 'recovery email changed');
    assert.equal(after.address, 'New address');

    // The edit form re-sends unchanged bank/contact values on every save.
    const resend = await call(base, path, { token: w.tok.staffOfA, method: 'PATCH', body: {
        address: 'Newer address', email: 'a@owner.test', checkinBankAccountNumber: '111122223333', checkinIfscCode: 'HDFC0001234',
    } });
    assert.equal(resend.status, 200, 'unchanged protected values must not block an ordinary edit');
});

test('O-04 the owner and a platform admin can change bank details; the response never carries a hash', async (t) => {
    const { server, base } = await mount('/api/owners', '../routes/ownerRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();
    const path = `/api/owners/${w.ownerA.loginId}`;

    const self = await call(base, path, { token: w.tok.ownerA, method: 'PATCH', body: { checkinBankAccountNumber: '444455556666', credentials: { password: 'new-owner-pass' } } });
    assert.equal(self.status, 200, JSON.stringify(self.body));
    assert.equal(self.body.checkinBankAccountNumber, '444455556666');
    assert.equal(self.body.credentials && self.body.credentials.password, undefined, 'password hash returned');
    assert.equal(self.body.checkinPassword, undefined);

    const admin = await call(base, path, { token: w.tok.superadmin, method: 'PATCH', body: { checkinBankAccountNumber: '777788889999' } });
    assert.equal(admin.status, 200);
    assert.equal((await Owner.findById(w.ownerA._id).lean()).checkinBankAccountNumber, '777788889999');
});

test('O-05 an owner cannot self-certify KYC through the profile PATCH', async (t) => {
    const { server, base } = await mount('/api/owners', '../routes/ownerRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const res = await call(base, `/api/owners/${w.ownerA.loginId}`, { token: w.tok.ownerA, method: 'PATCH', body: { kyc: { status: 'verified' }, address: 'x' } });
    assert.equal(res.status, 200);
    assert.equal((await Owner.findById(w.ownerA._id).lean()).kyc.status, 'pending');
});

// ════════════════════════════════════════════════════════════════════════════
// T — GET /api/tenants/:tenantId/kyc and write-route responses
// ════════════════════════════════════════════════════════════════════════════

test('T-01 raw KYC: only parties with access to the tenant\'s owner', async (t) => {
    const { server, base } = await mount('/api/tenants', '../routes/tenantRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();
    const path = `/api/tenants/${w.tenantA._id}/kyc`;

    assert.equal((await call(base, path)).status, 401, 'anonymous');
    // THE BUG: only role === 'owner' was record-checked.
    assert.equal((await call(base, path, { token: w.tok.outsider })).status, 403, 'unrelated employee read the raw Aadhaar');
    assert.equal((await call(base, path, { token: w.tok.ownerB })).status, 403, 'another owner');
    assert.equal((await call(base, path, { token: w.tok.tenantA })).status, 403, 'tenants are not KYC reviewers');

    // Legitimate KYC review keeps the real values.
    for (const who of ['ownerA', 'staffOfA', 'superadmin', 'admin']) {
        const res = await call(base, path, { token: w.tok[who] });
        assert.equal(res.status, 200, `${who} must keep KYC review access`);
        assert.equal(res.body.kyc.aadhaarNumber, w.aadhaarA);
        assert.equal(res.body.kyc.aadhaarFront, 'https://cdn.test/a-front.jpg');
        assert.equal(res.body.kyc.aadhaarData, undefined, 'raw provider payload is not needed');
    }
});

test('T-02 write routes no longer echo the raw Aadhaar in their response', async (t) => {
    const { server, base } = await mount('/api/tenants', '../routes/tenantRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const res = await call(base, `/api/tenants/${w.tenantA._id}/deactivate`, { token: w.tok.superadmin, method: 'POST', body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(!leaks(res.body, w.aadhaarA), 'deactivate echoed the Aadhaar');
    assert.ok(!JSON.stringify(res.body).includes('a-front.jpg'));
    assert.equal(res.body.data.status, 'suspended');
});

test('T-03 the strict gates from Phase 0b still hold', async (t) => {
    const { server, base } = await mount('/api/tenants', '../routes/tenantRoutes');
    t.after(() => new Promise((r) => server.close(r)));
    const w = await world();

    const del = await call(base, '/api/tenants/bulk-delete', { token: w.tok.outsider, method: 'POST', body: { tenantIds: [String(w.tenantA._id)] } });
    assert.equal(del.status, 403, 'staff must not reach bulk-delete');
    assert.ok(await Tenant.findById(w.tenantA._id), 'tenant deleted');
    const csv = await call(base, '/api/tenants/kyc/police-verification-export', { token: w.tok.outsider });
    assert.equal(csv.status, 403, 'staff must not export the Aadhaar CSV');
});
