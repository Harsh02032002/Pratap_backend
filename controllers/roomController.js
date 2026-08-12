const mongoose = require('mongoose');
const Room = require('../models/Room');
const Property = require('../models/Property');
const Notification = require('../models/Notification');
const User = require('../models/user');

// Owner adds a room to their property. Room is created with status 'inactive'.
exports.sendPaymentLink = async (req, res) => {
  try {
    const { roomId } = req.params;
    if (!roomId) return res.status(400).json({ success: false, message: 'Room ID required' });
    const mongoose = require('mongoose');
    if (!mongoose.Types.ObjectId.isValid(roomId)) {
      return res.status(400).json({ success: false, message: 'Invalid Room ID format' });
    }
    const room = await Room.findById(roomId).lean();
    if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
    // Attempt to locate tenant assigned to this room
    const Tenant = require('../models/Tenant');
    let tenant = null;
    if (Array.isArray(room.bedAssignments) && room.bedAssignments.length) {
      const occupied = room.bedAssignments.find(b => b && b.tenantId);
      if (occupied) tenant = await Tenant.findById(occupied.tenantId).lean();
    }
    if (!tenant) {
      tenant = await Tenant.findOne({ room: roomId, status: { $in: ['active', 'pending'] } }).lean();
    }
    if (!tenant) {
      return res.status(404).json({ success: false, message: 'No tenant assigned to this room' });
    }
    const baseUrl = process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'https://app.roomhy.com';
    const paymentLink = `${baseUrl}/pay?roomId=${roomId}&tenantId=${tenant._id}`;
    return res.json({ success: true, paymentLink });
  } catch (err) {
    console.error('sendPaymentLink error:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

exports.createRoom = async (req, res) => {
    try {
        const propertyId = req.body.propertyId || req.body.property;
        const title = req.body.title || req.body.number || req.body.roomNo;
        const type = req.body.type || req.body.roomType || 'AC';
        const beds = Number(req.body.beds || req.body.capacity || 1);
        const price = Number(req.body.price || req.body.rent || req.body.roomRent || 0);
        const user = req.user;
        if (!user) return res.status(401).json({ message: 'Auth required' });
        if (!['owner', 'propertyowner', 'manager', 'superadmin'].includes(user.role)) {
            return res.status(403).json({ message: 'Only owners can add rooms' });
        }
        if (!propertyId) return res.status(400).json({ message: 'Property ID is required' });
        if (!title || !String(title).trim()) return res.status(400).json({ message: 'Room title is required' });

        const property = await Property.findById(propertyId).lean();
        if (!property) return res.status(404).json({ message: 'Property not found' });

        // Superadmin can add to any property
        // Owner must own the property (match by _id OR by loginId OR by ownerLoginId in request body)
        const requestOwnerLoginId = String(req.body.ownerLoginId || user.loginId || '').toUpperCase();
        const ownerMatches =
            user.role === 'superadmin' ||
            (property.owner && property.owner.toString() === user._id.toString()) ||
            (property.ownerLoginId && String(property.ownerLoginId).toUpperCase() === String(user.loginId || '').toUpperCase()) ||
            (property.ownerLoginId && requestOwnerLoginId && String(property.ownerLoginId).toUpperCase() === requestOwnerLoginId);
        if (!ownerMatches) {
            return res.status(403).json({ message: 'You can only add rooms to your assigned property' });
        }

        const room = await Room.create({
            property: propertyId,
            title: String(title).trim(),
            type: String(type).trim() || 'AC',
            beds: Number.isFinite(beds) && beds > 0 ? beds : 1,
            price: Number.isFinite(price) && price >= 0 ? price : 0,
            unitType: req.body.unitType || 'Room',
            floor: req.body.floor || '',
            sharingType: req.body.sharingType || '',
            remarks: req.body.remarks || '',
            isAvailable: req.body.isAvailable !== undefined ? req.body.isAvailable : true,
            facilities: req.body.facilities || [],
            roomTypeFeatures: req.body.roomTypeFeatures || [],
            media: req.body.media || [],
            electricity: {
                unitCost: Number(req.body.electricityUnitCost) || 0,
                readings: []
            },
            createdBy: user._id,
            status: 'inactive'
        });

        // Notify superadmins and owner
        try {
            const notifications = [];
            const superAdmins = await User.find({ role: 'superadmin' }).lean();
            superAdmins.forEach(sa => notifications.push(Notification.create({
                toRole: 'superadmin',
                toLoginId: sa.loginId || '',
                from: String(user.loginId || user._id || 'owner'),
                type: 'room_added',
                meta: {
                    roomId: room._id,
                    propertyId,
                    propertyTitle: property.title || '',
                    roomTitle: String(title).trim()
                }
            })));
            if (user.loginId) {
                notifications.push(Notification.create({
                    toRole: 'owner',
                    toLoginId: String(user.loginId),
                    from: String(user.loginId),
                    type: 'room_added_owner',
                    meta: {
                        roomId: room._id,
                        propertyId,
                        propertyTitle: property.title || '',
                        roomTitle: String(title).trim()
                    }
                }));
            }
            await Promise.all(notifications);
        } catch (notifyErr) {
            console.warn('createRoom notification warning:', notifyErr.message);
        }

        return res.status(201).json({ success: true, room });
    } catch (err) {
        console.error(err);
        return res.status(500).json({ message: 'Server error' });
    }
};

exports.bulkCreateRooms = async (req, res) => {
    try {
        const { propertyId, rooms } = req.body;
        const user = req.user;
        if (!user) return res.status(401).json({ message: 'Auth required' });
        if (!['owner', 'propertyowner', 'manager', 'superadmin'].includes(user.role)) {
            return res.status(403).json({ message: 'Only owners can add rooms' });
        }
        if (!propertyId) return res.status(400).json({ message: 'Property ID is required' });
        if (!Array.isArray(rooms) || rooms.length === 0) return res.status(400).json({ message: 'Rooms array is required' });

        const property = await Property.findById(propertyId).lean();
        if (!property) return res.status(404).json({ message: 'Property not found' });

        const requestOwnerLoginId = String(req.body.ownerLoginId || user.loginId || '').toUpperCase();
        const ownerMatches =
            user.role === 'superadmin' ||
            (property.owner && property.owner.toString() === user._id.toString()) ||
            (property.ownerLoginId && String(property.ownerLoginId).toUpperCase() === String(user.loginId || '').toUpperCase()) ||
            (property.ownerLoginId && requestOwnerLoginId && String(property.ownerLoginId).toUpperCase() === requestOwnerLoginId);
        if (!ownerMatches) {
            return res.status(403).json({ message: 'You can only add rooms to your assigned property' });
        }

        const roomsToInsert = rooms.map(roomData => ({
            property: propertyId,
            title: String(roomData.title || roomData.roomNo || '').trim(),
            type: String(roomData.type || roomData.roomType || 'AC').trim(),
            beds: Number.isFinite(Number(roomData.beds || roomData.capacity || 1)) ? Number(roomData.beds || roomData.capacity || 1) : 1,
            price: Number.isFinite(Number(roomData.price || roomData.rent || 0)) ? Number(roomData.price || roomData.rent || 0) : 0,
            unitType: roomData.unitType || 'Room',
            floor: roomData.floor || '',
            sharingType: roomData.sharingType || '',
            remarks: roomData.remarks || '',
            isAvailable: roomData.isAvailable !== undefined ? roomData.isAvailable : true,
            facilities: roomData.facilities || [],
            roomTypeFeatures: roomData.roomTypeFeatures || [],
            media: roomData.media || [],
            electricity: {
                unitCost: Number(roomData.electricityUnitCost) || 0,
                readings: []
            },
            createdBy: user._id,
            status: 'inactive'
        }));

        const insertedRooms = await Room.insertMany(roomsToInsert);

        return res.status(201).json({ success: true, rooms: insertedRooms });
    } catch (err) {
        console.error('bulkCreateRooms error:', err);
        return res.status(500).json({ message: 'Server error' });
    }
};




exports.getRoomsByProperty = async (req, res) => {
    try {
        const { propertyId } = req.params;
        const { unassigned } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 0;
        console.log("Searching rooms for propertyId:", propertyId, "unassigned:", unassigned, "page:", page, "limit:", limit);
        
        // Ensure propertyId is a valid ObjectId
        if (!mongoose.Types.ObjectId.isValid(propertyId)) {
          return res.status(400).json({ message: "Invalid Property ID format" });
        }
        
        // We skip syncing occupancy during paginated fetches to improve speed
        if (!limit) {
            try {
                const ownerController = require('./ownercontroller');
                await ownerController.syncPropertyOccupancyData(propertyId);
            } catch (syncErr) {
                console.error(`❌ Error syncing occupancy during getRoomsByProperty for property ${propertyId}:`, syncErr.message);
            }
        }

        const query = { property: new mongoose.Types.ObjectId(propertyId), isDeleted: { $ne: true } };
        let roomsQuery = Room.find(query).populate('property', 'title');
        
        if (limit > 0) {
            roomsQuery = roomsQuery.skip((page - 1) * limit).limit(limit);
        }
        
        let rooms = await roomsQuery.lean();
// Fallback generation: if no rooms found, generate from property roomTypes
if (rooms.length === 0) {
    const selectedProp = await Property.findById(propertyId).lean();
    if (selectedProp && Array.isArray(selectedProp.roomTypes)) {
        selectedProp.roomTypes.forEach(rt => {
            const count = parseInt(rt.totalRooms) || 0;
            const bedsCount = parseInt(rt.occupancy) || parseInt(rt.totalBeds) || 1;
            const priceVal = Number(rt.pricePerBed || rt.pricePerRoom || 0);
            for (let i = 1; i <= count; i++) {
                rooms.push({
                    _id: `${rt.type}-${i}`,
                    title: `${rt.type} - Room ${i}`,
                    type: rt.type,
                    beds: bedsCount,
                    price: priceVal,
                    property: propertyId
                });
            }
        });
    }
}

        if (unassigned === 'true') {
            const Tenant = require('../models/Tenant');
            const tenants = await Tenant.find({
                property: new mongoose.Types.ObjectId(propertyId),
                status: { $in: ['active', 'pending'] }
            }).select('roomNo room').lean();
            
            // Count tenants per room
            const tenantCountByRoomNo = {};
            const tenantCountByRoomId = {};
            
            tenants.forEach(t => {
                if (t.room) {
                    const rId = t.room.toString();
                    tenantCountByRoomId[rId] = (tenantCountByRoomId[rId] || 0) + 1;
                }
                if (t.roomNo) {
                    const rNo = String(t.roomNo).trim().toLowerCase();
                    tenantCountByRoomNo[rNo] = (tenantCountByRoomNo[rNo] || 0) + 1;
                }
            });
            
            rooms = rooms.filter(room => {
                const countById = tenantCountByRoomId[room._id.toString()] || 0;
                const countByNo = tenantCountByRoomNo[String(room.title).trim().toLowerCase()] || 0;
                const activeCount = Math.max(countById, countByNo);
                const capacity = Array.isArray(room.beds)
                    ? (room.beds.length || Number(room.capacity || room.totalBeds) || 1)
                    : (Number(room.beds || room.capacity || room.totalBeds) || 1);
                return activeCount < capacity;
            });
        }
        
        const total = await Room.countDocuments(query);
        console.log(`Found ${rooms.length} rooms for property ${propertyId}`);
        res.json({ success: true, rooms, total });
    } catch (err) {
        console.error("Error in getRoomsByProperty:", err);
        res.status(500).json({ message: err.message });
    }
};

// Add electricity reading to a room
exports.addElectricityReading = async (req, res) => {
    try {
        const { roomId } = req.params;
        const { unitCost, initialReading, initialReadingDate, finalReading, finalReadingDate, description } = req.body;

        if (!mongoose.Types.ObjectId.isValid(roomId)) {
            return res.status(400).json({ message: "Invalid Room ID format" });
        }

        if (!initialReading || !initialReadingDate || !finalReading || !finalReadingDate) {
            return res.status(400).json({ message: "All reading fields are required" });
        }

        const room = await Room.findById(roomId);
        if (!room) {
            return res.status(404).json({ message: "Room not found" });
        }

        // Calculate units consumed and total cost
        const unitsConsumed = Number(finalReading) - Number(initialReading);
        const cost = unitCost || room.electricity?.unitCost || 0;
        const totalCost = unitsConsumed * cost;

        // Update unit cost if provided
        if (unitCost) {
            room.electricity = room.electricity || {};
            room.electricity.unitCost = unitCost;
        }

        // Add reading
        room.electricity = room.electricity || { unitCost: 0, readings: [] };
        room.electricity.readings = room.electricity.readings || [];
        room.electricity.readings.push({
            initialReading: Number(initialReading),
            initialReadingDate: new Date(initialReadingDate),
            finalReading: Number(finalReading),
            finalReadingDate: new Date(finalReadingDate),
            unitsConsumed,
            totalCost,
            description: description || ''
        });

        await room.save();

        return res.status(201).json({ 
            success: true, 
            message: "Reading added successfully",
            reading: room.electricity.readings[room.electricity.readings.length - 1],
            room 
        });
    } catch (err) {
        console.error("Error adding electricity reading:", err);
        return res.status(500).json({ message: err.message });
    }
};

// Get electricity readings for a room
exports.getElectricityReadings = async (req, res) => {
    try {
        const { roomId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(roomId)) {
            return res.status(400).json({ message: "Invalid Room ID format" });
        }

        const room = await Room.findById(roomId).populate('property', 'title ownerLoginId').lean();
        if (!room) {
            return res.status(404).json({ message: "Room not found" });
        }

        return res.json({
            success: true,
            room: {
                _id: room._id,
                title: room.title,
                property: room.property,
                electricity: room.electricity || { unitCost: 0, readings: [] }
            }
        });
    } catch (err) {
        console.error("Error fetching electricity readings:", err);
        return res.status(500).json({ message: err.message });
    }
};

// Get all rooms for an owner
exports.getRoomsByOwner = async (req, res) => {
    try {
        const { ownerLoginId } = req.params;
        const normalizedOwnerId = String(ownerLoginId || '').trim().toUpperCase();
        const limit = parseInt(req.query.limit) || 0;
        const { propertyId } = req.query;

        // Dynamically import ownerController to prevent circular dependency issues
        const ownerController = require('./ownercontroller');
        await ownerController.healOwnerProperties(normalizedOwnerId);

        const propertyFilter = { ownerLoginId: normalizedOwnerId, isDeleted: { $ne: true } };
        if (propertyId) propertyFilter._id = propertyId;
        const properties = await Property.find(propertyFilter).lean();

        const propertyIds = properties.map(p => p._id);
        
        let rooms = [];
        const propertyTotals = {};

        if (limit > 0) {
            // Fetch limited rooms per property
            for (const propId of propertyIds) {
                const propRooms = await Room.find({ property: propId, isDeleted: { $ne: true } })
                                            .populate('property', 'title')
                                            .limit(limit)
                                            .lean();
                const total = await Room.countDocuments({ property: propId, isDeleted: { $ne: true } });
                rooms.push(...propRooms);
                propertyTotals[propId.toString()] = total;
            }
        } else {
            // Fetch all rooms
            rooms = await Room.find({ property: { $in: propertyIds }, isDeleted: { $ne: true } }).populate('property', 'title').lean();
            for (const propId of propertyIds) {
                propertyTotals[propId.toString()] = rooms.filter(r => String(r.property?._id || r.property) === propId.toString()).length;
            }
        }

        res.json({ success: true, rooms, propertyTotals });
    } catch (err) {
        console.error("Error getting rooms by owner:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// Toggle promoted status
exports.togglePromoted = async (req, res) => {
    try {
        const { roomId } = req.params;
        const room = await Room.findById(roomId);
        if (!room) {
            return res.status(404).json({ success: false, message: "Room not found" });
        }
        room.isPromoted = !room.isPromoted;
        await room.save();
        res.json({ success: true, room });
    } catch (err) {
        console.error("Error toggling promoted status:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// Update a room
exports.updateRoom = async (req, res) => {
    try {
        const { roomId } = req.params;
        const updateData = { ...req.body };
        
        // Ensure electricity unit cost maps properly if provided
        if (updateData.electricityUnitCost !== undefined) {
            updateData['electricity.unitCost'] = Number(updateData.electricityUnitCost);
            delete updateData.electricityUnitCost;
        }

        // Automatically sync beds count with sharingType if provided
        if (updateData.sharingType) {
            const sType = String(updateData.sharingType).trim();
            if (sType === 'Single Sharing' || sType === 'Private Room (No Sharing)') updateData.beds = 1;
            else if (sType === 'Double Sharing') updateData.beds = 2;
            else if (sType === 'Triple Sharing') updateData.beds = 3;
            else if (sType === 'Four Sharing') updateData.beds = 4;
            else if (updateData.roomBeds) updateData.beds = Number(updateData.roomBeds);
        } else if (updateData.roomBeds) {
            updateData.beds = Number(updateData.roomBeds);
        }

        const room = await Room.findById(roomId);
        if (!room) {
            return res.status(404).json({ success: false, message: "Room not found" });
        }

        // Check if media/photos are actually being changed - requires admin approval.
        // The edit form always echoes the room's existing photos back in the payload even
        // when the owner only changed an unrelated field (e.g. bed count), so this must
        // compare against the room's current media rather than just checking "is present" —
        // otherwise every edit to a room that already has photos gets silently diverted into
        // the pending-approval queue instead of applying immediately.
        const incomingMediaUrls = (Array.isArray(updateData.media) ? updateData.media : [])
            .map(m => (m && typeof m === 'object' ? m.url : m))
            .filter(Boolean)
            .sort();
        const currentMediaUrls = (Array.isArray(room.media) ? room.media : [])
            .map(m => (m && typeof m === 'object' ? m.url : m))
            .filter(Boolean)
            .sort();
        const hasMediaUpdate = incomingMediaUrls.length > 0 &&
            JSON.stringify(incomingMediaUrls) !== JSON.stringify(currentMediaUrls);
        
        if (hasMediaUpdate) {
            // Save changes to pendingChanges for admin approval instead of applying live
            room.pendingChanges = {
                data: updateData,
                status: 'pending',
                requestedAt: new Date(),
                requestedBy: req.user?.loginId || room.ownerLoginId || 'owner'
            };
            await room.save();

            // Send approval request notification to superadmins
            try {
                const superAdmins = await User.find({ role: 'superadmin' }).lean();
                for (const sa of superAdmins) {
                    await Notification.create({
                        toRole: 'superadmin',
                        toLoginId: sa.loginId || '',
                        from: req.user?.loginId || 'owner',
                        type: 'room_media_approval',
                        message: `New room photos uploaded for "${room.title}" by owner. Pending review and live website approval.`,
                        meta: {
                            roomId: room._id.toString(),
                            roomTitle: room.title,
                            propertyId: room.property?.toString()
                        }
                    });
                }
            } catch (notifyErr) {
                console.warn('Room media superadmin notification failed:', notifyErr.message);
            }

            return res.json({ 
                success: true, 
                message: "Room photo upload submitted for admin approval. Changes will go live after approval.",
                room,
                requiresApproval: true
            });
        }

        // For non-media updates, apply directly
        const updatedRoom = await Room.findByIdAndUpdate(roomId, { $set: updateData }, { new: true });
        res.json({ success: true, message: "Room updated successfully", room: updatedRoom });
    } catch (err) {
        console.error("Error updating room:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// Approve pending room changes
exports.approveRoomChanges = async (req, res) => {
    try {
        const { roomId } = req.params;
        const room = await Room.findById(roomId);
        if (!room) {
            return res.status(404).json({ success: false, message: "Room not found" });
        }
        if (!room.pendingChanges || room.pendingChanges.status !== 'pending') {
            return res.status(400).json({ success: false, message: "No pending changes for this room" });
        }

        const requestedBy = room.pendingChanges.requestedBy;
        const hasMediaChanges = room.pendingChanges.data?.media && Array.isArray(room.pendingChanges.data.media);

        // Apply changes
        const data = room.pendingChanges.data;
        if (data) {
            Object.keys(data).forEach(key => {
                if (key.startsWith('electricity.')) {
                    const subKey = key.split('.')[1];
                    if (!room.electricity) room.electricity = {};
                    room.electricity[subKey] = data[key];
                } else {
                    room[key] = data[key];
                }
            });
        }

        room.pendingChanges.status = 'approved';
        // Clear data but keep record of approval
        room.pendingChanges.data = null;
        await room.save();

        // Send notification to owner
        try {
            const Notification = require('../models/Notification');
            const message = hasMediaChanges 
                ? `Your room photos for "${room.title}" have been approved and are now live on the website.`
                : `Your room changes for "${room.title}" have been approved and applied successfully.`;

            await Notification.create({
                toRole: 'owner',
                toLoginId: requestedBy,
                from: req.user?.loginId || 'superadmin',
                type: 'room_changes_approved',
                message: message,
                meta: {
                    roomId: room._id.toString(),
                    roomTitle: room.title,
                    propertyId: room.property?.toString()
                }
            });
        } catch (notifyErr) {
            console.warn('Owner notification failed for room approval:', notifyErr.message);
        }

        res.json({ success: true, message: "Room changes approved and applied successfully", room });
    } catch (err) {
        console.error("Error approving room changes:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// Reject pending room changes
exports.rejectRoomChanges = async (req, res) => {
    try {
        const { roomId } = req.params;
        const room = await Room.findById(roomId);
        if (!room) {
            return res.status(404).json({ success: false, message: "Room not found" });
        }
        if (!room.pendingChanges || room.pendingChanges.status !== 'pending') {
            return res.status(400).json({ success: false, message: "No pending changes for this room" });
        }

        room.pendingChanges.status = 'rejected';
        await room.save();

        res.json({ success: true, message: "Room changes rejected successfully", room });
    } catch (err) {
        console.error("Error rejecting room changes:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// Assign room verification task to employee
exports.assignRoomVerification = async (req, res) => {
    try {
        const { roomId } = req.params;
        const { employeeId, employeeName } = req.body;
        const room = await Room.findById(roomId);
        if (!room) {
            return res.status(404).json({ success: false, message: "Room not found" });
        }
        if (!room.pendingChanges || room.pendingChanges.status !== 'pending') {
            return res.status(400).json({ success: false, message: "No pending changes for this room to assign" });
        }

        room.pendingChanges.assignedTo = employeeId;
        room.pendingChanges.assignedToName = employeeName;
        await room.save();

        res.json({ success: true, message: `Room verification assigned to ${employeeName}`, room });
    } catch (err) {
        console.error("Error assigning room verification:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// Delete a room (Soft Delete)
exports.deleteRoom = async (req, res) => {
    try {
        const { roomId } = req.params;
        const room = await Room.findByIdAndUpdate(roomId, { isDeleted: true }, { new: true });
        if (!room) {
            return res.status(404).json({ success: false, message: "Room not found" });
        }

        // Clean up tenant room assignments for this room
        const Tenant = require('../models/Tenant');
        await Tenant.updateMany(
            { room: roomId },
            { $set: { room: null, roomNo: '', bedNo: '' } }
        );

        res.json({ success: true, message: "Room soft-deleted successfully" });
    } catch (err) {
        console.error("Error deleting room:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};

// Get all rooms (Super Admin / Employee / Manager - paginated, filtered, search)
exports.getAllRooms = async (req, res) => {
    try {
        const { applyRoomScope, applyPropertyScope } = require('../utils/scopeHelpers');
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const search = req.query.search || '';
        const propertyFilter = req.query.property || '';
        const sharingTypeFilter = req.query.sharingType || '';

        // Build search query with employee scope
        const query = applyRoomScope(req, { isDeleted: { $ne: true } });

        if (req.query.pendingChanges === 'true') {
            query['pendingChanges.status'] = 'pending';
        }
        if (req.query.assignedTo) {
            query['pendingChanges.assignedTo'] = req.query.assignedTo;
        }

        if (propertyFilter && propertyFilter !== 'all') {
            query.property = propertyFilter;
        }

        if (sharingTypeFilter && sharingTypeFilter !== 'all') {
            query.sharingType = sharingTypeFilter;
        }

        if (search) {
            const searchRegex = new RegExp(search, 'i');
            
            // Search in properties first
            const Property = require('../models/Property');
            const matchingProperties = await Property.find({
                $or: [
                    { title: searchRegex },
                    { ownerName: searchRegex },
                    { ownerLoginId: searchRegex }
                ]
            }).select('_id').lean();
            
            const matchingPropIds = matchingProperties.map(p => p._id);

            query.$or = [
                { title: searchRegex },
                { property: { $in: matchingPropIds } }
            ];
        }

        const total = await Room.countDocuments(query);
        const rooms = await Room.find(query)
            .populate({
                path: 'property',
                select: 'title ownerLoginId ownerName address locationCode propertyId visitId'
            })
            .skip((page - 1) * limit)
            .limit(limit)
            .sort({ createdAt: -1 })
            .lean();

        // Calculate statistics across active rooms (scoped for employees)
        const activeRoomQuery = applyRoomScope(req, { isDeleted: { $ne: true } });
        const allActiveRooms = await Room.find(activeRoomQuery).lean();
        
        let totalRoomsCount = allActiveRooms.length;
        let vacantRoomsCount = 0;
        let occupiedRoomsCount = 0;
        let maintenanceRoomsCount = 0;

        allActiveRooms.forEach(room => {
            if (!room.isAvailable || room.status === 'inactive') {
                maintenanceRoomsCount++;
            } else {
                const bedsCount = Number(room.beds || 1);
                // Count bed assignments
                const assignedCount = Array.isArray(room.bedAssignments)
                    ? room.bedAssignments.filter(b => b && b.tenantId).length
                    : 0;
                if (assignedCount >= bedsCount) {
                    occupiedRoomsCount++;
                } else {
                    vacantRoomsCount++;
                }
            }
        });

        const Property = require('../models/Property');
        const activePropQuery = applyPropertyScope(req, { isDeleted: { $ne: true } });
        const totalPropertiesCount = await Property.countDocuments(activePropQuery);

        res.json({
            success: true,
            rooms,
            total,
            page,
            totalPages: Math.ceil(total / limit),
            stats: {
                totalRooms: totalRoomsCount,
                vacantRooms: vacantRoomsCount,
                occupiedRooms: occupiedRoomsCount,
                maintenanceRooms: maintenanceRoomsCount,
                totalProperties: totalPropertiesCount
            }
        });
    } catch (err) {
        console.error("Error getting all rooms:", err);
        res.status(500).json({ success: false, message: err.message });
    }
};