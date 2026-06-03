const CASHFREE_API_BASES = {
    sandbox: 'https://sandbox.cashfree.com',
    production: 'https://api.cashfree.com'
};

function getApiBase() {
    if (process.env.CASHFREE_API_BASE) {
        return process.env.CASHFREE_API_BASE.trim();
    }
    const env = String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
    return CASHFREE_API_BASES[env] || CASHFREE_API_BASES.sandbox;
}

function isAadhaarBypassEnabled() {
    const aadhaarBypass = String(process.env.CASHFREE_AADHAAR_BYPASS || '').toLowerCase() === 'true';
    const digilockerBypass = String(process.env.CASHFREE_DIGILOCKER_BYPASS || '').toLowerCase() === 'true';
    const env = String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
    return aadhaarBypass || (env === 'sandbox' && digilockerBypass);
}

function getMockOtp() {
    return String(process.env.CASHFREE_MOCK_OTP || '123456').trim();
}

function getHeaders() {
    const clientId = process.env.CASHFREE_CLIENT_ID;
    const clientSecret = process.env.CASHFREE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('Cashfree client credentials are not configured');
    }

    return {
        'Content-Type': 'application/json',
        'x-client-id': clientId,
        'x-client-secret': clientSecret,
        'x-api-version': process.env.CASHFREE_API_VERSION || '2025-01-01'
    };
}

async function callCashfree(path, payload) {
    const controller = new AbortController();
    const timeoutMs = Number(process.env.CASHFREE_TIMEOUT_MS || 15000);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${getApiBase()}${path}`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const code = data?.code || data?.error_code || data?.type || '';
            const message = data?.message || data?.error_description || data?.error || `Cashfree request failed (${response.status})`;
            const detail = code ? `${message} [${code}]` : message;
            console.error('[Cashfree Error]', {
                path,
                status: response.status,
                code,
                message,
                response: data
            });
            const err = new Error(detail);
            err.code = code;
            err.status = response.status;
            err.data = data;
            throw err;
        }
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

async function requestAadhaarOtp(aadhaarNumber) {
    if (isAadhaarBypassEnabled()) {
        return {
            referenceId: `mock-${String(aadhaarNumber || '').trim()}`,
            raw: {
                mock: true,
                mockOtp: getMockOtp()
            }
        };
    }

    let data;
    try {
        data = await callCashfree('/verification/offline-aadhaar/otp', {
            aadhaar_number: String(aadhaarNumber || '').trim()
        });
    } catch (err) {
        // Cashfree may return verification_pending when OTP was just generated for same Aadhaar.
        // Reuse the refId so verify endpoint can proceed without forcing a resend.
        if (err?.code === 'verification_pending') {
            const pendingRefId =
                err?.data?.error?.refId ||
                err?.data?.error?.reference_id ||
                err?.data?.reference_id ||
                err?.data?.ref_id;
            if (pendingRefId) {
                return {
                    referenceId: String(pendingRefId),
                    raw: err.data,
                    pending: true
                };
            }
        }
        throw err;
    }

    const referenceId = data?.reference_id || data?.ref_id || data?.data?.reference_id || data?.data?.ref_id;
    if (!referenceId) {
        throw new Error('Cashfree OTP reference not received');
    }
    return { referenceId, raw: data };
}

async function verifyAadhaarOtp(referenceId, otp) {
    if (isAadhaarBypassEnabled()) {
        const expectedOtp = getMockOtp();
        if (String(otp || '').trim() !== expectedOtp) {
            const err = new Error('Invalid OTP');
            err.code = 'invalid_otp';
            throw err;
        }
        return {
            success: true,
            mock: true,
            reference_id: referenceId,
            status: 'VALID'
        };
    }

    const data = await callCashfree('/verification/offline-aadhaar/verify', {
        reference_id: referenceId,
        ref_id: referenceId,
        otp: String(otp || '').trim()
    });
    return data;
}

// Cashfree OCR integration pending — always skips for now
async function aadhaarOcr(_base64Image) {
    return { sandbox: true };
}

module.exports = {
    requestAadhaarOtp,
    verifyAadhaarOtp,
    aadhaarOcr
};
