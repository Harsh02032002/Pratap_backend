const Tenant = require('../models/Tenant');

/**
 * Generate a unique tenant loginId.
 * Format: ROOMHYTNT#### (e.g., ROOMHYTNT4821)
 */
async function generateTenantId() {
    const prefix = 'ROOMHYTNT';
    let attempts = 0;

    while (attempts < 30) {
        const suffix = String(Math.floor(1000 + Math.random() * 9000));
        const candidate = `${prefix}${suffix}`;
        const exists = await Tenant.exists({ loginId: candidate });
        if (!exists) return candidate;
        attempts += 1;
    }

    throw new Error('Unable to generate unique tenant login ID');
}

module.exports = generateTenantId;
