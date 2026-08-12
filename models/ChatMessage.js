const mongoose = require('mongoose');
const crypto = require('crypto');

// Encryption helpers (AES-256-CBC)
const ENCRYPTION_KEY = process.env.MSG_ENCRYPTION_KEY || 'roomhy_chat_sec_key_32bytes_long'; // 32 bytes
const IV_LENGTH = 16;

function encryptText(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptText(text) {
  try {
    const parts = text.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = Buffer.from(parts[1], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (e) {
    return '[Decryption Failed]';
  }
}

const chatMessageSchema = new mongoose.Schema({
  room_id: { type: String, required: true, index: true },
  conversation_id: { type: String, default: null, index: true },
  sender_login_id: { type: String, required: true },
  sender_name: String,
  sender_role: {
    type: String,
    enum: ['property_owner', 'tenant', 'areamanager', 'website_user', 'superadmin']
  },
  message: { type: String, required: true },
  message_type: {
    type: String,
    enum: ['text', 'image', 'file', 'system'],
    default: 'text'
  },
  file_url: String,
  is_read: { type: Boolean, default: false },

  // Moderation fields
  is_blocked: { type: Boolean, default: false },
  is_masked: { type: Boolean, default: false },
  original_message_encrypted: { type: String, default: null }, // AES encrypted
  violation_type: {
    type: String,
    enum: ['phone', 'email', 'whatsapp', 'telegram', 'upi_payment', 'external_link', 'spam', 'abuse', 'contact_sharing', 'external_settlement', 'commission_bypass', null],
    default: null
  },
  moderation_status: {
    type: String,
    enum: ['pending_review', 'false_positive', 'action_taken', null],
    default: null
  },
  moderation_resolved_by: { type: String, default: null },

  created_at: { type: Date, default: Date.now, index: true },
  updated_at: { type: Date, default: Date.now }
});

chatMessageSchema.index({ room_id: 1, created_at: -1 });

// Automatic Moderation Pre-save Hook
chatMessageSchema.pre('save', async function(next) {
  // Only moderate text messages sent by non-system and non-superadmin users
  if (this.is_blocked || this.message_type !== 'text' || this.sender_login_id === 'system' || this.sender_role === 'superadmin') {
    return next();
  }

  try {
    let ChatSettings;
    try {
      ChatSettings = mongoose.model('ChatSettings');
    } catch (e) {
      ChatSettings = require('./ChatSettings');
    }

    const settings = await ChatSettings.findOne({ ownerLoginId: 'SUPER_ADMIN' });
    
    // Default values if settings are not found (fallback to true)
    const strict = settings ? settings.strictModeration !== false : true;
    const blockContact = settings ? settings.blockContactSharing !== false : true;

    if (!strict && !blockContact) {
      return next();
    }

    let msgText = this.message;
    const originalText = msgText;
    let violation = null;

    // 1. Check for Emails
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
    if (blockContact) {
      emailRegex.lastIndex = 0;
      const replaced = msgText.replace(emailRegex, '[MASKED EMAIL]');
      if (replaced !== msgText) {
        violation = 'email';
        msgText = replaced;
      }
    }

    // 2. Check for Phone Numbers (spaced out/formatted or raw 10 digits)
    if (blockContact) {
      const phoneRegex = /(\+?\d{1,4}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g;
      const cleanDigits = msgText.replace(/\s+/g, '').replace(/[-()]/g, '');
      const hasTenDigits = /\d{10}/.test(cleanDigits) || /\b(91|0)\d{10}\b/.test(cleanDigits);
      
      phoneRegex.lastIndex = 0;
      const hasPhonePattern = phoneRegex.test(msgText);
      
      if (hasPhonePattern || hasTenDigits) {
        if (!violation) violation = 'phone';
        phoneRegex.lastIndex = 0;
        msgText = msgText.replace(phoneRegex, '[MASKED PHONE]');
        
        const spacedDigitsRegex = /(\d\s*){10,12}/g;
        msgText = msgText.replace(spacedDigitsRegex, '[MASKED PHONE]');
        
        const rawTenDigitsRegex = /\d{10}/g;
        msgText = msgText.replace(rawTenDigitsRegex, '[MASKED PHONE]');
      }
    }

    // 3. Check for WhatsApp / Telegram links
    const socialLinksRegex = /(wa\.me|whatsapp\.com|t\.me|telegram\.me)/gi;
    if (blockContact) {
      socialLinksRegex.lastIndex = 0;
      const replaced = msgText.replace(socialLinksRegex, '[MASKED LINK]');
      if (replaced !== msgText) {
        if (!violation) violation = 'whatsapp';
        msgText = replaced;
      }
    }

    // 4. UPI Patterns
    const upiRegex = /[a-zA-Z0-9.-]+\s*@\s*(upi|ybl|paytm|okaxis|okhdfcbank|okicici|pay)/gi;
    if (strict) {
      upiRegex.lastIndex = 0;
      const replaced = msgText.replace(upiRegex, '[MASKED UPI]');
      if (replaced !== msgText) {
        if (!violation) violation = 'upi_payment';
        msgText = replaced;
      }
    }

    // 5. General External Links
    const linkRegex = /(https?:\/\/[^\s]+)/gi;
    if (blockContact) {
      linkRegex.lastIndex = 0;
      if (linkRegex.test(msgText)) {
        const lower = msgText.toLowerCase();
        const isPaymentLink =
          lower.includes('/website/pay') ||
          lower.includes('bookingid=') ||
          lower.includes('cashfree') ||
          lower.includes('razorpay') ||
          lower.includes('rzp.io') ||
          lower.includes('roomhy.com') ||
          lower.includes('localhost') ||
          lower.includes('127.0.0.1');

        if (!isPaymentLink) {
          if (!violation) violation = 'external_link';
          linkRegex.lastIndex = 0;
          msgText = msgText.replace(linkRegex, '[MASKED LINK]');
        }
      }
    }

    // 6. Abusive / Blacklisted Words (Strict moderation)
    const abuseWords = ['fuck', 'bitch', 'bastard', 'asshole', 'dick', 'chutiya', 'harami', 'saala', 'randi'];
    const spamWords = ['scam', 'fraud', 'cheat', 'pay offline', 'direct payment', 'pay directly', 'deal outside'];
    
    if (strict) {
      // Check for abuse
      for (const word of abuseWords) {
        const wordRegex = new RegExp(`\\b${word}\\b`, 'gi');
        wordRegex.lastIndex = 0;
        const replaced = msgText.replace(wordRegex, '[CENSORED]');
        if (replaced !== msgText) {
          if (!violation) violation = 'abuse';
          msgText = replaced;
        }
      }
      // Check for spam
      for (const word of spamWords) {
        const wordRegex = new RegExp(`\\b${word}\\b`, 'gi');
        wordRegex.lastIndex = 0;
        const replaced = msgText.replace(wordRegex, '[CENSORED]');
        if (replaced !== msgText) {
          if (!violation) violation = 'spam';
          msgText = replaced;
        }
      }
    }

    if (violation) {
      this.is_masked = true;
      this.violation_type = violation;
      this.moderation_status = 'pending_review';
      this.original_message_encrypted = encryptText(originalText);
      this.message = msgText;
    }
  } catch (err) {
    console.error('Error in chat message pre-save moderation hook:', err);
  }

  next();
});

// Static methods for encryption
chatMessageSchema.statics.encryptText = encryptText;
chatMessageSchema.statics.decryptText = decryptText;

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
