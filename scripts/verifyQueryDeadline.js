'use strict';

/**
 * verifyQueryDeadline.js — runtime proof that operation deadlines reach MongoDB.
 *
 *   node scripts/verifyQueryDeadline.js
 *
 * The unit tests prove the helper computes the right number. Only the wire can
 * prove the number is actually sent and that the server honours it. Read-only:
 * it issues finds with a limit and one deliberately impossible deadline.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { installGlobalQueryDeadline, runWithRequestBudget, deadlineFor } = require('../utils/queryDeadline');
const { MONGO, REQUEST_DEADLINE_MS, QUERY_TIMEOUT_MS } = require('../config/timeouts');

installGlobalQueryDeadline(mongoose);

const observed = [];
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) { console.log('NOT RUN — no MONGO_URI'); process.exit(0); }

  await mongoose.connect(uri, { ...MONGO, monitorCommands: true });
  mongoose.connection.getClient().on('commandStarted', (e) => {
    if (['find', 'aggregate'].includes(e.commandName)) {
      observed.push({ cmd: e.commandName, maxTimeMS: e.command.maxTimeMS });
    }
  });

  const Probe = mongoose.model('DeadlineProbe', new mongoose.Schema({}, { strict: false, collection: 'owners' }));

  // 1. inside a request budget.
  //    The body must be async and awaited INSIDE the context — returning an
  //    unexecuted Query defers exec() until after the context has exited, which
  //    is the one usage that silently gets no coverage. Express handlers await
  //    inside, which is why the middleware path below is the real proof.
  observed.length = 0;
  await runWithRequestBudget(REQUEST_DEADLINE_MS, async () => { await Probe.find({}).limit(1).lean(); });
  const inReq = observed.at(-1);
  check('find inside a request carries maxTimeMS',
    inReq && inReq.maxTimeMS > 0 && inReq.maxTimeMS <= QUERY_TIMEOUT_MS.read,
    `maxTimeMS=${inReq && inReq.maxTimeMS} (read class ${QUERY_TIMEOUT_MS.read})`);

  // 2. outside any request → job class, not a request deadline
  observed.length = 0;
  await Probe.find({}).limit(1).lean();
  const outReq = observed.at(-1);
  check('find outside a request gets the job class',
    outReq && outReq.maxTimeMS === deadlineFor('job'),
    `maxTimeMS=${outReq && outReq.maxTimeMS} (job class ${deadlineFor('job')})`);

  // 3. late in a request → shortened to what remains
  observed.length = 0;
  await runWithRequestBudget(2000, async () => { await Probe.find({}).limit(1).lean(); });
  const late = observed.at(-1);
  check('a query late in a request is shortened to the remaining budget',
    late && late.maxTimeMS < QUERY_TIMEOUT_MS.read,
    `maxTimeMS=${late && late.maxTimeMS}`);

  // 4. aggregate goes through option({maxTimeMS})
  observed.length = 0;
  await runWithRequestBudget(REQUEST_DEADLINE_MS, async () => { await Probe.aggregate([{ $limit: 1 }]); });
  const agg = observed.at(-1);
  check('aggregate carries maxTimeMS on the wire',
    agg && agg.cmd === 'aggregate' && agg.maxTimeMS > 0,
    `maxTimeMS=${agg && agg.maxTimeMS}`);

  // 5. an explicit deadline is not overridden
  observed.length = 0;
  await runWithRequestBudget(REQUEST_DEADLINE_MS, async () => { await Probe.find({}).maxTimeMS(1234).limit(1).lean(); });
  check('an explicit maxTimeMS survives the hook',
    observed.at(-1) && observed.at(-1).maxTimeMS === 1234,
    `maxTimeMS=${observed.at(-1) && observed.at(-1).maxTimeMS}`);

  // 6. THE ONE THAT MATTERS: the server actually kills the operation.
  let killed = null;
  try {
    // Deterministic server-side CPU work with an impossible deadline. $where
    // is rejected on this Atlas tier, and a collection scan can finish inside
    // the limit and make this check flaky; a reduce over a million elements
    // cannot. Read-only — it touches one document.
    await Probe.aggregate([
      { $limit: 1 },
      { $addFields: { _vfy: { $reduce: {
        input: { $range: [0, 1000000] }, initialValue: 0,
        in: { $add: ['$$value', '$$this'] },
      } } } },
      { $project: { _vfy: 1 } },
    ]).option({ maxTimeMS: 50 });
  } catch (err) {
    killed = err;
  }
  check('MongoDB terminates an over-running operation server-side',
    Boolean(killed) && (killed.code === 50 || /MaxTimeMSExpired|operation exceeded time limit/i.test(killed.message)),
    killed ? `code=${killed.code} ${String(killed.message).slice(0, 60)}` : 'no error raised');

  // 7. The real path: Express + the real requestDeadline middleware.
  const express = require('express');
  const { requestDeadline } = require('../middleware/requestDeadline');
  const app = express();
  app.use('/api', requestDeadline);
  app.get('/api/owners/probe', async (req, res) => {
    await Probe.find({}).limit(1).lean();
    res.json({ ok: true });
  });
  app.get('/api/upload/probe', async (req, res) => {   // deadline-exempt prefix
    await Probe.find({}).limit(1).lean();
    res.json({ ok: true });
  });

  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;

  observed.length = 0;
  await fetch(`http://127.0.0.1:${port}/api/owners/probe`).then(r => r.json());
  const viaHttp = observed.at(-1);
  check('a real Owner Panel request bounds its query at the read class',
    viaHttp && viaHttp.maxTimeMS > 0 && viaHttp.maxTimeMS <= QUERY_TIMEOUT_MS.read,
    `maxTimeMS=${viaHttp && viaHttp.maxTimeMS}`);

  observed.length = 0;
  await fetch(`http://127.0.0.1:${port}/api/upload/probe`).then(r => r.json());
  const viaExempt = observed.at(-1);
  check('a deadline-exempt route does NOT inherit the request deadline',
    viaExempt && viaExempt.maxTimeMS === deadlineFor('job'),
    `maxTimeMS=${viaExempt && viaExempt.maxTimeMS} (job class ${deadlineFor('job')})`);

  await new Promise(r => server.close(r));
  await mongoose.disconnect();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('verification aborted:', e.message);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
