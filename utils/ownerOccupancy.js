const Owner = require('../models/Owner');
const Property = require('../models/Property');
const ApprovedProperty = require('../models/ApprovedProperty');

const firstText = (...values) => {
    for (const value of values) {
        const text = String(value || '').trim();
        if (text) return text;
    }
    return '';
};

const toArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) {
            return [];
        }
    }
    return [];
};

const normalizeBeds = (beds = []) => {
    const list = toArray(beds);
    return list.map((bed, index) => ({
        status: String(bed?.status || '').toLowerCase() === 'occupied' ? 'occupied' : 'available',
        tenantId: bed?.tenantId || bed?.loginId || `BED-${index + 1}`,
        tenantName: firstText(bed?.tenantName, bed?.name)
    }));
};

const normalizeRoomInventory = (rooms = [], meta = {}) => {
    return toArray(rooms).map((room, index) => {
        const number = firstText(room?.number, room?.roomNo, room?.title, `Room ${index + 1}`);
        const beds = normalizeBeds(room?.beds);
        return {
            id: firstText(room?.id, room?._id, `ROOM-${Date.now()}-${index + 1}`),
            propertyId: firstText(room?.propertyId, meta.propertyId),
            propertyTitle: firstText(room?.propertyTitle, meta.propertyTitle),
            number,
            roomNo: firstText(room?.roomNo, number),
            title: firstText(room?.title, number),
            type: firstText(room?.type, room?.roomType, 'Standard'),
            roomType: firstText(room?.roomType, room?.type, 'Standard'),
            rent: Number(room?.rent ?? room?.price ?? 0),
            price: Number(room?.price ?? room?.rent ?? 0),
            gender: firstText(room?.gender, meta.gender, 'Mixed'),
            beds: beds.length > 0 ? beds : [{ status: 'available', tenantId: '', tenantName: '' }]
        };
    });
};

const summarizeRoomInventory = (rooms = []) => {
    const summary = {
        roomCount: 0,
        bedCount: 0,
        vacantRooms: 0,
        vacantBeds: 0,
        occupiedRooms: 0,
        occupiedBeds: 0
    };

    (rooms || []).forEach((room) => {
        const beds = normalizeBeds(room?.beds);
        const occupiedBeds = beds.filter((bed) => bed.status === 'occupied').length;
        const vacantBeds = Math.max(0, beds.length - occupiedBeds);
        summary.roomCount += 1;
        summary.bedCount += beds.length;
        summary.occupiedBeds += occupiedBeds;
        summary.vacantBeds += vacantBeds;
        if (occupiedBeds > 0) {
            summary.occupiedRooms += 1;
        }
        if (vacantBeds > 0) {
            summary.vacantRooms += 1;
        }
    });

    return summary;
};

const syncOwnerPropertyOccupancy = async ({
    loginId,
    roomInventory = [],
    propertyId = '',
    propertyTitle = '',
    propertyLocationCode = ''
}) => {
    const normalizedLoginId = String(loginId || '').trim().toUpperCase();
    const normalizedRooms = normalizeRoomInventory(roomInventory, { propertyId, propertyTitle });
    const summary = summarizeRoomInventory(normalizedRooms);
    const liveOnWebsite = summary.vacantRooms > 0 || summary.vacantBeds > 0;

    const owner = await Owner.findOneAndUpdate(
        { loginId: normalizedLoginId },
        {
            $set: {
                roomInventory: normalizedRooms,
                roomCount: summary.roomCount,
                bedCount: summary.bedCount,
                vacantRooms: summary.vacantRooms,
                vacantBeds: summary.vacantBeds,
                occupiedRooms: summary.occupiedRooms,
                occupiedBeds: summary.occupiedBeds
            }
        },
        { new: true }
    );

    const propertyFilter = propertyId
        ? { _id: propertyId, ownerLoginId: normalizedLoginId }
        : {
            ownerLoginId: normalizedLoginId,
            ...(propertyTitle ? { title: propertyTitle } : {})
        };
    const property = await Property.findOne(propertyFilter).sort({ createdAt: 1 });
    if (property) {
        property.roomCount = summary.roomCount;
        property.bedCount = summary.bedCount;
        property.vacantRooms = summary.vacantRooms;
        property.vacantBeds = summary.vacantBeds;
        property.occupiedRooms = summary.occupiedRooms;
        property.occupiedBeds = summary.occupiedBeds;
        property.isPublished = liveOnWebsite;
        property.status = 'active';
        if (propertyLocationCode && !property.locationCode) property.locationCode = propertyLocationCode;
        await property.save();
    }

    const approvedProperty = await ApprovedProperty.findOne({
        $or: [
            { 'generatedCredentials.loginId': normalizedLoginId },
            ...(propertyTitle ? [{ 'propertyInfo.name': propertyTitle }] : [])
        ]
    }).sort({ approvedAt: -1 });
    if (approvedProperty) {
        approvedProperty.propertyInfo = {
            ...(approvedProperty.propertyInfo || {}),
            name: firstText(approvedProperty.propertyInfo?.name, propertyTitle),
            roomCount: summary.roomCount,
            bedCount: summary.bedCount,
            vacantRooms: summary.vacantRooms,
            vacantBeds: summary.vacantBeds,
            occupiedRooms: summary.occupiedRooms,
            occupiedBeds: summary.occupiedBeds
        };
        approvedProperty.isLiveOnWebsite = liveOnWebsite;
        approvedProperty.status = liveOnWebsite ? 'live' : 'offline';
        await approvedProperty.save();
    }

    return {
        owner,
        property,
        approvedProperty,
        roomInventory: normalizedRooms,
        summary,
        liveOnWebsite
    };
};

module.exports = {
    normalizeRoomInventory,
    summarizeRoomInventory,
    syncOwnerPropertyOccupancy
};
