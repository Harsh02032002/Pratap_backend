'use strict';

/**
 * socketAuth.js — JWT handshake verification and server-authorized identity for
 * Socket.IO.
 *
 * THE HOLE THIS CLOSES
 * ────────────────────
 * There was no io.use() middleware anywhere in this application and nothing read
 * socket.handshake. A socket's identity came entirely from the client's own
 * join_room payload:
 *
 *     socket.on('join_room', (data) => {
 *       const { login_id, role, name } = data;   // <- attacker-chosen
 *       socket.join(login_id);
 *       socket.userRole = role;
 *     });
 *
 * So any client could join any other user's room — receiving their messages in
 * real time — and send messages as them with any role it liked.
 *
 * HOW IT IS FIXED
 * ───────────────
 * The handshake is authenticated with the same authenticateToken() that guards
 * the HTTP API, so a socket is subject to the identical revocation gate: a
 * deactivated, deleted, blocked or force-logged-out account cannot connect.
 * The authorized identity is then derived FROM THE DATABASE RECORD and stored on
 * socket.data.auth; the join_room payload is ignored for identity.
 *
 * Because a socket is long-lived, the handshake check alone would let a session
 * that was revoked one second after connecting stay live for hours. Every
 * connected socket is therefore re-validated on an interval and disconnected
 * when its account is revoked.
 *
 * The room set is computed server-side with buildChatLookupVariants, the same
 * helper the HTTP chat routes use, so the several id forms one website user is
 * addressed by all still resolve — without the client getting to nominate them.
 */

const { authenticateToken } = require('../middleware/authMiddleware');
const { buildChatLookupVariants, canonicalChatId } = require('../utils/chatIdentity');

// How often to re-check that every connected socket's account is still valid.
const REVALIDATE_MS = Math.max(
    10_000,
    Number.parseInt(process.env.SOCKET_REVALIDATE_MS, 10) || 60_000
);

/**
 * Token sources, in order of preference. `auth` is the correct Socket.IO
 * mechanism; the query string is accepted because some clients cannot set it,
 * but note a query token can be captured by proxy access logs.
 */
function tokenFromHandshake(handshake) {
    if (!handshake) return null;
    const fromAuth = handshake.auth && handshake.auth.token;
    if (fromAuth) return String(fromAuth).replace(/^Bearer\s+/i, '').trim();

    const header = handshake.headers && handshake.headers.authorization;
    if (header) return String(header).replace(/^Bearer\s+/i, '').trim();

    const fromQuery = handshake.query && handshake.query.token;
    if (fromQuery) return String(fromQuery).replace(/^Bearer\s+/i, '').trim();

    return null;
}

/** Builds the server-authorized identity from the resolved account document. */
function identityFor(user) {
    const rawId = user.loginId || user.email || '';
    return {
        accountId: String(user._id || ''),
        loginId: String(rawId),
        chatId: canonicalChatId(rawId) || String(rawId),
        role: String(user.role || ''),
        name: user.name || user.email || 'User',
        // Every id form this account is addressed by — computed here, never
        // accepted from the client.
        rooms: buildChatLookupVariants(rawId, user).filter(Boolean),
    };
}

function attachSocketAuth(io) {
    io.use(async (socket, next) => {
        const token = tokenFromHandshake(socket.handshake);

        const verdict = await authenticateToken(token);
        if (!verdict.ok) {
            // Socket.IO surfaces err.data to the client's connect_error handler,
            // so the frontend can clear a dead session and redirect to login.
            const err = new Error(verdict.body.message || 'Not authorized');
            err.data = { sessionEnded: verdict.body.sessionEnded === true, reason: verdict.reason };
            return next(err);
        }

        socket.data.auth = identityFor(verdict.user);
        // Kept only in memory for re-validation. NEVER logged.
        socket.data.authToken = token;
        return next();
    });

    // ── Re-validation of live connections ───────────────────────────────────
    const timer = setInterval(async () => {
        let sockets;
        try {
            sockets = await io.fetchSockets();
        } catch (_) {
            return; // transient adapter error; try again next tick
        }

        for (const s of sockets) {
            const token = s.data?.authToken;
            if (!token) {
                s.disconnect(true);
                continue;
            }
            try {
                const verdict = await authenticateToken(token);
                if (!verdict.ok) {
                    s.emit('session_ended', { reason: verdict.reason });
                    s.disconnect(true);
                    console.log(`[SOCKET] disconnected ${s.data?.auth?.loginId || 'unknown'} (${verdict.reason})`);
                }
            } catch (err) {
                // Fail closed: if we cannot confirm the session is still valid for
                // a long-lived connection, end it rather than let it run on.
                s.disconnect(true);
                console.warn('[SOCKET] revalidation failed, disconnected:', err.message);
            }
        }
    }, REVALIDATE_MS);

    // Do not hold the event loop open in tests or on shutdown.
    if (typeof timer.unref === 'function') timer.unref();

    return () => clearInterval(timer);
}

module.exports = { attachSocketAuth, tokenFromHandshake, identityFor, REVALIDATE_MS };
