const axios = require('axios');

/**
 * Provider-agnostic AI Moderation Service.
 * Resolves configuration from environment variables to moderate chat messages.
 * Supports Groq, OpenAI, or any OpenAI-compatible API.
 * 
 * Configured via:
 * - AI_MODERATION_PROVIDER: 'groq' or 'openai' (default: 'groq')
 * - AI_MODERATION_API_KEY: API key for completions (fallback to GROQ_API_KEY / OPENAI_API_KEY)
 * - AI_MODERATION_BASE_URL: Base URL endpoint (fallback to groq/openai official endpoints)
 * - AI_MODERATION_MODEL: Model to request (fallback to llama-3.3-70b-versatile / gpt-4o-mini)
 * 
 * @param {string} text - Message text.
 * @param {string} senderRole - Sender's role ('property_owner', 'tenant', 'website_user', etc.)
 * @param {string} receiverRole - Receiver's role.
 * @param {string} [contextHistory] - Formatted recent conversation history for context.
 * @returns {Promise<object>} Returns { violation: boolean, type: string, confidence: number, reason: string }
 */
async function moderateMessage(text, senderRole, receiverRole, contextHistory) {
    // 1. Resolve Provider
    const provider = (process.env.AI_MODERATION_PROVIDER || 'groq').toLowerCase().trim();

    // 2. Resolve API Key
    let apiKey = process.env.AI_MODERATION_API_KEY;
    if (!apiKey) {
        if (provider === 'groq') {
            apiKey = process.env.GROQ_API_KEY;
        } else if (provider === 'openai') {
            apiKey = process.env.OPENAI_API_KEY;
        }
    }

    if (!apiKey) {
        console.warn(`⚠️ AI moderation API key not configured for provider: ${provider}. Skipping AI moderation.`);
        return { violation: false, type: 'none', confidence: 0, reason: 'AI API Key is not configured' };
    }

    // 3. Resolve Base URL & completions path
    let baseURL = process.env.AI_MODERATION_BASE_URL;
    if (!baseURL) {
        if (provider === 'groq') {
            baseURL = 'https://api.groq.com/openai/v1';
        } else if (provider === 'openai') {
            baseURL = 'https://api.openai.com/v1';
        } else {
            // Default fallback
            baseURL = 'https://api.groq.com/openai/v1';
        }
    }

    // Ensure URL doesn't end with a slash for clean concatenation
    baseURL = baseURL.replace(/\/+$/, '');
    const completionsUrl = `${baseURL}/chat/completions`;

    // 4. Resolve Model
    let model = process.env.AI_MODERATION_MODEL;
    if (!model) {
        if (provider === 'groq') {
            model = 'llama-3.3-70b-versatile';
        } else if (provider === 'openai') {
            model = 'gpt-4o-mini';
        } else {
            model = 'llama-3.3-70b-versatile';
        }
    }

    // Map roles to user-friendly titles
    const mapRole = (role) => {
        const cleanRole = String(role || '').toLowerCase().trim();
        if (cleanRole === 'property_owner' || cleanRole === 'owner') return 'Owner';
        if (cleanRole === 'tenant' || cleanRole === 'website_user') return 'Tenant';
        return 'User';
    };

    const sender = mapRole(senderRole);
    const receiver = mapRole(receiverRole);

    // Sanitize sensitive items (PAN, Aadhaar) from payload for security compliance
    let sanitizedText = text || '';
    sanitizedText = sanitizedText.replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '[REDACTED AADHAAR]');
    sanitizedText = sanitizedText.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, '[REDACTED PAN]');

    const systemPrompt = `You are an AI Chat Moderator for Roomhy, a property rental and room booking platform.
Your task is to analyze user chat messages (often written in Hinglish, Hindi, or split into multiple short messages) to identify policy violations.

The platform allows property negotiations, rent discussion, property address sharing, and room detail sharing. These are NOT violations.

Violations to look for:
1. Contact Sharing: Sharing phone numbers, email addresses, personal UPI IDs, or direct payment details.
2. Commission Bypass / External Settlement Attempts: Actively trying to bypass the platform commission, proposing direct off-platform transactions, asking to pay cash, asking to pay offline, or asking not to pay on the app/platform.
3. Moving Communication Outside: Directing or requesting the other party to move chat to WhatsApp, Telegram, phone call, or email.

CRITICAL - HINGLISH COMPREHENSION:
Users often write in Hinglish (Hindi using Latin/English alphabet). You must translate and interpret the context.
Examples of violations in Hinglish:
- "yahan paise mat do, wahan aake de dena" or "yahan paise naa de mujhe, vahan aake de dio" (meaning: don't pay here on the app, pay in person/offline) -> This is a commission_bypass.
- "cash de dena" or "in hand de dena" (meaning: pay cash directly) -> This is a commission_bypass.
- "direct account me transfer kar do" -> This is a commission_bypass.
- "booking cancel kar do, direct deal karte hain" -> This is a commission_bypass.
- "whatsapp par aao" or "wa pe message karo" -> This is a contact_sharing / moving communication outside.

Analyze the current message in the context of the recent conversation history to catch split-sentence attempts.

You must respond ONLY with a JSON object in this format:
{
  "violation": true or false,
  "type": "contact_sharing" or "commission_bypass" or "external_settlement" or "none",
  "confidence": number between 0 and 100 representing confidence score,
  "reason": "brief explanation of the decision"
}`;

    const userMessageContent = `Recent Conversation History (context for detecting split/follow-up messages):
${contextHistory || 'No previous message history.'}

Current Message to evaluate:
Message: "${sanitizedText}"
Sender Role: ${sender}
Receiver Role: ${receiver}`;

    // Moderation runs in the background, so a slightly longer budget costs
    // nothing and a timeout here means the message goes UNMODERATED (see the
    // fail-open catch below). 5s was tight enough to trip regularly.
    const timeoutMs = Number(process.env.AI_MODERATION_TIMEOUT_MS || 12000);
    const maxAttempts = 2;

    let response;

    try {
        console.log(`🤖 Invoking AI Moderation via provider: ${provider} (Model: ${model}, URL: ${completionsUrl})`);
        console.log(`--- PROMPT --- \n${userMessageContent}\n--------------`);

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                response = await axios.post(
                    completionsUrl,
                    {
                        model: model,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userMessageContent }
                        ],
                        response_format: {
                            type: 'json_object'
                        },
                        temperature: 0.1
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: timeoutMs
                    }
                );
                break;
            } catch (attemptErr) {
                // Retry once on timeout / transport failure, but not on a 4xx —
                // a bad key or model will fail identically the second time.
                const status = attemptErr.response?.status;
                if (attempt === maxAttempts || (status && status < 500)) throw attemptErr;
                console.warn(`⚠️ AI moderation attempt ${attempt} failed (${attemptErr.message}); retrying...`);
            }
        }

        const choice = response.data?.choices?.[0]?.message?.content;
        console.log(`--- RESPONSE --- \n${choice}\n----------------`);
        if (!choice) {
            throw new Error(`Empty response content from ${provider} API`);
        }

        const moderationResult = JSON.parse(choice);
        return {
            violation: !!moderationResult.violation,
            type: moderationResult.type || 'none',
            confidence: Number(moderationResult.confidence || 0),
            reason: moderationResult.reason || ''
        };
    } catch (err) {
        console.error(`❌ AI Chat Moderation API error (${provider}) after ${maxAttempts} attempt(s):`, err.message);
        // Fail-safe: Allow the message to proceed in case of API failure to avoid
        // user disruption. `failed` records that this message was NOT actually
        // screened, so an unscreened message is distinguishable from a clean one.
        return { violation: false, type: 'none', confidence: 0, failed: true, reason: `API call failed: ${err.message}` };
    }
}

module.exports = {
    moderateMessage
};
