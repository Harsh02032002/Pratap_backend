'use strict';

/**
 * auditTimeouts.js — static guard for the timeout architecture.
 *
 *   node scripts/auditTimeouts.js
 *
 * Deliberately narrow. A scanner that flags every query would be ignored within
 * a week, so this only reports things that are wrong regardless of context:
 *
 *   1. a second place that configures Mongo timeouts, which can be wired up by
 *      mistake and quietly override the tuned values
 *   2. Mongo timeout literals outside config/timeouts.js
 *   3. Aggregate.maxTimeMS(), which does not exist in Mongoose 8 and no-ops
 *   4. a hierarchy that no longer holds
 *
 * Exits non-zero on any finding.
 */

const fs = require('fs');
const path = require('path');
const cfg = require('../config/timeouts');

const ROOT = path.join(__dirname, '..');
const SKIP = /node_modules|\.git|admin-dist|public|scratch|^tests$/;

// Standalone maintenance tools. They open their own short-lived connection,
// outside the request path and outside the pool the server uses, so the request
// hierarchy does not apply to them.
const ONE_OFF_TOOL = /^(check[-_]|fix[-_]|update[-_]|create[-_]|reset[-_]|seed[-_]?|add[-_]|inspect[-_]|find[-_]|activate[-_]|sync[-_]|run[-_]|test[-_]|attach[-_])/;

// Dead duplicates of the Mongo connection options, kept in the tree but wired to
// nothing: config/database.js is imported by no file, and config/db.js only by
// config/database.js. Both still carry pre-fix values (socketTimeoutMS 45000),
// so wiring either one up would silently undo the tuned configuration. They are
// listed rather than corrected because correcting a dead file only makes the
// audit look clean; the real fix is deletion, which is a call for the owners of
// this repo to make.
const KNOWN_DEAD_CONFIGS = new Set(['config/database.js', 'config/db.js']);
const TIMEOUT_KEYS = /(serverSelectionTimeoutMS|connectTimeoutMS|socketTimeoutMS|waitQueueTimeoutMS|maxPoolSize|minPoolSize)\s*:/;

const findings = [];
const add = (severity, file, line, msg) => findings.push({ severity, file, line, msg });

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const CONFIG = path.join(ROOT, 'config', 'timeouts.js');

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const src = fs.readFileSync(file, 'utf8');

  src.split('\n').forEach((line, i) => {
    const n = i + 1;

    // 3. An API that silently does nothing on Mongoose 8.
    if (/\baggregate\s*\([^)]*\)\s*\.\s*maxTimeMS\s*\(/.test(line) || /^\s*\.\s*maxTimeMS\s*\(/.test(line) && /aggregate/.test(src.slice(Math.max(0, src.indexOf(line) - 200), src.indexOf(line)))) {
      add('ERROR', rel, n, 'Aggregate.maxTimeMS() does not exist in Mongoose 8 — use .option({ maxTimeMS })');
    }

    // 1 + 2. Timeout configuration living somewhere other than the one file.
    if (file !== CONFIG && TIMEOUT_KEYS.test(line) && /\d{3,}/.test(line)) {
      const base = path.basename(rel);
      if (ONE_OFF_TOOL.test(base) || rel.startsWith('scripts/')) return;   // developer tools
      if (KNOWN_DEAD_CONFIGS.has(rel)) {
        add('WARN', rel, n, 'dead duplicate Mongo config — not imported by server.js; delete it rather than letting it drift');
        return;
      }
      add('ERROR', rel, n, `Mongo timeout literal outside config/timeouts.js: ${line.trim().slice(0, 70)}`);
    }
  });
}

// 4. The hierarchy itself.
const { MONGO, REQUEST_DEADLINE_MS, CLIENT_TIMEOUT_MS, QUERY_TIMEOUT_MS } = cfg;
const invariants = [
  [CLIENT_TIMEOUT_MS > REQUEST_DEADLINE_MS, 'client must exceed the request deadline'],
  [REQUEST_DEADLINE_MS > QUERY_TIMEOUT_MS.read, 'request deadline must exceed the read deadline'],
  [QUERY_TIMEOUT_MS.read > MONGO.waitQueueTimeoutMS, 'read deadline must exceed the pool wait'],
  [MONGO.waitQueueTimeoutMS > MONGO.connectTimeoutMS, 'pool wait must exceed connect'],
  [MONGO.waitQueueTimeoutMS / REQUEST_DEADLINE_MS <= 0.4, 'pool wait must stay at or under 40% of the request budget'],
  [MONGO.socketTimeoutMS > QUERY_TIMEOUT_MS.job, 'socket timeout must stay above the job deadline'],
];
for (const [ok, msg] of invariants) if (!ok) add('ERROR', 'config/timeouts.js', 0, `hierarchy: ${msg}`);

const errors = findings.filter(f => f.severity === 'ERROR');
const warns = findings.filter(f => f.severity === 'WARN');

for (const f of [...errors, ...warns]) {
  console.log(`${f.severity.padEnd(5)} ${f.file}${f.line ? ':' + f.line : ''}  ${f.msg}`);
}
console.log(`\n${errors.length} error(s), ${warns.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
