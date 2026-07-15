'use strict';

/**
 * Notification data-access layer.
 *
 * The ONLY place that talks to the Notification model for recipient-scoped reads.
 * No business logic, no request/response handling — just parameterised queries
 * with explicit field projection and pagination so callers never SELECT *.
 */

const Notification = require('../models/Notification');

// Columns the notification UI needs. Everything else (from, toRole, __v, and any
// owner-only / device-token / audit data that may live in `meta`) is excluded at
// the database level to minimise payload and avoid over-fetching.
const LIST_PROJECTION = {
  type: 1,
  read: 1,
  priority: 1,
  createdAt: 1,
  'meta.title': 1,
  'meta.message': 1,
};

const DEFAULT_SORT = { createdAt: -1, _id: -1 };

/**
 * Fetch one page of notifications for a pre-built (already auth-scoped) filter.
 * `.lean()` returns plain objects (no Mongoose hydration overhead).
 */
async function findPage(filter, { skip = 0, limit = 20 } = {}) {
  return Notification.find(filter, LIST_PROJECTION)
    .sort(DEFAULT_SORT)
    .skip(skip)
    .limit(limit)
    .lean();
}

/** Count documents for the same filter (drives pagination metadata). */
async function countByFilter(filter) {
  return Notification.countDocuments(filter);
}

module.exports = {
  findPage,
  countByFilter,
  LIST_PROJECTION,
  DEFAULT_SORT,
};
