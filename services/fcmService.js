const admin = require('firebase-admin');
const User = require('../models/user');
const Owner = require('../models/Owner');
const Tenant = require('../models/Tenant');
const Employee = require('../models/Employee');

let isFcmInitialized = false;

// Initialize Firebase Admin SDK if credentials are available in environment
try {
    let serviceAccount = null;

    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
        } catch (e) {
            console.error('[FCM] ❌ Error parsing FIREBASE_SERVICE_ACCOUNT_JSON:', e.message);
        }
    } else if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
        serviceAccount = {
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        };
    }

    if (serviceAccount && serviceAccount.projectId) {
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        isFcmInitialized = true;
        console.log('[FCM] ✅ Firebase Admin SDK initialized successfully!');
    } else {
        console.log('[FCM] ℹ️ Firebase credentials not set in .env yet. FCM Push running in simulation mode.');
    }
} catch (error) {
    console.error('[FCM] ⚠️ FCM initialization skipped:', error.message);
}

/**
 * Helper to search across Owner, User, Tenant, Employee models for a loginId / ID / Phone
 */
async function findAccount(userIdOrLoginId) {
    if (!userIdOrLoginId) return null;
    const str = String(userIdOrLoginId).trim();
    const isObjectId = /^[0-9a-fA-F]{24}$/.test(str);
    const regex = new RegExp(`^${str}$`, 'i');

    const query = isObjectId
        ? { $or: [{ _id: str }, { loginId: regex }, { phone: str }] }
        : { $or: [{ loginId: regex }, { phone: str }] };

    // 1. Check Owner model
    let acc = await Owner.findOne(query);
    if (acc) return { doc: acc, type: 'owner' };

    // 2. Check User model
    acc = await User.findOne(query);
    if (acc) return { doc: acc, type: 'user' };

    // 3. Check Tenant model
    acc = await Tenant.findOne(query);
    if (acc) return { doc: acc, type: 'tenant' };

    // 4. Check Employee model
    acc = await Employee.findOne(query);
    if (acc) return { doc: acc, type: 'employee' };

    return null;
}

/**
 * Register or update an FCM / WebPush token for a user or owner
 */
async function registerToken(userIdOrLoginId, token, deviceType = 'web') {
    if (!token) return { success: false, message: 'Token is required' };

    try {
        const found = await findAccount(userIdOrLoginId);
        if (!found) {
            console.warn(`[FCM] ⚠️ Target account not found for loginId/ID: "${userIdOrLoginId}"`);
            return { success: false, message: 'Account not found' };
        }

        const { doc, type } = found;
        if (!doc.fcmTokens) doc.fcmTokens = [];

        // Check if token already exists
        const existingIndex = doc.fcmTokens.findIndex(t => t.token === token);
        if (existingIndex > -1) {
            doc.fcmTokens[existingIndex].deviceType = deviceType;
            doc.fcmTokens[existingIndex].updatedAt = new Date();
        } else {
            doc.fcmTokens.push({ token, deviceType, updatedAt: new Date() });
        }

        await doc.save();
        console.log(`[FCM] 📱 Token registered for ${type} ${doc.name || doc.loginId || userIdOrLoginId} (${deviceType})`);
        return { success: true, message: `Token registered successfully for ${type}` };
    } catch (err) {
        console.error('[FCM] Error registering token:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Remove an FCM token (e.g. on logout)
 */
async function removeToken(userIdOrLoginId, token) {
    try {
        const found = await findAccount(userIdOrLoginId);
        if (found) {
            found.doc.fcmTokens = (found.doc.fcmTokens || []).filter(t => t.token !== token);
            await found.doc.save();
        }
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

/**
 * Send push notification to a single FCM / WebPush Token
 */
async function sendToToken(token, notificationPayload) {
    const { title, body, icon = '/logo.png', data = {}, clickAction = '/' } = notificationPayload;

    if (!isFcmInitialized) {
        console.log(`[FCM-SIMULATION] 📤 Push to token ${token.substring(0, 10)}...: "${title}" - "${body}"`);
        return { success: true, simulated: true };
    }

    try {
        const message = {
            token: token,
            notification: {
                title: title,
                body: body
            },
            data: {
                click_action: clickAction,
                ...data
            },
            webpush: {
                notification: {
                    title: title,
                    body: body,
                    icon: icon,
                    click_action: clickAction
                }
            }
        };

        const response = await admin.messaging().send(message);
        console.log(`[FCM] 📤 Notification sent successfully. Message ID: ${response}`);
        return { success: true, messageId: response };
    } catch (error) {
        console.error('[FCM] ❌ Error sending push notification:', error.message);
        // Clean up invalid or unregistered tokens
        if (error.code === 'messaging/registration-token-not-registered' || error.code === 'messaging/invalid-registration-token') {
            await User.updateMany({}, { $pull: { fcmTokens: { token } } });
            await Owner.updateMany({}, { $pull: { fcmTokens: { token } } });
            await Tenant.updateMany({}, { $pull: { fcmTokens: { token } } });
        }
        return { success: false, error: error.message };
    }
}

/**
 * Send push notification to a specific user or owner by loginId or userId across all their registered devices
 */
async function sendToUser(userIdOrLoginId, notificationPayload) {
    try {
        const found = await findAccount(userIdOrLoginId);
        if (!found || !found.doc.fcmTokens || found.doc.fcmTokens.length === 0) {
            console.log(`[FCM] No registered push tokens for target: ${userIdOrLoginId}`);
            return { success: false, message: 'No registered FCM tokens' };
        }

        const { doc, type } = found;
        const results = await Promise.all(
            doc.fcmTokens.map(t => sendToToken(t.token, notificationPayload))
        );

        console.log(`[FCM] 📤 Push sent to ${type} ${doc.loginId || userIdOrLoginId} across ${doc.fcmTokens.length} device(s)`);
        return { success: true, count: doc.fcmTokens.length, results };
    } catch (err) {
        console.error('[FCM] Error sending to user:', err);
        return { success: false, error: err.message };
    }
}

/**
 * Send push notification to all users of a specific Role (e.g. 'tenant', 'owner', 'superadmin', 'employee')
 */
async function sendToRole(role, notificationPayload) {
    try {
        let modelsToQuery = [];
        const normalizedRole = String(role).toLowerCase();
        if (normalizedRole.includes('owner')) modelsToQuery.push(Owner);
        if (normalizedRole.includes('tenant')) modelsToQuery.push(Tenant);
        if (normalizedRole.includes('employee') || normalizedRole.includes('staff')) modelsToQuery.push(Employee);
        modelsToQuery.push(User);

        let allTokens = [];
        for (const Model of modelsToQuery) {
            const docs = await Model.find({ 'fcmTokens.0': { $exists: true } });
            docs.forEach(d => {
                if (Array.isArray(d.fcmTokens)) {
                    d.fcmTokens.forEach(t => { if (t.token) allTokens.push(t.token); });
                }
            });
        }

        if (allTokens.length === 0) {
            console.log(`[FCM] No tokens found for role: ${role}`);
            return { success: false, message: `No active tokens for role ${role}` };
        }

        console.log(`[FCM] 📣 Broadcasting push notification to role "${role}" (${allTokens.length} devices)...`);
        const results = await Promise.all(allTokens.map(t => sendToToken(t, notificationPayload)));
        return { success: true, targetCount: allTokens.length, results };
    } catch (err) {
        console.error(`[FCM] Error broadcasting to role ${role}:`, err);
        return { success: false, error: err.message };
    }
}

module.exports = {
    registerToken,
    removeToken,
    sendToToken,
    sendToUser,
    sendToRole,
    isInitialized: () => isFcmInitialized
};
