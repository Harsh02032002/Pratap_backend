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

  // Self-healing: Clear any false positive violations caused by official payment links or single innocent words
  try {
    await ChatViolation.deleteMany({
      $or: [
        { messageSnippet: /roomhy/i },
        { messageSnippet: /bookingId/i },
        { messageSnippet: /website\/pay/i },
        { messageSnippet: /Cashfree/i },
        { messageSnippet: /Razorpay/i },
        { messageSnippet: /^\s*"?\s*(yaan|yahan|paise|paisa|naa|de|de na|hi|hello|ha|haan)\s*"?\s*$/i }
      ]
    });
  } catch (_) {}

  // 1. Check if explicitly suspended/blocked on User model
  const user = await User.findOne({ loginId: cleanId }).lean();

  // 2. Check Owner suspension & chatRestrictedUntil
  const upperId = cleanId.toUpperCase();
  const owner = await Owner.findOne({ loginId: upperId }).lean();

  // Check if remaining real violations >= 2
  const realViolationsCount = await ChatViolation.countDocuments({
    $or: [
      { ownerId: upperId },
      { participantLoginId: cleanId },
      { participantLoginId: upperId }
    ]
  });

  if (realViolationsCount < 2) {
    // Restore account if it was falsely blocked by payment links
    if (owner && (!owner.isActive || owner.chatRestrictedUntil)) {
      await Owner.updateOne({ loginId: upperId }, { $set: { isActive: true, chatRestrictedUntil: null } });
    }
    if (user && (user.status === 'blocked' || !user.isActive || user.chatRestrictedUntil)) {
      await User.updateOne({ loginId: cleanId }, { $set: { status: 'active', isActive: true, chatRestrictedUntil: null } });
    }
    return { blocked: false };
  }

  // 4. Check unresolved violations count in last 24 hours
  const settings = await ChatSettings.findOne({ ownerLoginId: 'SUPER_ADMIN' }).lean();
  const limit = settings?.strikeLimit || 3;
  const autoBan = false; // Disabled automatic restriction (Only manual Super Admin restriction is allowed)

  if (autoBan) {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const violationsCount = await ChatViolation.countDocuments({
      participantLoginId: cleanId,
      resolvedAt: { $exists: false },
      createdAt: { $gte: cutoff }
    });

    if (violationsCount >= limit) {
      // Automatically restrict user for banDurationHours (default 24h)
      const durationHours = settings?.banDurationHours || 24;
      const restrictUntil = new Date(Date.now() + durationHours * 60 * 60 * 1000);

      if (user) {
        await User.updateOne({ loginId: cleanId }, { chatRestrictedUntil: restrictUntil });
      }
      if (owner) {
        await Owner.updateOne({ loginId: upperId }, { chatRestrictedUntil: restrictUntil });
      }

      return {
        blocked: true,
        reason: `Your chat is blocked for ${durationHours} hours due to warnings.`
      };
    }
  }

  return { blocked: false };
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
    const phoneRegex = /(\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
    const textWithoutUrls = msgText.replace(/(https?:\/\/[^\s]+|www\.[^\s]+)/gi, '');
    const cleanDigits = textWithoutUrls.replace(/[\s\-().,_/*]/g, '');
    const hasTenDigits = /\d{10}/.test(cleanDigits);

    const spacedDigitsRegex = /(\d[\s\-.,_*/]*){10,12}/g;
    spacedDigitsRegex.lastIndex = 0;
    const hasSpacedDigits = spacedDigitsRegex.test(msgText);

    const numWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ek', 'teen', 'chaar', 'char', 'paanch', 'panch', 'chhe', 'che', 'saat', 'aath', 'nau', 'noo', 'shunya', 'double', 'triple'];
    let wordNumCount = 0;
    const lowerText = msgText.toLowerCase();
    numWords.forEach(word => {
      const wRx = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = lowerText.match(wRx);
      if (matches) wordNumCount += matches.length;
    });

    if (phoneRegex.test(msgText) || hasTenDigits || hasSpacedDigits || wordNumCount >= 4) {
      if (!violationType) violationType = 'contact_sharing';
      msgText = msgText.replace(phoneRegex, '[MASKED PHONE]')
                       .replace(spacedDigitsRegex, '[MASKED PHONE]')
                       .replace(/\b\d{10}\b/g, '[MASKED PHONE]');
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
      const isPayment = lower.includes('/website/pay') || lower.includes('pay?bookingid=') || lower.includes('cashfree') || lower.includes('razorpay') || lower.includes('rzp.io');
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
    /\bDP\s*(dikhegi|dikhe|dekh|check|profile|photo|wahi|same|pe|par)\b/i,
    /\b(profile|my|meri)\s+DP\b/i,
    /\busername\s*(wahi|same|id|handle|har\s+jagah)\b/i,
    /\bsearch\s*(kar|kr|karo|kro|lena|le|karoge)\b/i,
    /\binitials\s*(search|yaad)?\b/i,
    /\bgoogle\s*(karo|kr|kro|search|kar\s+lena)?\b/i,
    /\b(net\s+par|net\s+pe|profile\s+picture|same\s+id)\b/i,
    /\bbooking\s+cancel\b/i,
    /\bcancel\s+booking\b/i,
    /\bcancel\s+(kardo|krdo|kar\s+do|kr\s+do|karke|krke|karna|krna|karwa|krwa)\b/i,
    /\bplatform\s*(ki|ko|se|par|fees|charge|commission|brokerage)?\s*(zaroorat|beech|mat|bachao|save|bypass|hata)\b/i,
    /\b(commission|comm|brokerage|fees|charge|charges)\s*([a-zA-Z]*\s+){0,2}(save|bach|bacha|bachao|bachayein|saving|cut|discount|kyu|kyun|bahao|nahi|na|mat|deni)\b/i,
    /\b(no\s+brokerage|save\s+commission|brokerage\s+bach|bypass\s+commission|without\s+commission)\b/i,
    /\b(in\s*hand|hand\s*to\s*hand|cash\s*in\s*hand|offline\s+cash|direct\s+cash)\b/i,
    /\boffline\s+(cash|payment|deal|transfer|settlement)\b/i,
    /\b(cash|payment|deal|transfer|settlement)\s+offline\b/i,
    /\bdirect\s+(cash|payment|offline|deal|account\s+transfer)\b/i,
    /\b(app|platform)\s+se\s+bahar\b/i,
    /\b(number|no|num|contact|mobile|phone|phn|call)\s+([a-zA-Z]*\s+){0,2}(bhej\w*|de\w*|share\w*|note\w*|kar|kr|karo|kro|lena|le|karta|likha)\b/i,
    /\b(bhej\w*|de\w*|share\w*|note\w*)\s+([a-zA-Z]*\s+){0,2}(number|no|num|contact|mobile|phone|phn|call)\b/i,
    /\b(call|phone|phn|baat\w*|connect\w*)\s+([a-zA-Z]*\s+){0,2}(kar|kr|karo|kro|lena|le)\b/i,
    /\bboard\s+(pe|par)\s+number\b/i,
    /\b(advance|deposit|payment|rent|money|paise|paisa|cash|account|kharcha|kharch)\s+([a-zA-Z]*\s+){0,2}(direct|offline|cash|transfer|account|bhej\w*|de\w*|mat|outside|bach|save|wahin)\b/i,
    /\b(direct|offline|cash|transfer|account|outside|bach|save|wahin)\s+([a-zA-Z]*\s+){0,2}(advance|deposit|payment|rent|money|paise|paisa|cash|account|pay\w*|kharcha|kharch)\b/i,
    /\b(dalal|middleman|beech\s+wala|teesra\s+beech)\s+(hata|mat|na)\b/i,
    /\bseedha\s+(hisaab|hisab|len\s*den|deal\w*|payment|pay\w*|malik|kirayedar|owner|tenant|baat\w*|nahi)\b/i,
    /\b(apas|aapas)\s+mein\s+(deal|payment|cash|settle|hisaab)\b/i,
    /\bscene\s+set\b/i,
    /\bopen\s+me(in)?\s+nahi\b/i,
    /\b(pg|hostel)\s+(pe|par|me|in)\s+mil\w*\b/i,
    /\bbeech\s+(ka|ko|se|me|mein|wala|wale|waale)\b/i,
    /\b(samajh\s+jao|samajh\s+gaya|samajh\s+gaye|samajh\s+rhe|samajh\s+rahe|samajhdar|ishara)\b/i,
    /\b(outside\s+website|external\s+link|other\s+website)\b/i,
    /\b(koi\s+aur\s+tareeka|skip\s+formalities|formalities\s+skip|bina\s+app)\b/i,
    /\b(extra\s+lagega|doosra\s+option|bacha\s+sakta|dono\s+ka\s+fayda|unnecessary\s+cost|sasta\s+padega|bina\s+platform|aapka\s+benefit|benefit\s+hai|kharcha\s+bach|bach\s+jayega|fayda\s+ho)\b/i,
    /\b(watchman|reception|gate\s+pe|owner\s+se\s+mil\w*|milkar\s+final|face\s+to\s+face\s+clear|har\s+jagah\s+isi\s+naam|net\s+par\s+mil\w*|profile\s+picture\s+pehchan|same\s+id\s+har\s+app|rules\s+ki\s+wajah|hint\s+de\s+diya|samne\s+baith|personally\s+mil\w*|property\s+par\s+mil\w*|wahin\s+details|aane\s+ke\s+baad|hostel\s+mein\s+hi|same\s+username|handle\s+wahi)\b/i,
    /\b(gate\s+pe\s+aa|watchman\s+ko\s+mera|owner\s+se\s+milwa\w*|direct\s+location|google\s+kar\s+lena|search\s+karoge|same\s+id|initials\s+yaad|booking\s+ki\s+zaroorat|entry\s+ke\s+time|deposit\s+wahin|cash\s+preferred|online\s+mat|details\s+de\s+dunga|smart\s+banna|visit\s+ke\s+baad|property\s+par\s+mil\w*|meta\s+wali|blue\s+app|same\s+username|handle\s+wahi)\b/i,
    /\b(property\s+)?visit\s+([a-zA-Z]*\s+){0,3}(pe\s+)?(discuss\w*|baat\w*|final\w*|settle\w*|deal\w*|decide\w*|mil\w*|connect\w*)\b/i,
    /\b(discuss\w*|baat\w*|final\w*|settle\w*|deal\w*|decide\w*|mil\w*|connect\w*)\s+([a-zA-Z]*\s+){0,3}(pe\s+)?property\s+visit\b/i,
    /\bmil(kar|ke|te)\s+([a-zA-Z]*\s+){0,3}(discuss|baat|final|settle|deal)\b/i,
    /\b(discuss|baat|final|settle|deal)\s+([a-zA-Z]*\s+){0,3}mil(kar|ke|te)\b/i,
    /\bbaaki\s+([a-zA-Z]*\s+){0,2}mil\w*\b/i,
    /\b(wahan|wahin|location|pg|hostel|flat|apartment|gate|address)\s+([a-zA-Z]*\s+){0,3}(settle\w*|deal\w*|pay\w*|payment\w*|baat\w*|discuss\w*|final\w*|decide\w*)\b/i,
    /\b(settle\w*|deal\w*|pay\w*|payment\w*|baat\w*|discuss\w*|final\w*|decide\w*)\s+([a-zA-Z]*\s+){0,3}(wahan|wahin|location|pg|hostel|flat|apartment|gate|address)\b/i,
    /\bonline\s+([a-zA-Z]*\s+){0,2}(mat|nahi|na|no|skip|avoid|zaroorat)\b/i,
    /\b(mat|nahi|na|no|skip|avoid|zaroorat)\s+([a-zA-Z]*\s+){0,2}online\b/i,
    /\bbina\s+([a-zA-Z]*\s+){0,2}beech\b/i,
    /\b(owner|malik)\s+([a-zA-Z]*\s+){0,2}(naam|name)\b/i,
    /\b(app|platform)\s+([a-zA-Z]*\s+){0,2}bina\b/i,
    /\bbina\s+([a-zA-Z]*\s+){0,2}(app|platform)\b/i
  ];

  // Clean payment links and safe phrases before bypass check
  let cleanBypassText = msgText;
  const officialUrls = [
    /https?:\/\/(www\.)?roomhy\.com\/website\/pay[^\s]*/gi,
    /https?:\/\/localhost(:\d+)?\/website\/pay[^\s]*/gi,
    /https?:\/\/127\.0\.0\.1(:\d+)?\/website\/pay[^\s]*/gi
  ];
  officialUrls.forEach(urlRx => {
    cleanBypassText = cleanBypassText.replace(urlRx, '');
  });
  cleanBypassText = cleanBypassText
    .replace(/\bpayment\s+link\b/gi, '')
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
      // Strike 2: Auto block owner and user account after 2 genuine attempts
      await Promise.allSettled([
        Owner.updateOne({ $or: [{ loginId: ownerId }, { _id: ownerId }] }, { isActive: false }),
        User.updateOne({ $or: [{ loginId: ownerId }, { _id: ownerId }] }, { status: 'blocked', isActive: false })
      ]);

      const blockWarningMsg = new ChatMessage({
        room_id: receiverLoginId,
        sender_login_id: 'system',
        sender_name: 'Roomhy System',
        sender_role: 'superadmin',
        message: `🚨 ACCOUNT BLOCKED (Attempt 2 of 2): Account (${ownerName}) has been automatically suspended due to repeated policy violations (commission bypass). Chat is now closed.`,
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

// Asynchronous background moderation function using Groq AI & local detection
async function moderateChatMessageAsync(messageDoc, receiverLoginId) {
  try {
    if (
      !messageDoc ||
      messageDoc.sender_login_id === 'system' ||
      messageDoc.message_type === 'system' ||
      messageDoc.sender_role === 'superadmin' ||
      messageDoc.message_type === 'image' ||
      messageDoc.message_type === 'file' ||
      messageDoc.message_type === 'video'
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

    const recentMessages = await ChatMessage.find({
      $or: [
        { room_id: { $in: receiverVariants }, sender_login_id: { $in: senderVariants } },
        { room_id: { $in: senderVariants }, sender_login_id: { $in: receiverVariants } }
      ],
      created_at: { $lt: messageDoc.created_at }
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
      const combinedCheck = detectViolation(combinedSenderText, settings || {});
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
        combinedSenderText
      );
    }

    await ChatMessage.updateOne(
      { _id: messageDoc._id },
      { 
        $set: { 
          aiModeratedAt: new Date(), 
          aiModerationResult: moderation,
          is_blocked: moderation.violation,
          violation_type: moderation.violation ? (moderation.type || 'commission_bypass') : null
        } 
      }
    );

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

        if (isRepeatedOrSevere) {
          console.log(`🚨 Auto-blocking offender ${offenderId} (Genuine Attempt 2 failed)`);
          await Promise.allSettled([
            Owner.updateOne({ $or: [{ loginId: offenderId }, { loginId: ownerId }] }, { isActive: false, status: 'blocked', blockedReason: 'Repeated commission bypass attempt' }),
            User.updateOne({ $or: [{ loginId: offenderId }, { loginId: ownerId }] }, { status: 'blocked', isActive: false })
          ]);
          if (global.io) {
            global.io.to(offenderId).to(ownerId).emit('account_blocked', {
              blocked: true,
              accountBlocked: true,
              reason: 'Your account has been permanently blocked due to repeated commission bypass attempts.'
            });
          }
        } else {
          // New Attempt 1 — emit warning
          if (global.io) {
            global.io.to(offenderId).to(ownerId).emit('message_blocked', {
              warning: true,
              warningType: '1st_warning',
              attemptCount: 1,
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
          global.io.to(offenderId).to(ownerId).emit('message_blocked', {
            warning: true,
            warningType: '1st_warning',
            attemptCount: 1,
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
      const key = v.ownerId || v.participantLoginId;
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
    for (const [ownerKey, list] of userGroups.entries()) {
      if (list.length < 2) {
        await Owner.updateMany({ $or: [{ loginId: ownerKey }, { _id: ownerKey }] }, { $set: { isActive: true, chatRestrictedUntil: null } });
        await User.updateMany({ loginId: ownerKey }, { $set: { status: 'active', isActive: true, chatRestrictedUntil: null } });
      }
    }
  } catch (_) {}
}, 15000);

module.exports = {
  getParticipantRoleAndName,
  isOwnerTenantChat,
  checkUserBlockStatus,
  detectViolation,
  logViolation,
  notifySuperAdminAlert,
  moderateChatMessageAsync
};
