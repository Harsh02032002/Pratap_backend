const mongoose = require('mongoose');
const Owner = require('../models/Owner');
const User = require('../models/user');
const ChatSettings = require('../models/ChatSettings');
const ChatViolation = require('../models/ChatViolation');
const { notifySuperadmin } = require('./superadminNotifier');
const aiModerationService = require('../services/aiModerationService');

// Helper to determine the role of a participant by login ID
async function getParticipantRoleAndName(loginId) {
  if (!loginId) return { role: null, name: 'Unknown' };
  const cleanId = String(loginId).trim();
  const upperId = cleanId.toUpperCase();

  // Try Owner first
  const owner = await Owner.findOne({ loginId: upperId }).lean();
  if (owner) {
    return { role: 'property_owner', name: owner.name || owner.profile?.name || cleanId };
  }

  // Try User next
  const user = await User.findOne({ loginId: cleanId }).lean();
  if (user) {
    const role = user.role === 'owner' ? 'property_owner' : 'tenant';
    const name = user.name || `${user.firstName || ''} ${user.lastName || ''}`.trim() || cleanId;
    return { role, name };
  }

  // Website user pattern roomhywebXXXXXX
  if (/^roomhyweb\d{6}$/i.test(cleanId)) {
    return { role: 'website_user', name: `Tenant (${cleanId})` };
  }

  // Fallback pattern matching for IDs not present in DB (e.g. mock test data/new users)
  if (/^ROOMHYTNT/i.test(upperId)) {
    return { role: 'tenant', name: `Tenant (${cleanId})` };
  } else if (/^ROOMHY/i.test(upperId)) {
    return { role: 'property_owner', name: `Owner (${cleanId})` };
  }

  return { role: null, name: cleanId };
}

// Check if a chat session is between an Owner and a Tenant
async function isOwnerTenantChat(senderLoginId, receiverLoginId) {
  const p1 = await getParticipantRoleAndName(senderLoginId);
  const p2 = await getParticipantRoleAndName(receiverLoginId);

  const roles = [p1.role, p2.role];
  const hasOwner = roles.includes('property_owner');
  const hasTenant = roles.includes('tenant') || roles.includes('website_user');
  
  return hasOwner && hasTenant;
}

// Check if a user is currently restricted or blocked from chatting
async function checkUserBlockStatus(loginId) {
  if (!loginId) return { blocked: false };
  const cleanId = String(loginId).trim();

  // 1. Check if explicitly suspended/blocked on User model
  const user = await User.findOne({ loginId: cleanId }).lean();

  // 2. Check Owner suspension & chatRestrictedUntil
  const upperId = cleanId.toUpperCase();
  const owner = await Owner.findOne({ loginId: upperId }).lean();

  // A previous strike has already blocked this account. This must be checked
  // before any self-healing/count logic, otherwise a blocked user could keep
  // sending messages.
  if (user?.status === 'blocked' || owner?.status === 'blocked' || owner?.isActive === false) {
    return {
      blocked: true,
      reason: 'Your account has been blocked because of repeated chat-policy violations.'
    };
  }

  // Count only the violations this account actually COMMITTED.
  //
  // participantLoginId is the offender. ownerId is the owner of the
  // CONVERSATION the violation happened in, which is a completely different
  // thing: when a tenant shares a phone number, the violation is stored with
  // participantLoginId = <tenant> and ownerId = <the owner they were talking
  // to>. Counting the ownerId clause here charged that strike to the owner,
  // so an owner reached "2 strikes" — a permanent block — from one strike of
  // their own plus one committed by somebody else in their inbox.
  //
  // That is not a hypothetical: it is what silently 403'd every
  // POST /api/chat/send for the owner whose messages "disappeared".
  const realViolationsCount = await ChatViolation.countDocuments({
    participantLoginId: { $in: [cleanId, upperId] }
  });

  if (realViolationsCount < 2) {
    // A single strike is a warning only. It must not lock the account.
    if (owner && owner.chatRestrictedUntil) {
      await Owner.updateOne({ loginId: upperId }, { $set: { isActive: true, chatRestrictedUntil: null } });
    }
    if (user && user.chatRestrictedUntil) {
      await User.updateOne({ loginId: cleanId }, { $set: { status: 'active', isActive: true, chatRestrictedUntil: null } });
    }
    return { blocked: false };
  }

  // Safety net for violations recorded by an earlier deployment: two genuine
  // attempts mean the sender is blocked even if the async moderation worker
  // was interrupted before it applied the block.
  await Promise.allSettled([
    Owner.updateOne({ loginId: upperId }, { $set: { isActive: false, status: 'blocked', blockedReason: 'Repeated commission bypass attempt' } }),
    User.updateOne({ loginId: cleanId }, { $set: { status: 'blocked', isActive: false } })
  ]);
  return {
    blocked: true,
    reason: 'Your account has been blocked because of repeated chat-policy violations.'
  };
}

/**
 * How far back the split-typing check may look when merging a sender's recent
 * messages into one string to screen.
 *
 * Deliberately short. Anything longer stops being "one thought typed across a
 * few messages" and becomes "everything this person has ever said", which made
 * a single past violation taint every future message they sent.
 */
const SPLIT_CONTEXT_WINDOW_MS = Number(process.env.CHAT_SPLIT_CONTEXT_WINDOW_MS || 5 * 60 * 1000);

// Helper to strip legitimate rent / deposit / token amounts from phone number screening
function stripRentAndAmounts(text) {
  if (!text || typeof text !== 'string') return '';
  let clean = text;

  // 1. Explicit currency / rent terms + numbers: ₹18000, Rs 18000, 18000/month, 18000/-, rent 18000, deposit 10000, 18k
  clean = clean.replace(/(?:₹|rs\.?|inr|rent|deposit|kiraya|token|price|amount)\s*:?\s*\b\d{3,5}\b/gi, '[AMOUNT_TOKEN]');
  clean = clean.replace(/\b\d{3,5}\s*(?:\/-|k|pm|\/mo|\/month|per\s*month|rent|deposit|kiraya)\b/gi, '[AMOUNT_TOKEN]');

  // 2. Standalone 4-5 digit numbers that start with 1-5 OR end in 00/000 (e.g. 18000, 15000, 12000, 10000, 8000, 5000, 25000, 30000)
  clean = clean.replace(/\b([1-5]\d{3,4}|[6-9]\d{2,3}00)\b/g, (match) => {
    if (match.endsWith('00') || match.endsWith('000') || /^[1-5]/.test(match)) {
      return '[AMOUNT_TOKEN]';
    }
    return match;
  });

  return clean;
}

// Detect violations in message content
function detectViolation(text, settings = {}) {
  if (!text) return { violation: null, maskedText: '' };

  // 0. Official RoomHy Links & Payment Messages Exemption Check
  const isOfficialRoomhyMsg = (
    text.includes('roomhy.com') ||
    text.includes('app.roomhy.com') ||
    text.includes('/website/pay') ||
    text.includes('bookingId=') ||
    text.includes('PayU') ||
    text.includes('payu') ||
    text.includes('CashFree') ||
    text.includes('Cashfree') ||
    text.startsWith('Dear ')
  );
  if (isOfficialRoomhyMsg) {
    return { violation: null, maskedText: text };
  }

  // Exemption for short conversational chatter (< 6 words) without explicit phone/email/links/digits
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  const isShortChatter = words.length <= 6;
  const shortExemptPattern = /^\s*"?\s*(de|naa|na|paise|paisa|yahan|yaan|ha|haa|haan|thik|theek|bhej|bhejo|dena|karo|kro|hi|hello|ok|okay|aata|aaya|bhai|sir|mam|rent|room|ac|non ac|single|double|sharing|mil|baat|kaise|ho|acha|achha|batao|chahiye|mileyga|milraha|kab|kitna|haan|ji|yes|no|theek|hai|hain|karta|karti|kar|kri|lega|lenge|di|dunga|deta|deti|please|thanks|thank|you|welcome|bye|goodbye|morning|evening|night|afternoon|suno|sunna|bol|bolo|sunai|sunao|acha|achhi|badhi|badi|chota|choti|kam|zyada|kam|kum|jaldi|deri|abhi|ab|kal|parso|aaj|kal|pehle|baad|mein|mere|tumhare|uski|unki|sab|kuch|koi|kuch|bhi|nahi|na|to|fir|phir|lekin|magar|ya|aur|ki|ka|ke|ko|se|pe|par|mein|tum|main|hum|aap|tu|tera|mera|tumhara|hamara|uska|unki|unke|in|is|it|us|un|ye|wo|vah|ve|yeh|woh|kya|kyun|kaise|kahan|kidhar|kab|kaun|kaunsi|kaunse|kitna|kitne|kitni|kaise|kaisi|kaisa|kaise|kaisi|kaisa|kaise|kaisi|kaisa|kaise|kaisi|kaisa|kaise|kaisi)\s*"?\s*$/i;

  const hasDigitsOrUrl = /\d{5,}|http|www|\.com|@/.test(trimmed);
  if (isShortChatter && !hasDigitsOrUrl && shortExemptPattern.test(trimmed)) {
    return { violation: null, maskedText: text };
  }

  const blockPhone = settings.blockPhoneNumbers !== false;
  const blockEmail = settings.blockEmails !== false;
  const blockLink = settings.blockLinks !== false;

  let msgText = text;
  let violationType = null;

  // 1. Email Check
  if (blockEmail) {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
    emailRegex.lastIndex = 0;
    const replaced = msgText.replace(emailRegex, '[MASKED EMAIL]');
    if (replaced !== msgText) {
      violationType = 'contact_sharing';
      msgText = replaced;
    }
  }

  // 2. Phone Number Check (Raw 10 digits, spaced out, or word-based)
  if (blockPhone) {
    const phoneRegex = /(?:^|[^\d])((?:\+?91[-.\s]?)?[6-9](?:[-.\s]?\d){9})(?!\d)/g;
    const textWithoutUrls = msgText.replace(/(https?:\/\/[^\s]+|www\.[^\s]+)/gi, '');
    const textWithoutAmounts = stripRentAndAmounts(textWithoutUrls);
    const hasTenDigits = phoneRegex.test(textWithoutAmounts);
    phoneRegex.lastIndex = 0;

    const numWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ek', 'teen', 'chaar', 'char', 'paanch', 'panch', 'chhe', 'che', 'saat', 'aath', 'nau', 'noo', 'shunya', 'double', 'triple'];
    let wordNumCount = 0;
    const lowerText = msgText.toLowerCase();
    numWords.forEach(word => {
      const wRx = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = lowerText.match(wRx);
      if (matches) wordNumCount += matches.length;
    });

    if (phoneRegex.test(textWithoutAmounts) || hasTenDigits || wordNumCount >= 4) {
      if (!violationType) violationType = 'contact_sharing';
      msgText = msgText.replace(phoneRegex, '[MASKED PHONE]')
                       .replace(/\b(?:[6-9]\d{9})\b/g, '[MASKED PHONE]');
    }
  }

  // 3. UPI ID Check
  const upiRegex = /[a-zA-Z0-9.-]+\s*@\s*(upi|ybl|paytm|okaxis|okhdfcbank|okicici|pay|phonepe|gpay|okdhfl|oksbi|axisbank|hdfcbank|icici|sbi|barodampay|kotak)/gi;
  upiRegex.lastIndex = 0;
  const replacedUpi = msgText.replace(upiRegex, '[MASKED UPI]');
  if (replacedUpi !== msgText) {
    violationType = 'contact_sharing';
    msgText = replacedUpi;
  }

  // 4. Social Media ID Check
  const socialRegex = /(instagram\.com|ig\.me|t\.me|telegram\.me|facebook\.com|fb\.me|fb\.com|snapchat\.com|twitter\.com|x\.com)/gi;
  socialRegex.lastIndex = 0;
  const hasSocialLink = socialRegex.test(msgText);

  const socialKeywords = [/\binsta id\b/i, /\binstagram id\b/i, /\btelegram id\b/i, /\btg id\b/i, /\bsnapchat id\b/i, /\bsnap id\b/i, /\bfb id\b/i, /\bfacebook id\b/i, /\bmy insta\b/i, /\bmy ig\b/i, /\bmy telegram\b/i, /\bdm me on\b/i];
  const hasSocialKeyword = socialKeywords.some(rx => rx.test(msgText));

  if (hasSocialLink || hasSocialKeyword) {
    if (!violationType) violationType = 'contact_sharing';
    msgText = msgText.replace(socialRegex, '[MASKED SOCIAL]');
  }

  // 5. External Link Check
  if (blockLink) {
    const linkRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
    linkRegex.lastIndex = 0;
    if (linkRegex.test(msgText)) {
      const lower = msgText.toLowerCase();
      const isOfficial = lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('roomhy.com') || lower.includes('roohmy');
      const isPayment = lower.includes('/website/pay') || lower.includes('pay?bookingid=') || lower.includes('payu') || lower.includes('payu.in') || lower.includes('razorpay') || lower.includes('rzp.io');
      if (!isOfficial && !isPayment) {
        if (!violationType) violationType = 'contact_sharing';
        msgText = msgText.replace(linkRegex, '[MASKED LINK]');
      }
    }
  }

  // 6. External Settlement & Commission Bypass Keywords
  const bypassKeywords = [
    /\B@[a-zA-Z0-9_]{3,30}\b/i,
    /\b(insta|instagram|ig|telegram|tg|facebook|fb|snapchat|snap|linkedin|twitter|x\.com|social\s+media|social\s+handle|same\s+username|handle\s+wahi)\b/i,
    /\b(via|through|on|share|send|write|give|my)\s+(email|mail|gmail|yahoo|hotmail|outlook)\b/i,
    /\b(email|mail|gmail|yahoo|hotmail|outlook)\s+(id|address)\b/i,
    /\b(email|mail|gmail|yahoo|hotmail|outlook)\s+(par|pe)\s+(bhej\w*|send\w*|de\w*|share\w*|karo|kr|kro)\b/i,
    /\b(mail|email)\s+(me|mujhe|us)\b/i,
    /\b(whatsapp|watsapp|watsp|wtsp|green\s+app)\b/i,
    /\b(wa|wp)\s*(pe|par|msg|message|chat|contact|no|num|number)\b/i,
    /\b(msg|message|chat|contact|no|num|number)\s*(wa|wp)\b/i,
    /\b(meta|purple|call\s+wali|photo\s+sharing|meta\s+photo|reels|reels\s+wali|green|blue)\s+([a-zA-Z]*\s+)?app\b/i,
    /\b(commission|comm|brokerage|fees|charge|charges)\s*([a-zA-Z]*\s+){0,2}(save|bach|bacha|bachao|bachayein|saving|cut|discount|kyu|kyun|bahao|nahi|na|mat|deni)\b/i,
    /\b(no\s+brokerage|save\s+commission|brokerage\s+bach|bypass\s+commission|without\s+commission)\b/i,
    /\b(in\s*hand|hand\s*to\s*hand|cash\s*in\s*hand|offline\s+cash|direct\s+cash)\b/i,
    /\boffline\s+(cash|payment|deal|transfer|settlement)\b/i,
    /\b(cash|payment|deal|transfer|settlement)\s+offline\b/i,
    /\bdirect\s+(cash|payment|offline|deal|account\s+transfer)\b/i,
    /\b(app|platform)\s+se\s+bahar\b/i,
    /\b(number|no|num|contact|mobile|phone|phn)\s+([a-zA-Z]*\s+){0,2}(bhej\w*|de\w*|share\w*|note\w*|likha)\b/i,
    /\b(bhej\w*|de\w*|share\w*|note\w*)\s+([a-zA-Z]*\s+){0,2}(number|no|num|contact|mobile|phone|phn)\b/i,
    /\bboard\s+(pe|par)\s+number\b/i,
    /\b(advance|deposit|payment|rent|money|paise|paisa|cash|account)\s+([a-zA-Z]*\s+){0,2}(direct|offline|cash|transfer|outside|bach|save)\b/i,
    /\b(direct|offline|cash|transfer|outside|bach|save)\s+([a-zA-Z]*\s+){0,2}(advance|deposit|payment|rent|money|paise|paisa|cash|account|pay\w*)\b/i,
    /\b(dalal|middleman|beech\s+wala|teesra\s+beech)\s+(hata|mat|na)\b/i,
    /\b(apas|aapas)\s+mein\s+(deal|payment|cash|settle|hisaab)\b/i,
    /\b(outside\s+website|external\s+link|other\s+website)\b/i,
    /\b(skip\s+formalities|formalities\s+skip|bina\s+app)\b/i,
    /\b(extra\s+lagega|doosra\s+option|unnecessary\s+cost|bina\s+platform)\b/i,
    /\b(watchman|reception|gate\s+pe)\s+([a-zA-Z]*\s+){0,2}(cash|money|paise|payment)\b/i,
    /\b(online\s+mat|online\s+nahi|avoid\s+online)\b/i,

    // "give me the money" in Hinglish, either word order:
    //   "dede paise mujhe" / "paise de do" / "paisa dedo bhai"
    //
    // This slipped past every pattern above. The money-word list already
    // existed, but each rule paired it with a channel word (direct, offline,
    // cash, transfer) and this phrasing names no channel at all — it is a bare
    // demand for a handover, which is the most common way an owner opens an
    // off-platform payment.
    //
    // Both a money word AND a give word are required, within two words of each
    // other, so ordinary rent talk is untouched: "8000 rent hai monthly" has no
    // give word, "de dena" alone has no money word, and "paise online bhej do"
    // is a legitimate on-platform instruction the AI layer judges in context.
    /\b(paise|paisa|rupay|rupaye|amount|cash)\s+([a-zA-Z]*\s+){0,2}(de\s?de|de\s?do|dedo|dede|dena|de\s?dena|bhej\s?de|bhej\s?do)\b/i,
    /\b(de\s?de|de\s?do|dedo|dede|dena|de\s?dena|bhej\s?de|bhej\s?do)\s+([a-zA-Z]*\s+){0,2}(paise|paisa|rupay|rupaye|amount|cash)\b/i
  ];

  // Clean payment links and safe phrases before bypass check
  let cleanBypassText = msgText;
  const officialUrls = [
    /https?:\/\/(www\.)?roomhy\.com\/website\/pay[^\s]*/gi,
    /https?:\/\/(www\.)?payu\.in[^\s]*/gi,
    /https?:\/\/(www\.)?test\.payu\.in[^\s]*/gi,
    /https?:\/\/(www\.)?secure\.payu\.in[^\s]*/gi,
    /https?:\/\/localhost(:\d+)?\/website\/pay[^\s]*/gi,
    /https?:\/\/127\.0\.0\.1(:\d+)?\/website\/pay[^\s]*/gi
  ];
  officialUrls.forEach(urlRx => {
    cleanBypassText = cleanBypassText.replace(urlRx, '');
  });
  cleanBypassText = cleanBypassText
    .replace(/\bpayment\s+link\b/gi, '')
    .replace(/\btoken\s+payment\b/gi, '')
    .replace(/\bcashfree\b/gi, '')
    .replace(/\bpasand\s+aay\w*\b/gi, '');

  const hasBypass = bypassKeywords.some(rx => rx.test(cleanBypassText));
  if (hasBypass) {
    violationType = 'commission_bypass';
  }

  // Also support custom keywords from settings
  if (settings.blockedKeywords && Array.isArray(settings.blockedKeywords)) {
    settings.blockedKeywords.forEach(kw => {
      if (kw && kw.trim()) {
        const kwRx = new RegExp(`\\b${kw.trim()}\\b`, 'gi');
        if (kwRx.test(msgText)) {
          if (!violationType) violationType = 'commission_bypass';
          msgText = msgText.replace(kwRx, '[CENSORED]');
        }
      }
    });
  }

  return { violation: violationType, maskedText: msgText };
}

// Helper to record or group violation attempts (consecutive messages in same session = Attempt 1)
async function recordOrGroupViolation(ownerId, offenderId, participantName, tenantId, tenantName, roomId, violationType, messageSnippet, messageId, confidence, reason, decision) {
  const ChatViolation = mongoose.model('ChatViolation');

  // Find all violations for this specific owner/offender PAIR only (not any random violation)
  const pairViolations = await ChatViolation.find({
    $or: [
      { ownerId, participantLoginId: offenderId },
      { ownerId: offenderId, participantLoginId: ownerId }
    ]
  }).sort({ createdAt: -1 });

  const latestViolation = pairViolations[0] || null;

  const ATTEMPT_SESSION_WINDOW = 5 * 60 * 1000; // 5 minutes grouping window for consecutive messages
  const isSameSession = latestViolation && (Date.now() - new Date(latestViolation.createdAt).getTime() < ATTEMPT_SESSION_WINDOW);

  if (isSameSession) {
    // Group into same attempt — DO NOT create a new violation document!
    const cleanSnippet = String(messageSnippet || '').slice(0, 300);
    if (!latestViolation.messageSnippet.includes(cleanSnippet)) {
      latestViolation.messageSnippet = `${latestViolation.messageSnippet} | ${cleanSnippet}`;
      latestViolation.updatedAt = new Date();
      await latestViolation.save();
    }
    console.log(`ℹ️ Grouped consecutive message into Attempt ${latestViolation.attemptNumber || 1} for ${offenderId}`);
    return { violation: latestViolation, attemptNumber: latestViolation.attemptNumber || 1, isNewAttempt: false };
  }

  // Genuinely NEW session/attempt — count existing pair documents to determine attempt number
  const distinctAttempts = pairViolations.length; // each saved doc = 1 past session
  const attemptNumber = distinctAttempts + 1;

  const violation = new ChatViolation({
    participantLoginId: offenderId,
    participantName,
    ownerId,
    ownerName: participantName,
    tenantId,
    tenantName,
    conversationId: roomId,
    violationType: violationType || 'commission_bypass',
    messageSnippet: String(messageSnippet || '').slice(0, 500),
    messageId: messageId || null,
    attemptNumber,
    aiConfidence: confidence || 0.95,
    aiReason: reason || '',
    aiDecision: decision || null,
    moderatedAt: new Date(),
    status: 'New'
  });

  try {
    await violation.save();
  } catch (saveErr) {
    if (saveErr.code === 11000) {
      console.log(`[recordOrGroupViolation] Duplicate violation for message ${messageId} ignored.`);
      return { violation: latestViolation, attemptNumber: latestViolation?.attemptNumber || 1, isNewAttempt: false };
    }
    throw saveErr;
  }

  return { violation, attemptNumber, isNewAttempt: true };
}

// Log violation and alert Super Admin
async function logViolation(senderLoginId, receiverLoginId, messageText, violationType, messageId) {
  try {
    const sender = await getParticipantRoleAndName(senderLoginId);
    const receiver = await getParticipantRoleAndName(receiverLoginId);
 
    const isSenderOwner = sender.role === 'property_owner';
    const ownerId = isSenderOwner ? senderLoginId : receiverLoginId;
    const ownerName = isSenderOwner ? sender.name : receiver.name;
    const tenantId = isSenderOwner ? receiverLoginId : senderLoginId;
    const tenantName = isSenderOwner ? receiver.name : sender.name;

    const { violation, attemptNumber, isNewAttempt } = await recordOrGroupViolation(
      ownerId,
      senderLoginId,
      sender.name,
      tenantId,
      tenantName,
      receiverLoginId,
      violationType,
      messageText,
      messageId
    );

    const ChatMessage = mongoose.model('ChatMessage');

    if (attemptNumber === 1 && isNewAttempt) {
      // Strike 1 Warning Message
      const strike1Msg = new ChatMessage({
        room_id: receiverLoginId,
        sender_login_id: 'system',
        sender_name: 'Roomhy System',
        sender_role: 'superadmin',
        message: `⚠️ ROOMHY POLICY WARNING (Attempt 1 of 2): Sharing contact details, phone numbers, or offline payment deals is strictly prohibited. Next attempt will result in permanent account block.`,
        message_type: 'system',
        is_read: false
      });
      await strike1Msg.save();

      if (global.io) {
        global.io.to(receiverLoginId).emit('receive_message', strike1Msg);
        global.io.to(senderLoginId).emit('receive_message', strike1Msg);
      }
    } else if (attemptNumber >= 2 && isNewAttempt) {
      // Strike 2: auto-block the account that actually sent the message.
      // senderLoginId is the offender; ownerId is only the owner of the
      // conversation it happened in. Blocking ownerId here punished the owner
      // for a tenant's violation.
      const offenderId = senderLoginId;
      const isOffenderObjId = mongoose.Types.ObjectId.isValid(offenderId) && String(offenderId).match(/^[0-9a-fA-F]{24}$/);
      const offenderConds = [{ loginId: offenderId }, { loginId: String(offenderId).toUpperCase() }];
      if (isOffenderObjId) offenderConds.push({ _id: offenderId });
      await Promise.allSettled([
        Owner.updateOne({ $or: offenderConds }, { isActive: false }),
        User.updateOne({ $or: offenderConds }, { status: 'blocked', isActive: false })
      ]);

      const blockWarningMsg = new ChatMessage({
        room_id: receiverLoginId,
        sender_login_id: 'system',
        sender_name: 'Roomhy System',
        sender_role: 'superadmin',
        // Names the account that was actually suspended. It previously always
        // named the owner, even when the tenant was the one who was blocked.
        message: `🚨 ACCOUNT BLOCKED (Attempt 2 of 2): Account (${sender.name || offenderId}) has been automatically suspended due to repeated policy violations (commission bypass). Chat is now closed.`,
        message_type: 'system',
        is_read: false
      });
      await blockWarningMsg.save();

      if (global.io) {
        global.io.to(receiverLoginId).emit('receive_message', blockWarningMsg);
        global.io.to(senderLoginId).emit('receive_message', blockWarningMsg);
        global.io.to('SUPER_ADMIN').emit('owner_account_blocked', { ownerId, ownerName, totalViolations: attemptNumber });
      }
    }

    if (isNewAttempt) {
      await notifySuperAdminAlert(violation);
    }

    return violation;
  } catch (err) {
    console.error('Error in logViolation:', err);
  }
}

// Notify Super Admin via Database, Email, and Socket.io
async function notifySuperAdminAlert(violation) {
  try {
    let typeLabel = 'Policy Violation';
    if (violation.violationType === 'commission_bypass') {
      typeLabel = 'Commission Bypass Communication';
    } else if (violation.violationType === 'contact_sharing') {
      typeLabel = 'Contact Sharing Attempt';
    } else if (violation.violationType === 'external_settlement') {
      typeLabel = 'External Settlement Communication';
    } else if (violation.violationType) {
      typeLabel = violation.violationType.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    }

    const subject = `⚠️ Alert: Chat Violation Detected on Roomhy`;

    // Fetch conversation context/reason
    const BookingRequest = require('../models/BookingRequest');
    const ChatRoom = require('../models/ChatRoom');
    const booking = await BookingRequest.findOne({
      owner_id: violation.ownerId,
      $or: [
        { user_id: violation.tenantId },
        { email: violation.tenantId }
      ]
    }).sort({ created_at: -1 }).lean();

    let context = 'General inquiry / No active booking request found';
    if (booking) {
      context = `Booking Request for property "${booking.property_name}" (Rent: ₹${booking.rent_amount}, Status: ${booking.booking_status})`;
    } else {
      const chatRoom = await ChatRoom.findOne({
        $or: [
          { room_id: violation.ownerId },
          { room_id: violation.tenantId }
        ]
      }).lean();
      if (chatRoom && chatRoom.property_name) {
        context = `Inquiry for property "${chatRoom.property_name}"`;
      }
    }

    const message = `${typeLabel} Detected: Owner ${violation.ownerName} (${violation.ownerId}) is talking to Tenant ${violation.tenantName} (${violation.tenantId}). Reason: ${context}`;

    // 1. Database & Email Notification
    await notifySuperadmin({
      type: 'chat_violation',
      from: 'system',
      subject,
      message,
      meta: {
        'Violation ID': violation._id.toString(),
        'Violation Type': typeLabel,
        'Sender': violation.participantName,
        'Owner Name': violation.ownerName,
        'Tenant Name': violation.tenantName,
        'Message Snippet': violation.messageSnippet,
        'Reason for Chat': context
      }
    });

    // 2. Real-time Socket.io Notification
    if (global.io) {
      global.io.to('SUPER_ADMIN').emit('new_violation_alert', {
        id: violation._id,
        violationType: violation.violationType,
        senderName: violation.participantName,
        ownerName: violation.ownerName,
        tenantName: violation.tenantName,
        messageSnippet: violation.messageSnippet,
        createdAt: violation.createdAt,
        conversationContext: context
      });
      console.log('⚡ Real-time violation alert sent to SUPER_ADMIN');
    }
  } catch (err) {
    console.error('Error in notifySuperAdminAlert:', err);
  }
}

async function moderateChatMessageAsync(messageDoc, receiverLoginId) {
  try {
    const textLower = String(messageDoc?.message || '').toLowerCase();
    if (
      !messageDoc ||
      messageDoc.sender_login_id === 'system' ||
      messageDoc.message_type === 'system' ||
      messageDoc.sender_role === 'superadmin' ||
      messageDoc.message_type === 'image' ||
      messageDoc.message_type === 'file' ||
      messageDoc.message_type === 'video' ||
      textLower.includes('payu.in') ||
      textLower.includes('payu') ||
      textLower.includes('roomhy.com') ||
      textLower.includes('/website/pay') ||
      textLower.includes('bookingid=') ||
      textLower.includes('token payment')
    ) {
      return;
    }

    const ChatMessage = mongoose.model('ChatMessage');
    const currentMsg = await ChatMessage.findById(messageDoc._id).lean();
    if (!currentMsg || currentMsg.aiModeratedAt) {
      return;
    }

    const senderRole = messageDoc.sender_role || 'tenant';
    const receiverInfo = await getParticipantRoleAndName(receiverLoginId);
    const receiverRole = receiverInfo.role || 'property_owner';

    let messageText = messageDoc.message || '';
    if (messageDoc.original_message_encrypted) {
      try {
        messageText = ChatMessage.decryptText(messageDoc.original_message_encrypted);
      } catch (err) {
        console.warn('Failed to decrypt original message for AI moderation:', err.message);
      }
    }

    const sender = String(messageDoc.sender_login_id).trim();
    const receiver = String(receiverLoginId).trim();
    const senderVariants = [...new Set([sender, sender.toLowerCase(), sender.toUpperCase()])];
    const receiverVariants = [...new Set([receiver, receiver.toLowerCase(), receiver.toUpperCase()])];

    // Only messages from the last few minutes count as context.
    //
    // This window did not exist, and its absence was a false-positive engine.
    // The split-typing check below merges the sender's recent messages into one
    // string and screens that, so it could catch someone typing "paise" / "naa"
    // / "de" as separate messages. With no lower bound it merged the last 8
    // messages no matter how old they were: once anything flagged sat in that
    // history, EVERY later message inherited it forever. An owner typing "hi"
    // was screened as "...453534545454 5000 7845 dede paise mujhe ... hi",
    // flagged, and struck — twice, which suspends the account.
    //
    // Split typing means messages sent back-to-back in one breath, so a few
    // minutes is the honest span. It matches ATTEMPT_SESSION_WINDOW, which
    // already groups consecutive messages into a single attempt.
    const contextSince = new Date(
      new Date(messageDoc.created_at).getTime() - SPLIT_CONTEXT_WINDOW_MS
    );

    const recentMessages = await ChatMessage.find({
      $or: [
        { room_id: { $in: receiverVariants }, sender_login_id: { $in: senderVariants } },
        { room_id: { $in: senderVariants }, sender_login_id: { $in: receiverVariants } }
      ],
      created_at: { $lt: messageDoc.created_at, $gte: contextSince }
    })
      .sort({ created_at: -1 })
      .limit(8)
      .lean();

    recentMessages.reverse();

    const contextHistory = recentMessages.map(msg => {
      let text = msg.message || '';
      if (msg.original_message_encrypted) {
        try {
          text = ChatMessage.decryptText(msg.original_message_encrypted);
        } catch (_) {}
      }
      const cleanRole = String(msg.sender_role || '').toLowerCase().trim();
      const roleLabel = (cleanRole === 'property_owner' || cleanRole === 'owner') ? 'Owner' : 'Tenant';
      return `${roleLabel}: "${text}"`;
    }).join('\n');

    const settings = await ChatSettings.findOne({ ownerLoginId: 'SUPER_ADMIN' }).lean();
    let localCheck = detectViolation(messageText, settings || {});

    // Aggregate recent messages to detect split typing evasion (e.g. typing "de", "naa", "paise", "yahan")
    const senderRecentTexts = recentMessages
      .filter(m => String(m.sender_login_id).toLowerCase().trim() === String(messageDoc.sender_login_id).toLowerCase().trim())
      .map(m => {
        let t = m.message || '';
        if (m.original_message_encrypted) {
          try { t = ChatMessage.decryptText(m.original_message_encrypted); } catch (_) {}
        }
        return t;
      });
    senderRecentTexts.push(messageText);
    const combinedSenderText = senderRecentTexts.join(' ');

    if (!localCheck.violation) {
      const combinedCheck = detectViolation(stripRentAndAmounts(combinedSenderText), settings || {});
      if (combinedCheck.violation) {
        localCheck = combinedCheck;
        console.log(`⚡ Multi-message Split Evasion Violation Detected on message ${messageDoc._id}:`, combinedCheck.violation);
      }
    }

    let moderation = { violation: false, type: 'none', confidence: 0, reason: '' };

    if (localCheck.violation) {
      console.log(`⚡ Instant Local Violation Detected on message ${messageDoc._id}:`, localCheck.violation);
      moderation = {
        violation: true,
        type: localCheck.violation,
        confidence: 0.98,
        reason: `Detected ${localCheck.violation} keyword pattern in chat message.`
      };
    } else {
      moderation = await aiModerationService.moderateMessage(
        messageText,
        senderRole,
        receiverRole,
        contextHistory,
        stripRentAndAmounts(combinedSenderText)
      );
    }

    // Normalise confidence to 0-1. The local regex path reports 0.98 while the
    // AI provider returns a 0-100 percentage, so any threshold comparing the
    // two was meaningless.
    if (Number(moderation.confidence) > 1) {
      moderation.confidence = Number(moderation.confidence) / 100;
    }

    // Save moderation status on the ChatMessage document to avoid duplicate runs.
    // violation_type is stamped here as well as in the pre-save hook, because
    // violations found on this path (notably commission_bypass) never reached
    // the message — so the chat UI, which renders its warning badge from
    // msg.violation_type, showed nothing.
    const moderationUpdate = {
      aiModeratedAt: new Date(),
      aiModerationResult: moderation,
      is_blocked: moderation.violation,
      violation_type: moderation.violation
        ? ((moderation.type && moderation.type !== 'none') ? moderation.type : 'commission_bypass')
        : null
    };

    await ChatMessage.updateOne({ _id: messageDoc._id }, { $set: moderationUpdate });

    if (moderation.violation) {
      console.log(`⚠️ AI Moderation Violation Detected on message ${messageDoc._id}:`, moderation);

      const sender = await getParticipantRoleAndName(messageDoc.sender_login_id);
      const receiver = await getParticipantRoleAndName(receiverLoginId);

      const isSenderOwner = sender.role === 'property_owner';
      const ownerId = isSenderOwner ? messageDoc.sender_login_id : receiverLoginId;
      const ownerName = isSenderOwner ? sender.name : receiver.name;
      const tenantId = isSenderOwner ? receiverLoginId : messageDoc.sender_login_id;
      const tenantName = isSenderOwner ? receiver.name : sender.name;

      const offenderId = messageDoc.sender_login_id;

      const { violation, attemptNumber, isNewAttempt } = await recordOrGroupViolation(
        ownerId,
        offenderId,
        sender.name,
        tenantId,
        tenantName,
        messageDoc.room_id,
        moderation.type || 'commission_bypass',
        messageText,
        messageDoc._id,
        moderation.confidence,
        moderation.reason,
        moderation
      );

      if (isNewAttempt) {
        const isRepeatedOrSevere = attemptNumber >= 2;

        await ChatViolation.updateOne(
          { _id: violation._id },
          {
            $set: {
              status: isRepeatedOrSevere ? 'Reviewed' : 'Warning Sent',
              actionTaken: isRepeatedOrSevere ? 'blocked' : 'warned'
            },
            $push: {
              actionHistory: {
                action: isRepeatedOrSevere ? 'blocked' : 'warned',
                adminId: 'system',
                reason: isRepeatedOrSevere ? 'Automatic block after attempt 2 of 2' : 'Automatic warning for attempt 1 of 2'
              }
            }
          }
        );

        if (isRepeatedOrSevere) {
          console.log(`🚨 Auto-blocking offender ${offenderId} (Genuine Attempt 2 failed)`);
          // Block the OFFENDER only. The previous `$or: [offenderId, ownerId]`
          // matched a single document, and when the offender was the tenant
          // (who has no Owner record) the only thing it could match was the
          // owner — so a tenant's violation blocked the owner's account.
          const offenderConds = [
            { loginId: offenderId },
            { loginId: String(offenderId).toUpperCase() }
          ];
          await Promise.allSettled([
            Owner.updateOne({ $or: offenderConds }, { isActive: false, status: 'blocked', blockedReason: 'Repeated commission bypass attempt' }),
            User.updateOne({ $or: offenderConds }, { status: 'blocked', isActive: false })
          ]);
          if (global.io) {
            global.io.to(offenderId).emit('account_blocked', {
              blocked: true,
              accountBlocked: true,
              reason: 'Your account has been permanently blocked due to repeated commission bypass attempts.'
            });
          }
        } else {
          // New Attempt 1 — emit warning to the OFFENDER only.
          //
          // This used to be `.to(offenderId).to(ownerId)`, so when the tenant
          // was the offender the owner also got a "1st Warning: your account
          // will be blocked" popup for something they did not send.
          if (global.io) {
            global.io.to(offenderId).emit('message_blocked', {
              warning: true,
              warningType: '1st_warning',
              attemptCount: 1,
              // The offending text, so the UI can show what was actually
              // withheld instead of labelling this warning as the user's
              // own message.
              snippet: String(messageText || '').slice(0, 300),
              message: '⚠️ 1st Warning: Sharing contact numbers, emails, or offline payment terms is strictly prohibited on Roomhy. A 2nd attempt will permanently block your account.'
            });
          }
        }

        // Create system chat message for new attempts
        const pairKey = [messageDoc.sender_login_id, receiverLoginId].sort().join(':').toUpperCase();
        const warningText = isRepeatedOrSevere
          ? `🚨 ACCOUNT BLOCKED: Account (${sender.name || offenderId}) has been AUTOMATICALLY BLOCKED & SUSPENDED due to repeated commission bypass / security policy violations. Chat is now closed.`
          : `⚠️ ROOMHY SECURITY WARNING: Asking for offline payments, commission bypass, or sharing direct contact details is strictly prohibited. Continued violations will result in IMMEDIATE ACCOUNT BLOCK & PERMANENT SUSPENSION.`;

        const systemMsgDoc = {
          sender_login_id: 'system',
          sender_name: 'Roomhy System',
          sender_role: 'superadmin',
          message: warningText,
          message_type: 'system',
          is_read: false,
          created_at: new Date()
        };

        const roomIdsToWarn = [...new Set([messageDoc.room_id, messageDoc.sender_login_id, receiverLoginId].filter(Boolean))];
        
        for (const rId of roomIdsToWarn) {
          const sysMsg = await ChatMessage.create({
            ...systemMsgDoc,
            room_id: rId,
            conversation_id: pairKey
          });

          if (global.io) {
            const payload = {
              _id: sysMsg._id,
              room_id: rId,
              conversation_id: sysMsg.conversation_id,
              sender_login_id: 'system',
              sender_name: 'Roomhy System',
              sender_role: 'superadmin',
              message: sysMsg.message,
              message_type: 'system',
              created_at: sysMsg.created_at
            };
            global.io.to(rId).emit('receive_message', payload);
            global.io.to(rId).emit('new_message', sysMsg);
          }
        }

        if (isRepeatedOrSevere && global.io) {
          global.io.to('SUPER_ADMIN').emit('owner_account_blocked', { ownerId, ownerName, totalViolations: attemptNumber });
        }

        await notifySuperAdminAlert(violation);
      } else {
        // Grouped consecutive message — STILL show warning if it's Attempt 1 session
        if (attemptNumber < 2 && global.io) {
          // Offender only — see the note on the other message_blocked emit.
          // Warning somebody about a message they did not send is both
          // confusing and, since it names account suspension, alarming.
          global.io.to(offenderId).emit('message_blocked', {
            warning: true,
            warningType: '1st_warning',
            attemptCount: 1,
            snippet: String(messageText || '').slice(0, 300),
            message: '⚠️ 1st Warning: Sharing contact numbers, emails, or offline payment terms is strictly prohibited on Roomhy. A 2nd attempt will permanently block your account.'
          });
        }
      }
    }

  } catch (err) {
    console.error('Error in moderateChatMessageAsync:', err);
  }
}

// Cleanup task to consolidate past duplicate single-word violations into 1 attempt and heal false blocks
setInterval(async () => {
  try {
    const ChatViolation = mongoose.model('ChatViolation');
    // Group multiple violations from same user created within 5 mins of each other into 1
    const allViolations = await ChatViolation.find({}).sort({ createdAt: 1 }).lean();
    const userGroups = new Map();
    const toDeleteIds = [];

    for (const v of allViolations) {
      // Group by the OFFENDER, matching what checkUserBlockStatus() counts.
      // Keying on ownerId first bucketed a tenant's violation under the owner,
      // so an owner with one real strike looked like two and this loop —
      // whose whole job is to heal accounts below two genuine strikes — never
      // unblocked them.
      const key = v.participantLoginId;
      if (!key) continue;
      if (!userGroups.has(key)) {
        userGroups.set(key, [v]);
      } else {
        const list = userGroups.get(key);
        const last = list[list.length - 1];
        const diffMs = new Date(v.createdAt).getTime() - new Date(last.createdAt).getTime();
        if (diffMs < 5 * 60 * 1000) {
          // Duplicate within 5 mins — mark for deletion
          toDeleteIds.push(v._id);
        } else {
          list.push(v);
        }
      }
    }

    if (toDeleteIds.length > 0) {
      await ChatViolation.deleteMany({ _id: { $in: toDeleteIds } });
      console.log(`✅ Consolidated ${toDeleteIds.length} duplicate single-message violation records into 1 attempt`);
    }

    // Auto-unblock only accounts that have LESS than 2 genuine attempts (heals false positive single strikes)
    for (const [offenderKey, list] of userGroups.entries()) {
      if (list.length < 2) {
        const isKeyObjId = mongoose.Types.ObjectId.isValid(offenderKey) && String(offenderKey).match(/^[0-9a-fA-F]{24}$/);
        const offenderConds = [{ loginId: offenderKey }, { loginId: String(offenderKey).toUpperCase() }];
        if (isKeyObjId) offenderConds.push({ _id: offenderKey });
        await Owner.updateMany({ $or: offenderConds }, { $set: { isActive: true, chatRestrictedUntil: null } });
        // Matched on the exact-case loginId only, so a stored id whose case
        // differed from the violation's stayed blocked forever while the Owner
        // record beside it was healed.
        await User.updateMany({ $or: offenderConds }, { $set: { status: 'active', isActive: true, chatRestrictedUntil: null } });
      }
    }
  } catch (_) {}
}, 15000);

async function healChatModerationAndUnblockAccounts() {
  try {
    const targetEmails = ['harshdeepbca503@gmail.com'];
    const targetLoginIds = ['ROOMHY6935'];

    // 1. Unblock false-positive blocked owners/users
    await Promise.allSettled([
      Owner.updateMany(
        { $or: [{ loginId: { $in: targetLoginIds } }, { 'profile.email': { $in: targetEmails } }, { email: { $in: targetEmails } }] },
        { $set: { isActive: true, status: 'active', blockedReason: null, chatRestrictedUntil: null } }
      ),
      User.updateMany(
        { $or: [{ loginId: { $in: targetLoginIds } }, { email: { $in: targetEmails } }] },
        { $set: { status: 'active', isActive: true, chatRestrictedUntil: null } }
      )
    ]);

    // 2. Remove false-positive system warning messages from ChatMessage DB that contain warning bubbles
    const ChatMessage = mongoose.model('ChatMessage');
    const deleteResult = await ChatMessage.deleteMany({
      $or: [
        { message: { $regex: /ROOMHY POLICY WARNING|ACCOUNT BLOCKED|sharing contact details|offline payment deals/i } },
        { sender_login_id: 'system', message_type: 'system' }
      ]
    });

    // 3. Clear ChatViolation records for target users
    const ChatViolation = mongoose.model('ChatViolation');
    await ChatViolation.deleteMany({
      $or: [
        { participantLoginId: { $in: targetLoginIds } },
        { ownerId: { $in: targetLoginIds } }
      ]
    });

    // 4. Heal existing BookingRequest records with default ₹8,000/₹7,000 notes for properties
    try {
      const BookingRequest = mongoose.model('BookingRequest');
      const bidsToHeal = await BookingRequest.find({
        $or: [
          { message: /₹8,000|₹7,000/i },
          { bid_amount: 8000 },
          { bid_amount: 7000 }
        ]
      }).lean();

      for (const b of bidsToHeal) {
        const rentAmt = b.rent_amount && b.rent_amount > 0 ? b.rent_amount : 2500;
        let newMsg = b.message;
        if (newMsg && (newMsg.includes('8,000') || newMsg.includes('7,000'))) {
          newMsg = `Tenant Max Budget: ₹${rentAmt.toLocaleString('en-IN')}. If you can offer this property for ₹${rentAmt.toLocaleString('en-IN')}/month, please accept the bid.`;
        }
        await BookingRequest.updateOne(
          { _id: b._id },
          {
            $set: {
              bid_amount: rentAmt,
              message: newMsg
            }
          }
        );
      }
    } catch (_) {}

    console.log(`✅ [healChatModeration] Unblocked Harshdeep Kaur (${targetLoginIds.join(', ')}) & purged ${deleteResult.deletedCount || 0} system policy warning messages.`);
  } catch (err) {
    console.error('⚠️ [healChatModeration] Error during heal:', err.message);
  }
}

module.exports = {
  getParticipantRoleAndName,
  isOwnerTenantChat,
  checkUserBlockStatus,
  detectViolation,
  logViolation,
  notifySuperAdminAlert,
  moderateChatMessageAsync,
  healChatModerationAndUnblockAccounts
};
