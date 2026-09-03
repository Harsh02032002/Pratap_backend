'use strict';

/**
 * Regression tests for the split-typing context window.
 *
 * WHAT BROKE
 * ──────────
 * moderateChatMessageAsync merges a sender's recent messages into one string
 * and screens that, so someone typing "paise" / "naa" / "de" as three separate
 * messages is still caught. The query that gathered those messages had an
 * upper bound but NO lower bound:
 *
 *     created_at: { $lt: messageDoc.created_at }     // last 8, any age
 *
 * So the merged string was "the last 8 things this person said", not "what
 * they said in the last minute". Once a flagged message sat in that history,
 * every later message inherited it — an owner typing "hi" was screened as
 * "...453534545454 5000 7845 dede paise mujhe ... hi", flagged, struck, and
 * on the second strike suspended.
 *
 * These tests drive the real detectViolation over the string the aggregation
 * builds, and pin down the window that stops the taint.
 */

const test = require('node:test');
const assert = require('node:assert');

const { detectViolation } = require('../utils/moderationHelper');

const flagged = (text) => Boolean(detectViolation(text, {}).violation);

/**
 * Rebuild the sender-text merge exactly as moderateChatMessageAsync does:
 * take the sender's messages inside the window, oldest first, append the new
 * one, join with a space.
 */
function combinedSenderText(history, current, nowMs, windowMs) {
    return history
        .filter((m) => nowMs - m.at <= windowMs)
        .sort((a, b) => a.at - b.at)
        .map((m) => m.text)
        .concat(current)
        .join(' ');
}

const MINUTE = 60 * 1000;
const WINDOW = 5 * MINUTE;
const NOW = Date.now();

// A history containing genuinely flagged content, sent days ago.
const OLD_BAD_HISTORY = [
    { text: '453534545454', at: NOW - 3 * 24 * 60 * MINUTE },
    { text: 'dede paise mujhe', at: NOW - 3 * 24 * 60 * MINUTE },
    { text: '5000 7845', at: NOW - 2 * 24 * 60 * MINUTE }
];

test('"hi" is not a violation on its own', () => {
    assert.ok(!flagged('hi'), 'the plainest possible message must never be flagged');
});

test('an old violation does not taint a later innocent message', () => {
    // The exact production symptom: owner types "hi", days after the flagged
    // messages, and is struck for it.
    const merged = combinedSenderText(OLD_BAD_HISTORY, 'hi', NOW, WINDOW);

    assert.strictEqual(merged, 'hi', 'nothing days old may enter the merged string');
    assert.ok(!flagged(merged), '"hi" must stay clean regardless of what was said days ago');
});

test('without a window the same message IS flagged - the bug being fixed', () => {
    // Documents why the window exists. With an unbounded window the old
    // messages are merged back in and "hi" is judged as a violation.
    const merged = combinedSenderText(OLD_BAD_HISTORY, 'hi', NOW, Number.MAX_SAFE_INTEGER);

    assert.ok(merged.includes('453534545454'), 'unbounded merge pulls in ancient text');
    assert.ok(flagged(merged), 'which is exactly how typing "hi" got an account struck');
});

test('genuine split typing inside the window is still caught', () => {
    // The feature must keep working: one intent typed across several quick
    // messages is still screened as a whole.
    const recent = [
        { text: 'paise', at: NOW - 40 * 1000 },
        { text: 'mujhe', at: NOW - 25 * 1000 }
    ];
    const merged = combinedSenderText(recent, 'de do', NOW, WINDOW);

    assert.ok(merged.includes('paise'), 'recent messages must still be merged');
    assert.ok(flagged(merged), 'split-typed evasion inside the window must still be caught');
});

test('the window boundary keeps recent context and drops stale context', () => {
    const straddling = [
        { text: '453534545454', at: NOW - 6 * MINUTE },  // outside
        { text: 'hello',        at: NOW - 1 * MINUTE }   // inside
    ];
    const merged = combinedSenderText(straddling, 'ok', NOW, WINDOW);

    assert.strictEqual(merged, 'hello ok');
    assert.ok(!flagged(merged));
});

test('ordinary conversation after a past violation stays sendable', () => {
    // An account that took one strike must still be able to talk. Every one of
    // these was previously flagged purely by inheritance.
    for (const text of ['hi', 'hello', 'ok', 'thik hai', 'room available hai']) {
        const merged = combinedSenderText(OLD_BAD_HISTORY, text, NOW, WINDOW);
        assert.ok(!flagged(merged), `must stay clean: ${JSON.stringify(text)}`);
    }
});
