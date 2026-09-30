const mongoose = require('mongoose');

const ElectricityReadingSchema = new mongoose.Schema({
	initialReading: { type: Number, required: true },
	initialReadingDate: { type: Date, required: true },
	finalReading: { type: Number, required: true },
	finalReadingDate: { type: Date, required: true },
	unitsConsumed: { type: Number, default: 0 },
	totalCost: { type: Number, default: 0 },
	description: { type: String, default: '' },
	createdAt: { type: Date, default: Date.now }
});

const BedAssignmentSchema = new mongoose.Schema({
	tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' },
	tenantName: { type: String },
	tenantLoginId: { type: String },
	assignedAt: { type: Date, default: Date.now }
}, { _id: false });

const RoomSchema = new mongoose.Schema({
	property: { type: mongoose.Schema.Types.ObjectId, ref: 'Property', required: true },
	title: { type: String, required: true },
	type: { type: String, default: 'AC' },
	beds: { type: Number, default: 1 },
	price: { type: Number, default: 0 },
	unitType: { type: String, default: 'Room' },
	floor: { type: String, default: '' },
	sharingType: { type: String, default: '' },
	remarks: { type: String, default: '' },
	isAvailable: { type: Boolean, default: true },
	facilities: { type: [String], default: [] },
	roomTypeFeatures: { type: [String], default: [] },
	media: { type: [Object], default: [] },
	bedAssignments: [BedAssignmentSchema],
	electricity: {
		unitCost: { type: Number, default: 0 },
		readings: [ElectricityReadingSchema]
	},
	createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
	// `isAvailable` is the occupancy flag. `available` is retained here as a
	// legacy room-status value because existing import/seed flows still emit it.
	status: { type: String, enum: ['inactive', 'active', 'available'], default: 'inactive' },
	isPromoted: { type: Boolean, default: false },
	isDeleted: { type: Boolean, default: false },
	createdAt: { type: Date, default: Date.now },
	pendingChanges: {
		data: { type: Object, default: null },
		requestedAt: { type: Date, default: null },
		requestedBy: { type: String, default: null },
		reason: { type: String, default: null },
		status: { type: String, enum: ['pending', 'approved', 'rejected', null], default: null },
		assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
		assignedToName: { type: String }
	}
});

RoomSchema.index({ property: 1, isDeleted: 1 });
// Matches getAllRooms' actual filter+sort shape (controllers/roomController.js)
// — equality on property/isDeleted/sharingType, then sorted by createdAt desc.
// This index's prefix also serves any query that only filters by
// {property, isDeleted}, so the narrower index above stays as-is rather than
// being removed here (additive only — not touching what's already indexed).
RoomSchema.index({ property: 1, isDeleted: 1, sharingType: 1, createdAt: -1 });
// Supports the T-17 fix in services/moveoutService.js (per-tenant bed lookup).
RoomSchema.index({ 'bedAssignments.tenantId': 1 });

module.exports = mongoose.model('Room', RoomSchema);
