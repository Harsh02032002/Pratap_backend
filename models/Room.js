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
	status: { type: String, enum: ['inactive','active'], default: 'inactive' },
	isPromoted: { type: Boolean, default: false },
	createdAt: { type: Date, default: Date.now }
});

RoomSchema.index({ property: 1 });

module.exports = mongoose.model('Room', RoomSchema);