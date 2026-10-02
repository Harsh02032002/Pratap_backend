'use strict';

/**
 * ownerPropertyHealJob — background repair for owner↔property links.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Properties created before owner linkage was enforced can carry a missing,
 * null, empty, "TEMP" or "GEN" `ownerLoginId`. They still hold the owner's
 * email/phone on the contact block, so they can be re-attached to the right
 * owner after the fact. That repair used to run inline inside owner-facing GET
 * handlers, which meant a read request performed an unbounded scan plus a
 * serial write loop before returning any data.
 *
 * It now runs here: on a schedule, under a distributed lock, in bounded
 * batches, and completely off the request path.
 *
 * DESIGN NOTES
 * ────────────
 * • Lock — reuses services/cronLockService (CronLock collection), the same
 *   mechanism dailyRentEvaluator and autoMarkAbsentJob already use. Safe under
 *   PM2 cluster mode / multiple replicas: only one instance does the work.
 *
 * • Idempotent — the selector only matches properties whose ownerLoginId is
 *   unset/placeholder. Once healed, a property no longer matches, so a second
 *   run is a no-op. Nothing is written unless a field actually changes.
 *
 * • Bounded — walks the collection with a cursor and flushes in fixed-size
 *   batches, so memory stays flat whether there are 1e3 or 1e6 candidates.
 *   MAX_PROPERTIES_PER_RUN caps a single run; leftovers are picked up next run.
 *
 * • bulkWrite vs save() — Property has a pre('save') hook that (a) stamps
 *   `updatedAt` and (b) resolves owner/ownerLoginId/ownerName/ownerPhone by
 *   email/phone lookup. Branch (b) is exactly what this job already computes,
 *   so running it again would re-do 2-3 queries per property for an identical
 *   result. Branch (a) is replicated explicitly below by setting `updatedAt`
 *   in the $set. The bulkWrite is therefore behaviourally equivalent to the
 *   old save() loop, minus the redundant per-document lookups.
 *
 * • Phone matching stays a suffix regex. Numbers are stored inconsistently
 *   (+91…, 0…, bare 10-digit), so a suffix match is the correct semantic and
 *   no ordinary index can serve it. Making it indexable needs a normalized
 *   `phoneLast10` field on Property — a separate migration, deliberately out
 *   of scope here. Off the request path and batched, the cost is acceptable.
 *   The interpolated value is digits-only (\D stripped), so it cannot inject.
 */

const cron = require('node-cron');
const mongoose = require('mongoose');

const Owner = require('../models/Owner');
const Property = require('../models/Property');
const User = require('../models/user');
const Employee = require('../models/Employee');
const CronHealth = require('../models/CronHealth');
const { acquireLock, releaseLock } = require('../services/cronLockService');
const { normalizeLoginId } = require('../utils/normalizeId');
const { withReadDeadline } = require('../utils/queryDeadline');

const JOB_NAME = 'ownerPropertyHeal';
const LOCK_TIMEOUT_MINUTES = 20;

// Flush writes every N matched properties — keeps the in-memory op array small.
const BATCH_SIZE = 500;
// Hard ceiling per run. Anything beyond this is left for the next run rather
// than letting one execution grow without bound.
const MAX_PROPERTIES_PER_RUN = 20000;
// Owners processed per sweep page.
const OWNER_PAGE_SIZE = 200;
// Ceiling on tenants pulled per owner for the electricity backfill, so one
// very large owner cannot dominate a run.
const TENANTS_PER_OWNER_CAP = 2000;
// Ceiling on unassigned pending properties resolved per run of the
// employee-assignment heal below.
const MAX_PENDING_ASSIGNMENTS_PER_RUN = 5000;

/** Placeholder values that mean "this property has no real owner link yet". */
const UNLINKED_SELECTOR = {
  $or: [
    { ownerLoginId: { $exists: false } },
    { ownerLoginId: null },
    { ownerLoginId: '' },
    { ownerLoginId: 'TEMP' },
    { ownerLoginId: 'GEN' },
  ],
};

/** Last 10 digits of a phone number, or '' when it isn't a usable number. */
function last10(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Build the match clause that finds properties belonging to this owner but not
 * yet linked. Returns null when the owner has neither an email nor a phone to
 * match on — there is nothing to search for in that case.
 */
function buildCandidateQuery(ownerDoc) {
  const emails = [ownerDoc.email, ownerDoc.profile?.email, ownerDoc.checkinEmail]
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean);

  const phones = [ownerDoc.phone, ownerDoc.profile?.phone, ownerDoc.checkinPhone]
    .map(last10)
    .filter(Boolean);

  if (emails.length === 0 && phones.length === 0) return null;

  const matchConditions = [];
  if (emails.length > 0) {
    matchConditions.push({ 'contact.email': { $in: emails } });
    matchConditions.push({ email: { $in: emails } });
  }
  for (const phone of [...new Set(phones)]) {
    const suffix = new RegExp(`${phone}$`); // digits only — injection-safe
    matchConditions.push({ 'contact.number': suffix });
    matchConditions.push({ ownerPhone: suffix });
    matchConditions.push({ phone: suffix });
  }

  return {
    $and: [UNLINKED_SELECTOR, { isDeleted: { $ne: true } }, { $or: matchConditions }],
  };
}

/**
 * Repair one owner's unlinked properties.
 *
 * Safe to call concurrently with itself for *different* owners; callers that
 * sweep every owner should hold the job lock.
 *
 * @param {string} loginId
 * @param {{ maxProperties?: number }} [opts]
 * @returns {Promise<{owner: string, scanned: number, repaired: number, skipped: number, failed: number}>}
 */
async function healOwnerProperties(loginId, opts = {}) {
  const stats = { owner: '', scanned: 0, repaired: 0, skipped: 0, failed: 0 };

  const normalizedLoginId = normalizeLoginId(String(loginId || ''));
  if (!normalizedLoginId) return stats;
  stats.owner = normalizedLoginId;

  if (mongoose.connection.readyState !== 1) {
    console.warn(`[${JOB_NAME}] DB not connected — skipping ${normalizedLoginId}`);
    return stats;
  }

  const maxProperties = opts.maxProperties || MAX_PROPERTIES_PER_RUN;

  // 'job' class, not 'read' — background work must not inherit the 7s
  // request-scale deadline, but must still be bounded (Phase 11).
  const ownerDoc = await withReadDeadline(
    Owner.findOne({ loginId: normalizedLoginId })
      .select('loginId name email phone profile checkinEmail checkinPhone'),
    'job',
  ).lean();
  if (!ownerDoc) return stats;

  const query = buildCandidateQuery(ownerDoc);
  if (!query) return stats;

  // Resolved once per owner, not once per property (the old save() hook did the
  // latter). Null is fine — `owner` is simply left alone in that case.
  const userDoc = await withReadDeadline(
    User.findOne({ loginId: normalizedLoginId, role: 'owner' }).select('_id'),
    'job',
  ).lean();
  const ownerUserId = userDoc ? userDoc._id : null;

  const fallbackName = ownerDoc.name || ownerDoc.profile?.name || '';
  const fallbackPhone = ownerDoc.phone || ownerDoc.profile?.phone || '';

  // Cursor + batched flush: memory stays flat regardless of match count.
  const cursor = withReadDeadline(
    Property.find(query)
      .select('_id ownerLoginId owner ownerName ownerPhone')
      .limit(maxProperties),
    'job',
  )
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  let ops = [];

  const flush = async () => {
    if (ops.length === 0) return;
    const pending = ops;
    ops = [];
    try {
      const result = await Property.bulkWrite(pending, { ordered: false });
      stats.repaired += result.modifiedCount || 0;
    } catch (err) {
      // ordered:false still applies the writes that succeeded. Count what landed
      // and attribute the rest to failures instead of reporting a clean run.
      const applied = err.result?.nModified ?? err.result?.result?.nModified ?? 0;
      stats.repaired += applied;
      stats.failed += pending.length - applied;
      console.error(`[${JOB_NAME}] bulkWrite partial failure for ${normalizedLoginId}: ${err.message}`);
    }
  };

  try {
    for (let prop = await cursor.next(); prop != null; prop = await cursor.next()) {
      stats.scanned += 1;

      // Only set what actually changes — this is what makes re-runs no-ops
      // rather than pointless writes.
      const $set = {};
      if (prop.ownerLoginId !== normalizedLoginId) $set.ownerLoginId = normalizedLoginId;
      if (ownerUserId && String(prop.owner || '') !== String(ownerUserId)) $set.owner = ownerUserId;
      if (!prop.ownerName && fallbackName) $set.ownerName = fallbackName;
      if (!prop.ownerPhone && fallbackPhone) $set.ownerPhone = fallbackPhone;

      if (Object.keys($set).length === 0) {
        stats.skipped += 1;
        continue;
      }

      // Replicates the `this.updatedAt = new Date()` line in Property's
      // pre('save') hook, which bulkWrite bypasses.
      $set.updatedAt = new Date();

      ops.push({ updateOne: { filter: { _id: prop._id }, update: { $set } } });
      if (ops.length >= BATCH_SIZE) await flush();
    }
    await flush();
  } finally {
    await cursor.close().catch(() => { });
  }

  if (stats.repaired > 0 || stats.failed > 0) {
    console.log(
      `[${JOB_NAME}] owner=${normalizedLoginId} scanned=${stats.scanned} ` +
      `repaired=${stats.repaired} skipped=${stats.skipped} failed=${stats.failed}`
    );
  }

  return stats;
}

/**
 * Auto-assign unassigned pending/pending_approval properties to an active
 * Employee matching their city/area.
 *
 * This used to run inline inside GET /api/properties (getAllProperties),
 * looping over the current page and issuing up to 3 Employee lookups plus a
 * `property.save()` per unassigned property — a write, inside a GET, capable
 * of ~4,000 extra queries on a single request when the page was large. It now
 * runs here instead: batched, off the request path, with one Employee
 * resolution per unique (city, area) pair rather than one per property.
 *
 * @returns {Promise<{scanned: number, assigned: number, failed: number}>}
 */
async function healPendingPropertyAssignments() {
  const stats = { scanned: 0, assigned: 0, failed: 0 };

  if (mongoose.connection.readyState !== 1) {
    console.warn(`[${JOB_NAME}] DB not connected — skipping employee-assignment heal`);
    return stats;
  }

  const query = {
    isDeleted: { $ne: true },
    status: { $in: ['pending_approval', 'pending'] },
    $or: [{ assignedToName: { $exists: false } }, { assignedToName: '' }, { assignedToName: null }],
  };

  // Cache resolved employees per (city, area) pair so properties sharing a
  // pair only trigger one set of Employee lookups, not one each.
  const employeeCache = new Map();
  const resolveEmployee = async (city, area) => {
    const cacheKey = `${city}\u0000${area}`;
    if (employeeCache.has(cacheKey)) return employeeCache.get(cacheKey);

    let emp = null;
    if (city) {
      if (area) {
        emp = await Employee.findOne({ city: new RegExp(`^${city}$`, 'i'), area: new RegExp(`^${area}$`, 'i'), isActive: true }).select('_id name email phone loginId').lean();
        if (!emp) emp = await Employee.findOne({ city: new RegExp(`^${city}$`, 'i'), area: new RegExp(area, 'i'), isActive: true }).select('_id name email phone loginId').lean();
      }
      if (!emp) {
        emp = await Employee.findOne({ city: new RegExp(`^${city}$`, 'i'), isActive: true }).select('_id name email phone loginId').lean();
      }
    }
    employeeCache.set(cacheKey, emp);
    return emp;
  };

  const cursor = withReadDeadline(
    Property.find(query)
      .select('_id city area locality')
      .limit(MAX_PENDING_ASSIGNMENTS_PER_RUN),
    'job',
  )
    .lean()
    .cursor({ batchSize: BATCH_SIZE });

  let ops = [];
  const flush = async () => {
    if (ops.length === 0) return;
    const pending = ops;
    ops = [];
    try {
      const result = await Property.bulkWrite(pending, { ordered: false });
      stats.assigned += result.modifiedCount || 0;
    } catch (err) {
      const applied = err.result?.nModified ?? err.result?.result?.nModified ?? 0;
      stats.assigned += applied;
      stats.failed += pending.length - applied;
      console.error(`[${JOB_NAME}] employee-assignment bulkWrite partial failure: ${err.message}`);
    }
  };

  try {
    for (let prop = await cursor.next(); prop != null; prop = await cursor.next()) {
      stats.scanned += 1;
      const city = (prop.city || 'Jaipur').trim();
      const area = (prop.area || prop.locality || '').trim();
      const emp = await resolveEmployee(city, area);
      if (!emp) continue;

      ops.push({
        updateOne: {
          filter: { _id: prop._id },
          update: {
            $set: {
              assignedTo: emp._id,
              assignedToName: emp.name,
              assignedToEmail: emp.email || '',
              assignedToPhone: emp.phone || '',
              assignedToLoginId: emp.loginId || '',
              updatedAt: new Date(),
            },
          },
        },
      });
      if (ops.length >= BATCH_SIZE) await flush();
    }
    await flush();
  } finally {
    await cursor.close().catch(() => { });
  }

  if (stats.assigned > 0 || stats.failed > 0) {
    console.log(`[${JOB_NAME}] employee-assignment heal: scanned=${stats.scanned} assigned=${stats.assigned} failed=${stats.failed}`);
  }

  return stats;
}

/**
 * Sweep every owner. Lock-guarded so only one instance runs it, and paged so
 * the owner list is never loaded whole.
 */
async function runOwnerPropertyHealJob() {
  if (mongoose.connection.readyState !== 1) {
    console.warn(`[${JOB_NAME}] DB not connected — skipping run`);
    return null;
  }

  const acquired = await acquireLock(JOB_NAME, LOCK_TIMEOUT_MINUTES);
  if (!acquired) {
    console.log(`[${JOB_NAME}] Another instance holds the lock — skipping this execution`);
    return null;
  }

  const startedAt = new Date();
  let health = null;
  try {
    health = await CronHealth.create({ jobName: JOB_NAME, startedAt, status: 'RUNNING' });
  } catch (_) {
    // Health tracking is best-effort — never let it stop the actual repair.
  }

  const totals = { owners: 0, scanned: 0, repaired: 0, skipped: 0, failed: 0, ownersFailed: 0, invoiceHealFailed: 0, moveInHealFailed: 0, electricityHealFailed: 0, employeeAssignmentFailed: 0 };

  try {
    console.log(`[${JOB_NAME}] Job started at ${startedAt.toISOString()}`);

    // Not owner-specific, so it runs once per sweep rather than once per
    // owner. Isolated so a failure here can't abort the owner-linkage repair.
    try {
      await healPendingPropertyAssignments();
    } catch (err) {
      totals.employeeAssignmentFailed += 1;
      console.error(`[${JOB_NAME}] employee-assignment heal failed: ${err.message}`);
    }

    let skip = 0;
    let budget = MAX_PROPERTIES_PER_RUN;

    // Page through owners rather than loading them all at once.
    for (; ;) {
      const owners = await withReadDeadline(
        Owner.find({ isDeleted: { $ne: true } })
          .select('loginId')
          .sort({ _id: 1 })
          .skip(skip)
          .limit(OWNER_PAGE_SIZE),
        'job',
      ).lean();

      if (owners.length === 0) break;

      for (const owner of owners) {
        if (budget <= 0) break;
        totals.owners += 1;
        try {
          // One owner blowing up must not abort the sweep.
          const s = await healOwnerProperties(owner.loginId, { maxProperties: budget });
          totals.scanned += s.scanned;
          totals.repaired += s.repaired;
          totals.skipped += s.skipped;
          totals.failed += s.failed;
          budget -= s.scanned;
        } catch (err) {
          totals.ownersFailed += 1;
          console.error(`[${JOB_NAME}] owner ${owner.loginId} failed: ${err.message}`);
        }

        // The invoice repair used to be chained off the end of the old inline
        // healOwnerProperties, so it ran on every owner GET too. Keep it in the
        // same sweep to preserve that behaviour — isolated, because it is a
        // separate concern and a failure here must not lose the property fixes
        // already committed above.
        try {
          // Lazy require: ownercontroller re-exports back into this module.
          await require('../controllers/ownercontroller').healTenantInvoices(
            normalizeLoginId(String(owner.loginId || ''))
          );
        } catch (err) {
          totals.invoiceHealFailed += 1;
          console.error(`[${JOB_NAME}] invoice heal for ${owner.loginId} failed: ${err.message}`);
        }

        // Move-in invoice backfill previously ran inline in
        // GET /api/rent-collection/dashboard and /invoices. Same treatment:
        // preserved here, isolated so it cannot abort the sweep.
        try {
          await require('../services/invoiceService').autoHealMoveInInvoices(owner.loginId);
        } catch (err) {
          totals.moveInHealFailed += 1;
          console.error(`[${JOB_NAME}] move-in invoice heal for ${owner.loginId} failed: ${err.message}`);
        }

        // Electricity→invoice backfill previously ran inside
        // enrichTenantsWithDues on GET /api/owners/:loginId/tenants. That
        // helper is read-only now; the repair variant runs here instead.
        try {
          const Tenant = require('../models/Tenant');
          const { enrichTenantsWithDues } = require('../services/tenantDuesService');
          const tenants = await Tenant.find({
            ownerLoginId: normalizeLoginId(String(owner.loginId || '')),
            isDeleted: { $ne: true },
          })
            .select('_id property roomNo room')
            .limit(TENANTS_PER_OWNER_CAP)
            .lean();
          if (tenants.length > 0) {
            await enrichTenantsWithDues(tenants, { repair: true });
          }
        } catch (err) {
          totals.electricityHealFailed += 1;
          console.error(`[${JOB_NAME}] electricity heal for ${owner.loginId} failed: ${err.message}`);
        }
      }

      if (budget <= 0) {
        console.warn(`[${JOB_NAME}] Reached the ${MAX_PROPERTIES_PER_RUN}-property ceiling — remainder deferred to the next run`);
        break;
      }
      if (owners.length < OWNER_PAGE_SIZE) break;
      skip += OWNER_PAGE_SIZE;
    }

    const durationMs = Date.now() - startedAt.getTime();
    console.log(
      `[${JOB_NAME}] Job completed in ${durationMs}ms — ` +
      `owners=${totals.owners} scanned=${totals.scanned} repaired=${totals.repaired} ` +
      `skipped=${totals.skipped} failed=${totals.failed} ownersFailed=${totals.ownersFailed} ` +
      `invoiceHealFailed=${totals.invoiceHealFailed} moveInHealFailed=${totals.moveInHealFailed} ` +
      `electricityHealFailed=${totals.electricityHealFailed} employeeAssignmentFailed=${totals.employeeAssignmentFailed}`
    );

    if (health) {
      await CronHealth.updateOne(
        { _id: health._id },
        {
          $set: {
            completedAt: new Date(),
            durationMs,
            status: 'SUCCESS',
            invoicesProcessed: totals.repaired,
          },
        }
      ).catch(() => { });
    }

    return totals;
  } catch (err) {
    console.error(`[${JOB_NAME}] Job failed: ${err.message}`);
    if (health) {
      await CronHealth.updateOne(
        { _id: health._id },
        {
          $set: {
            completedAt: new Date(),
            durationMs: Date.now() - startedAt.getTime(),
            status: 'FAILED',
            errorMessage: err.message,
          },
        }
      ).catch(() => { });
    }
    return null;
  } finally {
    await releaseLock(JOB_NAME).catch(() => { });
  }
}

/**
 * Serverless fallback — OFF unless HEAL_ON_DEMAND=true.
 *
 * On a host that keeps a process alive (the VPS / PM2 deployment) the cron
 * schedule below is the only trigger, and GET handlers stay strictly read-only.
 * On a host where node-cron never fires (Vercel and similar), setting
 * HEAL_ON_DEMAND=true lets an owner-facing read kick the sweep at most once per
 * day. Even then the caller must NOT await this — it returns immediately and
 * the work happens detached.
 *
 * The day-scoped lock (20h TTL, never explicitly released) means the first
 * caller each day does the work and every other caller returns at once.
 */
function ensureDailyOwnerPropertyHeal() {
  if (String(process.env.HEAL_ON_DEMAND || '').toLowerCase() !== 'true') return;
  if (mongoose.connection.readyState !== 1) return;

  // Detached on purpose: never returned, never awaited, so no request can block
  // on it and no rejection can surface as a failed response.
  void acquireLock(`${JOB_NAME}Daily`, 20 * 60)
    .then((got) => (got ? runOwnerPropertyHealJob() : null))
    .catch((err) => console.error(`[${JOB_NAME}] on-demand trigger failed: ${err.message}`));
}

function registerOwnerPropertyHealJob() {
  // 02:40 daily — off-peak, and offset from the other jobs (00:15 auto-absent,
  // and the rent evaluator) so they don't contend for the connection pool.
  cron.schedule('40 2 * * *', runOwnerPropertyHealJob);
  console.log('🕐 Owner-property heal job scheduled: Daily 2:40 AM (batched, lock-guarded)');
}

module.exports = {
  JOB_NAME,
  healOwnerProperties,
  healPendingPropertyAssignments,
  runOwnerPropertyHealJob,
  ensureDailyOwnerPropertyHeal,
  registerOwnerPropertyHealJob,
  // exported for tests
  buildCandidateQuery,
  UNLINKED_SELECTOR,
};
