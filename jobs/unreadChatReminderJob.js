'use strict';

/**
 * unreadChatReminderJob — email someone when a chat message goes unread.
 *
 * WHAT IT DOES
 * ────────────
 * A message that has sat unread for REMINDER_DELAY_MINUTES gets one reminder
 * email to the person it was sent to, pointing them at the right place to read
 * it:
 *
 *   tenant wrote, owner has not read  -> email the owner  -> Owner Panel
 *   owner wrote, tenant has not read   -> email the tenant -> website chat
 *
 * "Unread" is exactly the `is_read` flag the chat UI already maintains: both
 * panels call POST /api/chat/mark-read when the conversation is opened. So if
 * the recipient opens the thread within the delay, the message stops matching
 * and no email is ever sent. That is the intended behaviour — the reminder
 * exists for the case where nobody looked.
 *
 * WHY A JOB AND NOT A setTimeout AT SEND TIME
 * ───────────────────────────────────────────
 * A timer lives in one process's memory: it is lost on every deploy, restart
 * and crash, and under PM2 cluster mode it would fire once per worker. Reading
 * the state back from the database on a schedule survives all of that and is
 * idempotent by construction.
 *
 * SAFETY PROPERTIES
 * ─────────────────
 * • Exactly once — `reminder_email_sent_at` is stamped on every message the
 *   email covered. A message stays unread until the recipient opens the chat,
 *   so without that marker the same reminder would go out on every single run.
 *
 * • One email per conversation, not per message — five unread messages produce
 *   one email that says five, not five emails.
 *
 * • Cooldown — a conversation that keeps receiving unanswered messages will not
 *   generate a reminder more often than COOLDOWN_MINUTES. Without this, an
 *   owner sending a message every few minutes into an unread thread would
 *   trigger a reminder every few minutes.
 *
 * • Marked even on failure — if the address is unusable the messages are still
 *   stamped, so a permanently unreachable recipient cannot make the job retry
 *   the same batch forever. Delivery failures are logged.
 *
 * • Locked — reuses services/cronLockService like every other job here, so only
 *   one instance sends under PM2 cluster mode.
 */

const cron = require('node-cron');

const ChatMessage = require('../models/ChatMessage');
const Owner = require('../models/Owner');
const User = require('../models/user');
const BookingRequest = require('../models/BookingRequest');
const { acquireLock, releaseLock } = require('../services/cronLockService');
const { generateWebsiteUserIdFromEmail, canonicalChatId } = require('../utils/chatIdentity');
const { sendUnreadChatReminderEmail } = require('../utils/emailNotifications');

const JOB_NAME = 'unreadChatReminder';

/**
 * How long a message may sit unread before the reminder goes out.
 * Fixed at 10 minutes by product decision; env override exists for testing
 * (CHAT_REMINDER_DELAY_MINUTES).
 */
const REMINDER_DELAY_MINUTES = Number(process.env.CHAT_REMINDER_DELAY_MINUTES || 10);

/**
 * Minimum gap between two reminders for the same conversation, so an active
 * but unanswered thread does not email the recipient every few minutes.
 */
const COOLDOWN_MINUTES = Number(process.env.CHAT_REMINDER_COOLDOWN_MINUTES || 60);

/**
 * Never remind about a message older than this.
 *
 * Two things depend on it. First deployment: this feature is switched on over a
 * database already holding unread messages going back months — a live preview
 * found threads 146 days old still flagged unread. Without a ceiling the first
 * run would mail people about conversations they abandoned last season, which
 * is spam, and would look like a bug to everyone who received one. Second: the
 * same applies after any long outage of this job.
 *
 * Messages past the ceiling are stamped without an email, so they leave the
 * working set permanently instead of being re-evaluated on every run forever.
 */
const MAX_MESSAGE_AGE_HOURS = Number(process.env.CHAT_REMINDER_MAX_AGE_HOURS || 24);

/** Cap on one run, so a backlog cannot turn into an unbounded send loop. */
const MAX_EMAILS_PER_RUN = Number(process.env.CHAT_REMINDER_MAX_PER_RUN || 200);

/** Lock TTL — comfortably longer than a run, short enough to self-heal. */
const LOCK_TIMEOUT_MINUTES = 5;

/** How much of the message to quote in the email. */
const PREVIEW_CHARS = 160;

const MINUTE = 60 * 1000;

/**
 * Who is this room_id, and where do we send them?
 *
 * room_id is the recipient's own id, but the same person can be stored under
 * several forms (see utils/chatIdentity). Resolution order matters: Owner is
 * checked first because an owner login id is unambiguous, and only then the
 * website-user forms.
 *
 * @returns {Promise<{email:string, name:string, audience:'owner'|'tenant'}|null>}
 */
async function resolveRecipient(roomId, hashIndex) {
    const raw = String(roomId || '').trim();
    if (!raw) return null;

    // ── Owner ────────────────────────────────────────────────────────────────
    const owner = await Owner.findOne({ loginId: raw.toUpperCase() })
        .select('name email profile').lean();
    if (owner) {
        const email = owner.email || owner.profile?.email;
        if (!email) return null;
        return { email, name: owner.name || owner.profile?.name || 'there', audience: 'owner' };
    }

    // ── Website user / tenant ────────────────────────────────────────────────
    const user = await User.findOne({ $or: [{ loginId: raw }, { email: raw.toLowerCase() }] })
        .select('name fullName firstName lastName email').lean();
    if (user?.email) {
        return { email: user.email, name: displayName(user), audience: 'tenant' };
    }

    // The id IS an email — the form a website user gets when their loginId is
    // their email address.
    if (raw.includes('@')) {
        return { email: raw.toLowerCase(), name: 'there', audience: 'tenant' };
    }

    // A roomhyweb###### id is a one-way hash of an email, so it cannot be
    // reversed — it has to be looked up against known addresses. See hashIndex.
    if (/^roomhyweb\d{6}$/i.test(raw)) {
        const found = hashIndex.get(raw.toLowerCase());
        if (found) return { email: found.email, name: found.name || 'there', audience: 'tenant' };
    }

    return null;
}

function displayName(doc) {
    if (!doc) return 'there';
    return doc.name
        || doc.fullName
        || `${doc.firstName || ''} ${doc.lastName || ''}`.trim()
        || 'there';
}

/**
 * email-hash -> {email, name}, built only when a run actually needs it.
 *
 * `roomhyweb######` is a hash, so the only way back to an address is to hash
 * the addresses we know and look for a match. That means reading the email
 * column of Users and BookingRequests.
 *
 * Built lazily and only for the ids a run could not resolve any other way, so
 * a run where every recipient is an owner or a plain email does no work here
 * at all. It is still a scan, and the long-term fix is to store the website
 * chat id on the User record instead of deriving it — noted rather than done,
 * because that is a migration and this is a notification job.
 */
async function buildHashIndex(neededIds) {
    const index = new Map();
    if (neededIds.size === 0) return index;

    const add = (email, name) => {
        if (!email) return;
        const hash = generateWebsiteUserIdFromEmail(email);
        if (!hash || !neededIds.has(hash) || index.has(hash)) return;
        index.set(hash, { email: String(email).toLowerCase(), name });
    };

    const users = await User.find({ email: { $exists: true, $ne: null } })
        .select('email name fullName firstName lastName').lean();
    for (const u of users) add(u.email, displayName(u));

    if (index.size < neededIds.size) {
        const bookings = await BookingRequest.find({ email: { $exists: true, $ne: null } })
            .select('email name').lean();
        for (const b of bookings) add(b.email, b.name);
    }

    return index;
}

/** Best available human name for whoever sent the unread messages. */
async function resolveSenderName(senderLoginId, fallback) {
    if (fallback && fallback !== senderLoginId) return fallback;

    const raw = String(senderLoginId || '').trim();
    const owner = await Owner.findOne({ loginId: raw.toUpperCase() }).select('name profile').lean();
    if (owner) return owner.name || owner.profile?.name || 'Your contact';

    const user = await User.findOne({ $or: [{ loginId: raw }, { email: raw.toLowerCase() }] })
        .select('name fullName firstName lastName').lean();
    if (user) return displayName(user);

    return 'Your contact';
}

/**
 * One pass: find unread messages past the delay, group them per conversation,
 * email each recipient once, and stamp what was covered.
 *
 * @returns {Promise<{sent:number, skipped:number, conversations:number}>}
 */
async function runUnreadChatReminderJob() {
    const acquired = await acquireLock(JOB_NAME, LOCK_TIMEOUT_MINUTES);
    if (!acquired) return { sent: 0, skipped: 0, conversations: 0, lockedOut: true };

    let sent = 0;
    let skipped = 0;

    try {
        const cutoff = new Date(Date.now() - REMINDER_DELAY_MINUTES * MINUTE);
        const staleBefore = new Date(Date.now() - MAX_MESSAGE_AGE_HOURS * 60 * MINUTE);

        // Retire anything too old to be worth an email in one write, before the
        // main selector runs. This is what stops the first deployment mailing
        // people about months-old threads, and it keeps the working set small.
        const retired = await ChatMessage.updateMany(
            {
                is_read: false,
                reminder_email_sent_at: null,
                created_at: { $lt: staleBefore }
            },
            { $set: { reminder_email_sent_at: new Date() } }
        );
        if (retired?.modifiedCount) {
            console.log(`[unreadChatReminder] retired ${retired.modifiedCount} message(s) older than ${MAX_MESSAGE_AGE_HOURS}h without emailing`);
        }

        const pending = await ChatMessage.find({
            is_read: false,
            reminder_email_sent_at: null,
            created_at: { $lte: cutoff },
            // Blocked messages were withheld from the recipient, so there is
            // nothing for them to come and read. System notices are the
            // platform talking to itself.
            is_blocked: { $ne: true },
            sender_login_id: { $nin: ['system', 'System'] },
            message_type: { $ne: 'system' }
        })
            .sort({ created_at: 1 })
            .limit(MAX_EMAILS_PER_RUN * 20)
            .lean();

        if (pending.length === 0) return { sent: 0, skipped: 0, conversations: 0 };

        // Group per conversation: one email covering N messages, not N emails.
        // Keyed on recipient + canonical sender so the same person writing under
        // two id forms is still one conversation.
        const groups = new Map();
        for (const msg of pending) {
            const key = `${String(msg.room_id).trim()}::${canonicalChatId(msg.sender_login_id)}`;
            if (!groups.has(key)) {
                groups.set(key, { roomId: String(msg.room_id).trim(), senderLoginId: msg.sender_login_id, messages: [] });
            }
            groups.get(key).messages.push(msg);
        }

        // Only hash-form recipients force the address lookup, so most runs skip it.
        const needHashLookup = new Set(
            [...groups.values()]
                .map((g) => g.roomId.toLowerCase())
                .filter((id) => /^roomhyweb\d{6}$/.test(id))
        );
        const hashIndex = await buildHashIndex(needHashLookup);

        const cooldownSince = new Date(Date.now() - COOLDOWN_MINUTES * MINUTE);

        for (const group of groups.values()) {
            if (sent >= MAX_EMAILS_PER_RUN) break;

            const ids = group.messages.map((m) => m._id);

            // Cooldown: was this same CONVERSATION already reminded recently?
            //
            // Scoped to recipient + sender, not to the recipient alone. Keyed on
            // room_id only, an owner who was just reminded about one tenant
            // would have a second tenant's message stamped and silently dropped
            // — the recipient would never be told about it at all. Throttling
            // one talkative sender must not suppress a different person.
            const senderVariants = [...new Set([
                group.senderLoginId,
                String(group.senderLoginId).toLowerCase(),
                String(group.senderLoginId).toUpperCase(),
                canonicalChatId(group.senderLoginId)
            ].filter(Boolean))];

            const recent = await ChatMessage.findOne({
                room_id: group.roomId,
                sender_login_id: { $in: senderVariants },
                reminder_email_sent_at: { $gte: cooldownSince }
            }).select('_id').lean();

            if (recent) {
                // Stamp them anyway. They were consciously covered by the
                // cooldown decision, and leaving them null would make this
                // conversation re-evaluated on every run forever.
                await ChatMessage.updateMany({ _id: { $in: ids } }, { $set: { reminder_email_sent_at: new Date() } });
                skipped += 1;
                continue;
            }

            const recipient = await resolveRecipient(group.roomId, hashIndex);
            if (!recipient) {
                console.warn(`[unreadChatReminder] no email for room "${group.roomId}" — skipping ${ids.length} message(s)`);
                await ChatMessage.updateMany({ _id: { $in: ids } }, { $set: { reminder_email_sent_at: new Date() } });
                skipped += 1;
                continue;
            }

            const latest = group.messages[group.messages.length - 1];
            const senderName = await resolveSenderName(group.senderLoginId, latest.sender_name);

            const preview = String(latest.message || '').slice(0, PREVIEW_CHARS)
                + (String(latest.message || '').length > PREVIEW_CHARS ? '…' : '');

            const ok = await sendUnreadChatReminderEmail({
                to: recipient.email,
                recipientName: recipient.name,
                senderName,
                unreadCount: group.messages.length,
                preview,
                audience: recipient.audience
            });

            // Stamped whether or not the send succeeded: a bad address must not
            // make this batch retry on every run for the rest of time. The
            // failure is logged by the mailer.
            await ChatMessage.updateMany({ _id: { $in: ids } }, { $set: { reminder_email_sent_at: new Date() } });

            if (ok) sent += 1;
            else skipped += 1;
        }

        if (sent || skipped) {
            console.log(`[unreadChatReminder] ${sent} reminder(s) sent, ${skipped} skipped, across ${groups.size} conversation(s)`);
        }

        return { sent, skipped, conversations: groups.size };
    } catch (err) {
        console.error('[unreadChatReminder] run failed:', err.message);
        return { sent, skipped, conversations: 0, error: err.message };
    } finally {
        await releaseLock(JOB_NAME).catch(() => {});
    }
}

/**
 * Every 2 minutes. The delay itself is REMINDER_DELAY_MINUTES; this only sets
 * how precisely the deadline is observed, so a message is emailed between 10
 * and 12 minutes after it was sent rather than up to an hour later.
 */
function registerUnreadChatReminderJob() {
    cron.schedule('*/2 * * * *', runUnreadChatReminderJob, { name: JOB_NAME });
    console.log(
        `🕐 Unread-chat reminder job scheduled (every 2 min, reminds after ${REMINDER_DELAY_MINUTES} min unread, ` +
        `${COOLDOWN_MINUTES} min cooldown per conversation)`
    );
}

module.exports = {
    runUnreadChatReminderJob,
    registerUnreadChatReminderJob,
    resolveRecipient,
    REMINDER_DELAY_MINUTES,
    COOLDOWN_MINUTES,
    MAX_MESSAGE_AGE_HOURS,
    JOB_NAME
};
