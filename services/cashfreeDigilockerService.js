function getBaseUrl() {
    const env = String(process.env.CASHFREE_ENV || 'sandbox').toLowerCase();
    if (process.env.CASHFREE_API_BASE) return process.env.CASHFREE_API_BASE.trim();
    return env === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com';
}

function isBypassEnabled() {
    return String(process.env.CASHFREE_DIGILOCKER_BYPASS || '').toLowerCase() === 'true';
}

function buildMockVerifyUrl(redirectUrl, verificationId) {
    const fallbackBase = process.env.DIGITAL_CHECKIN_URL || process.env.FRONTEND_URL || process.env.APP_URL || 'https://admin.roomhy.com';
    const url = new URL(String(redirectUrl || `${fallbackBase}/digital-checkin/ownerprofile`));
    url.searchParams.set('verification_id', verificationId);
    url.searchParams.set('reference_id', verificationId);
    url.searchParams.set('mock_digilocker', '1');
    return url.toString();
}

function getHeaders() {
    const clientId = process.env.CASHFREE_CLIENT_ID;
    const clientSecret = process.env.CASHFREE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error('Cashfree client credentials are not configured');
    }
    const headers = {
        'Content-Type': 'application/json',
        'x-client-id': clientId,
        'x-client-secret': clientSecret
    };
    if (process.env.CASHFREE_API_VERSION) {
        headers['x-api-version'] = process.env.CASHFREE_API_VERSION;
    }
    return headers;
}

async function callJson(method, path, { body, query } = {}) {
    const url = new URL(`${getBaseUrl()}${path}`);
    if (query && typeof query === 'object') {
        Object.entries(query).forEach(([k, v]) => {
            if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
        });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(process.env.CASHFREE_TIMEOUT_MS || 15000));
    try {
        const response = await fetch(url.toString(), {
            method,
            headers: getHeaders(),
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const err = new Error(data?.message || data?.error || `Cashfree DigiLocker request failed (${response.status})`);
            err.status = response.status;
            err.code = data?.code || data?.type || '';
            err.data = data;
            throw err;
        }
        return data;
    } finally {
        clearTimeout(timeout);
    }
}

async function verifyDigilockerAccount({ verificationId, mobileNumber, aadhaarNumber }) {
    if (isBypassEnabled()) {
        return {
            success: true,
            mock: true,
            account_exists: false,
            verification_id: verificationId,
            mobile_number: mobileNumber || '',
            aadhaar_number: aadhaarNumber || ''
        };
    }
    return callJson('POST', '/verification/digilocker/verify-account', {
        body: {
            verification_id: verificationId,
            mobile_number: mobileNumber || undefined,
            aadhaar_number: aadhaarNumber || undefined
        }
    });
}

async function createDigilockerUrl({ verificationId, redirectUrl, userFlow = 'signin', documents = ['AADHAAR'] }) {
    if (isBypassEnabled()) {
        const verifyUrl = buildMockVerifyUrl(redirectUrl, verificationId);
        return {
            success: true,
            mock: true,
            verification_id: verificationId,
            reference_id: verificationId,
            user_flow: userFlow,
            document_requested: documents,
            redirect_url: redirectUrl,
            url: verifyUrl,
            verification_url: verifyUrl
        };
    }
    return callJson('POST', '/verification/digilocker', {
        body: {
            verification_id: verificationId,
            document_requested: documents,
            redirect_url: redirectUrl,
            user_flow: userFlow
        }
    });
}

async function getDigilockerVerificationStatus({ verificationId, referenceId }) {
    if (isBypassEnabled()) {
        return {
            success: true,
            mock: true,
            verification_id: verificationId || referenceId,
            reference_id: referenceId || verificationId,
            status: 'VERIFIED'
        };
    }
    return callJson('GET', '/verification/digilocker', {
        query: {
            verification_id: verificationId,
            reference_id: referenceId
        }
    });
}

async function getDigilockerDocument({ documentType = 'AADHAAR', verificationId, referenceId }) {
    if (isBypassEnabled()) {
        return {
            success: true,
            mock: true,
            document_type: documentType,
            verification_id: verificationId || referenceId,
            reference_id: referenceId || verificationId,
            document_id: `mock-${String(documentType || 'AADHAAR').toLowerCase()}`,
            status: 'AVAILABLE'
        };
    }
    return callJson('GET', `/verification/digilocker/document/${documentType}`, {
        query: {
            verification_id: verificationId,
            reference_id: referenceId
        }
    });
}

module.exports = {
    verifyDigilockerAccount,
    createDigilockerUrl,
    getDigilockerVerificationStatus,
    getDigilockerDocument
};
