const test = require('node:test');
const assert = require('node:assert/strict');
const { buildChatLookupVariants, generateWebsiteUserIdFromEmail } = require('../utils/chatIdentity');

test('buildChatLookupVariants includes email-derived website room IDs', () => {
  const variants = buildChatLookupVariants('roomhyweb123456', {
    email: 'tenant@example.com',
    loginId: 'tenant-login',
    userId: 'user-123'
  });

  assert.ok(variants.includes('roomhyweb123456'));
  assert.ok(variants.includes('tenant-login'));
  assert.ok(variants.includes('user-123'));
  assert.ok(variants.includes(generateWebsiteUserIdFromEmail('tenant@example.com')));
});

test('buildChatLookupVariants can derive a website room ID from an email string', () => {
  const variants = buildChatLookupVariants('tenant@example.com');
  assert.ok(variants.includes(generateWebsiteUserIdFromEmail('tenant@example.com')));
});
