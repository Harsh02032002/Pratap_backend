const AuditLog = require('../models/AuditLog');
const { maskAadhaar, redactAadhaarInText } = require('../utils/aadhaarMask');

// Matched case-insensitively against every key at every depth. This used to
// look at top-level keys only, so the owner PATCH's `credentials.password` and
// every nested KYC Aadhaar number were written to the AuditLog in plain text.
const SECRET_KEY_RE = /password|passcode|otp|token|secret|captcha/i;
const AADHAAR_KEY_RE = /aadh?aa?r(number|no)?$|^aadharnumber$|idproofnumber/i;
// Data URLs / base64 blobs (card photos, signatures): pointless in an audit
// row and they ARE the identity document.
const BLOB_RE = /^data:[^;]+;base64,/i;
const MAX_DEPTH = 8;

function maskValue(key, value, depth) {
    if (SECRET_KEY_RE.test(key)) return '[REDACTED]';
    if (AADHAAR_KEY_RE.test(key) && (typeof value === 'string' || typeof value === 'number')) {
        return maskAadhaar(value) || '[REDACTED]';
    }
    if (typeof value === 'string') {
        if (BLOB_RE.test(value)) return '[REDACTED:file]';
        return redactAadhaarInText(value);
    }
    if (value && typeof value === 'object') {
        if (depth >= MAX_DEPTH) return '[TRUNCATED]';
        if (Array.isArray(value)) return value.map((v) => maskValue('', v, depth + 1));
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = maskValue(k, v, depth + 1);
        return out;
    }
    return value;
}

function maskSecrets(payload = {}) {
    if (!payload || typeof payload !== 'object') return {};
    return maskValue('', payload, 0);
}

function auditTrail(moduleName) {
    return (req, res, next) => {
        const method = String(req.method || '').toUpperCase();
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next();

        res.on('finish', () => {
            if (res.statusCode < 200 || res.statusCode >= 500) return;
            const actor = req.user || {};
            const xff = req.headers['x-forwarded-for'];
            const ip = Array.isArray(xff) ? xff[0] : String(xff || req.socket.remoteAddress || '');
            const action = `${method} ${req.path}`;

            AuditLog.create({
                actorId: actor.loginId || actor._id || '',
                actorRole: actor.role || 'anonymous',
                actorEmail: actor.email || '',
                module: moduleName,
                action,
                method,
                path: req.originalUrl || req.path,
                statusCode: res.statusCode,
                ip: ip.split(',')[0].trim(),
                userAgent: String(req.headers['user-agent'] || ''),
                payload: maskSecrets(req.body || {})
            }).catch((err) => {
                console.warn('Audit log write failed:', err.message);
            });
        });

        next();
    };
}

module.exports = { auditTrail, maskSecrets };
