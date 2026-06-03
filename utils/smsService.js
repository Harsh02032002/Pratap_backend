const axios = require('axios');

// SMS OTP Service - MSG91 Configuration
// Website: https://msg91.com
// Pricing: ~₹0.15-0.25 per SMS

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const MSG91_SENDER_ID = process.env.MSG91_SENDER_ID || 'ROOMHY';
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;

// Alternative: Fast2SMS Configuration
// Website: https://www.fast2sms.com
// Pricing: ~₹0.10-0.20 per SMS
const FAST2SMS_API_KEY = process.env.FAST2SMS_API_KEY;
const TWILIO_ACCOUNT_SID = (process.env.TWILIO_ACCOUNT_SID || '').trim();
const TWILIO_AUTH_TOKEN = (process.env.TWILIO_AUTH_TOKEN || '').trim();
const TWILIO_SMS_FROM = (process.env.TWILIO_SMS_FROM || '').trim();
const TWILIO_WHATSAPP_FROM = (process.env.TWILIO_WHATSAPP_FROM || '').trim();
const TWILIO_OTP_CHANNEL = (process.env.TWILIO_OTP_CHANNEL || 'sms').trim().toLowerCase();

/**
 * Send OTP via MSG91
 * @param {string} phone - 10 digit phone number
 * @param {string} otp - 6 digit OTP
 * @returns {Promise<boolean>}
 */
async function sendOTP_MSG91(phone, otp) {
    try {
        if (!MSG91_AUTH_KEY) {
            console.error('MSG91_AUTH_KEY not configured');
            return false;
        }

        // Format phone number with country code
        const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;

        const response = await axios.post('https://api.msg91.com/api/v5/otp', {
            template_id: MSG91_TEMPLATE_ID,
            sender: MSG91_SENDER_ID,
            otp: otp,
            mobiles: formattedPhone
        }, {
            headers: {
                'authkey': MSG91_AUTH_KEY,
                'Content-Type': 'application/json'
            }
        });

        console.log('MSG91 Response:', response.data);
        return response.data.type === 'success';
    } catch (error) {
        console.error('MSG91 Error:', error.response?.data || error.message);
        return false;
    }
}

/**
 * Send OTP via Fast2SMS
 * @param {string} phone - 10 digit phone number
 * @param {string} otp - 6 digit OTP
 * @returns {Promise<boolean>}
 */
async function sendOTP_Fast2SMS(phone, otp) {
    try {
        if (!FAST2SMS_API_KEY) {
            console.error('FAST2SMS_API_KEY not configured');
            return false;
        }

        const response = await axios.post('https://www.fast2sms.com/dev/bulkV2', {
            variables_values: otp,
            route: "otp",
            numbers: phone
        }, {
            headers: {
                'authorization': FAST2SMS_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        console.log('Fast2SMS Response:', response.data);
        return response.data.return === true;
    } catch (error) {
        console.error('Fast2SMS Error:', error.response?.data || error.message);
        return false;
    }
}

function isTwilioConfigured(channel = 'sms') {
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return false;
    if (channel === 'whatsapp') return Boolean(TWILIO_WHATSAPP_FROM);
    return Boolean(TWILIO_SMS_FROM);
}

async function sendOTP_Twilio(phone, otp, purpose = 'verification') {
    const channel = TWILIO_OTP_CHANNEL === 'whatsapp' ? 'whatsapp' : 'sms';
    if (!isTwilioConfigured(channel)) {
        console.error(`Twilio ${channel} not configured`);
        return false;
    }

    try {
        const to = channel === 'whatsapp' ? `whatsapp:+91${phone}` : `+91${phone}`;
        const from = channel === 'whatsapp'
            ? (TWILIO_WHATSAPP_FROM.startsWith('whatsapp:') ? TWILIO_WHATSAPP_FROM : `whatsapp:${TWILIO_WHATSAPP_FROM}`)
            : TWILIO_SMS_FROM;

        const body = `Your Roomhy ${purpose} OTP is ${otp}. It is valid for 10 minutes.`;
        const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
        const payload = new URLSearchParams({
            To: to,
            From: from,
            Body: body
        });

        const response = await axios.post(endpoint, payload.toString(), {
            auth: {
                username: TWILIO_ACCOUNT_SID,
                password: TWILIO_AUTH_TOKEN
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log(`Twilio ${channel} OTP sent:`, response.data?.sid || 'ok');
        return true;
    } catch (error) {
        console.error('Twilio OTP Error:', error.response?.data || error.message);
        return false;
    }
}

/**
 * Send OTP SMS (uses available provider)
 * @param {string} phone - Phone number
 * @param {string} otp - OTP code
 * @param {string} purpose - 'signup' | 'login' | 'reset'
 * @returns {Promise<{success: boolean, provider: string}>}
 */
async function sendOTPSMS(phone, otp, purpose = 'verification') {
    // Try Twilio first
    if (isTwilioConfigured(TWILIO_OTP_CHANNEL)) {
        const success = await sendOTP_Twilio(phone, otp, purpose);
        if (success) {
            return { success: true, provider: `Twilio-${TWILIO_OTP_CHANNEL}` };
        }
    }

    // Try MSG91 first
    if (MSG91_AUTH_KEY) {
        const success = await sendOTP_MSG91(phone, otp);
        if (success) {
            return { success: true, provider: 'MSG91' };
        }
    }

    // Fallback to Fast2SMS
    if (FAST2SMS_API_KEY) {
        const success = await sendOTP_Fast2SMS(phone, otp);
        if (success) {
            return { success: true, provider: 'Fast2SMS' };
        }
    }

    // If no SMS provider works, return false
    // The caller should fall back to email OTP
    return { success: false, provider: null };
}

/**
 * Format phone number for India
 * @param {string} phone 
 * @returns {string}
 */
function formatPhoneNumber(phone) {
    // Remove all non-digit characters
    let cleaned = phone.replace(/\D/g, '');

    // Remove leading 91 or 0 if present
    if (cleaned.startsWith('91') && cleaned.length === 12) {
        cleaned = cleaned.substring(2);
    } else if (cleaned.startsWith('0') && cleaned.length === 11) {
        cleaned = cleaned.substring(1);
    }

    return cleaned;
}

module.exports = {
    sendOTPSMS,
    sendOTP_Twilio,
    sendOTP_MSG91,
    sendOTP_Fast2SMS,
    formatPhoneNumber
};
