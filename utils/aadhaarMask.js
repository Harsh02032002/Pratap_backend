'use strict';

/**
 * aadhaarMask.js — the one place an Aadhaar number becomes something safe to
 * show, log, or put in an error message.
 *
 * Rules, deliberately conservative:
 *   • Only a well-formed number (exactly 12 digits once spaces/dashes are
 *     removed) reveals anything, and then only its last 4 digits.
 *   • A missing OR malformed value reveals nothing. A malformed value is very
 *     often a full number with a typo, an extra digit or odd formatting, so
 *     "best effort" masking of it would leak most of the number.
 *   • Non-string input (numbers, objects, arrays) is handled, never thrown on.
 */

const MASK_PREFIX = 'XXXX XXXX ';

// 12 digits, optionally grouped 4-4-4 by a single space or dash, not embedded
// in a longer run of digits. Real Aadhaar numbers never start with 0 or 1.
const AADHAAR_IN_TEXT_RE = /(?<!\d)([2-9]\d{3})[ -]?(\d{4})[ -]?(\d{4})(?!\d)/g;

/** The bare 12 digits if `value` is a well-formed Aadhaar number, else ''. */
function aadhaarDigits(value) {
    if (value === null || value === undefined) return '';
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    const digits = String(value).replace(/[\s-]/g, '');
    return /^\d{12}$/.test(digits) ? digits : '';
}

/** Last four digits of a well-formed number, else ''. */
function aadhaarLast4(value) {
    const digits = aadhaarDigits(value);
    return digits ? digits.slice(-4) : '';
}

/** "XXXX XXXX 1234" for a well-formed number, else ''. */
function maskAadhaar(value) {
    const last4 = aadhaarLast4(value);
    return last4 ? MASK_PREFIX + last4 : '';
}

/**
 * Replaces every Aadhaar-looking number inside free text with its masked form.
 * For mismatch reasons, error messages and log lines — NOT for structured
 * fields like phone numbers, where a 12-digit "91" + mobile number would be a
 * false positive.
 */
function redactAadhaarInText(text) {
    if (text === null || text === undefined) return '';
    return String(text).replace(AADHAAR_IN_TEXT_RE, (_m, _a, _b, last4) => MASK_PREFIX + last4);
}

/** Returns the first well-formed number among `candidates`, else ''. */
function firstAadhaar(...candidates) {
    for (const c of candidates) {
        const digits = aadhaarDigits(c);
        if (digits) return digits;
    }
    return '';
}

module.exports = {
    aadhaarDigits,
    aadhaarLast4,
    maskAadhaar,
    redactAadhaarInText,
    firstAadhaar,
};
