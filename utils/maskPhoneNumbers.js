/**
 * maskPhoneNumbers — Chat mein phone numbers mask karta hai.
 *
 * Rule:
 *   - 10-digit Indian phone numbers detect karo (with or without +91/91 prefix)
 *   - Pehle 5 digits dikhao, baaki 5 → XXXXX
 *   - Example: 9464165020 → 94641XXXXX
 *   - Example: +919464165020 → +9194641XXXXX
 *
 * @param {string} text - Chat message text
 * @returns {string} - Masked text
 */
function maskPhoneNumbers(text) {
    if (!text || typeof text !== 'string') return text;

    // Regex: optional country code (+91 or 91), then 10 digits
    // Matches: 9464165020 | +919464165020 | 91-9464165020 | 91 9464165020
    const phoneRegex = /(\+?91[\s\-]?)?([6-9]\d{4})(\d{5})/g;

    return text.replace(phoneRegex, (match, countryCode, firstFive, lastFive) => {
        const prefix = countryCode || '';
        return `${prefix}${firstFive}XXXXX`;
    });
}

module.exports = { maskPhoneNumbers };
