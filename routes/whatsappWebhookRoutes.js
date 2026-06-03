const express = require('express');
const City = require('../models/City');
const Area = require('../models/Area');
const ApprovedProperty = require('../models/ApprovedProperty');
const Tenant = require('../models/Tenant');
const {
    clearSession,
    getSession,
    sendButtonMessage,
    sendTemplateMessage,
    sendTextMessage,
    setSession
} = require('../utils/whatsappBot');

const router = express.Router();

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'my_verify_token';
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || process.env.ACCESS_TOKEN || '';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID || '';
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const BOT_ENABLED = String(process.env.WHATSAPP_BOT_ENABLED || 'true').toLowerCase() !== 'false';
const WEBSITE_URL = (process.env.WEBSITE_URL || 'https://roomhy.com').replace(/\/+$/, '');
const APP_URL = (process.env.APP_URL || 'https://app.roomhy.com').replace(/\/+$/, '');
const DIGITAL_CHECKIN_URL = (process.env.DIGITAL_CHECKIN_URL || process.env.WEBSITE_URL || 'https://roomhy.com').replace(/\/+$/, '');
const BOT_BRAND_NAME = process.env.WHATSAPP_BOT_BRAND_NAME || 'RoomHy';
const BOT_SUPPORT_PHONE = process.env.WHATSAPP_BOT_SUPPORT_PHONE || '+91 00000 00000';
const BOT_SUPPORT_EMAIL = process.env.WHATSAPP_BOT_SUPPORT_EMAIL || 'support@roomhy.com';

function normalizeText(value) {
    return String(value || '').trim().toLowerCase();
}

function titleCase(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function slugify(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function compactText(lines) {
    return lines.filter(Boolean).join('\n');
}

function getWebsiteLink(path) {
    return `${WEBSITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function getAppLink(path) {
    return `${APP_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

function normalizeApprovedProperty(doc) {
    const info = doc?.propertyInfo || {};
    return {
        id: String(doc?.visitId || doc?._id || ''),
        name: info.name || 'Property',
        city: String(info.city || '').trim(),
        area: String(info.area || '').trim(),
        rent: info.rent || 0
    };
}

async function sendMainMenu(to) {
    return sendButtonMessage(
        to,
        compactText([
            `Welcome to ${BOT_BRAND_NAME} WhatsApp Bot.`,
            'Choose one option below.'
        ]),
        [
            { id: 'auth_signup', title: 'Signup' },
            { id: 'auth_login', title: 'Login' },
            { id: 'support_menu', title: 'Support' }
        ]
    );
}

async function sendPostAuthMenu(to) {
    return sendButtonMessage(
        to,
        compactText([
            `${BOT_BRAND_NAME} options`,
            'Choose your next step.'
        ]),
        [
            { id: 'go_bidding', title: 'Bidding' },
            { id: 'go_property', title: 'View Property' },
            { id: 'go_listing', title: 'List Property' }
        ]
    );
}

async function sendSupportMenu(to) {
    return sendButtonMessage(
        to,
        compactText([
            `${BOT_BRAND_NAME} support`,
            'Select owner or tenant support.'
        ]),
        [
            { id: 'support_owner', title: 'Owner Help' },
            { id: 'support_tenant', title: 'Tenant Help' },
            { id: 'main_menu', title: 'Main Menu' }
        ]
    );
}

async function fetchActiveCities() {
    const docs = await City.find({ status: 'Active' }).sort({ name: 1 }).select('name state').lean();
    return docs.map((city) => ({
        id: String(city._id),
        name: city.name,
        state: city.state || ''
    }));
}

async function fetchAreasForCity(cityId, cityName) {
    const query = cityId
        ? { city: cityId, status: 'Active' }
        : { cityName: new RegExp(`^${String(cityName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), status: 'Active' };
    const docs = await Area.find(query).sort({ name: 1 }).select('name cityName').lean();
    return docs.map((area) => ({
        id: String(area._id),
        name: area.name,
        cityName: area.cityName || cityName || ''
    }));
}

async function fetchPropertiesForArea(cityName, areaName) {
    const docs = await ApprovedProperty.find({
        status: { $in: ['approved', 'live'] },
        'propertyInfo.city': new RegExp(`^${String(cityName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        'propertyInfo.area': new RegExp(String(areaName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    })
        .sort({ approvedAt: -1 })
        .limit(5)
        .lean();

    return docs.map(normalizeApprovedProperty);
}

async function askCitySelection(to, phone) {
    const cities = await fetchActiveCities();
    if (!cities.length) {
        await sendTextMessage(to, 'No active cities are available right now. Please try again later.');
        return;
    }

    setSession(phone, {
        step: 'awaiting_city',
        cities,
        selectedCityId: '',
        selectedCityName: '',
        selectedAreaId: '',
        selectedAreaName: '',
        areas: []
    });

    const body = compactText([
        'Select a city by replying with the number or city name.',
        '',
        ...cities.map((city, index) => `${index + 1}. ${city.name}${city.state ? `, ${city.state}` : ''}`)
    ]);
    await sendTextMessage(to, body);
}

async function askAreaSelection(to, phone, cityId, cityName) {
    const areas = await fetchAreasForCity(cityId, cityName);
    if (!areas.length) {
        await sendTextMessage(
            to,
            compactText([
                `No active areas found for ${cityName}.`,
                `Browse properties here: ${getWebsiteLink(`/website/ourproperty?city=${encodeURIComponent(slugify(cityName) || cityName)}`)}`
            ])
        );
        return;
    }

    setSession(phone, {
        step: 'awaiting_area',
        selectedCityId: cityId,
        selectedCityName: cityName,
        areas
    });

    const body = compactText([
        `Selected city: ${cityName}`,
        'Now reply with the area number or name.',
        '',
        ...areas.map((area, index) => `${index + 1}. ${area.name}`)
    ]);
    await sendTextMessage(to, body);
}

async function sendPropertyResults(to, phone, cityName, areaName) {
    const properties = await fetchPropertiesForArea(cityName, areaName);
    const browseLink = getWebsiteLink(`/website/ourproperty?city=${encodeURIComponent(slugify(cityName) || cityName)}`);

    setSession(phone, {
        step: 'post_auth',
        selectedCityName: cityName,
        selectedAreaName: areaName
    });

    if (!properties.length) {
        await sendTextMessage(
            to,
            compactText([
                `No properties found right now in ${areaName}, ${cityName}.`,
                `Browse city listings: ${browseLink}`,
                `Or type "bidding" to go to fast bidding.`
            ])
        );
        return;
    }

    const propertyLinks = properties
        .map((property, index) =>
            `${index + 1}. ${property.name} - INR ${property.rent || 0}\n${getWebsiteLink(`/website/property?id=${encodeURIComponent(property.id)}`)}`
        )
        .join('\n\n');

    const sent = await sendTemplateMessage(
        to,
        'roomhy_property_results',
        ['Guest', cityName, areaName, `${propertyLinks}\n\nMore: ${browseLink}`.slice(0, 1024)],
        { skipPhoneNormalization: true }
    );

    if (!sent) {
        const lines = [
            `Properties in ${areaName}, ${cityName}:`,
            ''
        ];

        properties.forEach((property, index) => {
            lines.push(`${index + 1}. ${property.name}`);
            lines.push(`Rent: INR ${property.rent || 0}`);
            lines.push(getWebsiteLink(`/website/property?id=${encodeURIComponent(property.id)}`));
            lines.push('');
        });

        lines.push(`More in this city: ${browseLink}`);
        await sendTextMessage(to, compactText(lines));
    }
}

async function sendSignupLink(to, phone) {
    setSession(phone, { step: 'awaiting_auth_completion' });
    const sent = await sendTemplateMessage(
        to,
        'roomhy_signup_link',
        ['Guest', getWebsiteLink('/website/signup?mode=signup')],
        { skipPhoneNormalization: true }
    );
    if (!sent) {
        await sendTextMessage(
            to,
            compactText([
                'Signup here:',
                getWebsiteLink('/website/signup?mode=signup'),
                '',
                'After signup is complete, reply with "done" or "menu".'
            ])
        );
    }
}

async function sendLoginLink(to, phone) {
    setSession(phone, { step: 'awaiting_auth_completion' });
    const sent = await sendTemplateMessage(
        to,
        'roomhy_login_link',
        ['Guest', getWebsiteLink('/website/signup?mode=login')],
        { skipPhoneNormalization: true }
    );
    if (!sent) {
        await sendTextMessage(
            to,
            compactText([
                'Login here:',
                getWebsiteLink('/website/signup?mode=login'),
                '',
                'After login is complete, reply with "done" or "menu".'
            ])
        );
    }
}

async function sendBiddingLink(to) {
    const sent = await sendTemplateMessage(
        to,
        'roomhy_fast_bidding_link',
        ['Guest', getWebsiteLink('/website/fast-bidding')],
        { skipPhoneNormalization: true }
    );
    if (!sent) {
        await sendTextMessage(
            to,
            compactText([
                'Fast bidding link:',
                getWebsiteLink('/website/fast-bidding')
            ])
        );
    }
}

async function sendListingLink(to) {
    const sent = await sendTemplateMessage(
        to,
        'roomhy_listing_link',
        ['Guest', getWebsiteLink('/website/list')],
        { skipPhoneNormalization: true }
    );
    if (!sent) {
        await sendTextMessage(
            to,
            compactText([
                'List your property here:',
                getWebsiteLink('/website/list')
            ])
        );
    }
}

async function sendOwnerSupport(to) {
    const sent = await sendTemplateMessage(
        to,
        'roomhy_owner_support',
        ['Owner', getAppLink('/propertyowner/ownerlogin'), BOT_SUPPORT_PHONE, BOT_SUPPORT_EMAIL],
        { skipPhoneNormalization: true }
    );
    if (!sent) {
        await sendTextMessage(
            to,
            compactText([
                'Owner support',
                `Owner panel login: ${getAppLink('/propertyowner/ownerlogin')}`,
                `Phone: ${BOT_SUPPORT_PHONE}`,
                `Email: ${BOT_SUPPORT_EMAIL}`
            ])
        );
    }
}

async function sendTenantSupport(to) {
    const sent = await sendTemplateMessage(
        to,
        'roomhy_tenant_support',
        ['Tenant', getWebsiteLink('/website/signup?mode=login'), getWebsiteLink('/website/mystays'), BOT_SUPPORT_PHONE, BOT_SUPPORT_EMAIL],
        { skipPhoneNormalization: true }
    );
    if (!sent) {
        await sendTextMessage(
            to,
            compactText([
                'Tenant support',
                `Website login/signup: ${getWebsiteLink('/website/signup?mode=login')}`,
                `My stays: ${getWebsiteLink('/website/mystays')}`,
                `Phone: ${BOT_SUPPORT_PHONE}`,
                `Email: ${BOT_SUPPORT_EMAIL}`
            ])
        );
    }
}

async function sendBookingConfirmationMenu(to, phone) {
    const session = getSession(phone);
    await sendButtonMessage(
        to,
        compactText([
            'Booking confirmed.',
            'Choose refund or alternative property.'
        ]),
        [
            { id: 'booking_refund', title: 'Refund' },
            { id: 'booking_alternative', title: 'Alternative' },
            { id: 'post_auth_menu', title: 'Main Menu' }
        ]
    );

    if (session.selectedCityName && session.selectedAreaName) {
        await sendTextMessage(
            to,
            compactText([
                `Saved preference: ${session.selectedAreaName}, ${session.selectedCityName}`,
                'You can reply "alternative" any time to get matching property links in that area.'
            ])
        );
    }
}

async function findTenantByPhone(phone) {
    try {
        const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
        return await Tenant.findOne({
            $or: [
                { phone: last10 },
                { phone: `91${last10}` },
                { phone: phone }
            ]
        }).select('loginId name kycStatus agreementSigned status').lean();
    } catch (_) {
        return null;
    }
}

async function sendDigitalCheckinLink(to, phone) {
    const tenant = await findTenantByPhone(phone);
    if (tenant?.loginId) {
        const checkinUrl = `${DIGITAL_CHECKIN_URL}/digital-checkin/tenantkyc?loginId=${encodeURIComponent(tenant.loginId)}`;
        const sent = await sendTemplateMessage(
            to,
            'roomhy_digital_checkin_link',
            [tenant.name || 'Tenant', checkinUrl],
            { skipPhoneNormalization: true }
        );
        if (!sent) {
            await sendTextMessage(
                to,
                compactText([
                    `Hi ${tenant.name || 'Tenant'}, start your Digital Check-in here:`,
                    checkinUrl,
                    '',
                    `Login ID: ${tenant.loginId}`
                ])
            );
        }
        return;
    }
    await sendTextMessage(
        to,
        compactText([
            `Start your Digital Check-in at:`,
            `${DIGITAL_CHECKIN_URL}/digital-checkin/tenantkyc`,
            '',
            'You will need the Login ID sent in your booking confirmation email.'
        ])
    );
}

async function sendKycLink(to, phone) {
    const tenant = await findTenantByPhone(phone);
    if (tenant?.loginId) {
        if (tenant.kycStatus === 'verified') {
            await sendTextMessage(
                to,
                `Hi ${tenant.name || 'Tenant'}, your KYC is already verified ✅. Reply *agreement* to sign your rental agreement.`
            );
            return;
        }
        const kycUrl = `${DIGITAL_CHECKIN_URL}/digital-checkin/tenantkyc?loginId=${encodeURIComponent(tenant.loginId)}`;
        const sent = await sendTemplateMessage(
            to,
            'roomhy_kyc_link',
            [tenant.name || 'Tenant', kycUrl],
            { skipPhoneNormalization: true }
        );
        if (!sent) {
            await sendTextMessage(
                to,
                compactText([
                    `Hi ${tenant.name || 'Tenant'}, complete your Aadhaar KYC here:`,
                    kycUrl
                ])
            );
        }
        return;
    }
    await sendTextMessage(
        to,
        compactText([
            'Complete your KYC verification at:',
            `${DIGITAL_CHECKIN_URL}/digital-checkin/tenantkyc`,
            '',
            'Enter your Login ID to proceed.'
        ])
    );
}

async function sendAgreementLink(to, phone) {
    const tenant = await findTenantByPhone(phone);
    if (tenant?.loginId) {
        if (tenant.agreementSigned) {
            await sendTextMessage(
                to,
                `Hi ${tenant.name || 'Tenant'}, your agreement is already signed ✅. Welcome to ${BOT_BRAND_NAME}!`
            );
            return;
        }
        if (tenant.kycStatus !== 'verified') {
            await sendTextMessage(
                to,
                `Hi ${tenant.name || 'Tenant'}, please complete your KYC first. Reply *kyc* to get the verification link.`
            );
            return;
        }
        const agreementUrl = `${DIGITAL_CHECKIN_URL}/digital-checkin/tenantagreement?loginId=${encodeURIComponent(tenant.loginId)}`;
        const sent = await sendTemplateMessage(
            to,
            'roomhy_agreement_link',
            [tenant.name || 'Tenant', agreementUrl],
            { skipPhoneNormalization: true }
        );
        if (!sent) {
            await sendTextMessage(
                to,
                compactText([
                    `Hi ${tenant.name || 'Tenant'}, sign your rental agreement here:`,
                    agreementUrl
                ])
            );
        }
        return;
    }
    await sendTextMessage(
        to,
        compactText([
            'Sign your rental agreement at:',
            `${DIGITAL_CHECKIN_URL}/digital-checkin/tenantagreement`,
            '',
            'Enter your Login ID to proceed.'
        ])
    );
}

async function sendCheckinStatus(to, phone) {
    const tenant = await findTenantByPhone(phone);
    if (tenant?.loginId) {
        const kycOk = tenant.kycStatus === 'verified';
        const agrOk = Boolean(tenant.agreementSigned);
        const lines = [
            `Hi ${tenant.name || 'Tenant'}, your check-in status:`,
            `Login ID: ${tenant.loginId}`,
            `KYC: ${kycOk ? '✅ Verified' : '⏳ Pending'}`,
            `Agreement: ${agrOk ? '✅ Signed' : '⏳ Pending'}`,
            `Account: ${tenant.status || 'pending'}`
        ];
        if (!kycOk) {
            lines.push('', 'Reply *kyc* to complete Aadhaar verification.');
        } else if (!agrOk) {
            lines.push('', 'Reply *agreement* to sign your rental agreement.');
        } else {
            lines.push('', `Check-in complete. Welcome to ${BOT_BRAND_NAME}! 🎉`);
        }
        await sendTextMessage(to, compactText(lines));
        return;
    }
    await sendTextMessage(
        to,
        compactText([
            'No tenant account found for this number.',
            `Contact support: ${BOT_SUPPORT_EMAIL} | ${BOT_SUPPORT_PHONE}`
        ])
    );
}

async function sendRefundLink(to) {
    const sent = await sendTemplateMessage(
        to,
        'roomhy_refund_link',
        ['Tenant', getWebsiteLink('/website/refund-request')],
        { skipPhoneNormalization: true }
    );
    if (!sent) {
        await sendTextMessage(
            to,
            compactText([
                'Refund request link:',
                getWebsiteLink('/website/refund-request'),
                '',
                'If your booking is already visible in My Stays, you can also raise refund from there.'
            ])
        );
    }
}

async function sendAlternativePropertyFlow(to, phone) {
    const session = getSession(phone);
    if (session.selectedCityName && session.selectedAreaName) {
        await sendPropertyResults(to, phone, session.selectedCityName, session.selectedAreaName);
        return;
    }

    await sendTextMessage(
        to,
        compactText([
            'To show alternative properties, first select city and area.'
        ])
    );
    await askCitySelection(to, phone);
}

function findByIndexOrName(list, incomingText) {
    const text = normalizeText(incomingText);
    const index = Number.parseInt(text, 10);
    if (Number.isFinite(index) && index >= 1 && index <= list.length) {
        return list[index - 1];
    }

    return list.find((item) => normalizeText(item.name) === text || normalizeText(titleCase(item.name)) === text) || null;
}

async function handleIncomingMessage(senderPhone, incomingText) {
    const session = getSession(senderPhone);
    const text = normalizeText(incomingText);

    if (!text) {
        await sendMainMenu(senderPhone);
        return;
    }

    if (['clear', 'reset'].includes(text)) {
        clearSession(senderPhone);
        await sendTextMessage(senderPhone, 'Session cleared.');
        await sendMainMenu(senderPhone);
        return;
    }

    if (['hi', 'hello', 'hey', 'start'].includes(text)) {
        clearSession(senderPhone);
        const sent = await sendTemplateMessage(
            senderPhone,
            'roomhy_bot_welcome',
            ['Guest'],
            { skipPhoneNormalization: true }
        );
        if (!sent) {
            await sendMainMenu(senderPhone);
        }
        return;
    }

    if (['menu', 'main menu'].includes(text)) {
        await sendPostAuthMenu(senderPhone);
        return;
    }

    if (['signup', 'sign up'].includes(text)) {
        await sendSignupLink(senderPhone, senderPhone);
        return;
    }

    if (['login', 'log in'].includes(text)) {
        await sendLoginLink(senderPhone, senderPhone);
        return;
    }

    if (['done', 'completed', 'signup done', 'login done'].includes(text)) {
        setSession(senderPhone, { step: 'post_auth' });
        await sendPostAuthMenu(senderPhone);
        return;
    }

    if (['bidding', 'bid', 'fast bidding'].includes(text)) {
        await sendBiddingLink(senderPhone);
        return;
    }

    if (['view property', 'view properties', 'property', 'properties'].includes(text)) {
        await askCitySelection(senderPhone, senderPhone);
        return;
    }

    if (['list property', 'listing', 'listing property'].includes(text)) {
        await sendListingLink(senderPhone);
        return;
    }

    if (['support', 'help', 'contact support'].includes(text)) {
        await sendSupportMenu(senderPhone);
        return;
    }

    if (['owner support', 'owner help'].includes(text)) {
        await sendOwnerSupport(senderPhone);
        return;
    }

    if (['tenant support', 'tenant help'].includes(text)) {
        await sendTenantSupport(senderPhone);
        return;
    }

    if (['checkin', 'check in', 'digital checkin', 'digital check in', 'start checkin'].includes(text)) {
        await sendDigitalCheckinLink(senderPhone, senderPhone);
        return;
    }

    if (['kyc', 'verify kyc', 'aadhaar', 'aadhar', 'aadhaar kyc', 'aadhar kyc', 'kyc verify'].includes(text)) {
        await sendKycLink(senderPhone, senderPhone);
        return;
    }

    if (['agreement', 'sign agreement', 'rental agreement', 'sign', 'esign'].includes(text)) {
        await sendAgreementLink(senderPhone, senderPhone);
        return;
    }

    if (['status', 'my status', 'checkin status', 'kyc status', 'my kyc', 'my checkin'].includes(text)) {
        await sendCheckinStatus(senderPhone, senderPhone);
        return;
    }

    if (['booking confirmed', 'booking confirm', 'confirmed booking'].includes(text)) {
        await sendBookingConfirmationMenu(senderPhone, senderPhone);
        return;
    }

    if (text === 'refund') {
        await sendRefundLink(senderPhone);
        return;
    }

    if (['alternative', 'alternative property'].includes(text)) {
        await sendAlternativePropertyFlow(senderPhone, senderPhone);
        return;
    }

    if (session.step === 'awaiting_city') {
        const selectedCity = findByIndexOrName(session.cities || [], text);
        if (!selectedCity) {
            await sendTextMessage(senderPhone, 'Invalid city. Reply with the city number or exact city name.');
            return;
        }
        await askAreaSelection(senderPhone, senderPhone, selectedCity.id, selectedCity.name);
        return;
    }

    if (session.step === 'awaiting_area') {
        const selectedArea = findByIndexOrName(session.areas || [], text);
        if (!selectedArea) {
            await sendTextMessage(senderPhone, 'Invalid area. Reply with the area number or exact area name.');
            return;
        }
        setSession(senderPhone, {
            step: 'post_auth',
            selectedAreaId: selectedArea.id,
            selectedAreaName: selectedArea.name
        });
        await sendPropertyResults(senderPhone, senderPhone, session.selectedCityName, selectedArea.name);
        return;
    }

    const sent = await sendTemplateMessage(
        senderPhone,
        'roomhy_bot_fallback',
        ['Guest'],
        { skipPhoneNormalization: true }
    );
    if (!sent) {
        await sendTextMessage(
            senderPhone,
            compactText([
                'Reply with one of these commands:',
                'signup',
                'login',
                'bidding',
                'view property',
                'list property',
                'support',
                'booking confirmed'
            ])
        );
    }
}

async function handleButtonReply(senderPhone, buttonId) {
    switch (buttonId) {
        case 'auth_signup':
            await sendSignupLink(senderPhone, senderPhone);
            return;
        case 'auth_login':
            await sendLoginLink(senderPhone, senderPhone);
            return;
        case 'support_menu':
            await sendSupportMenu(senderPhone);
            return;
        case 'support_owner':
            await sendOwnerSupport(senderPhone);
            return;
        case 'support_tenant':
            await sendTenantSupport(senderPhone);
            return;
        case 'main_menu':
            clearSession(senderPhone);
            await sendMainMenu(senderPhone);
            return;
        case 'post_auth_menu':
            setSession(senderPhone, { step: 'post_auth' });
            await sendPostAuthMenu(senderPhone);
            return;
        case 'go_bidding':
            await sendBiddingLink(senderPhone);
            return;
        case 'go_property':
            await askCitySelection(senderPhone, senderPhone);
            return;
        case 'go_listing':
            await sendListingLink(senderPhone);
            return;
        case 'booking_refund':
            await sendRefundLink(senderPhone);
            return;
        case 'booking_alternative':
            await sendAlternativePropertyFlow(senderPhone, senderPhone);
            return;
        case 'go_checkin':
            await sendDigitalCheckinLink(senderPhone, senderPhone);
            return;
        case 'go_kyc':
            await sendKycLink(senderPhone, senderPhone);
            return;
        case 'go_agreement':
            await sendAgreementLink(senderPhone, senderPhone);
            return;
        case 'go_status':
            await sendCheckinStatus(senderPhone, senderPhone);
            return;
        default:
            await sendMainMenu(senderPhone);
    }
}

router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WhatsApp webhook verified successfully');
        return res.status(200).send(challenge);
    }

    console.warn('WhatsApp webhook verification failed');
    return res.sendStatus(403);
});

router.post('/', async (req, res) => {
    console.log('Incoming WhatsApp webhook body:');
    console.log(JSON.stringify(req.body, null, 2));

    try {
        if (!BOT_ENABLED) {
            return res.sendStatus(200);
        }

        const entry = req.body.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;
        const message = value?.messages?.[0];

        const senderPhone = message?.from || '';
        const textBody = message?.text?.body || '';
        const buttonReplyId = message?.interactive?.button_reply?.id || '';
        const buttonReplyTitle = message?.interactive?.button_reply?.title || '';

        if (senderPhone && buttonReplyId) {
            console.log('WhatsApp button reply:', buttonReplyId, buttonReplyTitle);
            await handleButtonReply(senderPhone, buttonReplyId);
        } else if (senderPhone && textBody) {
            console.log('WhatsApp sender:', senderPhone);
            console.log('WhatsApp message:', textBody);
            await handleIncomingMessage(senderPhone, textBody);
        } else {
            console.log('WhatsApp webhook received without supported text/button payload');
        }
    } catch (err) {
        console.error('WhatsApp webhook processing error:', err.message);
    }

    return res.sendStatus(200);
});

module.exports = router;
