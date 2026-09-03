#!/usr/bin/env node
'use strict';

/**
 * checkModeration.js — is the AI chat screener actually alive?
 *
 * WHY THIS EXISTS
 * ───────────────
 * services/aiModerationService.js fails OPEN: when the provider errors, the
 * message is allowed through unscreened. That is the right trade-off — a
 * provider outage must not stop owners and tenants talking — but it means a
 * broken configuration produces no visible symptom at all.
 *
 * It bit us exactly that way: Groq decommissioned 'llama-3.3-70b-versatile',
 * every call started returning 404, and chat ran on regex screening alone with
 * nothing reporting it. Contextual Hinglish attempts went straight through.
 *
 * Run this after any provider/model/key change, and periodically:
 *
 *     npm run check:moderation
 *
 * Exit code 0 = the screener works. Non-zero = it is degraded, and the message
 * says why. Safe to wire into a cron or a deploy step.
 */

require('dotenv').config();

const axios = require('axios');
const aiModerationService = require('../services/aiModerationService');

// Two messages that must be judged correctly. Deliberately small: this is a
// liveness check, not an eval — it answers "is the screener reachable and
// behaving sanely", quickly and for almost no cost.
const PROBES = [
  { text: 'cash me de dena, online mat karo', expect: true,  label: 'commission bypass (Hinglish)' },
  { text: 'rent kitna hai aur room available hai kya', expect: false, label: 'ordinary enquiry' }
];

async function listModels() {
  const provider = (process.env.AI_MODERATION_PROVIDER || 'groq').toLowerCase().trim();
  const key = process.env.AI_MODERATION_API_KEY
    || (provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GROQ_API_KEY);
  if (!key) return null;

  const base = (process.env.AI_MODERATION_BASE_URL
    || (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1')
  ).replace(/\/+$/, '');

  try {
    const res = await axios.get(`${base}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      timeout: 15000
    });
    return (res.data?.data || []).map((m) => m.id).sort();
  } catch (_) {
    return null;
  }
}

(async () => {
  const provider = process.env.AI_MODERATION_PROVIDER || 'groq (default)';
  const model = process.env.AI_MODERATION_MODEL || '(service default)';
  console.log(`AI moderation check — provider: ${provider}, model: ${model}\n`);

  let failures = 0;
  let unreachable = false;

  for (const probe of PROBES) {
    const result = await aiModerationService.moderateMessage(
      probe.text, 'property_owner', 'website_user', '', probe.text
    );

    if (result.failed) {
      unreachable = true;
      console.log(`  UNREACHABLE  ${probe.label}`);
      console.log(`               ${result.reason}`);
      failures += 1;
      continue;
    }

    const ok = result.violation === probe.expect;
    if (!ok) failures += 1;
    console.log(
      `  ${ok ? 'ok        ' : 'WRONG     '}  ${probe.label} ` +
      `-> violation=${result.violation}${result.type && result.type !== 'none' ? ` (${result.type})` : ''}`
    );
  }

  if (unreachable) {
    console.log('\n🚨 The AI screener is NOT running. Chat is protected by regex rules only.');
    const models = await listModels();
    if (models) {
      console.log('\nModels this API key can currently reach:');
      models.forEach((m) => console.log(`  ${m}`));
      console.log('\nSet AI_MODERATION_MODEL in .env to one of these and restart the server.');
    } else {
      console.log('\nCould not list models — check AI_MODERATION_API_KEY / GROQ_API_KEY and network access.');
    }
    process.exit(2);
  }

  if (failures > 0) {
    console.log(`\n⚠️  The screener is reachable but got ${failures} probe(s) wrong. Review the model choice.`);
    process.exit(1);
  }

  console.log('\n✅ AI moderation is live and judging correctly.');
  process.exit(0);
})().catch((err) => {
  console.error('check:moderation failed to run:', err.message);
  process.exit(2);
});
