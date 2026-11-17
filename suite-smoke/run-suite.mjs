// Generic runner with checkpoint/resume:  node run-suite.mjs <suite> <seed> <total> [outDir]
// Streams results; never keeps more than the summary in memory. Resumes from <outDir>/<suite>.ckpt.json.
import { Recorder } from './lib/run.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [suite, seed = 'S1', totalS = '1000', out = './results/run'] = process.argv.slice(2);
const RANGE = process.env.RANGE; // shard mode: RANGE=<first>-<last exclusive>, e.g. 40000-50000
const [rFirst, rLast] = RANGE ? RANGE.split('-').map(Number) : [0, +totalS];
const total = rLast;
const m = await import(`./suites/${suite}.js`);
const ck = `${out}/${suite}.ckpt.json`;
const rec = new Recorder(suite, out);
let start = rFirst;
if (existsSync(ck)) { const k = JSON.parse(readFileSync(ck, 'utf8')); if (k.seed === seed) { start = k.next; rec.run = k.run; rec.fail = k.fail; rec.checks = k.checks; for (const [a, v] of Object.entries(k.cells)) rec.cells.set(a, { run: v[0], fail: v[1] }); for (const [a, v] of Object.entries(k.inv)) rec.byInvariant.set(a, v); rec.keptFailures = k.kept ?? 0; } }
const fast = process.env.TIER !== 'signed';
const BATCH = +(process.env.BATCH ?? 150);
let w = await m.newWorld({ fast });
const t0 = Date.now();
const save = (next) => writeFileSync(ck, JSON.stringify({ seed, next, run: rec.run, fail: rec.fail, checks: rec.checks, kept: rec.keptFailures, cells: Object.fromEntries([...rec.cells].map(([a, v]) => [a, [v.run, v.fail]])), inv: Object.fromEntries(rec.byInvariant) }));
for (let i = start; i < total; i++) {
  if (i > start && i % BATCH === 0) w = await m.newWorld({ fast });
  const { cell, c } = await m.runCase(w, i, seed);
  rec.add(cell, c.v, c.trace, { idx: i, seed, checks: c.checks });
  if (i % 5000 === 4999) { save(i + 1); process.stderr.write(`${suite} ${i + 1}/${total} fail=${rec.fail} ${(((i + 1 - start) * 1000) / (Date.now() - t0)) | 0} cases/s\n`); }
}
save(total);
rec.save({ seed, total, ms: Date.now() - t0, tier: fast ? 'fast' : 'signed' });
console.log(JSON.stringify({ suite, seed, cases: rec.run, failed: rec.fail, checks: rec.checks, cells: rec.cells.size, ms: Date.now() - t0, inv: Object.fromEntries(rec.byInvariant) }));
