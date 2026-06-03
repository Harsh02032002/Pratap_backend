const ElectricityMeter = require('../models/ElectricityMeter');
const Tenant = require('../models/Tenant');

/**
 * Update current meter reading for a specific room and month
 * POST /api/electricity/update-reading
 * Body: { propertyId, roomNo, billingMonth, currentReading }
 */
exports.updateMeterReading = async (req, res) => {
    try {
        const { propertyId, roomNo, billingMonth, currentReading } = req.body;

        if (!propertyId || !roomNo || !billingMonth || currentReading === undefined) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        // Find the record for the current month
        let currentRecord = await ElectricityMeter.findOne({ property: propertyId, roomNo, billingMonth });

        if (!currentRecord) {
            // Find the most recent record to get the previous reading and unit cost
            const lastRecord = await ElectricityMeter.findOne({ property: propertyId, roomNo })
                .sort({ billingMonth: -1 });
            
            const previousReading = lastRecord ? lastRecord.currentReading : 0;
            // Get unit cost from room
            const Room = require('../models/Room');
            const room = await Room.findOne({ property: propertyId, title: roomNo });
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
        currentRecord.unitsConsumed = Math.max(0, currentRecord.currentReading - currentRecord.previousReading);
        
        if (!currentRecord.unitCost) {
            const Room = require('../models/Room');
            const room = await Room.findOne({ property: propertyId, title: roomNo });
            currentRecord.unitCost = room?.electricity?.unitCost || 0;
        }
        
        currentRecord.totalBill = currentRecord.unitsConsumed * currentRecord.unitCost;
        
        await currentRecord.save();

        res.json({
            success: true,
            message: 'Reading updated successfully',
            reading: currentRecord
        });
    } catch (error) {
        console.error('updateMeterReading error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
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
 * Get active meter records for an owner's properties (Warden view)
 * GET /api/electricity/owner/:ownerLoginId
 */
exports.getOwnerReadings = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const Property = require('../models/Property');
        const Room = require('../models/Room');
        
        const properties = await Property.find({ ownerLoginId: ownerLoginId.toUpperCase() });
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
        const record = await ElectricityMeter.findByIdAndDelete(id);
        
        if (!record) {
            return res.status(404).json({ success: false, message: 'Reading not found' });
        }
        
        res.json({ success: true, message: 'Reading deleted successfully' });
    } catch (error) {
        console.error('deleteMeterReading error:', error);
        res.status(500).json({ success: false, message: 'Server error' });
    }
};
