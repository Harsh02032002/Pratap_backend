const clients = new Set();

exports.addClient = (req, res, ownerLoginId) => {
    const origin = req.headers.origin || 'http://localhost:5174';
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true'
    });

    // initial payload to keep connection alive immediately
    res.write('data: {"connected":true}\n\n');

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
            client.res.write(`event: ${eventType}\n`);
            client.res.write(`data: ${JSON.stringify(data)}\n\n`);
        }
    });
};
