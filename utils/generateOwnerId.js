const User = require('../models/user');

/**
 * Generate a unique owner loginId.
 * Format: ROOMHY#### (e.g., ROOMHY4821)
 */
async function generateOwnerId() {
    const prefix = 'ROOMHY';
    let attempts = 0;

    while (attempts < 10000) {
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const candidate = `${prefix}${randomNum}`;
        const exists = await User.exists({ loginId: candidate });
        if (!exists) return candidate;
        attempts += 1;
    }

    throw new Error('Unable to generate unique owner loginId');
}

module.exports = generateOwnerId;
