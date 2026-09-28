'use strict';
// The ONE place a tenant room transfer happens. Both HTTP entry points
// (the dedicated POST /:id/transfer, and the legacy generic PATCH /:id,
// which still allows a room change bundled with other profile edits — see
// the frontend's "Edit Tenant" form) call this function. There is exactly
// one implementation of the transfer business rule, not two that could
// silently drift apart.
//
// Business rule: the current billing period keeps the old room/rent; the
// new one applies from the next billing month. No mid-month proration.
const { runInTransaction } = require('../utils/dbHelper');
const Room = require('../models/Room');
const Rent = require('../models/Rent');
const roomAssignmentService = require('./roomAssignmentService');
const { nextBillingMonth } = require('../utils/istDate');

class TransferValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function parseBedNo(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  return String(raw).trim().replace(/^[Bb]ed\s*/i, '');
}

/**
 * @param {object} params
 * @param {import('mongoose').Document} params.tenant - already-fetched Tenant doc
 * @param {import('mongoose').Document} params.newRoom - already-resolved, already-authorized target Room doc
 * @param {string|number} [params.newBedNo]
 * @param {string|number} [params.newAgreedRent]
 * @param {string|Date} [params.transferDate] - defaults to now
 * @param {string} [params.performedBy]
 * @returns {Promise<{tenant, assignment}>}
 */
async function transferTenant({ tenant, newRoom, newBedNo, newAgreedRent, transferDate, performedBy }) {
  // Idempotency guard: a retried/duplicate transfer request for a room the
  // tenant is ALREADY in must not create a second history row for the same
  // room (it would still pass the partial-unique index — that only blocks
  // two simultaneously-open rows per tenant, not two consecutive rows for
  // the same room — so this has to be an explicit check, not just the index).
  if (String(newRoom._id) === String(tenant.room)) {
    throw new TransferValidationError('Tenant is already assigned to this room');
  }

  const bedNoStr = parseBedNo(newBedNo) ?? tenant.bedNo;
  const bIndex = bedNoStr ? Number(bedNoStr) - 1 : null;

  if (bIndex !== null && bIndex >= 0) {
    const occupant = newRoom.bedAssignments?.[bIndex];
    if (occupant && occupant.tenantId && String(occupant.tenantId) !== String(tenant._id)) {
      throw new TransferValidationError(`Bed ${bedNoStr} in Room ${newRoom.title} is already occupied.`);
    }
  }

  const oldRoomId = tenant.room;
  const oldBedNo = tenant.bedNo;
  const resolvedTransferDate = transferDate ? new Date(transferDate) : new Date();
  const resolvedRent = newAgreedRent !== undefined && newAgreedRent !== null && newAgreedRent !== ''
    ? Number(newAgreedRent)
    : (newRoom.price || tenant.agreedRent);

  return runInTransaction(async (session) => {
    // Free the old bed slot.
    if (oldRoomId && oldBedNo) {
      const oldRoom = await Room.findById(oldRoomId).session(session);
      if (oldRoom?.bedAssignments) {
        const oldBedNoRaw = String(oldBedNo).trim().replace(/^[Bb]ed\s*/i, '');
        const oldIndex = Number(oldBedNoRaw) - 1;
        if (oldIndex >= 0 && oldRoom.bedAssignments[oldIndex] &&
            String(oldRoom.bedAssignments[oldIndex].tenantId) === String(tenant._id)) {
          oldRoom.bedAssignments[oldIndex] = {};
          oldRoom.markModified('bedAssignments');
          await oldRoom.save({ session });
        }
      }
    }

    // Occupy the new bed slot.
    if (bIndex !== null && bIndex >= 0) {
      if (!Array.isArray(newRoom.bedAssignments)) newRoom.bedAssignments = [];
      while (newRoom.bedAssignments.length <= bIndex) newRoom.bedAssignments.push({});
      newRoom.bedAssignments[bIndex] = {
        tenantId: tenant._id,
        tenantName: tenant.name,
        tenantLoginId: tenant.loginId,
        assignedAt: new Date(),
      };
      newRoom.markModified('bedAssignments');
      await newRoom.save({ session });
    }

    // The record billing actually reads: current month stays on the old
    // assignment, new assignment opens at the start of next month.
    const assignment = await roomAssignmentService.recordTransfer({
      tenantId: tenant._id,
      propertyId: tenant.property,
      roomId: newRoom._id,
      roomNo: newRoom.title,
      bedNo: bedNoStr,
      agreedRent: resolvedRent,
      transferDate: resolvedTransferDate,
      performedBy: performedBy || 'unknown',
    }, session);

    // Physical/current-profile fields move immediately — the tenant lives in
    // the new room today. Billing effective-date is handled separately,
    // above, via RoomAssignmentHistory.
    tenant.room = newRoom._id;
    tenant.roomNo = newRoom.title;
    if (bedNoStr) tenant.bedNo = bedNoStr;
    tenant.agreedRent = resolvedRent;
    // moveInDate is the tenant's ORIGINAL move-in date and must never be
    // overwritten by a transfer — that's a separate concept.
    tenant.roomTransferDate = resolvedTransferDate;
    await tenant.save({ session });

    // Legacy Rent: only reach records for the NEW effective billing month
    // onward. A pending record for the transfer month itself (or earlier)
    // reflects billing that must stay on the old room — "pending" alone is
    // not a safe stand-in for "future month".
    if (tenant.loginId) {
      await Rent.updateMany(
        {
          tenantLoginId: tenant.loginId,
          paymentStatus: 'pending',
          collectionMonth: { $gte: nextBillingMonth(resolvedTransferDate) },
        },
        { $set: { rentAmount: resolvedRent, totalDue: resolvedRent, roomNumber: newRoom.title } },
        { session }
      );
    }

    return { tenant, assignment };
  });
}

module.exports = { transferTenant, TransferValidationError };
