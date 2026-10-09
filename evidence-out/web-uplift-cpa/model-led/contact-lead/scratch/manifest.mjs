import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const raw = readFileSync(new URL('../../../../knowledge/principles.json', import.meta.url));
const p = JSON.parse(raw);
const rows = [];
for (const x of p.principles) for (const c of x.checks) rows.push({ principleId: x.id, checkId: c.id });
const sha = createHash('sha256').update(raw).digest('hex');
writeFileSync(new URL('./manifest.json', import.meta.url), JSON.stringify({ catalog: p.guidanceCatalogVersion, sha256: sha, expected: rows.length, rows }, null, 2));
console.log(p.guidanceCatalogVersion, sha, rows.length);
for (const x of p.principles) {
  console.log('##', x.id, x.applicability?.expectation);
  for (const c of x.checks) console.log(' -', c.id, '|', (c.detectableVia || '').slice(0, 260), '| guides:', JSON.stringify(c.guides));
}
