const mongoose = require('mongoose');
const BookingRequest = require('../models/BookingRequest');
const Notification = require('../models/Notification');
const User = require('../models/user');
const mailer = require('../utils/mailer');
const { sendTemplateToResolvedUser, resolvePhoneByEmailOrUserId } = require('../utils/whatsappBot');

/**
 * Determine match category based on tenant bid amount and property rent amount.
 * Gap threshold set to ₹2,500.
 */
function determineMatchCategory(bidAmount, rentAmount) {
    const bid = Number(bidAmount || 0);
    const rent = Number(rentAmount || 0);
    if (!bid || !rent) return 'no_match_active';
    if (rent <= bid) {
        return 'exact_match';
    } else if (rent <= bid + 2500) {
        return 'slight_gap';
    } else {
        return 'no_match_active';
    }
}

/**
 * Trigger auto-matching notifications for existing active tenant bids when a new property is created or approved.
 */
async function notifyMatchingBidsForNewProperty(propertyDoc) {
    try {
        if (!propertyDoc) return { success: false, reason: 'no_property_doc' };
        
        const propertyName = propertyDoc.propertyName || propertyDoc.name || propertyDoc.title || 'Property';
        const city = propertyDoc.city || '';
        const area = propertyDoc.area || propertyDoc.location || '';
        const rent = Number(propertyDoc.monthlyRent || propertyDoc.price || propertyDoc.rent || 0);

        if (!rent) return { success: false, reason: 'no_rent_specified' };

        // Search active pending bids in same city/area where bid_amount + 2500 >= property rent
        const query = {
            request_type: 'bid',
            status: 'pending',
            is_expired: { $ne: true }
        };

        if (city) {
            query.$or = [
                { city: new RegExp(`^${city.trim()}$`, 'i') },
                { area: new RegExp(`^${area.trim()}$`, 'i') }
            ];
        }

        const activeBids = await BookingRequest.find(query).lean();
        console.log(`🔍 Auto-match scanner checking ${activeBids.length} active bids for new property: ${propertyName} (Rent: ₹${rent})`);

        let notifyCount = 0;
        for (const bid of activeBids) {
            const tenantBidAmount = Number(bid.bid_amount || 0);
            if (tenantBidAmount + 2500 >= rent) {
                const isExact = rent <= tenantBidAmount;
                const matchTypeLabel = isExact ? 'Exact Budget Match' : 'Slight Budget Gap (Within ₹2,500)';

                const title = `🎉 New Matching Property Available!`;
                const message = isExact
                    ? `Great news! A new property "${propertyName}" in ${area || city} is available right in your budget of ₹${tenantBidAmount}/month!`
                    : `Good news! A new property "${propertyName}" in ${area || city} (Rent: ₹${rent}) is available near your budget. The owner can negotiate rent with you.`;

                // 1. In-App Notification for Tenant
                try {
                    await Notification.create({
                        toRole: 'tenant',
                        toLoginId: bid.user_id,
                        from: 'Roomhy Matching Engine',
                        type: 'bid_auto_match',
                        meta: {
                            title,
                            message,
                            propertyName,
                            rentAmount: rent,
                            bidAmount: tenantBidAmount,
                            matchType: matchTypeLabel,
                            propertyId: String(propertyDoc._id || propertyDoc.visitId || '')
                        },
                        read: false
                    });
                    notifyCount++;
                } catch (nErr) {
                    console.warn('Failed auto-match notification save:', nErr.message);
                }

                // 2. Email Notification to Tenant
                if (bid.email) {
                    try {
                        const emailSubject = `🔔 New Matching Property Found: ${propertyName}`;
                        const emailHtml = `
                            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                                <div style="background: #0FA596; color: #ffffff; padding: 20px; text-align: center;">
                                    <h2 style="margin: 0; font-size: 20px;">New Property Match Found!</h2>
                                </div>
                                <div style="padding: 24px; color: #1e293b; line-height: 1.6;">
                                    <p>Hi <strong>${bid.name || 'Student'}</strong>,</p>
                                    <p>${message}</p>
                                    <div style="background: #f8fafc; padding: 16px; border-radius: 8px; border-left: 4px solid #0FA596; margin: 16px 0;">
                                        <p style="margin: 4px 0;"><strong>Property:</strong> ${propertyName}</p>
                                        <p style="margin: 4px 0;"><strong>Location:</strong> ${area || city}</p>
                                        <p style="margin: 4px 0;"><strong>Rent:</strong> ₹${rent.toLocaleString('en-IN')}/month</p>
                                        <p style="margin: 4px 0;"><strong>Your Bid:</strong> ₹${tenantBidAmount.toLocaleString('en-IN')}/month</p>
                                    </div>
                                    <p>Log in to your Roomhy account to check the details and chat with the property owner.</p>
                                </div>
                            </div>
                        `;
                        await mailer.sendMail(bid.email, emailSubject, message, emailHtml);
                    } catch (eErr) {
                        console.warn('Failed auto-match email:', eErr.message);
                    }
                }

                // 3. WhatsApp Notification to Tenant
                if (bid.phone) {
                    try {
                        const waText = `🔔 *Roomhy Alert: New Matching Property Found!*\n\nHi ${bid.name || 'Student'},\n\nA new property *${propertyName}* in ${area || city} (Rent: ₹${rent.toLocaleString('en-IN')}) matches your bid requirement of ₹${tenantBidAmount.toLocaleString('en-IN')}.\n\nCheck your Roomhy app now to connect with the owner!`;
                        const targetPhone = bid.phone || await resolvePhoneByEmailOrUserId({ email: bid.email, userId: bid.user_id });
                        if (targetPhone && mailer.sendWhatsAppMessage && mailer.getMailerConfig) {
                            await mailer.sendWhatsAppMessage(targetPhone, waText, mailer.getMailerConfig());
                        }
                    } catch (wErr) {
                        console.warn('Failed auto-match WhatsApp:', wErr.message);
                    }
                }
            }
        }

        console.log(`✅ Auto-match notifications dispatched to ${notifyCount} matching tenant bids.`);
        return { success: true, notifiedCount: notifyCount };
    } catch (err) {
        console.error('❌ Error in notifyMatchingBidsForNewProperty:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Sweeper job to expire bids older than 24 hours and send 24-hour expiry notifications.
 */
async function expireOldBids() {
    try {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        const expiredBids = await BookingRequest.find({
            request_type: 'bid',
            status: 'pending',
            is_expired: { $ne: true },
            created_at: { $lt: twentyFourHoursAgo }
        });

        if (!expiredBids || expiredBids.length === 0) {
            return { success: true, expiredCount: 0 };
        }

        console.log(`⌛ Expiring ${expiredBids.length} bids older than 24 hours...`);

        let count = 0;
        for (const bid of expiredBids) {
            bid.status = 'rejected';
            bid.is_expired = true;
            bid.expired_at = new Date();
            await bid.save();
            count++;

            const propertyName = bid.property_name || 'Property';
            const tenantName = bid.name || 'Student';
            const bidAmount = Number(bid.bid_amount || 0);

            const title = "⌛ Bid Expired (24 Hours)";
            const message = `Your bid of ₹${bidAmount.toLocaleString('en-IN')} for "${propertyName}" has expired after 24 hours as the owner did not respond. Your requirement remains ACTIVE in our system for future property matches!`;

            // 1. In-App Notification
            try {
                await Notification.create({
                    toRole: 'tenant',
                    toLoginId: bid.user_id,
                    from: 'Roomhy System',
                    type: 'bid_expired_24h',
                    meta: {
                        title,
                        message,
                        bookingId: String(bid._id),
                        propertyName,
                        bidAmount
                    },
                    read: false
                });
            } catch (nErr) {
                console.warn('Expiry notification save warning:', nErr.message);
            }

            // 2. Email Notification
            if (bid.email) {
                try {
                    const emailSubject = `⌛ Bid Update: 24-Hour Expiry for ${propertyName}`;
                    const emailHtml = `
                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden;">
                            <div style="background: #f59e0b; color: #ffffff; padding: 20px; text-align: center;">
                                <h2 style="margin: 0; font-size: 20px;">24-Hour Bid Expiry Notice</h2>
                            </div>
                            <div style="padding: 24px; color: #1e293b; line-height: 1.6;">
                                <p>Hi <strong>${tenantName}</strong>,</p>
                                <p>${message}</p>
                                <div style="background: #fffbeb; padding: 16px; border-radius: 8px; border-left: 4px solid #f59e0b; margin: 16px 0;">
                                    <p style="margin: 4px 0;"><strong>Property:</strong> ${propertyName}</p>
                                    <p style="margin: 4px 0;"><strong>Offered Bid:</strong> ₹${bidAmount.toLocaleString('en-IN')}/month</p>
                                    <p style="margin: 4px 0;"><strong>Requirement Status:</strong> Active for Auto-Matching</p>
                                </div>
                                <p>You can submit a new bid anytime or browse other properties on Roomhy.</p>
                            </div>
                        </div>
                    `;
                    await mailer.sendMail(bid.email, emailSubject, message, emailHtml);
                } catch (eErr) {
                    console.warn('Expiry email warning:', eErr.message);
                }
            }

            // 3. WhatsApp Notification
            if (bid.phone) {
                try {
                    const waText = `⌛ *Roomhy Alert: Bid Expired (24 Hours)*\n\nHi ${tenantName},\n\nYour bid of ₹${bidAmount.toLocaleString('en-IN')} for *${propertyName}* has expired after 24 hours. Your requirement remains ACTIVE in our system for future property matches!`;
                    const targetPhone = bid.phone || await resolvePhoneByEmailOrUserId({ email: bid.email, userId: bid.user_id });
                    if (targetPhone && mailer.sendWhatsAppMessage && mailer.getMailerConfig) {
                        await mailer.sendWhatsAppMessage(targetPhone, waText, mailer.getMailerConfig());
                    }
                } catch (wErr) {
                    console.warn('Expiry WhatsApp warning:', wErr.message);
                }
            }
        }

        console.log(`✅ Expired ${count} bids and sent 24h expiry notifications.`);
        return { success: true, expiredCount: count };
    } catch (err) {
        console.error('❌ Error in expireOldBids:', err.message);
        return { success: false, error: err.message };
    }
}

module.exports = {
    determineMatchCategory,
    notifyMatchingBidsForNewProperty,
    expireOldBids
};
