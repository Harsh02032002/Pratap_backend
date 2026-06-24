const express = require('express');
const { formLimiter } = require('../middleware/security');
const {
    normalizePhoneNumber,
    sendTemplateMessage
} = require('../utils/whatsappBot');
const Tenant = require('../models/Tenant');

const router = express.Router();

// POST /api/whatsapp/broadcast
// Body: { ownerLoginId, ownerName, message, recipientGroup }
// recipientGroup: "all" | "pending-dues" | "upcoming-moveins"
router.post('/broadcast', formLimiter, async (req, res) => {
    try {
        const { ownerLoginId, ownerName, message, recipientGroup = 'all' } = req.body || {};

        if (!ownerLoginId || !message || !ownerName) {
            return res.status(400).json({ success: false, message: 'ownerLoginId, ownerName, and message are required' });
        }

        const normalizedOwnerId = String(ownerLoginId).toUpperCase();

        // Build tenant filter based on group
        let filter = { ownerLoginId: normalizedOwnerId, status: 'active' };
        if (recipientGroup === 'pending-dues') {
            filter.dueBalance = { $gt: 0 };
        } else if (recipientGroup === 'upcoming-moveins') {
            const now = new Date();
            const upcoming = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            filter.moveInDate = { $gte: now.toISOString().split('T')[0], $lte: upcoming.toISOString().split('T')[0] };
            delete filter.status;
        }

        const tenants = await Tenant.find(filter).select('name phone').lean();

        if (tenants.length === 0) {
            return res.json({ success: true, sent: 0, failed: 0, total: 0, results: [] });
        }

        const TEMPLATE = 'roomhy_tenant_broadcast';
        const results = [];

        for (const tenant of tenants) {
            const phone = normalizePhoneNumber(tenant.phone, '91');
            if (!phone) {
                results.push({ name: tenant.name, phone: tenant.phone || '—', status: 'skipped', reason: 'Invalid phone' });
                continue;
            }
            try {
                const sent = await sendTemplateMessage(
                    phone,
                    TEMPLATE,
                    [tenant.name, message, ownerName],
                    { skipPhoneNormalization: true, languageCode: 'en' }
                );
                results.push({ name: tenant.name, phone, status: sent ? 'sent' : 'failed' });
            } catch (err) {
                results.push({ name: tenant.name, phone, status: 'failed', reason: err.message });
            }
        }

        const sent = results.filter(r => r.status === 'sent').length;
        const failed = results.filter(r => r.status === 'failed').length;
        const skipped = results.filter(r => r.status === 'skipped').length;

        return res.json({ success: true, sent, failed, skipped, total: tenants.length, results });
    } catch (err) {
        console.error('Broadcast error:', err.message);
        return res.status(500).json({ success: false, message: 'Broadcast failed', error: err.message });
    }
});

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
