const express = require('express');
const { formLimiter } = require('../middleware/security');
const {
    normalizePhoneNumber,
    sendTemplateMessage
} = require('../utils/whatsappBot');

const router = express.Router();

router.get('/health', (req, res) => {
    res.json({
        success: true,
        configured: Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
        apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0'
    });
});

router.post('/test-template', formLimiter, async (req, res) => {
    try {
        const { to, templateName, parameters = [] } = req.body || {};
        const normalizedTo = normalizePhoneNumber(to, process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '91');

        if (!normalizedTo || !templateName) {
            return res.status(400).json({
                success: false,
                message: 'to and templateName are required'
            });
        }

        const sent = await sendTemplateMessage(normalizedTo, templateName, parameters, {
            skipPhoneNormalization: true
        });

        if (!sent) {
            return res.status(502).json({
                success: false,
                message: 'WhatsApp template send failed. Check token, phone number id, template name and Meta logs.'
            });
        }

        return res.json({
            success: true,
            message: 'WhatsApp template sent successfully',
            to: normalizedTo,
            templateName,
            parameters
        });
    } catch (error) {
        console.error('WhatsApp test-template error:', error.message);
        return res.status(500).json({
            success: false,
            message: 'WhatsApp template send failed',
            error: error.message
        });
    }
});

module.exports = router;
