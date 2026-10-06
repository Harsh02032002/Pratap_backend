const compression = require('compression');
const hpp = require('hpp');
const mongoSanitize = require('express-mongo-sanitize');

function requestHardening(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
}

module.exports = {
    compressionMiddleware: compression({
        filter: (req, res) => {
            if (req.headers['accept'] === 'text/event-stream' || (req.path && req.path.endsWith('/stream'))) {
                return false;
            }
            return compression.filter(req, res);
        }
    }),
    hppMiddleware: hpp(),
    mongoSanitizeMiddleware: (req, res, next) => {
        const options = { replaceWith: '_' };
        // Sanitize in place to avoid assigning to req.query (getter-only in Express 5)
        if (req.body) mongoSanitize.sanitize(req.body, options);
        if (req.params) mongoSanitize.sanitize(req.params, options);
        if (req.headers) mongoSanitize.sanitize(req.headers, options);
        if (req.query) mongoSanitize.sanitize(req.query, options);
        next();
    },
    requestHardening
};
