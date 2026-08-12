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
  // Official system payment links (e.g. roomhy.com/website/pay, CashFree, etc.) are NEVER policy violations!
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

  // Exemption for short conversational chatter (< 4 words) without explicit phone/email/links/digits
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  const isShortChatter = words.length <= 4;
  const shortExemptPattern = /^\s*"?\s*(de|naa|na|paise|paisa|yahan|yaan|ha|haa|haan|thik|theek|bhej|bhejo|dena|karo|kro|hi|hello|ok|okay|aata|aaya|bhai|sir|mam|rent|room|ac|non ac|single|double|sharing|mil|baat|kaise|ho|acha|achha|batao|chahiye|mileyga|milraha|kab|kitna)\s*"?\s*$/i;

  const hasDigitsOrUrl = /\d{5,}|http|www|\.com|@/.test(trimmed);
  if (isShortChatter && !hasDigitsOrUrl && shortExemptPattern.test(trimmed)) {
    return { violation: null, maskedText: text };
  }
  
  const blockPhone = settings.blockPhoneNumbers !== false;
  const blockEmail = settings.blockEmails !== false;
  const blockLink = settings.blockLinks !== false;
  const strict = settings.strictModeration !== false;

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
    // Strip URLs before digit extraction so hex Mongo ObjectIds in links don't trigger false 10-digit phone detection
    const textWithoutUrls = msgText.replace(/(https?:\/\/[^\s]+|www\.[^\s]+)/gi, '');
    const cleanDigits = textWithoutUrls.replace(/[\s\-().,_/*]/g, '');
    const hasTenDigits = /\d{10}/.test(cleanDigits);
    
    // Check for spaced digits e.g. 9 8 7 6 5 4 3 2 1 0, or with hyphens/dots
    const spacedDigitsRegex = /(\d[\s\-.,_*/]*){10,12}/g;
    spacedDigitsRegex.lastIndex = 0;
    const hasSpacedDigits = spacedDigitsRegex.test(msgText);

    // Check for word-based numbers e.g. "nine eight..." including Hinglish
    const numWords = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ek', 'teen', 'chaar', 'char', 'paanch', 'panch', 'chhe', 'che', 'saat', 'aath', 'nau', 'noo', 'shunya', 'double', 'triple'];
    let wordNumCount = 0;
    const lowerText = msgText.toLowerCase();
    numWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      const matches = lowerText.match(regex);
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

  // 5. External Link Check (excluding official website domains & payment links)
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
    // Social Media Handles & Keywords
    /\B@[a-zA-Z0-9_]{3,30}\b/i,
    /\b(insta|instagram|ig|telegram|tg|facebook|fb|snapchat|snap|linkedin|twitter|x\.com|social\s+media|social\s+handle|same\s+username|handle\s+wahi)\b/i,
    
    // Email & Mail contextual checks (avoids false positives on general mail/email words)
    /\b(via|through|on|share|send|write|give|my)\s+(email|mail|gmail|yahoo|hotmail|outlook)\b/i,
    /\b(email|mail|gmail|yahoo|hotmail|outlook)\s+(id|address)\b/i,
    /\b(email|mail|gmail|yahoo|hotmail|outlook)\s+(par|pe)\s+(bhej\w*|send\w*|de\w*|share\w*|karo|kr|kro)\b/i,
    /\b(mail|email)\s+(me|mujhe|us)\b/i,
    
    // WhatsApp & Messaging Variations
    /\b(whatsapp|watsapp|watsp|wtsp|green\s+app)\b/i,
    /\b(wa|wp)\s*(pe|par|msg|message|chat|contact|no|num|number)\b/i,
    /\b(msg|message|chat|contact|no|num|number)\s*(wa|wp)\b/i,
    
    // Indirect Messaging Apps & Profile (Meta app, Purple app, Call wali app, DP, initials)
    /\b(meta|purple|call\s+wali|photo\s+sharing|meta\s+photo|reels|reels\s+wali|green|blue)\s+([a-zA-Z]*\s+)?app\b/i,
    /\bDP\s*(dikhegi|dikhe|dekh|check|profile|photo|wahi|same|pe|par)\b/i,
    /\b(profile|my|meri)\s+DP\b/i,
    /\busername\s*(wahi|same|id|handle|har\s+jagah)\b/i,
    /\bsearch\s*(kar|kr|karo|kro|lena|le|karoge)\b/i,
    /\binitials\s*(search|yaad)?\b/i,
    /\bgoogle\s*(karo|kr|kro|search|kar\s+lena)?\b/i,
    /\b(net\s+par|net\s+pe|profile\s+picture|same\s+id)\b/i,
    
    // Booking Cancellation & Platform Bypass
    /\bbooking\s+cancel\b/i,
    /\bcancel\s+booking\b/i,
    /\bcancel\s+(kardo|krdo|kar\s+do|kr\s+do|karke|krke|karna|krna|karwa|krwa)\b/i,
    /\bplatform\s*(ki|ko|se|par|fees|charge|commission|brokerage)?\s*(zaroorat|beech|mat|bachao|save|bypass|hata)\b/i,
    /\b(commission|comm|brokerage|fees|charge|charges)\s*([a-zA-Z]*\s+){0,2}(save|bach|bacha|bachao|bachayein|saving|cut|discount|kyu|kyun|bahao|nahi|na|mat|deni)\b/i,
    /\b(no\s+brokerage|save\s+commission|brokerage\s+bach|bypass\s+commission|without\s+commission)\b/i,
    
    // Payment & Arrival Bypass Patterns (Specific offline deal instructions only)
    /\b(in\s*hand|hand\s*to\s*hand|cash\s*in\s*hand|offline\s*cash|direct\s*cash)\b/i,
    /\boffline\s+(cash|payment|deal|transfer|settlement)\b/i,
    /\b(cash|payment|deal|transfer|settlement)\s+offline\b/i,
    /\bdirect\s+(cash|payment|offline|deal|account\s+transfer)\b/i,
    
    // Steering away from platform
    /\b(app|platform)\s+se\s+bahar\b/i,
    
    // Contact details request / share
    /\b(number|no|num|contact|mobile|phone|phn|call)\s+([a-zA-Z]*\s+){0,2}(bhej\w*|de\w*|share\w*|note\w*|kar|kr|karo|kro|lena|le|karta|likha)\b/i,
    /\b(bhej\w*|de\w*|share\w*|note\w*)\s+([a-zA-Z]*\s+){0,2}(number|no|num|contact|mobile|phone|phn|call)\b/i,
    /\b(call|phone|phn|baat\w*|connect\w*)\s+([a-zA-Z]*\s+){0,2}(kar|kr|karo|kro|lena|le)\b/i,
    /\bboard\s+(pe|par)\s+number\b/i,
    
    // Payment Bypass Specifics
    /\b(advance|deposit|payment|rent|money|paise|paisa|cash|account|kharcha|kharch)\s+([a-zA-Z]*\s+){0,2}(direct|offline|cash|transfer|account|bhej\w*|de\w*|mat|outside|bach|save|wahin)\b/i,
    /\b(direct|offline|cash|transfer|account|outside|bach|save|wahin)\s+([a-zA-Z]*\s+){0,2}(advance|deposit|payment|rent|money|paise|paisa|cash|account|pay\w*|kharcha|kharch)\b/i,
    
    // Coded Settlement / Bypassing terms
    /\b(dalal|middleman|beech\s+wala|teesra\s+beech)\s+(hata|mat|na)\b/i,
    /\bseedha\s+(hisaab|hisab|len\s*den|deal\w*|payment|pay\w*|malik|kirayedar|owner|tenant|baat\w*|nahi)\b/i,
    /\b(apas|aapas)\s+mein\s+(deal|payment|cash|settle|hisaab)\b/i,
    /\bscene\s+set\b/i,
    /\bopen\s+me(in)?\s+nahi\b/i,
    /\b(pg|hostel)\s+(pe|par|me|in)\s+mil\w*\b/i,
    /\bbeech\s+(ka|ko|se|me|mein|wala|wale|waale)\b/i,
    
    // Smart / Hidden Intent
    /\b(samajh\s+jao|samajh\s+gaya|samajh\s+gaye|samajh\s+rhe|samajh\s+rahe|samajhdar|ishara)\b/i,
    /\b(outside\s+website|external\s+link|other\s+website)\b/i,
    /\b(koi\s+aur\s+tareeka|skip\s+formalities|formalities\s+skip|bina\s+app)\b/i,
    
    // Specific custom sentences from user sets
    /\b(extra\s+lagega|doosra\s+option|bacha\s+sakta|dono\s+ka\s+fayda|unnecessary\s+cost|sasta\s+padega|bina\s+platform|aapka\s+benefit|benefit\s+hai|sasta\s+padega|kharcha\s+bach|bach\s+jayega|fayda\s+ho)\b/i,
    /\b(watchman|reception|gate\s+pe|owner\s+se\s+mil\w*|milkar\s+final|face\s+to\s+face\s+clear|har\s+jagah\s+isi\s+naam|net\s+par\s+mil\w*|profile\s+picture\s+pehchan|same\s+id\s+har\s+app|rules\s+ki\s+wajah|hint\s+de\s+diya|samne\s+baith|personally\s+mil\w*|property\s+par\s+mil\w*|wahin\s+details|aane\s+ke\s+baad|hostel\s+mein\s+hi|same\s+username|handle\s+wahi)\b/i,
    /\b(gate\s+pe\s+aa|watchman\s+ko\s+mera|owner\s+se\s+milwa\w*|direct\s+location|face\s+to\s+face\s+clear|har\s+jagah\s+isi\s+naam|net\s+par\s+mil\w*|google\s+kar\s+lena|search\s+karoge|same\s+id|initials\s+yaad|booking\s+ki\s+zaroorat|entry\s+ke\s+time|deposit\s+wahin|cash\s+preferred|online\s+mat|details\s+de\s+dunga|smart\s+banna|baaki\s+([a-zA-Z]*\s+){0,2}mil\w*|visit\s+ke\s+baad|property\s+par\s+mil\w*|meta\s+wali|blue\s+app|same\s+username|handle\s+wahi)\b/i,

    // Contextual property visit
    /\b(property\s+)?visit\s+([a-zA-Z]*\s+){0,3}(pe\s+)?(discuss\w*|baat\w*|final\w*|settle\w*|deal\w*|decide\w*|mil\w*|connect\w*)\b/i,
    /\b(discuss\w*|baat\w*|final\w*|settle\w*|deal\w*|decide\w*|mil\w*|connect\w*)\s+([a-zA-Z]*\s+){0,3}(pe\s+)?property\s+visit\b/i,
    
    // Milkar discuss / Baat krna milke
    /\bmil(kar|ke|te)\s+([a-zA-Z]*\s+){0,3}(discuss|baat|final|settle|deal)\b/i,
    /\b(discuss|baat|final|settle|deal)\s+([a-zA-Z]*\s+){0,3}mil(kar|ke|te)\b/i,
    
    // Baaki milne par
    /\bbaaki\s+([a-zA-Z]*\s+){0,2}mil\w*\b/i,
    
    // Wahan pahunch kar settle / decide
    /\b(wahan|wahin|location|pg|hostel|flat|apartment|gate|address)\s+([a-zA-Z]*\s+){0,3}(settle\w*|deal\w*|pay\w*|payment\w*|baat\w*|discuss\w*|final\w*|decide\w*)\b/i,
    /\b(settle\w*|deal\w*|pay\w*|payment\w*|baat\w*|discuss\w*|final\w*|decide\w*)\s+([a-zA-Z]*\s+){0,3}(wahan|wahin|location|pg|hostel|flat|apartment|gate|address)\b/i,
    
    // Online ki zaroorat nahi
    /\bonline\s+([a-zA-Z]*\s+){0,2}(mat|nahi|na|no|skip|avoid|zaroorat)\b/i,
    /\b(mat|nahi|na|no|skip|avoid|zaroorat)\s+([a-zA-Z]*\s+){0,2}online\b/i,
    
    // Bina beech wale ke / Bina beech
    /\bbina\s+([a-zA-Z]*\s+){0,2}beech\b/i,
    
    // Owner ka naam yaad rakhna
    /\b(owner|malik)\s+([a-zA-Z]*\s+){0,2}(naam|name)\b/i,
    
    // App ke bina
    /\b(app|platform)\s+([a-zA-Z]*\s+){0,2}bina\b/i,
    /\bbina\s+([a-zA-Z]*\s+){0,2}(app|platform)\b/i
  ];
  
  // Clean "payment link", official payment URLs, and "pasand aaya" to avoid false blocks on official link referrals and safe room liked indicators
  let cleanBypassText = msgText;
  const officialUrls = [
    /https?:\/\/(www\.)?roomhy\.com\/website\/pay[^\s]*/gi,
    /https?:\/\/localhost(:\d+)?\/website\/pay[^\s]*/gi,
    /https?:\/\/127\.0\.0\.1(:\d+)?\/website\/pay[^\s]*/gi
  ];
  officialUrls.forEach(urlRegex => {
    cleanBypassText = cleanBypassText.replace(urlRegex, '');
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
        const regex = new RegExp(`\\b${kw.trim()}\\b`, 'gi');
        if (regex.test(msgText)) {
          if (!violationType) violationType = 'commission_bypass';
          msgText = msgText.replace(regex, '[CENSORED]');
        }
      }
    });
  }

  return { violation: violationType, maskedText: msgText };
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

    // Cooldown check: If a violation was logged for this sender in the last 5 minutes, update snippet instead of adding a 2nd strike!
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const recentViolation = await ChatViolation.findOne({
      participantLoginId: senderLoginId,
      createdAt: { $gte: fiveMinutesAgo }
    }).sort({ createdAt: -1 });

    if (recentViolation) {
      recentViolation.messageSnippet = `${recentViolation.messageSnippet} | ${messageText}`;
      recentViolation.updatedAt = new Date();
      await recentViolation.save();
      console.log(`ℹ️ Merged split message into existing violation for ${senderLoginId}`);
      return recentViolation;
    }

    const violation = new ChatViolation({
      participantLoginId: senderLoginId,
      participantName: sender.name,
      ownerId,
      ownerName,
      tenantId,
      tenantName,
      conversationId: receiverLoginId, // room_id of chat message
      violationType,
      messageSnippet: messageText,
      messageId: messageId || null,
      status: 'New'
    });

    await violation.save();

    // Check violation count for this user/owner
    const totalViolations = await ChatViolation.countDocuments({
      $or: [
        { ownerId },
        { participantLoginId: ownerId },
        { participantLoginId: senderLoginId }
      ]
    });

    const ChatMessage = mongoose.model('ChatMessage');

    if (totalViolations === 1) {
      // Strike 1 Warning Message
      const strike1Msg = new ChatMessage({
        room_id: receiverLoginId,
        sender_login_id: 'system',
        sender_name: 'Roomhy System',
        sender_role: 'superadmin',
        message: `⚠️ ROOMHY POLICY WARNING (Strike 1 of 2): Sharing contact details, phone numbers, or offline payment deals is strictly prohibited. Next attempt will result in permanent account block.`,
        message_type: 'system',
        is_read: false
      });
      await strike1Msg.save();

      if (global.io) {
        global.io.to(receiverLoginId).emit('receive_message', strike1Msg);
        global.io.to(senderLoginId).emit('receive_message', strike1Msg);
      }
    } else if (totalViolations >= 2) {
      // Strike 2: Auto block owner and user account after 2 violations
      await Promise.allSettled([
        Owner.updateOne({ $or: [{ loginId: ownerId }, { _id: ownerId }] }, { isActive: false }),
        User.updateOne({ $or: [{ loginId: ownerId }, { _id: ownerId }] }, { status: 'blocked', isActive: false })
      ]);

      const blockWarningMsg = new ChatMessage({
        room_id: receiverLoginId,
        sender_login_id: 'system',
        sender_name: 'Roomhy System',
        sender_role: 'superadmin',
        message: `🚨 ACCOUNT BLOCKED (Strike 2 of 2): Account (${ownerName}) has been automatically suspended due to repeated policy violations (commission bypass). Chat is now closed.`,
        message_type: 'system',
        is_read: false
      });
      await blockWarningMsg.save();

      if (global.io) {
        global.io.to(receiverLoginId).emit('receive_message', blockWarningMsg);
        global.io.to(senderLoginId).emit('receive_message', blockWarningMsg);
        global.io.to('SUPER_ADMIN').emit('owner_account_blocked', { ownerId, ownerName, totalViolations });
      }
    }
 
    // Trigger Super Admin Notification & WebSocket Alert
    await notifySuperAdminAlert(violation);
 
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

// Asynchronous background moderation function using Groq AI
async function moderateChatMessageAsync(messageDoc, receiverLoginId) {
  try {
    // 1. Skip system messages, non-text, or messages that have already been moderated by AI
    if (
      !messageDoc ||
      messageDoc.sender_login_id === 'system' ||
      messageDoc.message_type === 'system' ||
      messageDoc.sender_role === 'superadmin'
    ) {
      return;
    }

    const ChatMessage = mongoose.model('ChatMessage');
    
    // Check if already moderated
    const currentMsg = await ChatMessage.findById(messageDoc._id).lean();
    if (!currentMsg || currentMsg.aiModeratedAt) {
      return;
    }

    // Determine roles
    const senderRole = messageDoc.sender_role || 'tenant';
    const receiverInfo = await getParticipantRoleAndName(receiverLoginId);
    const receiverRole = receiverInfo.role || 'property_owner';

    // Retrieve original message text if it was masked/encrypted by local pre-save hook
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

    // Fetch last 8 messages of this specific 1:1 conversation context (both directions)
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

    // Reverse them to chronological order
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
        global.io.to('SUPER_ADMIN').emit('owner_account_blocked', { ownerId, ownerName, totalViolations });
      }

      // Emit new_violation_alert to Super Admin
      await notifySuperAdminAlert(violation);
    }
  } catch (err) {
    console.error('Error in moderateChatMessageAsync:', err);
  }
}

// One-time self healing startup cleanup to unblock falsely blocked accounts & clean single-word violation logs
setTimeout(async () => {
  try {
    const ChatViolation = mongoose.model('ChatViolation');
    await ChatViolation.deleteMany({
      $or: [
        { messageSnippet: /^\s*"?\s*(yaan|yahan|paise|paisa|naa|de|de na|hi|hello|ha|haan)\s*"?\s*$/i },
        { messageSnippet: /roomhy/i },
        { messageSnippet: /bookingId/i }
      ]
    });
    // Unblock owner Harsh / ROOMHY9525 if blocked by false positives
    await Owner.updateMany({ loginId: 'ROOMHY9525' }, { $set: { isActive: true, chatRestrictedUntil: null } });
    await User.updateMany({ loginId: 'ROOMHY9525' }, { $set: { status: 'active', isActive: true, chatRestrictedUntil: null } });
    // Un-mask any payment links that were falsely masked as [MASKED LINK]
    const ChatMessage = mongoose.model('ChatMessage');
    const maskedMsgs = await ChatMessage.find({ message: /\[MASKED LINK\]/i }).lean();
    for (const m of maskedMsgs) {
      if (m.original_message_encrypted) {
        try {
          const decrypted = ChatMessage.decryptText(m.original_message_encrypted);
          if (decrypted && (decrypted.toLowerCase().includes('cashfree') || decrypted.toLowerCase().includes('/website/pay') || decrypted.toLowerCase().includes('bookingid='))) {
            await ChatMessage.updateOne({ _id: m._id }, { $set: { message: decrypted, is_blocked: false } });
          }
        } catch (_) {}
      }
    }

    console.log('✅ Self-healed false positive violations and unblocked Owner ROOMHY9525');
  } catch (_) {}
}, 2000);

module.exports = {
  getParticipantRoleAndName,
  isOwnerTenantChat,
  checkUserBlockStatus,
  detectViolation,
  logViolation,
  notifySuperAdminAlert,
  moderateChatMessageAsync
};
