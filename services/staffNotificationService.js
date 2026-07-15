'use strict';

/**
 * Staff / recipient notification business logic.
 *
 * Turns a raw HTTP query + an authenticated identity into a validated, paginated,
 * UI-shaped result. Security rule: the recipient scope ALWAYS comes from the
 * authenticated caller — never from a client-supplied id. Query params can only
 * *narrow* results within that scope, never widen them.
 *
 * The repository is injected (defaults to the real one) so every branch here is
 * unit-testable without a database.
 */

const defaultRepo = require('../repositories/notificationRepository');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_PAGE = 1;
const ALLOWED_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
// `type` is free-form across the app, so we don't whitelist values — we only
// bound/sanitise it to a safe token to keep the query index-friendly and safe.
const TYPE_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;

/** Typed error so the controller can map it to HTTP 400 + an errorCode. */
class ValidationError extends Error {
  constructor(message, errorCode = 'INVALID_QUERY') {
    super(message);
    this.name = 'ValidationError';
    this.errorCode = errorCode;
  }
}

/** Parse a strictly-positive integer, or throw. */
function parseIntStrict(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw new ValidationError(`"${field}" must be a positive integer`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new ValidationError(`"${field}" is out of range`);
  return n;
}

function parseBool(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'read'].includes(s)) return true;
  if (['false', '0', 'no', 'unread'].includes(s)) return false;
  throw new ValidationError(`"${field}" must be a boolean (true/false)`);
}

function parseDate(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`"${field}" is not a valid date`);
  return d;
}

/**
 * Validate + normalise the raw query into { page, limit, skip, filters }.
 * Pure and side-effect free.
 */
function parseListQuery(query = {}) {
  const page = parseIntStrict(query.page, 'page') ?? DEFAULT_PAGE;
  if (page < 1) throw new ValidationError('"page" must be >= 1');

  let limit = parseIntStrict(query.limit, 'limit') ?? DEFAULT_LIMIT;
  if (limit < 1) throw new ValidationError('"limit" must be >= 1');
  if (limit > MAX_LIMIT) limit = MAX_LIMIT; // clamp instead of erroring — friendlier + abuse-safe

  const filters = {};

  const isRead = parseBool(query.isRead ?? query.read, 'isRead');
  if (isRead !== undefined) filters.read = isRead;

  if (query.type !== undefined && query.type !== '') {
    const type = String(query.type).trim();
    if (!TYPE_PATTERN.test(type)) throw new ValidationError('"type" contains invalid characters');
    filters.type = type;
  }

  if (query.priority !== undefined && query.priority !== '') {
    const priority = String(query.priority).trim().toLowerCase();
    if (!ALLOWED_PRIORITIES.includes(priority)) {
      throw new ValidationError(`"priority" must be one of: ${ALLOWED_PRIORITIES.join(', ')}`);
    }
    filters.priority = priority;
  }

  const from = parseDate(query.from ?? query.startDate, 'from');
  const to = parseDate(query.to ?? query.endDate, 'to');
  if (from && to && from > to) throw new ValidationError('"from" must be before "to"');
  if (from || to) {
    filters.createdAt = {};
    if (from) filters.createdAt.$gte = from;
    if (to) filters.createdAt.$lte = to;
  }

  return { page, limit, skip: (page - 1) * limit, filters };
}

/**
 * Build the Mongo filter. The recipient scope is mandatory and derives ONLY from
 * the authenticated login id — client query params are merged on top but can
 * never override the scope.
 */
function buildMongoFilter(loginId, filters = {}) {
  if (!loginId) throw new ValidationError('Authenticated recipient is required', 'UNAUTHENTICATED');
  return { ...filters, toLoginId: loginId };
}

/** Map a raw notification document to the minimal UI shape. */
function shapeNotification(doc = {}) {
  return {
    id: doc._id ? String(doc._id) : undefined,
    title: doc.meta?.title || '',
    message: doc.meta?.message || '',
    type: doc.type || 'info',
    priority: doc.priority || 'normal',
    isRead: !!doc.read,
    createdAt: doc.createdAt,
  };
}

/** Build the pagination metadata block. */
function buildPaginationMeta(page, limit, total) {
  const totalPages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrevious: page > 1,
  };
}

/**
 * Orchestrator: list notifications for the authenticated recipient.
 * @param {{ loginId: string, query: object }} params
 * @param {object} [repo] injected repository (defaults to the real one)
 * @returns {Promise<{ data: object[], pagination: object }>}
 */
async function listForRecipient({ loginId, query }, repo = defaultRepo) {
  const { page, limit, skip, filters } = parseListQuery(query);
  const mongoFilter = buildMongoFilter(loginId, filters);

  const [docs, total] = await Promise.all([
    repo.findPage(mongoFilter, { skip, limit }),
    repo.countByFilter(mongoFilter),
  ]);

  return {
    data: docs.map(shapeNotification),
    pagination: buildPaginationMeta(page, limit, total),
  };
}

module.exports = {
  listForRecipient,
  // Exported for unit testing / reuse:
  parseListQuery,
  buildMongoFilter,
  shapeNotification,
  buildPaginationMeta,
  ValidationError,
  MAX_LIMIT,
  DEFAULT_LIMIT,
};
