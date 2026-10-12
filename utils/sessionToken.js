'use strict';

/**
 * sessionToken.js — the one place a login/session JWT is minted.
 *
 * Centralised for three reasons:
 *
 *  1. The `tv` (token generation) claim MUST be on every session token. If a
 *     token were minted without it, `tv` would read as 0, and after any
 *     deactivation bumped the account's tokenVersion to 1 that account could
 *     never authenticate again — not even after a reactivation and a fresh
 *     login. Minting through one function makes that impossible to forget.
 *  2. Three of the old mint sites fell back to a hardcoded secret
 *     ('secret', 'roomhy-secret-key') when JWT_SECRET was unset. Anyone who
 *     knows a published default can forge a token for any account, which
 *     defeats revocation completely. There is no fallback here.
 *  3. The access-token lifetime becomes one configurable value instead of
 *     '7d' copy-pasted across five files.
 *
 * NOTE ON LIFETIME: the default is still 7 days, deliberately. This repo has no
 * refresh-token mechanism of any kind, so shortening the access token would log
 * every user out that often with nothing to renew the session. Short expiry is
 * also not what contains a revoked session here — the revocation gate in
 * middleware/authMiddleware.js is. Set ACCESS_TOKEN_TTL (e.g. '12h') to shorten
 * it once refresh tokens exist.
 */

const jwt = require('jsonwebtoken');
const { tokenVersionClaim } = require('./accountState');

const DEFAULT_ACCESS_TOKEN_TTL = '7d';

function getJwtSecret() {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET environment variable is not set. Refusing to mint a token with an insecure default.');
    }
    return process.env.JWT_SECRET;
}

const accessTokenTtl = () => (String(process.env.ACCESS_TOKEN_TTL || '').trim() || DEFAULT_ACCESS_TOKEN_TTL);

/**
 * @param {object} claims  the identity claims this token type already carried
 * @param {object} account the account document the token is being minted for —
 *                         its tokenVersion is what the request path will compare
 */
function signSessionToken(claims, account) {
    return jwt.sign(
        { ...claims, tv: tokenVersionClaim(account) },
        getJwtSecret(),
        { expiresIn: accessTokenTtl(), algorithm: 'HS256' }
    );
}

module.exports = { signSessionToken, accessTokenTtl, getJwtSecret, DEFAULT_ACCESS_TOKEN_TTL };
