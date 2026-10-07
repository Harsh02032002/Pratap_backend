/**
 * Single source of truth for which browser origins may call this API with
 * credentials. Previously the same inline check was copy-pasted into the REST
 * CORS middleware and the Socket.IO config, while the SSE stream skipped it and
 * reflected ANY Origin back with Allow-Credentials — so any site could hold an
 * owner's live event stream open from a victim's browser.
 *
 * The rule itself is unchanged from the original inline copies.
 */
function isAllowedOrigin(origin) {
    if (!origin) return true; // same-origin / server-to-server / curl
    return origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        origin.includes('roomhy.com') ||
        origin === 'https://roohmy-frontend-ux44.vercel.app';
}

module.exports = { isAllowedOrigin };
