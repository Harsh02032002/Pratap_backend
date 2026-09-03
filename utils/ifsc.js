'use strict';

const https = require('https');

// 4-letter bank code, 5th char 0, then 6 alphanumeric branch characters.
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/i;

function normalizeIfsc(value) {
    return String(value || '').trim().toUpperCase();
}

function isValidIfscFormat(value) {
    return IFSC_REGEX.test(normalizeIfsc(value));
}

function fetchIfscDetailsFromRazorpay(ifscCode) {
    const code = normalizeIfsc(ifscCode);
    return new Promise((resolve, reject) => {
        const url = `https://ifsc.razorpay.com/${encodeURIComponent(code)}`;
        const req = https.get(url, { timeout: 5000 }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve({ success: true, data: JSON.parse(data) });
                    } catch (e) {
                        reject(new Error('Invalid response from IFSC lookup service'));
                    }
                } else if (res.statusCode === 404) {
                    resolve({ success: false, message: 'IFSC code not found' });
                } else {
                    reject(new Error(`IFSC lookup service returned status ${res.statusCode}`));
                }
            });
        });

        req.on('error', (err) => reject(err));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('IFSC lookup request timed out'));
        });
    });
}

/**
 * Live IFSC lookup. Format-valid does NOT mean the bank account is owned
 * by the named holder — bankAccountVerificationStatus stays separate.
 */
async function lookupIfsc(ifscCode) {
    const code = normalizeIfsc(ifscCode);
    if (!code) {
        return {
            httpStatus: 400,
            body: {
                success: false,
                ifscStatus: 'invalid',
                bankAccountVerificationStatus: 'pending',
                message: 'IFSC code is required'
            }
        };
    }
    if (!isValidIfscFormat(code)) {
        return {
            httpStatus: 400,
            body: {
                success: false,
                ifscStatus: 'invalid',
                bankAccountVerificationStatus: 'pending',
                message: 'Invalid IFSC format. Expected 11 characters (e.g., HDFC0000060).'
            }
        };
    }

    try {
        const lookupResult = await fetchIfscDetailsFromRazorpay(code);
        if (lookupResult.success && lookupResult.data) {
            const bData = lookupResult.data;
            return {
                httpStatus: 200,
                body: {
                    success: true,
                    ifscStatus: 'valid',
                    bankAccountVerificationStatus: 'pending',
                    ifsc: code,
                    bankName: bData.BANK || '',
                    branchName: bData.BRANCH || '',
                    centre: bData.CENTRE || '',
                    district: bData.DISTRICT || '',
                    city: bData.CITY || '',
                    state: bData.STATE || '',
                    address: bData.ADDRESS || ''
                }
            };
        }
        return {
            httpStatus: 404,
            body: {
                success: false,
                ifscStatus: 'invalid',
                bankAccountVerificationStatus: 'pending',
                message: 'IFSC code not found in official bank records'
            }
        };
    } catch (apiErr) {
        return {
            httpStatus: 200,
            body: {
                success: true,
                ifscStatus: 'valid',
                bankAccountVerificationStatus: 'pending',
                ifsc: code,
                bankName: '',
                branchName: '',
                message: 'IFSC format is valid. Online branch details unavailable at this moment.'
            }
        };
    }
}

module.exports = {
    IFSC_REGEX,
    normalizeIfsc,
    isValidIfscFormat,
    fetchIfscDetailsFromRazorpay,
    lookupIfsc
};
