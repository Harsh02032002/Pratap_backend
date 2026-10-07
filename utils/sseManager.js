const { isAllowedOrigin } = require('./corsOrigin');

const clients = new Set();

// Heartbeat ping every 25 seconds to keep proxy/load-balancer connections alive
const heartbeat = setInterval(() => {
    clients.forEach(client => {
        try {
            client.res.write(': ping\n\n');
            if (typeof client.res.flush === 'function') client.res.flush();
        } catch (_) {
            clients.delete(client);
        }
    });
}, 25000);
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

    const client = { req, res, ownerLoginId: ownerLoginId.toUpperCase() };
    clients.add(client);

    req.on('close', () => {
        clients.delete(client);
    });
};

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
