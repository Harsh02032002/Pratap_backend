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

// Read all limits from environment — never hardcode production values.
// Override via .env: RATE_LIMIT_GLOBAL_MAX, RATE_LIMIT_AUTH_MAX, etc.
const GLOBAL_MAX   = parseInt(process.env.RATE_LIMIT_GLOBAL_MAX,  10) || 300;
const AUTH_MAX     = parseInt(process.env.RATE_LIMIT_AUTH_MAX,    10) || 10;
const OTP_MAX      = parseInt(process.env.RATE_LIMIT_OTP_MAX,     10) || 5;
const FORM_MAX     = parseInt(process.env.RATE_LIMIT_FORM_MAX,    10) || 20;
const CONTACT_MAX  = parseInt(process.env.RATE_LIMIT_CONTACT_MAX, 10) || 10;
const REFUND_MAX   = parseInt(process.env.RATE_LIMIT_REFUND_MAX,  10) || 5;
const CHAT_MAX     = parseInt(process.env.RATE_LIMIT_CHAT_MAX,    10) || 30;

const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: GLOBAL_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many requests. Please try again later.'
    }
});

// Login, register, password set/reset flows
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: AUTH_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many authentication attempts. Please try again later.'
    }
});

// OTP request and verify — applies across all roles (user, owner, tenant)
const otpLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: OTP_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many OTP requests. Please wait before trying again.'
    }
});

// General form submissions (enquiries, property add/edit, KYC submit, email)
const formLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: FORM_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many submissions. Please try again later.'
    }
});

// Contact form — lower hourly cap to prevent spam
const contactLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: CONTACT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many contact requests. Please try again later.'
    }
});

// Refund requests — strict hourly cap (financial endpoint)
const refundLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: REFUND_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many refund requests. Please try again later.'
    }
});

// Chat message REST endpoints — per-minute cap
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: CHAT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many messages. Please slow down.'
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
    contactLimiter,
    refundLimiter,
    chatLimiter,
    captchaProtection
};
