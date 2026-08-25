'use strict';

/**
 * scanGetWrites.js — static guard: reports database writes inside GET handlers.
 *
 *   node scripts/scanGetWrites.js routes/
 *
 * A GET should read and respond. Anything this prints is either a legitimate
 * exception (a view counter, a create-if-missing singleton) or an instance of
 * the repair-on-read problem that jobs/ownerPropertyHealJob.js exists to fix.
 * Review every new entry before accepting it.
 *
 * Exits non-zero when a repair function is found on a GET path.
 */
// Static scan: for each router.get(...) handler, report write ops in its body.
const fs = require('fs'), path = require('path');
const WRITES = /\.(save|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|bulkWrite|insertMany|create)\s*\(/g;
const HEAL  = /(healOwnerProperties|healTenantInvoices|fireHeal|syncPropertyOccupancyData|autoHealMoveInInvoices)\s*\(|enrichTenantsWithDues\s*\([^)]*repair/g;
const dir = process.argv[2];
let findings = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (!/router\.get\s*\(/.test(line)) return;
    // walk forward to the end of this handler by brace balance
    let depth = 0, started = false, body = [];
    for (let j = i; j < lines.length && j < i + 400; j++) {
      for (const ch of lines[j]) { if (ch === '(' || ch === '{') { depth++; started = true; } else if (ch === ')' || ch === '}') depth--; }
      body.push([j + 1, lines[j]]);
      if (started && depth <= 0) break;
    }
    for (const [ln, l] of body) {
      if (l.trim().startsWith('//') || l.trim().startsWith('*')) continue;
      const w = l.match(WRITES), h = l.match(HEAL);
      if (w || h) findings.push(`${f}:${ln}  [GET @${i + 1}]  ${(h ? 'REPAIR ' : 'WRITE  ')}${l.trim().slice(0, 110)}`);
    }
  });
}
console.log(findings.length ? findings.join('\n') : '  (no writes or repair calls found inside router.get handlers)');
process.exit(findings.some((f) => f.includes('REPAIR')) ? 1 : 0);
