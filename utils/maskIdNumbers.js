/**
 * maskAadhaar / maskPan
 * Sibling to maskPhoneNumbers.js — same "mask everything except the last few
 * characters" approach, applied to government ID numbers before they leave
 * the server in any API response.
 */

function maskAadhaar(value) {
    if (!value || typeof value !== 'string') return value;
    const digits = value.replace(/\D/g, '');
    if (digits.length < 4) return 'X'.repeat(digits.length);
    return `XXXX XXXX ${digits.slice(-4)}`;
}

function maskPan(value) {
    if (!value || typeof value !== 'string') return value;
    const clean = value.trim().toUpperCase();
    if (clean.length < 4) return 'X'.repeat(clean.length);
    return `${'X'.repeat(clean.length - 4)}${clean.slice(-4)}`;
}

module.exports = { maskAadhaar, maskPan };
