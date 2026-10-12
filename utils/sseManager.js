const { isAllowedOrigin } = require('./corsOrigin');

const clients = new Set();

const HEARTBEAT_MS = 25000;

/**
 * Ends one stream and drops it. Used both on revocation and on write failure.
 */
function closeClient(client, reason) {
    clients.delete(client);
    try {
        if (reason) {
            client.res.write('event: session_ended\n');
            client.res.write(`data: ${JSON.stringify({ reason })}\n\n`);
        }
        client.res.end();
    } catch (_) { /* already gone */ }
}

/**
 * Heartbeat AND authorization re-validation, every 25 seconds.
 *
 * WHY RE-VALIDATION BELONGS HERE: an SSE stream is authorized exactly once, at
 * connect, and is then deliberately exempted from the request deadline
 * (middleware/requestHardening.js) and kept open indefinitely by this very
 * heartbeat. So without this, deactivating an owner left their live event stream
 * running — the one place where "revoked on the next request" never arrives,
 * because there is no next request.
 *
 * Re-using the heartbeat tick means no extra timer and bounds the revocation
 * latency for a stream at one beat (25s), which is stated in the security report
 * as the SSE consistency guarantee.
 */
async function revalidateAndPing() {
    // Required lazily: authMiddleware pulls in the account models, and this
    // module is required from controllers that those models' chain can reach.
    let authenticateToken;
    try {
        ({ authenticateToken } = require('../middleware/authMiddleware'));
    } catch (_) {
        authenticateToken = null;
    }

    for (const client of Array.from(clients)) {
        // Ping first, so a dead socket is reaped even if auth cannot be checked.
        try {
            client.res.write(': ping\n\n');
            if (typeof client.res.flush === 'function') client.res.flush();
        } catch (_) {
            clients.delete(client);
            continue;
        }

        if (!authenticateToken || !client.token) continue;

        try {
            const verdict = await authenticateToken(client.token);
            if (!verdict.ok) {
                closeClient(client, verdict.reason);
                console.log(`[SSE] stream closed for ${client.ownerLoginId} (${verdict.reason})`);
            }
        } catch (err) {
            // Fail closed: an indefinitely-open authorized stream whose validity
            // cannot be confirmed is ended rather than left running.
            closeClient(client, 'revalidation_failed');
            console.warn('[SSE] revalidation failed, stream closed:', err.message);
        }
    }
}

const heartbeat = setInterval(revalidateAndPing, HEARTBEAT_MS);
// Never keep a process (script, test runner) alive just for the heartbeat.
if (typeof heartbeat.unref === 'function') heartbeat.unref();

exports.addClient = (req, res, ownerLoginId) => {
    const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    };
    // Only echo an allowlisted origin. Reflecting any Origin together with
    // Allow-Credentials let any website open this stream from an owner's browser.
    // No Origin header = same-origin request, which needs no CORS headers.
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Credentials'] = 'true';
    }
    res.writeHead(200, headers);

    // initial payload to keep connection alive immediately
    res.write('data: {"connected":true}\n\n');
    if (typeof res.flush === 'function') res.flush();

    // The token is kept in memory ONLY so the loop above can re-check that this
    // stream is still authorized. It is never written to a log or to the stream.
    // middleware/ownerAccess.js:sseTokenFromQuery has already lifted a ?token=
    // query parameter into this header, because EventSource cannot set headers.
    const authHeader = req.headers && req.headers.authorization;
    const token = authHeader ? String(authHeader).replace(/^Bearer\s+/i, '').trim() : null;

    const client = { req, res, token, ownerLoginId: ownerLoginId.toUpperCase() };
    clients.add(client);

    req.on('close', () => {
        clients.delete(client);
    });
};

// Exported so the security tests can drive one pass deterministically instead
// of waiting out the 25s timer.
exports._revalidateAndPing = revalidateAndPing;
exports._clientCount = () => clients.size;
exports._clients = () => Array.from(clients);

exports.notifyOwner = (ownerLoginId, eventType, data) => {
    if (!ownerLoginId) return;
    const target = String(ownerLoginId).toUpperCase();

    clients.forEach(client => {
        if (client.ownerLoginId === target) {
            try {
                client.res.write(`event: ${eventType}\n`);
                client.res.write(`data: ${JSON.stringify(data)}\n\n`);
                if (typeof client.res.flush === 'function') client.res.flush();
            } catch (_) {
                clients.delete(client);
            }
        }
    });
};
