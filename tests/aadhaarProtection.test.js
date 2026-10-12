'use strict';

/**
 * aadhaarProtection.test.js — pure unit tests (no database, no server) for the
 * Phase 0c helpers that decide what Aadhaar data may leave the server:
 *
 *   utils/aadhaarMask.js          masking of valid / missing / malformed values
 *   utils/checkinProfileView.js   the anonymous check-in profile response
 *   utils/ownerUpdatePolicy.js    who may change an owner's password/bank/contact
 *   utils/tenantProjections.js    stripping secrets from write-route responses
 *   middleware/auditTrail.js      what reaches the AuditLog collection
 *
 *   node --test tests/aadhaarProtection.test.js
 *
 * The fixture Aadhaar numbers below are synthetic. Assertions search the
 * SERIALISED output for the raw digits, so a leak through any field name —
 * including ones nobody thought to check — fails the test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { aadhaarDigits, aadhaarLast4, maskAadhaar, redactAadhaarInText } = require('../utils/aadhaarMask');
const { buildCheckinProfileView } = require('../utils/checkinProfileView');
const { evaluateOwnerUpdate, ownerResponse } = require('../utils/ownerUpdatePolicy');
const { stripTenantSecrets } = require('../utils/tenantProjections');
const { maskSecrets } = require('../middleware/auditTrail');

const TENANT_AADHAAR = '234567891234';
const OWNER_SET_AADHAAR = '987654321098';

const leaks = (value, digits) => JSON.stringify(value).replace(/[\s-]/g, '').includes(digits);

// ── Masking ─────────────────────────────────────────────────────────────────

test('M-01 a valid number masks to its last four digits only', () => {
    assert.equal(maskAadhaar(TENANT_AADHAAR), 'XXXX XXXX 1234');
    assert.equal(maskAadhaar('2345 6789 1234'), 'XXXX XXXX 1234', 'spaced form');
    assert.equal(maskAadhaar('2345-6789-1234'), 'XXXX XXXX 1234', 'dashed form');
    assert.equal(maskAadhaar(234567891234), 'XXXX XXXX 1234', 'numeric input');
    assert.equal(aadhaarLast4(TENANT_AADHAAR), '1234');
});

test('M-02 missing values reveal nothing', () => {
    for (const v of [undefined, null, '', '   ']) {
        assert.equal(maskAadhaar(v), '');
        assert.equal(aadhaarLast4(v), '');
    }
});

test('M-03 malformed values reveal NOTHING — not even a last four', () => {
    // A malformed value is usually a full number with a typo; partial
    // masking of it would leak most of the number.
    for (const v of ['23456789123', '2345678912345', '2345x6789y1234', 'XXXX XXXX 1234', {}, [], true]) {
        assert.equal(maskAadhaar(v), '', `malformed ${JSON.stringify(v)} must mask to ''`);
        assert.equal(aadhaarDigits(v), '');
    }
});

test('M-04 numbers inside free text are redacted, other digits are left alone', () => {
    const text = `Owner set (${OWNER_SET_AADHAAR}) vs Tenant (2345 6789 1234); ref 42; phone 9876543210`;
    const out = redactAadhaarInText(text);
    assert.ok(!leaks(out, OWNER_SET_AADHAAR));
    assert.ok(!leaks(out, TENANT_AADHAAR));
    assert.match(out, /XXXX XXXX 1098/);
    assert.match(out, /XXXX XXXX 1234/);
    assert.match(out, /ref 42/);
    assert.match(out, /9876543210/, 'a 10-digit phone number is not an Aadhaar');
    assert.equal(redactAadhaarInText(undefined), '');
});

// ── Check-in profile view ───────────────────────────────────────────────────

function storedTenant() {
    // Every place a number, a card image or a signature can live — including
    // legacy top-level fields .lean() can return.
    return {
        _id: '64f000000000000000000001',
        loginId: 'RH-T-1',
        name: 'Asha Tenant',
        phone: '9876543210',
        email: 'asha@example.test',
        kycStatus: 'submitted',
        tempPassword: 'temp-secret',
        aadhaarNumber: TENANT_AADHAAR,
        idProofNumber: TENANT_AADHAAR,
        idProof: { number: TENANT_AADHAAR, file: 'https://cdn.test/id.jpg' },
        kyc: {
            aadhaarNumber: TENANT_AADHAAR,
            aadhar: TENANT_AADHAAR,
            aadhaarLinkedPhone: '9876543210',
            aadhaarFront: 'https://cdn.test/front.jpg',
            aadhaarBack: 'https://cdn.test/back.jpg',
            aadharFile: 'data:image/png;base64,AAAA',
            aadhaarData: { uid: TENANT_AADHAAR, address: 'somewhere' },
            mismatchReasons: `Owner set (${OWNER_SET_AADHAAR}) vs Tenant uploaded (${TENANT_AADHAAR})`,
            fatherName: 'Father Name',
            idProof: 'Aadhaar Card',
        },
        kycVerificationData: { adminEnteredName: 'Asha Tenant', adminEnteredAadhaar: OWNER_SET_AADHAAR },
        digitalCheckin: {
            profile: { name: 'Asha Tenant', guardianNumber: '9000000000' },
            kyc: { aadhaarNumber: TENANT_AADHAAR, aadhaarFront: 'https://cdn.test/front.jpg' },
            documents: { aadhaarFrontUrl: 'https://cdn.test/front.jpg', aadhaarBackUrl: 'https://cdn.test/back.jpg' },
            agreement: { eSignName: 'Asha', signatureDataUrl: 'data:image/png;base64,SIG' },
            agreementDetails: { securityDeposit: '5000' },
        },
        agreementExtensions: [{ number: 1, months: 11, tenantSignatureDataUrl: 'data:image/png;base64,SIG2' }],
        agreementESignName: 'Asha',
    };
}

test('P-01 the public view contains no Aadhaar number, under ANY field name', () => {
    const view = buildCheckinProfileView(storedTenant());
    assert.ok(!leaks(view, TENANT_AADHAAR), 'tenant number leaked');
    assert.ok(!leaks(view, OWNER_SET_AADHAAR), 'owner-entered number leaked');
    assert.equal(view.aadhaarMasked, 'XXXX XXXX 1234');
    assert.equal(view.aadhaarLast4, '1234');
    assert.equal(view.aadhaarOnFile, true);
    assert.equal(view.sensitiveAccess, false);
});

test('P-02 the public view contains no card images, signatures or temp password', () => {
    const body = JSON.stringify(buildCheckinProfileView(storedTenant()));
    for (const secret of ['front.jpg', 'back.jpg', 'id.jpg', 'base64,AAAA', 'base64,SIG', 'temp-secret']) {
        assert.ok(!body.includes(secret), `${secret} leaked`);
    }
    assert.equal(buildCheckinProfileView(storedTenant()).kycDocuments, undefined);
});

test('P-03 onboarding fields the check-in pages prefill are preserved', () => {
    const view = buildCheckinProfileView(storedTenant());
    assert.equal(view.name, 'Asha Tenant');
    assert.equal(view.phone, '9876543210', 'the KYC step needs the linked phone');
    assert.equal(view.email, 'asha@example.test');
    assert.equal(view.kycStatus, 'submitted');
    assert.equal(view.kyc.fatherName, 'Father Name');
    assert.equal(view.kyc.idProof, 'Aadhaar Card');
    assert.equal(view.kycVerificationData.adminEnteredName, 'Asha Tenant');
    assert.equal(view.digitalCheckin.profile.guardianNumber, '9000000000');
    assert.equal(view.digitalCheckin.agreementDetails.securityDeposit, '5000');
    assert.equal(view.digitalCheckin.agreement.eSignName, 'Asha');
    assert.equal(view.agreementExtensions[0].months, 11);
});

test('P-04 the sensitive view adds the tenant\'s own card images — and still no number', () => {
    const view = buildCheckinProfileView(storedTenant(), { sensitive: true });
    assert.deepEqual(view.kycDocuments, { aadhaarFront: 'https://cdn.test/front.jpg', aadhaarBack: 'https://cdn.test/back.jpg' });
    assert.equal(view.sensitiveAccess, true);
    assert.ok(!leaks(view, TENANT_AADHAAR), 'the full number never leaves, even with a proof');
    assert.ok(!leaks(view, OWNER_SET_AADHAAR));
});

test('P-05 missing and malformed stored numbers reveal nothing', () => {
    const none = buildCheckinProfileView({ loginId: 'RH-T-2', name: 'No KYC' });
    assert.equal(none.aadhaarMasked, '');
    assert.equal(none.aadhaarOnFile, false);

    const bad = buildCheckinProfileView({ loginId: 'RH-T-3', kyc: { aadhaarNumber: '23456789123' } });
    assert.equal(bad.aadhaarMasked, '');
    assert.ok(!leaks(bad, '23456789123'));
});

test('P-06 the input object is never mutated', () => {
    const t = storedTenant();
    buildCheckinProfileView(t);
    assert.equal(t.kyc.aadhaarNumber, TENANT_AADHAAR);
    assert.equal(t.tempPassword, 'temp-secret');
});

// ── Owner update policy ─────────────────────────────────────────────────────

const storedOwner = () => ({
    loginId: 'RH-O-1',
    email: 'owner@example.test',
    phone: '9811111111',
    address: 'Old address',
    profile: { name: 'Owner', email: 'owner@example.test', phone: '9811111111', bankName: 'HDFC' },
    checkinBankAccountNumber: '111122223333',
    checkinIfscCode: 'HDFC0001234',
    bankDetails: { accountNumber: '111122223333', ifsc: 'HDFC0001234', isVerified: true },
    credentials: { password: '$2b$10$hashhashhashhashhashhashhashhashhashhashhashhashhash', firstTime: false },
    kyc: { status: 'pending' },
});
const DELEGATE = { isPlatformAdmin: false, isSelf: false };
const SELF = { isPlatformAdmin: false, isSelf: true };
const ADMIN = { isPlatformAdmin: true, isSelf: false };

test('O-01 a delegate cannot change the password — including by blanking it', () => {
    for (const body of [
        { credentials: { password: 'attacker-pass' } },
        { 'credentials.password': 'attacker-pass' },
        { credentials: { password: '' } },
        { credentials: null },
        { password: 'x' },
        { checkinPassword: 'x' },
    ]) {
        const { denied } = evaluateOwnerUpdate(body, storedOwner(), DELEGATE);
        assert.ok(denied.includes('credentials'), `not denied: ${JSON.stringify(body)}`);
    }
});

test('O-02 a delegate cannot change any bank / payout field', () => {
    for (const body of [
        { checkinBankAccountNumber: '999988887777' },
        { accountNumber: '999988887777' },
        { checkinUpiId: 'attacker@upi' },
        { bankDetails: { accountNumber: '999988887777', ifsc: 'ATTK0000001' } },
        { 'bankDetails.accountNumber': '999988887777' },
        { profile: { bankName: 'Attacker Bank' } },
    ]) {
        const { denied } = evaluateOwnerUpdate(body, storedOwner(), DELEGATE);
        assert.ok(denied.includes('bank'), `not denied: ${JSON.stringify(body)}`);
    }
});

test('O-03 a delegate cannot change the recovery email/phone (password-reset path)', () => {
    for (const body of [
        { email: 'attacker@example.test' },
        { 'profile.email': 'attacker@example.test' },
        { phone: '9000000001' },
        // $set of the parent object REPLACES it, erasing profile.email:
        { profile: { name: 'Renamed' } },
    ]) {
        const { denied } = evaluateOwnerUpdate(body, storedOwner(), DELEGATE);
        assert.ok(denied.includes('recovery'), `not denied: ${JSON.stringify(body)}`);
    }
});

test('O-04 the edit form re-sending UNCHANGED protected values is allowed', () => {
    // The superadmin/employee edit form sends every field on every save.
    const body = {
        address: 'New address',
        email: 'owner@example.test',
        phone: '9811111111',
        checkinBankAccountNumber: '111122223333',
        checkinIfscCode: 'HDFC0001234',
    };
    const { denied, update } = evaluateOwnerUpdate(body, storedOwner(), DELEGATE);
    assert.deepEqual(denied, []);
    assert.equal(update.address, 'New address');
});

test('O-05 the owner may change their own password, bank and contact details', () => {
    const body = { credentials: { password: 'new-pass' }, checkinBankAccountNumber: '999988887777', email: 'new@example.test' };
    const { denied, update } = evaluateOwnerUpdate(body, storedOwner(), SELF);
    assert.deepEqual(denied, []);
    assert.equal(update.credentials.password, 'new-pass');
    assert.equal(update.checkinBankAccountNumber, '999988887777');
});

test('O-06 nobody but a platform admin can set verification / system state', () => {
    for (const who of [SELF, DELEGATE]) {
        const body = {
            kyc: { status: 'verified' },
            status: 'active',
            bankLockedByVisit: false,
            bankDetails: { accountNumber: '111122223333', ifsc: 'HDFC0001234', isVerified: true, cf_beneficiary_id: 'X' },
        };
        const { update, stripped } = evaluateOwnerUpdate(body, storedOwner(), who);
        assert.equal(update.kyc, undefined, 'kyc must be dropped entirely, not left as {}');
        assert.equal(update.status, undefined);
        assert.equal(update.bankLockedByVisit, undefined);
        assert.equal(update.bankDetails.isVerified, undefined);
        assert.equal(update.bankDetails.cf_beneficiary_id, undefined);
        assert.ok(stripped.includes('kyc'));
    }
    const admin = evaluateOwnerUpdate({ kyc: { status: 'verified' } }, storedOwner(), ADMIN);
    assert.equal(admin.update.kyc.status, 'verified');
    assert.deepEqual(admin.denied, []);
});

test('O-07 the response never contains a password hash', () => {
    const out = ownerResponse({ ...storedOwner(), checkinPassword: '$2b$10$x', password: 'p' });
    assert.equal(out.credentials.password, undefined);
    assert.equal(out.checkinPassword, undefined);
    assert.equal(out.password, undefined);
    assert.equal(out.credentials.firstTime, false, 'non-secret siblings survive');
});

// ── Write-route responses and the audit log ─────────────────────────────────

test('S-01 stripTenantSecrets removes Aadhaar, images and signatures, incl. inside arrays', () => {
    const out = stripTenantSecrets(storedTenant());
    // The two paths the global projection deliberately leaves readable:
    assert.equal(out.kycVerificationData.adminEnteredAadhaar, undefined);
    assert.equal(out.kyc.aadhaarData, undefined);
    assert.equal(out.kycVerificationData.adminEnteredName, 'Asha Tenant');
    assert.ok(!leaks(out, OWNER_SET_AADHAAR));
    assert.ok(!leaks(out.kyc, TENANT_AADHAAR));
    assert.equal(out.kyc.aadhaarNumber, undefined);
    assert.equal(out.kyc.aadhar, undefined);
    assert.equal(out.kyc.aadhaarFront, undefined);
    assert.equal(out.digitalCheckin.kyc, undefined);
    assert.equal(out.digitalCheckin.agreement.signatureDataUrl, undefined);
    assert.equal(out.agreementExtensions[0].tenantSignatureDataUrl, undefined);
    assert.equal(out.tempPassword, undefined);
    assert.equal(out.name, 'Asha Tenant');
});

test('S-02 the audit log never stores a nested password, an OTP, or a full Aadhaar', () => {
    const logged = maskSecrets({
        credentials: { password: 'plain-text-pass' },
        otp: '123456',
        loginId: 'RH-T-1',
        aadhaarNumber: TENANT_AADHAAR,
        kyc: { aadhar: TENANT_AADHAAR, aadhaarFront: 'data:image/jpeg;base64,/9j/AAAA' },
        mismatchReasons: `Owner set (${OWNER_SET_AADHAAR})`,
        list: [{ newPassword: 'x' }],
    });
    const body = JSON.stringify(logged);
    assert.ok(!body.includes('plain-text-pass'), 'nested password stored');
    assert.ok(!body.includes('123456'), 'otp stored');
    assert.ok(!leaks(logged, TENANT_AADHAAR));
    assert.ok(!leaks(logged, OWNER_SET_AADHAAR));
    assert.ok(!body.includes('base64'));
    assert.equal(logged.loginId, 'RH-T-1', 'ordinary fields are kept for the audit trail');
    assert.equal(logged.aadhaarNumber, 'XXXX XXXX 1234');
});
