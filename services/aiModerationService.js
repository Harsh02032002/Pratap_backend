const axios = require('axios');

const fallbackModels = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'llama-3.2-3b-preview',
    'llama-3.2-1b-preview',
    'llama-3.2-11b-vision-preview',
    'llama3-70b-8192',
    'llama3-8b-8192',
    'mixtral-8x7b-32768',
    'gemma2-9b-it',
    'qwen-2.5-coder-32b'
];

let discoveredModels = [];

async function discoverAvailableModels() {
    try {
        const provider = (process.env.AI_MODERATION_PROVIDER || 'groq').toLowerCase().trim();
        const apiKey = process.env.AI_MODERATION_API_KEY || (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GROQ_API_KEY);
        if (!apiKey) return;

        let baseURL = (process.env.AI_MODERATION_BASE_URL || (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1')).replace(/\/+$/, '');

        const res = await axios.get(`${baseURL}/models`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: 6000
        });

        if (res.data?.data && Array.isArray(res.data.data)) {
            const allModels = res.data.data.map(m => m.id);
            // Filter out whisper/audio-only models
            const textModels = allModels.filter(id => !id.includes('whisper') && !id.includes('distill') && !id.includes('audio'));
            if (textModels.length > 0) {
                discoveredModels = textModels;
                console.log(`🤖 [AI MODERATION] Groq API Key verified! Discovered ${textModels.length} active models: ${textModels.join(', ')}`);
            }
        }
    } catch (err) {
        console.warn(`⚠️ [AI MODERATION Discovery] Failed to fetch models list: ${err.response?.data?.error?.message || err.message}`);
    }
}

// Auto-run model discovery on initialization
discoverAvailableModels();

/**
 * Provider-agnostic AI Moderation Service.
 * Resolves configuration from environment variables to moderate chat messages.
 * Supports Groq, OpenAI, or any OpenAI-compatible API.
 * 
 * Configured via:
 * - AI_MODERATION_PROVIDER: 'groq' or 'openai' (default: 'groq')
 * - AI_MODERATION_API_KEY: API key for completions (fallback to GROQ_API_KEY / OPENAI_API_KEY)
 * - AI_MODERATION_BASE_URL: Base URL endpoint (fallback to groq/openai official endpoints)
 * - AI_MODERATION_MODEL: Model to request (fallback to llama-3.1-8b-instant / gpt-4o-mini)
 * 
 * @param {string} text - Message text.
 * @param {string} senderRole - Sender's role ('property_owner', 'tenant', 'website_user', etc.)
 * @param {string} receiverRole - Receiver's role.
 * @param {string} [contextHistory] - Formatted recent conversation history for context.
 * @param {string} [combinedSenderText] - Aggregated recent messages from sender.
 * @returns {Promise<object>} Returns { violation: boolean, type: string, confidence: number, reason: string }
 */
async function moderateMessage(text, senderRole, receiverRole, contextHistory, combinedSenderText) {
    const textLower = String(text || '').toLowerCase();
    if (
      textLower.includes('payu.in') ||
      textLower.includes('payu') ||
      textLower.includes('roomhy.com') ||
      textLower.includes('/website/pay') ||
      textLower.includes('bookingid=') ||
      textLower.includes('token payment')
    ) {
      console.log('ℹ️ Skipping AI moderation for official Roomhy / PayU payment message.');
      return { violation: false, type: 'none', confidence: 0, reason: 'Official Roomhy payment message' };
    }

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
            baseURL = 'https://api.groq.com/openai/v1';
        }
    }

    baseURL = baseURL.replace(/\/+$/, '');
    const completionsUrl = `${baseURL}/chat/completions`;

    // 4. Resolve Model & Candidate List
    let configuredModel = process.env.AI_MODERATION_MODEL;
    if (!configuredModel) {
        configuredModel = provider === 'openai' ? 'gpt-4o-mini' : 'llama-3.1-8b-instant';
    }

    const modelsToTry = provider === 'groq'
        ? Array.from(new Set([configuredModel, ...discoveredModels, ...fallbackModels]))
        : [configuredModel];

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
Your task is to analyze user chat messages (often written in Hinglish, Hindi, or split into multiple short consecutive messages like "paise", "naa", "de") to identify policy violations.

The platform allows property negotiations, rent discussion, price bargaining, property address sharing, and room detail sharing. These are 100% PERMITTED and NOT violations.

CRITICAL - RENT NEGOTIATION, GREETINGS & EMOJIS (NOT VIOLATIONS):
- Emojis (e.g. 👋, 😊, 👍), greetings ("Hi Mam", "Hello Sir", "Good morning"), and polite chatter are 100% PERMITTED. NEVER flag greetings, polite chatter, or emojis as violations.
- Property rent negotiations, room price quotes, and bargaining (e.g., Tenant: "rent kam karo", Owner: "18000", Tenant: "aur kam karo", Owner: "12000") are 100% PERMITTED.
- Do NOT merge separate rent quotes (like 18000 and 12000) to form a fake 10-digit phone number.
- Numbers ending in 000/00 (like 18000, 15000, 12000, 10000, 8000, 5000, 25000) or sent after rent inquiries are RENT FIGURES, NOT phone numbers or contact sharing.
- ALWAYS read the entire conversation history! If the tenant asks to lower the rent and the owner replies with numbers like 18000 or 12000, it is 100% legitimate RENT NEGOTIATION and NOT contact sharing or phone number evasion.

Violations to look for:
1. Contact Sharing: Sharing phone numbers, email addresses, personal UPI IDs, or direct payment details.
2. Commission Bypass / External Settlement Attempts: Actively trying to bypass the platform commission, proposing direct off-platform transactions, asking to pay cash, asking to pay offline, or asking not to pay on the app/platform.
3. Moving Communication Outside: Directing or requesting the other party to move chat to WhatsApp, Telegram, phone call, or email.

CRITICAL - CONTEXTUAL MULTI-MESSAGE & SPLIT-TYPING INTENT EVALUATION:
- Users often type one single intent/thought across multiple short messages sent back-to-back (e.g., Message 1: "paise", Message 2: "naa", Message 3: "de").
- You MUST evaluate the combined intent of the user's recent consecutive messages ("paise naa de") together as ONE SINGLE INTENT/ACTION.
- Do NOT treat each short word in isolation as a separate intent or separate violation attempt.

CRITICAL - HINGLISH COMPREHENSION:
Users often write in Hinglish (Hindi using Latin/English alphabet). You must translate and interpret the context.
Examples of violations in Hinglish:
- "yahan paise mat do, wahan aake de dena" or "yahan paise naa de mujhe, vahan aake de dio" -> commission_bypass.
- "cash de dena" or "in hand de dena" -> commission_bypass.
- "direct account me transfer kar do" -> commission_bypass.
- "booking cancel kar do, direct deal karte hain" -> commission_bypass.
- "whatsapp par aao" or "wa pe message karo" -> contact_sharing / external_settlement.

You must respond ONLY with a JSON object in this format:
{
  "violation": true or false,
  "type": "contact_sharing" or "commission_bypass" or "external_settlement" or "none",
  "confidence": number between 0 and 100 representing confidence score,
  "reason": "brief explanation of the decision"
}`;

    const userMessageContent = `Recent Conversation History (context for detecting split/follow-up messages):
${contextHistory || 'No previous message history.'}

Combined Recent User Statement (consecutive short messages merged):
"${combinedSenderText || sanitizedText}"

Current Message to evaluate:
Message: "${sanitizedText}"
Sender Role: ${sender}
Receiver Role: ${receiver}`;

    const timeoutMs = parseInt(process.env.AI_MODERATION_TIMEOUT_MS, 10) || 12000;
    const maxAttempts = parseInt(process.env.AI_MODERATION_MAX_RETRIES, 10) || 2;
    
    let response = null;
    let lastError = null;
    let activeModel = configuredModel;

    try {
        for (const currentCandidate of modelsToTry) {
            activeModel = currentCandidate;
            let currentModelSuccess = false;

            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    const payload = {
                        model: activeModel,
                        messages: [
                            { role: 'system', content: systemPrompt },
                            { role: 'user', content: userMessageContent }
                        ],
                        temperature: 0.1,
                        max_tokens: 300
                    };
                    if (provider === 'openai') {
                        payload.response_format = { type: 'json_object' };
                    }
                    response = await axios.post(
                        completionsUrl,
                        payload,
                        {
                            headers: {
                                'Authorization': `Bearer ${apiKey}`,
                                'Content-Type': 'application/json'
                            },
                            timeout: timeoutMs
                        }
                    );
                    currentModelSuccess = true;
                    break;
                } catch (attemptErr) {
                    lastError = attemptErr;
                    const status = attemptErr.response?.status;
                    const errorMsg = attemptErr.response?.data?.error?.message || attemptErr.message;

                    if (status === 400 || status === 404) {
                        console.warn(`⚠️ Model "${activeModel}" returned HTTP ${status} on ${provider} (${errorMsg}). Trying next fallback model...`);
                        break;
                    }
                    if (attempt < maxAttempts) {
                        console.warn(`⚠️ AI moderation attempt ${attempt} for model "${activeModel}" failed (${errorMsg}); retrying...`);
                    }
                }
            }

            if (currentModelSuccess && response) {
                break;
            }
        }

        if (!response) {
            throw lastError || new Error(`All candidate models failed for provider ${provider}`);
        }

        const choice = response.data?.choices?.[0]?.message?.content;
        console.log(`--- AI MODERATION RESPONSE (${activeModel}) --- \n${choice}\n----------------`);
        if (!choice) {
            throw new Error(`Empty response content from ${provider} API using model ${activeModel}`);
        }

        let jsonString = String(choice || '').trim();
        jsonString = jsonString.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const moderationResult = JSON.parse(jsonString);

        health.consecutiveFailures = 0;
        health.lastSuccessAt = new Date();
        health.model = activeModel;

        return {
            violation: !!moderationResult.violation,
            type: moderationResult.type || 'none',
            confidence: Number(moderationResult.confidence || 0),
            reason: moderationResult.reason || ''
        };
    } catch (err) {
        const status = err.response?.status;
        health.consecutiveFailures += 1;
        health.lastFailureAt = new Date();
        health.lastFailureReason = `${status || 'network'}: ${err.message}`;
        health.model = activeModel;

        if (status === 404 || status === 400) {
            console.error(
                `🚨 AI MODERATION — provider ${provider} rejected model "${activeModel}" (HTTP ${status}). ` +
                `Chat is running on regex screening fallback.`
            );
        } else if (status === 401 || status === 403) {
            console.error(
                `🚨 AI MODERATION — provider ${provider} rejected API key (HTTP ${status}). ` +
                `Chat is running on regex screening fallback.`
            );
        } else {
            console.error(`❌ AI Chat Moderation API error (${provider}) for model "${activeModel}":`, err.message);
        }

        return {
            violation: false,
            type: 'none',
            confidence: 0,
            failed: true,
            reason: `API call failed: ${err.message}`
        };
    }
}

// ── Health ───────────────────────────────────────────────────────────────────
// Fail-open is the right call for a background screener — a provider outage
// must not stop tenants and owners talking. The danger is that it is SILENT:
// this layer was dead for as long as the model had been decommissioned and
// nothing anywhere said so. This makes the state readable.
const health = {
    consecutiveFailures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    model: null
};

const FAILURE_ALERT_THRESHOLD = 3;

/**
 * Current state of the AI screening layer, for a health endpoint or a boot check.
 * `degraded` means messages are passing on regex screening alone.
 */
function getModerationHealth() {
    return {
        ...health,
        degraded: health.consecutiveFailures >= FAILURE_ALERT_THRESHOLD ||
            (health.consecutiveFailures > 0 && !health.lastSuccessAt)
    };
}

module.exports = {
    moderateMessage,
    getModerationHealth
};
