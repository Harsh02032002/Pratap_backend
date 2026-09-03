function generateWebsiteUserIdFromEmail(email) {
  const safeEmail = String(email || '').trim().toLowerCase();
  if (!safeEmail) return '';
  let hash = 0;
  for (let i = 0; i < safeEmail.length; i += 1) {
    hash = (hash * 31 + safeEmail.charCodeAt(i)) % 1000000;
  }
  return `roomhyweb${String(hash).padStart(6, '0')}`;
}

function normalizeWebsiteUserId(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (/^roomhyweb\d{6}$/i.test(value)) return value;
  const digits = value.replace(/\D/g, '').slice(-6);
  if (digits.length === 6) return `roomhyweb${digits}`;
  return '';
}

function buildChatLookupVariants(rawId, user = {}) {
  const variants = new Set();
  const add = (value) => {
    if (!value) return;
    const plain = String(value).trim();
    if (!plain) return;
    variants.add(plain);
    variants.add(plain.toLowerCase());
    variants.add(plain.toUpperCase());
  };

  add(rawId);
  add(normalizeWebsiteUserId(rawId));
  if (typeof rawId === 'string' && rawId.includes('@')) {
    add(generateWebsiteUserIdFromEmail(rawId));
  }
  add(generateWebsiteUserIdFromEmail(user.email));
  add(normalizeWebsiteUserId(user.loginId));
  add(normalizeWebsiteUserId(user.userId));
  add(user.loginId);
  add(user.userId);
  add(user.email);
  return Array.from(variants);
}

/**
 * The single id a website user's conversation is filed under.
 *
 * WHY THIS EXISTS
 * ───────────────
 * One website user reaches chat under several different strings:
 *
 *   harshdeepbca503@gmail.com   the email, used when their User.loginId is an
 *                               email (WebsiteChat resolves loginId first)
 *   roomhyweb541955             the email hash, which is what EVERY backend
 *                               creation path mints — chatRoutes POST /create,
 *                               enquiryController's lead-accept, bookingController
 *   ROOMHYTNT6184               a tenant record minted later for the same person
 *
 * room_id is a raw string, so those are three separate conversations. That is
 * why accepting a lead and then chatting produced a SECOND "Harshdeep Kaur" row
 * in the owner's inbox: the welcome message was filed under the hash while the
 * tenant's own replies were filed under their email.
 *
 * Collapsing on the hash — rather than on the email — is deliberate: the hash is
 * already the form the creation paths write, so no existing thread has to be
 * rewritten for the two halves to meet. This is a READ-TIME normalisation only;
 * nothing stored is modified, and buildChatLookupVariants still resolves every
 * historical form, so messages sent under the old id stay visible.
 *
 * Ids that are not website-user ids (owner ids, ROOMHYTNT*, 'system',
 * SUPER_ADMIN) are returned untouched.
 */
function canonicalChatId(rawId) {
  const value = String(rawId || '').trim();
  if (!value) return '';
  if (/^roomhyweb\d{6}$/i.test(value)) return value.toLowerCase();
  if (value.includes('@')) return generateWebsiteUserIdFromEmail(value) || value;
  return value;
}

module.exports = {
  generateWebsiteUserIdFromEmail,
  normalizeWebsiteUserId,
  buildChatLookupVariants,
  canonicalChatId
};
