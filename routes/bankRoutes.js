const express = require('express');
const router = express.Router();
const axios = require('axios');

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/i;

/**
 * GET /api/bank/ifsc/:ifscCode
 * Lookup IFSC code via Razorpay public IFSC API.
 * Validates IFSC format, returns bank metadata with ifscStatus: 'valid'.
 * Does NOT set account ownership verification (bankAccountVerificationStatus).
 */
router.get('/ifsc/:ifscCode', async (req, res) => {
    try {
        const rawIfsc = (req.params.ifscCode || '').trim().toUpperCase();
        if (!rawIfsc || !IFSC_REGEX.test(rawIfsc)) {
            return res.status(400).json({
                success: false,
                ifscStatus: 'invalid',
                message: 'Invalid IFSC code format. Format must be 11 characters (e.g. HDFC0000060).'
            });
        }

        const response = await axios.get(`https://ifsc.razorpay.com/${rawIfsc}`, {
            timeout: 5000
        });

        if (response.data && response.data.BANK) {
            const rawBranch = (response.data.BRANCH || '').trim();
            const city = (response.data.CITY || '').trim();
            const state = (response.data.STATE || '').trim();
            const address = (response.data.ADDRESS || '').trim();

            let branchName = rawBranch;
            if (city && !branchName.toLowerCase().includes(city.toLowerCase())) {
                branchName = branchName ? `${branchName}, ${city}` : city;
            }

            return res.status(200).json({
                success: true,
                ifscStatus: 'valid',
                ifscCode: rawIfsc,
                bankName: response.data.BANK,
                branchName,
                rawBranch,
                city,
                state,
                address,
                contact: response.data.CONTACT || '',
                upi: !!response.data.UPI,
                rtgs: !!response.data.RTGS,
                neft: !!response.data.NEFT,
                imps: !!response.data.IMPS
            });
        }

        return res.status(404).json({
            success: false,
            ifscStatus: 'invalid',
            message: 'IFSC Code not found in bank database.'
        });
    } catch (err) {
        if (err.response && err.response.status === 404) {
            return res.status(404).json({
                success: false,
                ifscStatus: 'invalid',
                message: 'IFSC Code not found in bank database.'
            });
        }
        console.error('Error fetching IFSC details:', err.message);
        return res.status(500).json({
            success: false,
            ifscStatus: 'invalid',
            message: 'Error communicating with IFSC verification service.'
        });
    }
});

module.exports = router;
