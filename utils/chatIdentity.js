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

module.exports = {
  generateWebsiteUserIdFromEmail,
  normalizeWebsiteUserId,
  buildChatLookupVariants
};
