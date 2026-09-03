'use strict';

/**
 * Behavioural tests for jobs/unreadChatReminderJob.
 *
 * The real job function runs; only its data access and its mail transport are
 * stubbed. What is being pinned down here is the stuff that turns a helpful
 * nudge into a spam complaint: how many emails come out, who they go to, and
 * whether a message can be reminded about twice.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const resolve = (rel) => require.resolve(path.join(ROOT, rel));

const MINUTE = 60 * 1000;
const minutesAgo = (n) => new Date(Date.now() - n * MINUTE);

/** Does `doc` satisfy a (small subset of) Mongo query operators? */
function matches(doc, query) {
    return Object.entries(query).every(([field, cond]) => {
        const value = doc[field];
        if (field === '$or') return cond.some((c) => matches(doc, c));
        if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
            if ('$in' in cond) return cond.$in.includes(value);
            if ('$nin' in cond) return !cond.$nin.includes(value);
            if ('$ne' in cond) return value !== cond.$ne;
            if ('$lte' in cond) return value != null && new Date(value) <= new Date(cond.$lte);
            if ('$gte' in cond) return value != null && new Date(value) >= new Date(cond.$gte);
            // $lt/$gt must be handled explicitly. Falling through to `return
            // true` made the staleness sweep match every document and retire
            // the whole fixture, which failed nine unrelated tests.
            if ('$lt' in cond) return value != null && new Date(value) < new Date(cond.$lt);
            if ('$gt' in cond) return value != null && new Date(value) > new Date(cond.$gt);
            if ('$exists' in cond) return (value !== undefined) === cond.$exists;
            return true;
        }
        return value === cond;
    });
}

function chainable(rows) {
    const api = {
        sort: () => api,
        limit: () => api,
        select: () => api,
        lean: async () => rows
    };
    return api;
}

function fakeModel(rows = []) {
    return {
        rows,
        find: (query = {}) => chainable(rows.filter((d) => matches(d, query))),
        findOne: (query = {}) => {
            const hit = rows.find((d) => matches(d, query)) || null;
            const api = { select: () => api, lean: async () => hit };
            return api;
        },
        updateMany: async (query, update) => {
            const set = update.$set || {};
            let n = 0;
            for (const doc of rows) {
                if (!matches(doc, query)) continue;
                Object.assign(doc, set);
                n += 1;
            }
            return { modifiedCount: n };
        }
    };
}

/** In-memory `_id: {$in: [...]}` support for updateMany. */
function withIdIn(model) {
    const original = model.updateMany;
    model.updateMany = async (query, update) => {
        if (query._id && query._id.$in) {
            const wanted = new Set(query._id.$in.map(String));
            const set = update.$set || {};
            let n = 0;
            for (const doc of model.rows) {
                if (!wanted.has(String(doc._id))) continue;
                Object.assign(doc, set);
                n += 1;
            }
            return { modifiedCount: n };
        }
        return original(query, update);
    };
    return model;
}

function loadJob({ messages = [], owners = [], users = [], bookings = [] }) {
    const sentEmails = [];

    const messageModel = withIdIn(fakeModel(messages));

    const stubs = {
        'models/ChatMessage.js': messageModel,
        'models/Owner.js': fakeModel(owners),
        'models/user.js': fakeModel(users),
        'models/BookingRequest.js': fakeModel(bookings),
        'services/cronLockService.js': { acquireLock: async () => true, releaseLock: async () => {} },
        'utils/emailNotifications.js': {
            sendUnreadChatReminderEmail: async (args) => { sentEmails.push(args); return true; }
        }
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

    const jobId = resolve('jobs/unreadChatReminderJob.js');
    delete require.cache[jobId];
    const job = require(jobId);

    return {
        job,
        sentEmails,
        messages: messageModel.rows,
        cleanup: () => { injected.forEach((id) => delete require.cache[id]); delete require.cache[jobId]; }
    };
}

const OWNER = { loginId: 'ROOMHY3259', name: 'Prajesh Kamal', email: 'owner@example.com' };
const TENANT = { loginId: 'harsh@example.com', email: 'harsh@example.com', name: 'Harshdeep Kaur' };

const unreadMsg = (over = {}) => ({
    _id: `m${Math.random().toString(36).slice(2)}`,
    room_id: 'ROOMHY3259',
    sender_login_id: 'harsh@example.com',
    sender_name: 'Harshdeep Kaur',
    message: 'hello, is the room still available?',
    message_type: 'text',
    is_read: false,
    is_blocked: false,
    reminder_email_sent_at: null,
    created_at: minutesAgo(15),
    ...over
});

test('a message unread past the delay emails the owner, pointing at the Owner Panel', async () => {
    const { job, sentEmails, cleanup } = loadJob({
        messages: [unreadMsg()], owners: [OWNER], users: [TENANT]
    });

    const result = await job.runUnreadChatReminderJob();

    assert.strictEqual(result.sent, 1);
    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].to, 'owner@example.com');
    assert.strictEqual(sentEmails[0].audience, 'owner', 'a tenant writing to an owner must route to the Owner Panel');
    assert.strictEqual(sentEmails[0].senderName, 'Harshdeep Kaur');

    cleanup();
});

test('an owner writing to a tenant emails the tenant instead', async () => {
    const { job, sentEmails, cleanup } = loadJob({
        messages: [unreadMsg({ room_id: 'harsh@example.com', sender_login_id: 'ROOMHY3259', sender_name: 'Prajesh Kamal' })],
        owners: [OWNER],
        users: [TENANT]
    });

    await job.runUnreadChatReminderJob();

    assert.strictEqual(sentEmails.length, 1);
    assert.strictEqual(sentEmails[0].to, 'harsh@example.com');
    assert.strictEqual(sentEmails[0].audience, 'tenant', 'an owner writing to a tenant must route to the website chat');

    cleanup();
});

test('several unread messages produce ONE email that counts them', async () => {
    const { job, sentEmails, cleanup } = loadJob({
        messages: [unreadMsg(), unreadMsg(), unreadMsg()], owners: [OWNER], users: [TENANT]
    });

    await job.runUnreadChatReminderJob();

    assert.strictEqual(sentEmails.length, 1, 'three unread messages must not send three emails');
    assert.strictEqual(sentEmails[0].unreadCount, 3);

    cleanup();
});

test('a reminded message is never reminded again', async () => {
    const ctx = loadJob({ messages: [unreadMsg()], owners: [OWNER], users: [TENANT] });

    await ctx.job.runUnreadChatReminderJob();
    assert.strictEqual(ctx.sentEmails.length, 1);
    assert.ok(ctx.messages[0].reminder_email_sent_at, 'the message must be stamped');

    // The recipient still has not opened the chat, so it is still unread.
    await ctx.job.runUnreadChatReminderJob();
    assert.strictEqual(ctx.sentEmails.length, 1, 'a second run must not re-send');

    ctx.cleanup();
});

test('messages younger than the delay are left alone', async () => {
    // Fixtures are derived from the job's own configured delay rather than
    // hard-coded to 10, so temporarily dialling the delay down for manual
    // testing does not turn this suite red for the wrong reason.
    const rows = [];
    const { job, sentEmails, cleanup } = loadJob({ messages: rows, owners: [OWNER], users: [TENANT] });

    rows.push(unreadMsg({ created_at: minutesAgo(job.REMINDER_DELAY_MINUTES / 2) }));

    await job.runUnreadChatReminderJob();
    assert.strictEqual(sentEmails.length, 0, `a message younger than ${job.REMINDER_DELAY_MINUTES} min must not be emailed`);

    cleanup();
});

test('a message the recipient already opened is not reminded', async () => {
    const { job, sentEmails, cleanup } = loadJob({
        messages: [unreadMsg({ is_read: true })], owners: [OWNER], users: [TENANT]
    });

    await job.runUnreadChatReminderJob();
    assert.strictEqual(sentEmails.length, 0, 'reading the chat within the delay cancels the reminder');

    cleanup();
});

test('system notices and blocked messages never generate a reminder', async () => {
    const { job, sentEmails, cleanup } = loadJob({
        messages: [
            unreadMsg({ sender_login_id: 'system', message_type: 'system' }),
            // Withheld from the recipient, so there is nothing for them to read.
            unreadMsg({ is_blocked: true })
        ],
        owners: [OWNER],
        users: [TENANT]
    });

    await job.runUnreadChatReminderJob();
    assert.strictEqual(sentEmails.length, 0);

    cleanup();
});

test('the cooldown stops a busy unanswered thread emailing repeatedly', async () => {
    const rows = [];
    const { job, sentEmails, cleanup } = loadJob({ messages: rows, owners: [OWNER], users: [TENANT] });

    // Reminded half a cooldown ago — i.e. still inside it, whatever it is set to.
    rows.push(unreadMsg({ reminder_email_sent_at: minutesAgo(job.COOLDOWN_MINUTES / 2) }));
    rows.push(unreadMsg());

    const result = await job.runUnreadChatReminderJob();

    assert.strictEqual(sentEmails.length, 0, 'a conversation reminded inside the cooldown must wait');
    assert.strictEqual(result.skipped, 1);

    cleanup();
});

test('a recipient with no resolvable email is skipped and not retried forever', async () => {
    const ctx = loadJob({
        messages: [unreadMsg({ room_id: 'UNKNOWN_PARTY_9999' })], owners: [OWNER], users: [TENANT]
    });

    const result = await ctx.job.runUnreadChatReminderJob();

    assert.strictEqual(ctx.sentEmails.length, 0);
    assert.strictEqual(result.skipped, 1);
    assert.ok(
        ctx.messages[0].reminder_email_sent_at,
        'must still be stamped, or every future run re-evaluates the same dead address'
    );

    ctx.cleanup();
});

test('a website user stored as an email hash is resolved back to their address', async () => {
    const { generateWebsiteUserIdFromEmail } = require('../utils/chatIdentity');
    const hash = generateWebsiteUserIdFromEmail('harsh@example.com');

    const { job, sentEmails, cleanup } = loadJob({
        messages: [unreadMsg({ room_id: hash, sender_login_id: 'ROOMHY3259', sender_name: 'Prajesh Kamal' })],
        owners: [OWNER],
        users: [{ loginId: 'someoneelse', email: 'harsh@example.com', name: 'Harshdeep Kaur' }]
    });

    await job.runUnreadChatReminderJob();

    assert.strictEqual(sentEmails.length, 1, 'a roomhyweb###### room must still reach a real inbox');
    assert.strictEqual(sentEmails[0].to, 'harsh@example.com');
    assert.strictEqual(sentEmails[0].audience, 'tenant');

    cleanup();
});

test('months-old unread messages are retired silently, never emailed', async () => {
    // The state a first deployment actually meets: a live preview of this
    // database found unread threads 146 days old. Mailing people about those
    // would be spam and would read as a bug to everyone who got one.
    const ctx = loadJob({
        messages: [unreadMsg({ created_at: minutesAgo(146 * 24 * 60) })],
        owners: [OWNER],
        users: [TENANT]
    });

    await ctx.job.runUnreadChatReminderJob();

    assert.strictEqual(ctx.sentEmails.length, 0, 'a 146-day-old message must not generate an email');
    assert.ok(ctx.messages[0].reminder_email_sent_at, 'but it must be stamped so it leaves the working set');

    ctx.cleanup();
});

test('a message inside the age ceiling is still emailed normally', async () => {
    const { job, sentEmails, cleanup } = loadJob({
        messages: [unreadMsg({ created_at: minutesAgo(90) })], owners: [OWNER], users: [TENANT]
    });

    await job.runUnreadChatReminderJob();
    assert.strictEqual(sentEmails.length, 1, 'the staleness guard must not swallow recent messages');

    cleanup();
});

test('two different conversations each get their own email', async () => {
    const { job, sentEmails, cleanup } = loadJob({
        messages: [
            unreadMsg(),
            unreadMsg({ sender_login_id: 'other@example.com', sender_name: 'Radhe Shyam' })
        ],
        owners: [OWNER],
        users: [TENANT, { loginId: 'other@example.com', email: 'other@example.com', name: 'Radhe Shyam' }]
    });

    await job.runUnreadChatReminderJob();

    assert.strictEqual(sentEmails.length, 2, 'messages from two different people are two conversations');
    assert.deepStrictEqual(sentEmails.map((e) => e.senderName).sort(), ['Harshdeep Kaur', 'Radhe Shyam']);

    cleanup();
});
