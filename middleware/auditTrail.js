const AuditLog = require('../models/AuditLog');

function maskSecrets(payload = {}) {
    const clone = { ...payload };
    const blocked = ['password', 'newPassword', 'token', 'otp', 'captchaToken', 'turnstileToken', 'recaptchaToken'];
    blocked.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(clone, key)) {
            clone[key] = '[REDACTED]';
        }
    });
    return clone;
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

module.exports = { auditTrail };
