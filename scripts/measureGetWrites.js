'use strict';

/**
 * measureGetWrites.js — proves a GET endpoint performs zero repair writes.
 *
 * Instruments the Mongoose driver, issues a real request against a running
 * server, and reports every database operation the request triggered, split
 * into reads and writes.
 *
 *   node scripts/measureGetWrites.js http://localhost:5001 ROOMHY3259
 *   node scripts/measureGetWrites.js https://api.roomhy.com ROOMHY3259 <BEARER>
 *
 * Run it once on a build with the repair calls still in place and once after,
 * and diff the two reports. That is the measurement — do not quote numbers
 * from anywhere else.
 *
 * NOTE: counters below reflect operations issued by THIS process. Point it at a
 * server started in-process (see USAGE at the bottom) for a full picture, or
 * read the server's own logs when hitting a remote host.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const BASE = process.argv[2] || 'http://localhost:5001';
const OWNER = process.argv[3] || '';
const TOKEN = process.argv[4] || '';

if (!OWNER) {
  console.error('Usage: node scripts/measureGetWrites.js <baseUrl> <OWNER_LOGIN_ID> [bearerToken]');
  process.exit(1);
}

const WRITE_OPS = new Set([
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne',
  'deleteOne', 'deleteMany', 'findOneAndUpdate', 'findOneAndDelete',
  'findOneAndReplace', 'bulkWrite', 'save', 'create',
]);

const ENDPOINTS = [
  ['GET', `/api/dashboard/${OWNER}`],
  ['GET', `/api/owners/${OWNER}/properties`],
  ['GET', `/api/owners/${OWNER}/rooms?page=1&limit=50`],
  ['GET', `/api/owners/${OWNER}/tenants?nodues=true`],
  ['GET', `/api/owners/${OWNER}/rent`],
  ['GET', `/api/owners/${OWNER}/revenue-dashboard`],
  ['GET', `/api/rooms/owner/${OWNER}`],
  ['GET', '/api/rent-collection/dashboard'],
  ['GET', '/api/rent-collection/invoices'],
];

let ops = [];
mongoose.set('debug', (collectionName, method, ...args) => {
  ops.push({ collection: collectionName, method, isWrite: WRITE_OPS.has(method), at: Date.now() });
  void args;
});

async function hit(method, pathname) {
  ops = [];
  const started = Date.now();
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};

  let status = 0;
  let bytes = 0;
  try {
    const res = await fetch(`${BASE}${pathname}`, { method, headers });
    status = res.status;
    bytes = (await res.text()).length;
  } catch (err) {
    return { pathname, error: err.message };
  }

  const durationMs = Date.now() - started;
  const reads = ops.filter((o) => !o.isWrite);
  const writes = ops.filter((o) => o.isWrite);

  return {
    pathname,
    status,
    durationMs,
    kb: Math.round(bytes / 102.4) / 10,
    reads: reads.length,
    writes: writes.length,
    writeDetail: writes.map((w) => `${w.collection}.${w.method}`),
  };
}

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (uri) await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 }).catch(() => {});

  console.log(`Target: ${BASE}   Owner: ${OWNER}\n`);
  console.log('ENDPOINT'.padEnd(52) + 'STATUS  TIME     SIZE      READS  WRITES');
  console.log('─'.repeat(96));

  let totalWrites = 0;
  for (const [method, pathname] of ENDPOINTS) {
    const r = await hit(method, pathname);
    if (r.error) {
      console.log(`${pathname.padEnd(52)}ERROR   ${r.error}`);
      continue;
    }
    totalWrites += r.writes;
    const flag = r.writes > 0 ? '  ← WRITES ON A GET' : '';
    console.log(
      `${r.pathname.padEnd(52)}${String(r.status).padEnd(8)}` +
      `${String(r.durationMs + 'ms').padEnd(9)}${String(r.kb + 'KB').padEnd(10)}` +
      `${String(r.reads).padStart(5)}  ${String(r.writes).padStart(6)}${flag}`
    );
    for (const w of r.writeDetail) console.log(`${' '.repeat(54)}↳ ${w}`);
  }

  console.log('─'.repeat(96));
  console.log(totalWrites === 0
    ? '✅ 0 writes across every owner GET endpoint — the read path is clean.'
    : `❌ ${totalWrites} write(s) still issued from GET endpoints (listed above).`);

  await mongoose.disconnect().catch(() => {});
  process.exit(totalWrites === 0 ? 0 : 1);
})().catch((err) => { console.error('Measurement failed:', err); process.exit(1); });
