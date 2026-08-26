'use strict';

/**
 * poolMonitor.js — makes MongoDB connection-pool saturation visible.
 *
 * The failure this exists to diagnose looks like "random dashboard timeouts"
 * from the outside. From the inside it is almost always one of:
 *
 *   • checkOutFailed climbing   → the pool is exhausted; requests cannot get a
 *                                 connection within waitQueueTimeoutMS
 *   • checkedOut pinned at max  → every connection is busy on slow queries
 *   • poolCleared > 0           → the driver dropped and rebuilt the pool
 *                                 (failover, network blip)
 *
 * Without these numbers, pool size gets raised on a hunch. With them you can
 * tell "too many concurrent requests" apart from "queries are too slow", which
 * lead to opposite fixes.
 *
 * Uses the driver's own CMAP events — no polling, negligible overhead, and no
 * command payloads are touched so nothing sensitive is observed.
 */

const stats = {
  created: 0,
  closed: 0,
  checkedOut: 0,      // currently held by in-flight operations
  checkOutFailed: 0,  // waitQueueTimeoutMS expired — pool saturation
  poolCleared: 0,
  peakCheckedOut: 0,
  lastCheckOutFailureAt: null,
};

let attached = false;

/**
 * Attach to a live MongoClient. Safe to call more than once.
 * @param {import('mongoose').Connection} connection
 */
function attachPoolMonitor(connection) {
  if (attached) return false;
  let client;
  try {
    client = connection.getClient();
  } catch (_) {
    return false; // not connected yet
  }
  if (!client || typeof client.on !== 'function') return false;

  client.on('connectionCreated', () => { stats.created += 1; });
  client.on('connectionClosed', () => { stats.closed += 1; });

  client.on('connectionCheckedOut', () => {
    stats.checkedOut += 1;
    if (stats.checkedOut > stats.peakCheckedOut) stats.peakCheckedOut = stats.checkedOut;
  });
  client.on('connectionCheckedIn', () => {
    stats.checkedOut = Math.max(0, stats.checkedOut - 1);
  });

  client.on('connectionCheckOutFailed', (ev) => {
    stats.checkOutFailed += 1;
    stats.lastCheckOutFailureAt = new Date().toISOString();
    // The single most actionable line in the log during an incident.
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'db_pool_checkout_failed',
      reason: ev?.reason || 'timeout',
      checkedOut: stats.checkedOut,
      totalFailures: stats.checkOutFailed,
    }));
  });

  client.on('connectionPoolCleared', () => {
    stats.poolCleared += 1;
    stats.checkedOut = 0;
  });

  attached = true;
  return true;
}

const getPoolStats = () => ({ ...stats });

/** True when the pool looks saturated — for health checks and alerting. */
const isSaturated = (maxPoolSize) =>
  stats.checkOutFailed > 0 || (maxPoolSize > 0 && stats.checkedOut >= maxPoolSize);

module.exports = { attachPoolMonitor, getPoolStats, isSaturated };
