const express = require('express');
const router = express.Router();
const { getZohoAccessToken } = require('../services/zohoSignService');

router.get('/callback', async (req, res) => {
    const { code } = req.query;

    try {
        if (code) {
            const response = await fetch('https://accounts.zoho.in/oauth/v2/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body: new URLSearchParams({
                    grant_type: 'authorization_code',
                    client_id: process.env.ZOHO_CLIENT_ID,
                    client_secret: process.env.ZOHO_CLIENT_SECRET,
                    redirect_uri: process.env.ZOHO_REDIRECT_URI || 'http://localhost:5001/zoho/callback',
                    code
                })
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                return res.status(response.status).json(data);
            }

            console.log('✅ Zoho Tokens:', data);
            return res.json(data);
        }

        const accessToken = await getZohoAccessToken({ forceRefresh: true });
        return res.json({
            access_token: accessToken,
            token_source: 'refresh_token'
        });
    } catch (err) {
        console.error('❌ Zoho Error:', err.response?.data || err.message);
        res.status(err.status || 500).json(err.data || { error: err.message });
    }
});

module.exports = router;
