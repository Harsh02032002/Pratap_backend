const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

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

// Global-limiter-only memo: that limiter reads the key twice (keyGenerator and
// the per-request max) and resolving it can mean a JWT verification. Kept
// separate from getRateLimitKey so route-level limiters, which run later (after
// protect or multer may have changed req.user / req.body), still compute their
// key fresh exactly as before.
function getGlobalLimitKey(req) {
    if (req._globalRateLimitKey) return req._globalRateLimitKey;
    req._globalRateLimitKey = getRateLimitKey(req);
    return req._globalRateLimitKey;
}

function getRateLimitKey(req) {
    // 1. If req.user is already populated by auth middleware
    if (req.user && (req.user.id || req.user._id)) {
        return `user:${req.user.id || req.user._id}`;
    }

    // 2. If authentication has not occurred yet, check for bearer token and verify it
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            if (token) {
                // Verify the JWT token securely (complying with Rule 3: Do Not Use jwt.decode)
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                if (decoded && decoded.id) {
                    return `user:${decoded.id}`;
                }
            }
        } catch (e) {
            // Ignore token verification errors and proceed to other identifiers or IP fallback
        }
    }

    // 3. Check for identifier-based body fields (for login/OTP/forgot-password/reset)
    const bodyIdentifier = req.body && (req.body.identifier || req.body.loginId || req.body.email || req.body.phone || req.body.username);
    if (bodyIdentifier) {
        const normalized = String(bodyIdentifier).trim().toLowerCase();
        if (normalized) {
            return `ident:${normalized}`;
        }
    }

    // 4. Fallback to client IP for public/unauthenticated requests
    return getClientIp(req);
}

// Read all limits from environment — never hardcode production values.
// Override via .env: RATE_LIMIT_GLOBAL_MAX, RATE_LIMIT_AUTH_MAX, etc.
const GLOBAL_MAX   = parseInt(process.env.RATE_LIMIT_GLOBAL_MAX,  10) || 300;
// Budget for requests carrying a VERIFIED JWT. Panels fire 10-15 calls per page
// load and keep live views fresh, so a signed-in user legitimately needs more
// than an anonymous client. Anonymous/IP traffic keeps GLOBAL_MAX.
// Never below GLOBAL_MAX: an environment that raised RATE_LIMIT_GLOBAL_MAX
// (e.g. 15000) must not end up giving signed-in users LESS than anonymous ones.
const GLOBAL_AUTH_MAX = parseInt(process.env.RATE_LIMIT_GLOBAL_AUTH_MAX, 10) || Math.max(1000, GLOBAL_MAX);
const AUTH_MAX     = parseInt(process.env.RATE_LIMIT_AUTH_MAX,    10) || 10;
const OTP_MAX      = parseInt(process.env.RATE_LIMIT_OTP_MAX,     10) || 5;
const FORM_MAX     = parseInt(process.env.RATE_LIMIT_FORM_MAX,    10) || 20;
const CONTACT_MAX  = parseInt(process.env.RATE_LIMIT_CONTACT_MAX, 10) || 10;
const REFUND_MAX   = parseInt(process.env.RATE_LIMIT_REFUND_MAX,  10) || 5;
const CHAT_MAX     = parseInt(process.env.RATE_LIMIT_CHAT_MAX,    10) || 1000;

// These constants are read once, at require time. If this module is ever loaded
// before dotenv.config() runs, every value above silently falls back to its
// default and nothing looks wrong until a user is throttled — which is exactly
// what happened before. Printing the effective limits at boot makes that
// failure visible in one glance at the logs.
console.log('🛡️  Rate limits in effect:', {
    GLOBAL_MAX, GLOBAL_AUTH_MAX, AUTH_MAX, OTP_MAX, FORM_MAX, CONTACT_MAX, REFUND_MAX, CHAT_MAX
});

const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    // `user:` keys only come from a verified JWT (see getRateLimitKey), so a
    // forged or expired token still falls into the anonymous budget.
    max: (req) => (String(getGlobalLimitKey(req)).startsWith('user:') ? GLOBAL_AUTH_MAX : GLOBAL_MAX),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getGlobalLimitKey(req),
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
    keyGenerator: (req) => getRateLimitKey(req),
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
    keyGenerator: (req) => getRateLimitKey(req),
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
    keyGenerator: (req) => getRateLimitKey(req),
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
    keyGenerator: (req) => getRateLimitKey(req),
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
    keyGenerator: (req) => getRateLimitKey(req),
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
    keyGenerator: (req) => getRateLimitKey(req),
    message: {
        success: false,
        message: 'Too many messages. Please slow down.'
    }
});

// Short IP-based limiter to protect login/auth endpoints from massive brute force attempts (infrastructure protection)
const authIpLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute window
    max: 30, // max 30 attempts per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many login attempts from this IP. Please try again later.'
    }
});

// Short IP-based limiter to protect OTP endpoints from massive brute force attempts (infrastructure protection)
const otpIpLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute window
    max: 10, // max 10 OTP requests/verifications per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => getClientIp(req),
    message: {
        success: false,
        message: 'Too many OTP requests from this IP. Please wait before trying again.'
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
    authIpLimiter,
    otpIpLimiter,
    captchaProtection
};
