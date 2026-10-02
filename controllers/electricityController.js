const mongoose = require('mongoose');
const ElectricityMeter = require('../models/ElectricityMeter');
const Property = require('../models/Property');
const Room = require('../models/Room');
const { syncElectricityToInvoice } = require('../services/tenantDuesService');

/**
 * Validate billingMonth format: must be YYYY-MM with valid month 01-12 (E-3)
 */
function isValidBillingMonth(billingMonth) {
    if (!billingMonth || typeof billingMonth !== 'string') return false;
    const match = billingMonth.trim().match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!match) return false;
    const year = parseInt(match[1], 10);
    return year >= 2000 && year <= 2100;
}

/**
 * Verify property ownership / management authorization based on req.user (E-4, E-5, E-6, E-7)
 */
async function verifyPropertyAccess(req, propertyId) {
    if (!req.user) return { authorized: false, reason: 'unauthenticated' };

    const role = (req.user.role || '').toLowerCase();
    const userLoginId = String(req.user.loginId || req.user.id || '').toUpperCase();
    const parentLoginId = String(req.user.parentLoginId || '').toUpperCase();

    // Superadmin and areamanager have global system access
    if (role === 'superadmin' || role === 'admin' || role === 'areamanager') {
        return { authorized: true };
    }

    if (!propertyId) return { authorized: false, reason: 'missing_property_id' };

    const property = await Property.findById(propertyId).select('ownerLoginId').lean();
    if (!property) return { authorized: false, reason: 'property_not_found' };

    const ownerLoginId = String(property.ownerLoginId || '').toUpperCase();

    // Owner check: caller's loginId must match property's ownerLoginId
    if (role === 'owner') {
        if (userLoginId === ownerLoginId) return { authorized: true, property };
        return { authorized: false, reason: 'not_property_owner' };
    }

    // Warden / Employee / Staff check: caller's parentLoginId must match property's ownerLoginId
    if (role === 'employee' || role === 'staff' || role === 'warden' || role === 'manager') {
        if (parentLoginId === ownerLoginId || userLoginId === ownerLoginId) {
            return { authorized: true, property };
        }
        return { authorized: false, reason: 'warden_not_assigned_to_owner' };
    }

    // Fallback check
    if (userLoginId === ownerLoginId) return { authorized: true, property };

    return { authorized: false, reason: 'unauthorized_role' };
}

/**
 * Helper to safely start a Mongoose transaction if replica set is active
 */
async function startSafeSession() {
    try {
        const session = await mongoose.startSession();
        session.startTransaction();
        return session;
    } catch (_) {
        // Fallback for single-node standalone MongoDB (transactions not supported)
        return null;
    }
}

/**
 * Update current meter reading for a specific room and month
 * POST /api/electricity/update-reading
 * Body: { propertyId, roomNo, billingMonth, currentReading, previousReading? }
 */
exports.updateMeterReading = async (req, res) => {
    let session = null;
    try {
        const { propertyId, roomNo, billingMonth, currentReading, previousReading: reqPreviousReading } = req.body;

        if (!propertyId || !roomNo || !billingMonth || currentReading === undefined) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // E-3: Strict billingMonth format validation
        if (!isValidBillingMonth(billingMonth)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid billingMonth format. Must be YYYY-MM with valid month 01-12 (e.g. 2026-09).'
            });
        }

        // E-4: Property ownership authorization check
        const access = await verifyPropertyAccess(req, propertyId);
        if (!access.authorized) {
            return res.status(403).json({
                success: false,
                message: `Not authorized to update meter readings for this property (${access.reason}).`
            });
        }

        // E-1: Start session transaction if supported
        session = await startSafeSession();
        const options = session ? { session } : {};

        // Find existing record for current month
        let currentRecord = await ElectricityMeter.findOne({ property: propertyId, roomNo, billingMonth }, null, options);

        if (!currentRecord) {
            const lastRecord = await ElectricityMeter.findOne({ property: propertyId, roomNo }, null, options)
                .sort({ billingMonth: -1 });

            const previousReading = lastRecord ? lastRecord.currentReading : 0;
            const room = await Room.findOne({ property: propertyId, title: roomNo }, null, options);
            const unitCost = room?.electricity?.unitCost || (lastRecord ? lastRecord.unitCost : 0);

            currentRecord = new ElectricityMeter({
                property: propertyId,
                roomNo,
                billingMonth,
                previousReading,
                unitCost,
                status: 'unbilled'
            });
        }

        // Calculate usage and bill
        currentRecord.currentReading = Number(currentReading);
        if (reqPreviousReading !== undefined && reqPreviousReading !== null && reqPreviousReading !== "") {
            currentRecord.previousReading = Number(reqPreviousReading);
        }
        currentRecord.unitsConsumed = Math.max(0, currentRecord.currentReading - currentRecord.previousReading);

        if (!currentRecord.unitCost) {
            const room = await Room.findOne({ property: propertyId, title: roomNo }, null, options);
            currentRecord.unitCost = room?.electricity?.unitCost || 0;
        }

        currentRecord.totalBill = currentRecord.unitsConsumed * currentRecord.unitCost;

        await currentRecord.save(options);

        let invoiceSync = { synced: false };
        try {
            invoiceSync = await syncElectricityToInvoice(propertyId, roomNo, billingMonth, currentRecord, options);
            if (!invoiceSync.synced) {
                console.warn('[electricityController] invoice sync skipped:', invoiceSync.reason, { propertyId, roomNo, billingMonth });
            }
        } catch (linkErr) {
            console.error('[electricityController] invoice link error:', linkErr.message);
            invoiceSync = { synced: false, reason: linkErr.message };
        }

        if (session) {
            await session.commitTransaction();
            session.endSession();
            session = null;
        }

        res.json({
            success: true,
            message: invoiceSync.synced
                ? 'Reading saved and added to tenant dues'
                : 'Reading saved (tenant invoice not linked — check room has an active tenant)',
            reading: currentRecord,
            invoiceSync,
        });
    } catch (error) {
        if (session) {
            try { await session.abortTransaction(); session.endSession(); } catch (_) {}
        }
        console.error('updateMeterReading error:', error);
        res.status(500).json({ success: false, message: 'Server error: ' + error.message });
    }
};

/**
 * Get meter history log for a specific tenant
 * GET /api/electricity/history/:tenantId
 */
exports.getMeterHistory = async (req, res) => {
    try {
        const { tenantId } = req.params;
        const history = await ElectricityMeter.find({ tenant: tenantId })
            .sort({ billingMonth: -1 });

        res.json({ success: true, history });
    } catch (error) {
        console.error('getMeterHistory error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Get active meter records for an owner's properties (Warden/Owner view)
 * GET /api/electricity/owner/:ownerLoginId
 */
exports.getOwnerReadings = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const { propertyId } = req.query;

        // E-5: Validate authorization on owner readings lookup
        const role = (req.user?.role || '').toLowerCase();
        const userLoginId = String(req.user?.loginId || req.user?.id || '').toUpperCase();
        const parentLoginId = String(req.user?.parentLoginId || '').toUpperCase();
        const targetOwnerLoginId = String(ownerLoginId || '').toUpperCase();

        const isAuthorized = role === 'superadmin' ||
            role === 'admin' ||
            role === 'areamanager' ||
            (role === 'owner' && userLoginId === targetOwnerLoginId) ||
            ((role === 'employee' || role === 'staff' || role === 'warden' || role === 'manager') && (parentLoginId === targetOwnerLoginId || userLoginId === targetOwnerLoginId));

        if (!isAuthorized) {
            return res.status(403).json({
                success: false,
                message: 'Not authorized to view electricity readings for this owner.'
            });
        }

        const propertyFilter = { ownerLoginId: targetOwnerLoginId };
        if (propertyId) propertyFilter._id = propertyId;
        const properties = await Property.find(propertyFilter);
        const propertyIds = properties.map(p => p._id);

        const rooms = await Room.find({ property: { $in: propertyIds } }).populate('property', 'title');

        const readings = await ElectricityMeter.find({ property: { $in: propertyIds } })
            .sort({ billingMonth: -1 });

        // Group by room
        const results = rooms.map(room => {
            const roomReadings = readings.filter(r =>
                String(r.property) === String(room.property._id) &&
                String(r.roomNo) === String(room.title)
            );
            return {
                roomId: room._id,
                roomNo: room.title,
                propertyId: room.property._id,
                propertyTitle: room.property.title,
                roomUnitCost: room.electricity?.unitCost || 0,
                history: roomReadings,
                latest: roomReadings[0] || null
            };
        });

        res.json({ success: true, data: results });
    } catch (error) {
        console.error('getOwnerReadings error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Delete a specific meter reading
 * DELETE /api/electricity/:id
 */
exports.deleteMeterReading = async (req, res) => {
    try {
        const { id } = req.params;
        const record = await ElectricityMeter.findById(id);

        if (!record) {
            return res.status(404).json({ success: false, message: 'Reading not found' });
        }

        // E-6: Property ownership check prior to deletion
        const access = await verifyPropertyAccess(req, record.property);
        if (!access.authorized) {
            return res.status(403).json({
                success: false,
                message: `Not authorized to delete meter readings for this property (${access.reason}).`
            });
        }

        await ElectricityMeter.deleteOne({ _id: id });

        res.json({ success: true, message: 'Reading deleted successfully' });
    } catch (error) {
        console.error('deleteMeterReading error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};

/**
 * Bulk update meter readings (Warden/Owner one-shot table entry)
 * POST /api/electricity/bulk-update
 * Body: { readings: [{propertyId, roomNo, billingMonth, currentReading, previousReading?}] }
 */
exports.bulkUpdateReadings = async (req, res) => {
    let session = null;
    try {
        const { readings } = req.body;
        if (!Array.isArray(readings) || readings.length === 0) {
            return res.status(400).json({ success: false, message: 'readings array is required' });
        }

        // E-7: Transaction + authorization check across all bulk entries
        session = await startSafeSession();
        const options = session ? { session } : {};
        const results = [];

        for (const entry of readings) {
            const { propertyId, roomNo, billingMonth, currentReading, previousReading: reqPreviousReading } = entry;
            if (!propertyId || !roomNo || !billingMonth || currentReading === undefined) {
                results.push({ roomNo, success: false, message: 'Missing fields' });
                continue;
            }

            // E-3: Validate billingMonth format per entry
            if (!isValidBillingMonth(billingMonth)) {
                results.push({ roomNo, success: false, message: 'Invalid billingMonth format (YYYY-MM required)' });
                continue;
            }

            // E-7: Property authorization per entry
            const access = await verifyPropertyAccess(req, propertyId);
            if (!access.authorized) {
                results.push({ roomNo, success: false, message: `Not authorized for this property (${access.reason})` });
                continue;
            }

            try {
                let currentRecord = await ElectricityMeter.findOne({ property: propertyId, roomNo, billingMonth }, null, options);
                if (!currentRecord) {
                    const lastRecord = await ElectricityMeter.findOne({ property: propertyId, roomNo }, null, options).sort({ billingMonth: -1 });
                    const room = await Room.findOne({ property: propertyId, title: roomNo }, null, options);
                    currentRecord = new ElectricityMeter({
                        property: propertyId,
                        roomNo,
                        billingMonth,
                        previousReading: lastRecord ? lastRecord.currentReading : 0,
                        unitCost: room?.electricity?.unitCost || (lastRecord ? lastRecord.unitCost : 0),
                        status: 'unbilled'
                    });
                }
                currentRecord.currentReading = Number(currentReading);
                if (reqPreviousReading !== undefined && reqPreviousReading !== null && reqPreviousReading !== '') {
                    currentRecord.previousReading = Number(reqPreviousReading);
                }
                currentRecord.unitsConsumed = Math.max(0, currentRecord.currentReading - currentRecord.previousReading);
                if (!currentRecord.unitCost) {
                    const room = await Room.findOne({ property: propertyId, title: roomNo }, null, options);
                    currentRecord.unitCost = room?.electricity?.unitCost || 0;
                }
                currentRecord.totalBill = currentRecord.unitsConsumed * currentRecord.unitCost;
                await currentRecord.save(options);
                try { await syncElectricityToInvoice(propertyId, roomNo, billingMonth, currentRecord, options); } catch (_) {}
                results.push({ roomNo, success: true, reading: currentRecord });
            } catch (e) {
                results.push({ roomNo, success: false, message: e.message });
            }
        }

        if (session) {
            await session.commitTransaction();
            session.endSession();
            session = null;
        }

        const saved = results.filter(r => r.success).length;
        res.json({ success: true, message: `${saved}/${readings.length} readings saved`, results });
    } catch (error) {
        if (session) {
            try { await session.abortTransaction(); session.endSession(); } catch (_) {}
        }
        console.error('bulkUpdateReadings error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
