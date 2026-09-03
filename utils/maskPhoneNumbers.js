/**
 * maskPhoneNumbers & Contact Information Protection
 *
 * Rules:
 *   1. 10-digit Indian phone numbers (continuous, spaced, dashed, dotted, or spaced digits)
 *      Example: 9464165010 -> 94641XXXXX
 *      Example: 94641 65010 -> 94641 XXXXX
 *      Example: 9 4 6 4 1 6 5 0 1 0 -> 9 4 6 4 1 X X X X X
 *   2. Email addresses:
 *      Example: user@gmail.com -> u***r@gmail.com
 *   3. Standalone 5-10 digit numbers in single messages (used to trick filters by sending numbers in chunks):
 *      Example: "94641" -> "94641XXXXX"
 */

function maskPhoneNumbers(text) {
    if (!text || typeof text !== 'string') return text;

    let result = text;

    // 1. Mask Email Addresses
    const emailRegex = /([a-zA-Z0-9._%+-]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
    result = result.replace(emailRegex, (match, username, domain) => {
        if (username.length <= 2) return `${username[0]}*@${domain}`;
        return `${username[0]}${'*'.repeat(username.length - 2)}${username[username.length - 1]}@${domain}`;
    });

    // 2. Mask 10-digit Indian Phone Numbers (with optional +91, spaces, dots, or dashes)
    // Matches: 9464165010, +919464165010, 94641 65010, 94641-65010, 94641.65010
    const phoneRegex = /(\+?91[\s\.\-]?)?([6-9][\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d)[\s\.\-]*(\d[\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d[\s\.\-]*\d)/g;
    result = result.replace(phoneRegex, (match, countryCode, firstFiveRaw, lastFiveRaw) => {
        const cleanFirstFive = firstFiveRaw.replace(/\D/g, '');
        const prefix = countryCode ? countryCode.trim() + ' ' : '';
        return `${prefix}${cleanFirstFive}XXXXX`;
    });

    // 3. Mask spaced individual digits (e.g. 9 4 6 4 1 6 5 0 1 0)
    const spacedDigitsRegex = /([6-9])\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)\s+(\d)/g;
    result = result.replace(spacedDigitsRegex, (match, d1, d2, d3, d4, d5) => {
        return `${d1} ${d2} ${d3} ${d4} ${d5} X X X X X`;
    });

    // 4. Standalone 5-digit number chunks (e.g. "94641" or "65010" sent as standalone message)
    const standaloneDigitChunkRegex = /^\s*([6-9]\d{4})\s*$/;
    if (standaloneDigitChunkRegex.test(result)) {
        result = result.replace(standaloneDigitChunkRegex, '$1XXXXX');
    }

    return result;
}

/**
 * Helper to check and mask multi-message contact details (e.g. user sends "94641" in msg1 and "65010" in msg2)
 */
async function maskPreviousConsecutiveMessage(ChatMessage, roomId, senderLoginId, currentText) {
    try {
        const cleanCurrentDigits = String(currentText || '').replace(/\D/g, '');
        if (cleanCurrentDigits.length < 4 || cleanCurrentDigits.length > 6) return;

        // Fetch last message from this sender in this room within last 10 minutes
        const tenMinsAgo = new Date(Date.now() - 10 * 60 * 1000);
        const lastMsg = await ChatMessage.findOne({
            room_id: roomId,
            sender_login_id: senderLoginId,
            created_at: { $gte: tenMinsAgo }
        }).sort({ created_at: -1 }).lean();

        if (!lastMsg || !lastMsg.message) return;

        const cleanLastDigits = String(lastMsg.message).replace(/\D/g, '');
        const combined = cleanLastDigits + cleanCurrentDigits;

        // If previous digits + current digits form a 10-digit Indian phone number starting with 6-9
        if (combined.length >= 10 && /^[6-9]\d{9}$/.test(combined.slice(0, 10))) {
            console.log(`🔒 Masking multi-message phone number leak: ${cleanLastDigits} + ${cleanCurrentDigits}`);
            const maskedPrev = `${cleanLastDigits.slice(0, 5)}XXXXX`;
            await ChatMessage.findByIdAndUpdate(lastMsg._id, { message: maskedPrev });
        }
    } catch (err) {
        console.warn('Multi-message phone masking error:', err.message);
    }
}

module.exports = { maskPhoneNumbers, maskPreviousConsecutiveMessage };
