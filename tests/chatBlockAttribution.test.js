'use strict';

/**
 * Regression tests for the chat block that made an owner's messages vanish.
 *
 * WHAT BROKE
 * ──────────
 * ChatViolation stores two different people:
 *
 *   participantLoginId  the account that SENT the offending message
 *   ownerId             the owner of the CONVERSATION it happened in
 *
 * checkUserBlockStatus() counted both, so a tenant sharing a phone number in
 * an owner's inbox put a strike on the OWNER. Two strikes is a permanent block,
 * and a blocked account gets 403 from POST /api/chat/send — which the owner
 * panel swallowed into console.error. The owner saw their message appear and
 * then disappear, with no error and nothing saved.
 *
 * Observed in production: owner ROOMHY3259 had ONE violation of their own and
 * one committed by tenant roomhyweb043581, was counted at two, and was blocked.
 *
 * These tests drive the real checkUserBlockStatus() against stubbed models, so
 * they fail if the ownerId clause is ever put back.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const resolve = (rel) => require.resolve(path.join(ROOT, rel));

/** Minimal stand-in for a Mongoose model backed by a plain array. */
function fakeModel(rows = []) {
  const matches = (doc, cond) =>
    Object.entries(cond).every(([field, want]) => {
      if (want && typeof want === 'object' && Array.isArray(want.$in)) {
        return want.$in.includes(doc[field]);
      }
      return doc[field] === want;
    });

  const test1 = (doc, query) => {
    if (query.$or) return query.$or.some((cond) => matches(doc, cond));
    return matches(doc, query);
  };

  return {
    rows,
    updates: [],
    findOne: (query) => ({ lean: async () => rows.find((d) => test1(d, query)) || null }),
    countDocuments: async (query) => rows.filter((d) => test1(d, query)).length,
    updateOne: async (query, update) => {
      const target = rows.find((d) => test1(d, query));
      // Recorded so a test can assert WHICH account an update was aimed at.
      module.exports.lastUpdate = { query, update };
      return { matchedCount: target ? 1 : 0 };
    }
  };
}

/**
 * Load a fresh copy of moderationHelper with its model requires stubbed.
 * Stubbing through require.cache means the real function runs — only its data
 * access is replaced.
 */
function loadModerationHelper({ owners = [], users = [], violations = [] }) {
  const ownerModel = fakeModel(owners);
  const userModel = fakeModel(users);
  const violationModel = fakeModel(violations);

  const stubs = {
    'models/Owner.js': ownerModel,
    'models/user.js': userModel,
    'models/ChatViolation.js': violationModel,
    'models/ChatSettings.js': fakeModel([]),
    'services/aiModerationService.js': { moderateMessage: async () => ({ violation: false, type: 'none', confidence: 0 }) },
    'utils/superadminNotifier.js': { notifySuperadmin: async () => {} }
  };

  const injected = [];
  for (const [rel, exportsObj] of Object.entries(stubs)) {
    const id = resolve(rel);
    const stub = new Module(id, null);
    stub.filename = id;
    stub.loaded = true;
    stub.exports = exportsObj;
    require.cache[id] = stub;
    injected.push(id);
  }

  const helperId = resolve('utils/moderationHelper.js');
  delete require.cache[helperId];
  const helper = require(helperId);

  // moderationHelper installs a 15s setInterval at module scope; without this
  // the test process would never exit.
  clearIntervalsAfterLoad();

  return { helper, ownerModel, userModel, violationModel, cleanup: () => {
    for (const id of injected) delete require.cache[id];
    delete require.cache[helperId];
  } };
}

// The module-scope setInterval keeps the event loop alive. node:test would hang
// waiting for it, so it is unref'd as soon as it is created.
const realSetInterval = global.setInterval;
function clearIntervalsAfterLoad() { /* handled by the patch below */ }
global.setInterval = function patchedSetInterval(...args) {
  const handle = realSetInterval.apply(this, args);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return handle;
};

test('an owner is NOT blocked by a violation their tenant committed', async () => {
  const { helper, cleanup } = loadModerationHelper({
    owners: [{ loginId: 'ROOMHY3259', isActive: true }],
    users: [{ loginId: 'ROOMHY3259', status: 'active' }],
    // Exactly the two rows found in production.
    violations: [
      { ownerId: 'ROOMHY3259', participantLoginId: 'ROOMHY3259' },      // owner's own strike
      { ownerId: 'ROOMHY3259', participantLoginId: 'roomhyweb043581' }  // the TENANT's strike
    ]
  });

  const result = await helper.checkUserBlockStatus('ROOMHY3259');

  assert.strictEqual(
    result.blocked,
    false,
    'owner has one strike of their own — the tenant\'s strike must not count against them'
  );

  cleanup();
});

test('an account IS blocked by two violations it committed itself', async () => {
  const { helper, cleanup } = loadModerationHelper({
    owners: [{ loginId: 'ROOMHY3259', isActive: true }],
    users: [{ loginId: 'ROOMHY3259', status: 'active' }],
    violations: [
      { ownerId: 'ROOMHY3259', participantLoginId: 'ROOMHY3259' },
      { ownerId: 'ROOMHY3259', participantLoginId: 'ROOMHY3259' }
    ]
  });

  const result = await helper.checkUserBlockStatus('ROOMHY3259');

  assert.strictEqual(result.blocked, true, 'two genuine strikes must still block — moderation is not weakened');

  cleanup();
});

test('a tenant with two of their own strikes is blocked, in any casing', async () => {
  const { helper, cleanup } = loadModerationHelper({
    owners: [],
    users: [{ loginId: 'roomhyweb043581', status: 'active' }],
    violations: [
      { ownerId: 'ROOMHY3259', participantLoginId: 'roomhyweb043581' },
      { ownerId: 'ROOMHY7794', participantLoginId: 'ROOMHYWEB043581' }
    ]
  });

  const result = await helper.checkUserBlockStatus('roomhyweb043581');

  assert.strictEqual(result.blocked, true, 'both casings of the offender id must count');

  cleanup();
});

test('an account with a single strike stays unblocked (a warning, not a ban)', async () => {
  const { helper, cleanup } = loadModerationHelper({
    owners: [{ loginId: 'ROOMHY7794', isActive: true }],
    users: [{ loginId: 'ROOMHY7794', status: 'active' }],
    violations: [{ ownerId: 'ROOMHY7794', participantLoginId: 'ROOMHY7794' }]
  });

  assert.strictEqual((await helper.checkUserBlockStatus('ROOMHY7794')).blocked, false);

  cleanup();
});

test('an already-blocked account stays blocked regardless of the count', async () => {
  const { helper, cleanup } = loadModerationHelper({
    owners: [{ loginId: 'ROOMHY9999', isActive: false }],
    users: [{ loginId: 'ROOMHY9999', status: 'blocked' }],
    violations: []
  });

  const result = await helper.checkUserBlockStatus('ROOMHY9999');

  assert.strictEqual(result.blocked, true, 'an explicit block must not be undone by the counting path');

  cleanup();
});

// ─── canonical chat id ───────────────────────────────────────────────────────
// This is what folds the duplicate "same tenant, two threads" rows into one.

const { canonicalChatId, generateWebsiteUserIdFromEmail } = require('../utils/chatIdentity');

test('an email and its hash resolve to the same conversation', () => {
  const email = 'harshdeepbca503@gmail.com';
  const hash = generateWebsiteUserIdFromEmail(email);

  assert.strictEqual(hash, 'roomhyweb541955', 'the production pair this bug was found on');
  assert.strictEqual(canonicalChatId(email), hash);
  assert.strictEqual(canonicalChatId(hash), hash);
  assert.strictEqual(
    canonicalChatId(email),
    canonicalChatId(hash),
    'the lead-accept thread and the tenant\'s own replies must land on one row'
  );
});

test('email casing does not split a conversation', () => {
  assert.strictEqual(
    canonicalChatId('HarshdeepBca503@Gmail.com'),
    canonicalChatId('harshdeepbca503@gmail.com')
  );
});

test('ids that are not website-user ids are returned byte-for-byte', () => {
  // Owner and tenant record ids are real, distinct identities — collapsing them
  // would merge conversations belonging to different people.
  //
  // The case must survive too: this value is used as a Socket.IO room name in
  // both emit paths, and rooms match exactly. Lowercasing 'ROOMHY3259' here
  // would emit into a room nobody has joined and silently drop the message.
  assert.strictEqual(canonicalChatId('ROOMHY3259'), 'ROOMHY3259');
  assert.strictEqual(canonicalChatId('ROOMHYTNT6184'), 'ROOMHYTNT6184');
  assert.strictEqual(canonicalChatId('SUPER_ADMIN'), 'SUPER_ADMIN');
  assert.strictEqual(canonicalChatId('  ROOMHY3259  '), 'ROOMHY3259', 'trimmed, but not recased');
  assert.notStrictEqual(canonicalChatId('ROOMHY3259'), canonicalChatId('ROOMHY7794'));
});

test('empty and missing ids do not collapse together', () => {
  assert.strictEqual(canonicalChatId(''), '');
  assert.strictEqual(canonicalChatId(null), '');
  assert.strictEqual(canonicalChatId(undefined), '');
});
