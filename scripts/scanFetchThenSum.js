'use strict';
/**
 * scanFetchThenSum.js — static guard for the "fetch everything, sum in JS" pattern.
 *
 *   node scripts/scanFetchThenSum.js
 *
 * Flags a variable that is assigned from a money-model .find() and is then only
 * ever reduced/summed — i.e. the documents were fetched purely to be collapsed
 * into a scalar, which belongs in a $group/$sum instead.
 *
 * Reports each hit with whether the docs are used elsewhere, so legitimate
 * list endpoints (which genuinely need the documents) are not false positives.
 */
const fs = require('fs'), path = require('path');
const MONEY = /(PaymentTransaction|RentPayment|RentInvoice|PayoutRequest|PayoutLog|Rent)\.find\(/;
const DIRS = ['routes', 'controllers', 'services', 'utils', 'jobs'];
const root = path.join(__dirname, '..');
let hits = 0;

for (const dir of DIRS) {
  const d = path.join(root, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.js')) continue;
    const rel = `${dir}/${f}`;
    // Strip comments so doc blocks that quote the old pattern aren't flagged.
    const src = fs.readFileSync(path.join(d, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^([^\n]*?)\/\/.*$/gm, '$1');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      if (!MONEY.test(line)) return;
      const m = line.match(/(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z]+\.find\(/);
      if (!m) return;
      const v = m[1];
      const uses = lines
        .map((l, n) => [n + 1, l])
        .filter(([n, l]) => n !== i + 1 && new RegExp(`\\b${v}\\b`).test(l));
      const summed = uses.some(([, l]) => /\.reduce\(|\.map\(.*\+|forEach\(.*\+=/.test(l));
      const otherUse = uses.some(([, l]) => !/\.reduce\(/.test(l));
      if (summed && !otherUse) {
        hits++;
        console.log(`${rel}:${i + 1}  '${v}' is fetched then only summed → convert to $group/$sum`);
      }
    });
  }
}
console.log(hits === 0
  ? '  no fetch-then-sum-only patterns found'
  : `  ${hits} candidate(s) above`);
process.exit(hits === 0 ? 0 : 1);
