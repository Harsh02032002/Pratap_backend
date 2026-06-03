const rateLimit = require('express-rate-limit');

function boolFromEnv(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value).toLowerCase() === 'true';
}

function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (Array.isArray(xff) && xff.length) return xff[0];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
    return req.socket.remoteAddress || '';
}

const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_GLOBAL_MAX || 300),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many requests. Please try again later.'
    }
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_AUTH_MAX || 25),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many authentication attempts. Please wait and retry.'
    }
});

const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_OTP_MAX || 5),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many OTP requests. Please wait before trying again.'
    }
});

const formLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_FORM_MAX || 20),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many submissions. Please try again later.'
    }
});

async function verifyCaptchaToken(token, remoteip) {
    const provider = (process.env.CAPTCHA_PROVIDER || 'turnstile').toLowerCase();
    const secret =
        process.env.CAPTCHA_SECRET_KEY ||
        process.env.TURNSTILE_SECRET_KEY ||
        process.env.RECAPTCHA_SECRET_KEY;

    if (!secret) {
        return { ok: false, reason: 'CAPTCHA secret is not configured' };
    }

    const endpoint =
        provider === 'recaptcha'
            ? 'https://www.google.com/recaptcha/api/siteverify'
            : 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

    const params = new URLSearchParams();
    params.append('secret', secret);
    params.append('response', token);
    if (remoteip) params.append('remoteip', remoteip);

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    const data = await response.json();
    if (!response.ok) {
        return { ok: false, reason: 'CAPTCHA verification endpoint failed' };
    }

    if (!data.success) {
        return { ok: false, reason: 'CAPTCHA validation failed', details: data['error-codes'] || [] };
    }

    return { ok: true, details: data };
}

function captchaProtection(options = {}) {
    const { required = true } = options;
    const enforce = boolFromEnv(process.env.CAPTCHA_REQUIRED, false);

    return async (req, res, next) => {
        try {
            const token =
                (req.body && (req.body.captchaToken || req.body.turnstileToken || req.body.recaptchaToken)) ||
                req.headers['x-captcha-token'];

            if (!required && !token) return next();
            if (!required && token && !enforce) return next();
            if (!enforce && !required) return next();
            if (!token && !required) return next();

            if (!token) {
                return res.status(400).json({
                    success: false,
                    message: 'CAPTCHA token is required'
                });
            }

            const remoteIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
            const result = await verifyCaptchaToken(String(token), String(remoteIp || ''));
            if (!result.ok) {
                return res.status(400).json({
                    success: false,
                    message: result.reason || 'CAPTCHA verification failed'
                });
            }

            req.captchaVerified = true;
            return next();
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: 'CAPTCHA verification error',
                error: error.message
            });
        }
    };
}

module.exports = {
    globalApiLimiter,
    authLimiter,
    otpLimiter,
    formLimiter,
    captchaProtection
};
