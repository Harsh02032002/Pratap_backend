'use strict';

/**
 * Coverage tests for the LOCAL regex screener (detectViolation).
 *
 * WHY THE LOCAL LAYER MATTERS ON ITS OWN
 * ──────────────────────────────────────
 * services/aiModerationService.js fails OPEN — when the provider is
 * unreachable the message is allowed through unscreened. So whenever the AI is
 * down, these regexes are the ONLY thing standing between a commission-bypass
 * attempt and the tenant. That is not hypothetical: Groq decommissioned
 * 'llama-3.3-70b-versatile', every call 404'd, and chat ran on this layer alone
 * with no symptom anywhere.
 *
 * The second half of this file matters as much as the first. Over-blocking is
 * a real harm here — two strikes suspends an account — so the clean cases are
 * assertions about ordinary business conversation that must never be flagged.
 */

const test = require('node:test');
const assert = require('node:assert');

const { detectViolation } = require('../utils/moderationHelper');

const flagged = (text) => Boolean(detectViolation(text, {}).violation);

// ── must be caught ───────────────────────────────────────────────────────────

test('bare Hinglish demands for a money handover are caught', () => {
  // The gap this file was written for: every earlier rule paired a money word
  // with a channel word (direct / offline / cash / transfer), and this phrasing
  // names no channel at all.
  for (const text of [
    'dede paise mujhe',
    'paise de do',
    'paisa dedo bhai',
    'mujhe amount de dena',
    'cash bhej do'
  ]) {
    assert.ok(flagged(text), `should be flagged: ${JSON.stringify(text)}`);
  }
});

test('contact details are caught', () => {
  for (const text of [
    'mera number 9464165020 hai',
    '453534545454',
    'mail me on test@example.com',
    'whatsapp par baat karte hain'
  ]) {
    assert.ok(flagged(text), `should be flagged: ${JSON.stringify(text)}`);
  }
});

test('explicit off-platform settlement is caught', () => {
  for (const text of [
    'cash de dena',
    'booking cancel kar do',
    'offline payment kar dena'
  ]) {
    assert.ok(flagged(text), `should be flagged: ${JSON.stringify(text)}`);
  }
});

// ── must NOT be caught ───────────────────────────────────────────────────────

test('ordinary rent and room conversation is left alone', () => {
  // Discussing price, rooms and address is explicitly allowed on the platform.
  for (const text of [
    'hi',
    'hello sir',
    'rent kitna hai',
    'room available hai kya',
    '8000 rent hai monthly',
    'security deposit 5000 hai',
    'single room ka rent 7000 hoga',
    'AC room hai, khana bhi milta hai',
    'kal aake dekh lijiye',
    'ok thik hai'
  ]) {
    assert.ok(!flagged(text), `must NOT be flagged: ${JSON.stringify(text)}`);
  }
});

test('a give word without a money word is not a violation', () => {
  // "de dena" is one of the most common words in Hindi conversation. On its own
  // it says nothing about payment, and flagging it would suspend accounts for
  // talking normally.
  for (const text of [
    'address de dena',
    'time de do',
    'photo bhej do',
    'de dena bhai'
  ]) {
    assert.ok(!flagged(text), `must NOT be flagged: ${JSON.stringify(text)}`);
  }
});

test('a money word without a give word is not a violation', () => {
  for (const text of [
    'paise kitne lagenge',
    'total amount kya hoga',
    'rent ke paise mahine ke shuru me lagte hain'
  ]) {
    assert.ok(!flagged(text), `must NOT be flagged: ${JSON.stringify(text)}`);
  }
});

test('official Roomhy payment messages are never flagged', () => {
  // The owner panel sends these itself; flagging them would block the product's
  // own payment flow.
  const link = 'Dear Harshdeep, please complete the token payment of Rs 500 to confirm your booking. Pay securely here: https://roomhy.com/website/pay?bookingId=64b7f3a1c2e4d5f6a7b8c9d0';
  assert.ok(!flagged(link), 'the platform payment link must pass');
});
