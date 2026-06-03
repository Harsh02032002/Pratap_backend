const User = require('../models/user');
const Owner = require('../models/Owner');
const Tenant = require('../models/Tenant');

const sessions = new Map();

function getConfig() {
    return {
        accessToken: process.env.WHATSAPP_ACCESS_TOKEN || process.env.ACCESS_TOKEN || '',
        phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || '',
        apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
        defaultCountryCode: process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '91',
        templateLanguageCode: process.env.WHATSAPP_TEMPLATE_LANGUAGE_CODE || 'en'
    };
}

function normalizeWhatsAppText(value, maxLength = 3900) {
    return String(value || '')
        .replace(/\r/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function toTemplateParameters(values = []) {
    return values
        .map((value) => (value == null ? '' : String(value).trim()))
        .filter((value) => value.length > 0)
        .map((text) => ({
            type: 'text',
            text: text.slice(0, 1024)
        }));
}

// For templates that use named variables like {{tenant_name}} instead of {{1}}
// namedParams: { tenant_name: 'Pratap', kyc_url: 'https://...' }
function toNamedTemplateParameters(namedParams = {}) {
    return Object.entries(namedParams)
        .filter(([, value]) => value != null && String(value).trim().length > 0)
        .map(([name, value]) => ({
            type: 'text',
            parameter_name: name,
            text: String(value).trim().slice(0, 1024)
        }));
}

function getSession(phone) {
    const key = String(phone || '').trim();
    if (!key) return { step: 'root' };
    const existing = sessions.get(key) || {};
    return {
        step: 'root',
        selectedCityId: '',
        selectedCityName: '',
        selectedAreaId: '',
        selectedAreaName: '',
        cities: [],
        areas: [],
        ...existing
    };
}

function setSession(phone, nextState) {
    const key = String(phone || '').trim();
    if (!key) return;
    sessions.set(key, {
        ...getSession(key),
        ...nextState
    });
}

function clearSession(phone) {
    const key = String(phone || '').trim();
    if (!key) return;
    sessions.delete(key);
}

function normalizePhoneNumber(rawPhone, defaultCountryCode = '91') {
    if (!rawPhone) return '';
    const cleaned = String(rawPhone).trim().replace(/[^0-9+]/g, '');
    const digitsOnly = cleaned.replace(/\D/g, '');
    if (!digitsOnly) return '';

    if (digitsOnly.length === 10) {
        return `${defaultCountryCode}${digitsOnly}`;
    }

    if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
        return `${defaultCountryCode}${digitsOnly.slice(1)}`;
    }

    if (digitsOnly.length >= 11 && digitsOnly.length <= 15) {
        return digitsOnly;
    }

    return '';
}

async function resolvePhoneByEmailOrUserId({ phone, email, userId }) {
    const cfg = getConfig();
    const directPhone = normalizePhoneNumber(phone, cfg.defaultCountryCode);
    if (directPhone) return directPhone;

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedUserId = String(userId || '').trim();

    try {
        if (normalizedEmail) {
            const userDoc = await User.findOne({ email: normalizedEmail }).select('phone').lean();
            const userPhone = normalizePhoneNumber(userDoc?.phone, cfg.defaultCountryCode);
            if (userPhone) return userPhone;
        }
    } catch (_) {}

    try {
        if (normalizedEmail) {
            const ownerDoc = await Owner.findOne({
                $or: [{ email: normalizedEmail }, { 'profile.email': normalizedEmail }]
            }).select('phone profile.phone').lean();
            const ownerPhone = normalizePhoneNumber(ownerDoc?.phone || ownerDoc?.profile?.phone, cfg.defaultCountryCode);
            if (ownerPhone) return ownerPhone;
        }
    } catch (_) {}

    try {
        if (normalizedEmail || normalizedUserId) {
            const tenantDoc = await Tenant.findOne({
                $or: [
                    normalizedEmail ? { email: normalizedEmail } : null,
                    normalizedUserId ? { loginId: normalizedUserId.toUpperCase() } : null
                ].filter(Boolean)
            }).select('phone').lean();
            const tenantPhone = normalizePhoneNumber(tenantDoc?.phone, cfg.defaultCountryCode);
            if (tenantPhone) return tenantPhone;
        }
    } catch (_) {}

    try {
        if (normalizedUserId) {
            const userDoc = await User.findOne({
                $or: [{ loginId: normalizedUserId.toUpperCase() }, { _id: normalizedUserId }]
            }).select('phone').lean();
            const userPhone = normalizePhoneNumber(userDoc?.phone, cfg.defaultCountryCode);
            if (userPhone) return userPhone;
        }
    } catch (_) {}

    return '';
}

async function sendWhatsAppPayload(payload) {
    const cfg = getConfig();
    if (!cfg.accessToken || !cfg.phoneNumberId || !payload) {
        console.warn('[WhatsApp] Missing config — accessToken:', !!cfg.accessToken, 'phoneNumberId:', !!cfg.phoneNumberId);
        return false;
    }

    const response = await fetch(`https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${cfg.accessToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            ...payload
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.warn(`WhatsApp send failed [phoneNumberId=${cfg.phoneNumberId}]:`, response.status, errorText);
        return false;
    }

    const result = await response.json().catch(() => ({}));
    console.log(`[WhatsApp] Sent to ${payload.to} | msgId=${result?.messages?.[0]?.id || 'unknown'}`);
    return true;
}

async function sendTemplateMessage(to, templateName, variables = [], options = {}) {
    if (!to || !templateName) return false;
    const cfg = getConfig();
    const normalizedTo = options.skipPhoneNormalization
        ? String(to).trim()
        : normalizePhoneNumber(to, cfg.defaultCountryCode);
    if (!normalizedTo) return false;

    // namedParams takes priority over positional variables
    const parameters = options.namedParams
        ? toNamedTemplateParameters(options.namedParams)
        : toTemplateParameters(Array.isArray(variables) ? variables : [variables]);

    const template = {
        name: String(templateName).trim(),
        language: {
            code: options.languageCode || cfg.templateLanguageCode || 'en'
        }
    };

    const components = [];
    if (parameters.length) {
        components.push({ type: 'body', parameters });
    }

    // urlButtons: array of variable arrays, one per URL button index
    // e.g. urlButtons: [[otp]] means button index 0 gets otp as param
    if (Array.isArray(options.urlButtons)) {
        options.urlButtons.forEach((btnVars, index) => {
            const btnParams = toTemplateParameters(Array.isArray(btnVars) ? btnVars : [btnVars]);
            if (btnParams.length) {
                components.push({
                    type: 'button',
                    sub_type: 'url',
                    index: String(index),
                    parameters: btnParams
                });
            }
        });
    }

    if (components.length) {
        template.components = components;
    }

    return sendWhatsAppPayload({
        to: normalizedTo,
        type: 'template',
        template
    });
}

async function sendTextMessage(to, body) {
    if (!to || !body) return false;
    return sendWhatsAppPayload({
        to,
        type: 'text',
        text: {
            preview_url: true,
            body: normalizeWhatsAppText(body, 3900)
        }
    });
}

async function sendDocumentMessage(to, link, filename, caption = '') {
    if (!to || !link) return false;
    return sendWhatsAppPayload({
        to,
        type: 'document',
        document: {
            link: String(link).trim(),
            filename: String(filename || 'document.pdf').trim().slice(0, 240),
            caption: normalizeWhatsAppText(caption, 1024)
        }
    });
}

async function sendButtonMessage(to, body, buttons) {
    if (!to || !body || !Array.isArray(buttons) || buttons.length === 0) {
        return false;
    }

    const safeButtons = buttons.slice(0, 3).map((button) => ({
        type: 'reply',
        reply: {
            id: String(button.id || '').slice(0, 256),
            title: String(button.title || '').slice(0, 20)
        }
    }));

    return sendWhatsAppPayload({
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: {
                text: String(body).slice(0, 1024)
            },
            action: {
                buttons: safeButtons
            }
        }
    });
}

async function sendBookingConfirmationButtons({
    phone,
    email,
    userId,
    cityName,
    areaName,
    propertyName,
    tenantName
}) {
    const resolvedPhone = await resolvePhoneByEmailOrUserId({ phone, email, userId });
    if (!resolvedPhone) return false;

    setSession(resolvedPhone, {
        step: 'post_auth',
        selectedCityName: cityName || '',
        selectedAreaName: areaName || ''
    });
    return sendTemplateMessage(
        resolvedPhone,
        'roomhy_booking_confirmation',
        [
            tenantName || 'Guest',
            propertyName || 'your property'
        ],
        { skipPhoneNormalization: true }
    );
}

async function sendTemplateToResolvedUser({
    phone,
    email,
    userId,
    templateName,
    variables = [],
    options = {}
}) {
    const resolvedPhone = await resolvePhoneByEmailOrUserId({ phone, email, userId });
    if (!resolvedPhone) return false;
    return sendTemplateMessage(resolvedPhone, templateName, variables, {
        skipPhoneNormalization: true,
        ...options
    });
}

async function sendDocumentToResolvedUser({
    phone,
    email,
    userId,
    link,
    filename,
    caption = ''
}) {
    const resolvedPhone = await resolvePhoneByEmailOrUserId({ phone, email, userId });
    if (!resolvedPhone) return false;
    return sendDocumentMessage(resolvedPhone, link, filename, caption);
}

module.exports = {
    clearSession,
    sendDocumentMessage,
    sendDocumentToResolvedUser,
    getSession,
    normalizePhoneNumber,
    resolvePhoneByEmailOrUserId,
    sendBookingConfirmationButtons,
    sendButtonMessage,
    sendTemplateMessage,
    sendTemplateToResolvedUser,
    sendTextMessage,
    normalizeWhatsAppText,
    setSession,
    toNamedTemplateParameters
};
