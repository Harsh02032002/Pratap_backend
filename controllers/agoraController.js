const { RtcTokenBuilder, RtcRole } = require('agora-access-token');

const APP_ID = process.env.AGORA_APP_ID || 'bb55b91652564e1b915c056f92c45b57';
const APP_CERTIFICATE = process.env.AGORA_APP_CERT || 'e308ad289a6f4be0b7c0cb5f8f7ca5a4';

// POST /api/admin/agora/token { channel, uid }
exports.getToken = async (req, res) => {
  try {
    const channel = req.body.channel || req.query.channel;
    if (!channel) return res.status(400).json({ message: 'channel is required' });

    const uid = req.body.uid || req.query.uid || 0;
    const role = RtcRole.PUBLISHER;
    const expireTime = 3600; // 1 hour
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expireTime;

    const token = RtcTokenBuilder.buildTokenWithUid(APP_ID, APP_CERTIFICATE, channel, uid, role, privilegeExpiredTs);
    return res.json({ token, appId: APP_ID, uid });
  } catch (err) {
    console.error('Agora token error', err);
    res.status(500).json({ message: err.message });
  }
};
