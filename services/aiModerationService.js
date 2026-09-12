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
            // Default fallback
            baseURL = 'https://api.groq.com/openai/v1';
        }
    }

    // Ensure URL doesn't end with a slash for clean concatenation
    baseURL = baseURL.replace(/\/+$/, '');
    const completionsUrl = `${baseURL}/chat/completions`;

    // 4. Resolve Model
    //
    // Groq's default was 'llama-3.3-70b-versatile' until that model was
    // DECOMMISSIONED by the provider. Every call then returned 404, and because
    // this service fails open (see the catch at the bottom) the entire AI layer
    // went silently dead: only the local regex in moderationHelper was still
    // screening anything, so contextual Hinglish attempts — "dede paise mujhe",
    // a phone number split across two messages — passed straight through.
    //
    // Measured against those exact messages plus a clean control set:
    //   openai/gpt-oss-120b          5/5 caught, 0 false alarms  (~845ms)
    //   openai/gpt-oss-20b           5/5 caught, 0 false alarms  (~631ms)
    //   openai/gpt-oss-safeguard-20b 4/5 caught, 0 false alarms  (~475ms)
    //
    // 120b is chosen over the faster 20b because this runs in the background,
    // off the request path, so latency costs the user nothing — and the threat
    // here is deliberate evasion, where the stronger model generalises better
    // than a ten-case sample can show.
    //
    // Override with AI_MODERATION_MODEL when the provider retires this one.
    // `npm run check:moderation` reports whether the configured model still
    // answers, so the next decommission surfaces as a failed check rather than
    // as months of unscreened chat.
    let model = process.env.AI_MODERATION_MODEL;
    if (!model) {
        if (provider === 'openai') {
            model = 'gpt-4o-mini';
        } else {
            model = 'openai/gpt-oss-120b';
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
Your task is to analyze user chat messages (often written in Hinglish, Hindi, or split into multiple short consecutive messages like "paise", "naa", "de") to identify policy violations.

The platform allows property negotiations, rent discussion, price bargaining, property address sharing, and room detail sharing. These are 100% PERMITTED and NOT violations.

CRITICAL - RENT NEGOTIATION & PRICE BARGAINING RULES (NOT VIOLATIONS):
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

    // Moderation runs in the background, so a slightly longer budget costs
    // nothing and a timeout here means the message goes UNMODERATED (see the
    // fail-open catch below). 5s was tight enough to trip regularly.
    const timeoutMs = parseInt(process.env.AI_MODERATION_TIMEOUT_MS, 10) || 12000;
    const maxAttempts = parseInt(process.env.AI_MODERATION_MAX_RETRIES, 10) || 2;
    let response = null;

    const modelsToTry = process.env.AI_MODERATION_MODEL
        ? [process.env.AI_MODERATION_MODEL]
        : (provider === 'groq' ? [model, ...fallbackModels.filter(m => m !== model)] : [model]);

    let lastError = null;

    for (const currentModel of modelsToTry) {
        model = currentModel;
        try {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
                    const status = attemptErr.response?.status;
                    if (attempt === maxAttempts || (status && status < 500)) throw attemptErr;
                    console.warn(`⚠️ AI moderation attempt ${attempt} failed (${attemptErr.message}); retrying...`);
                }
            }
            if (response) break;
        } catch (modelErr) {
            lastError = modelErr;
            const status = modelErr.response?.status;
            if (status === 404 && modelsToTry.indexOf(currentModel) < modelsToTry.length - 1) {
                console.warn(`⚠️ Model "${currentModel}" returned 404 on ${provider}, trying fallback model...`);
                continue;
            }
            throw modelErr;
        }
    }

    try {
        const choice = response.data?.choices?.[0]?.message?.content;
        console.log(`--- RESPONSE --- \n${choice}\n----------------`);
        if (!choice) {
            throw new Error(`Empty response content from ${provider} API`);
        }

        const moderationResult = JSON.parse(choice);
        health.consecutiveFailures = 0;
        health.lastSuccessAt = new Date();
        health.model = model;
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
        health.model = model;

        // A 404/400 is a CONFIGURATION failure, not a blip: the model is gone or
        // the request shape is wrong, and it will fail identically forever. That
        // is exactly how this layer died unnoticed, so it is logged distinctly
        // from a transient outage and repeated on every message rather than
        // being lost in the noise once.
        if (status === 404 || status === 400) {
            console.error(
                `🚨 AI MODERATION IS DOWN — provider ${provider} rejected model "${model}" (HTTP ${status}). ` +
                `Chat is running on regex screening ONLY. Set AI_MODERATION_MODEL to a model this key can reach ` +
                `and restart. Run "npm run check:moderation" to list working models.`
            );
        } else if (status === 401 || status === 403) {
            console.error(
                `🚨 AI MODERATION IS DOWN — provider ${provider} rejected the API key (HTTP ${status}). ` +
                `Chat is running on regex screening ONLY.`
            );
        } else {
            console.error(`❌ AI Chat Moderation API error (${provider}) after ${maxAttempts} attempt(s):`, err.message);
            if (health.consecutiveFailures === FAILURE_ALERT_THRESHOLD) {
                console.error(
                    `🚨 AI MODERATION has failed ${FAILURE_ALERT_THRESHOLD} times in a row (${health.lastFailureReason}). ` +
                    `Chat is running on regex screening ONLY.`
                );
            }
        }

        // Fail-safe: Allow the message to proceed in case of API failure to avoid
        // user disruption. `failed` records that this message was NOT actually
        // screened, so an unscreened message is distinguishable from a clean one.
        return { violation: false, type: 'none', confidence: 0, failed: true, reason: `API call failed: ${err.message}` };
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
