// Case recorder: counts per cell, keeps failures with a replayable trace, streams a checkpoint. No giant arrays.
import { writeFileSync, appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Recorder {
  constructor(suite, outDir) {
    this.suite = suite; this.dir = outDir; mkdirSync(outDir, { recursive: true });
    this.cells = new Map(); // cell key -> {run, fail}
    this.run = 0; this.fail = 0; this.checks = 0; this.byInvariant = new Map(); this.failFile = `${outDir}/${suite}.failures.jsonl`;
    this.keptFailures = 0;
  }
  add(cell, violations, trace, meta) {
    this.run++;
    const c = this.cells.get(cell) ?? { run: 0, fail: 0 }; c.run++; this.cells.set(cell, c);
    this.checks += meta.checks ?? 0;
    if (violations.length) {
      this.fail++; c.fail++;
      for (const v of violations) this.byInvariant.set(v.code, (this.byInvariant.get(v.code) ?? 0) + 1);
      if (this.keptFailures < 200) { this.keptFailures++; appendFileSync(this.failFile, JSON.stringify({ suite: this.suite, cell, ...meta, violations: violations.slice(0, 5), trace: trace.slice(-40) }).replace(/@/g, '[at]') + '\n'); }
    }
  }
  summary() {
    return { suite: this.suite, cases: this.run, failed: this.fail, checks: this.checks, cells: this.cells.size,
      invariants_violated: Object.fromEntries(this.byInvariant),
      cell_counts: Object.fromEntries([...this.cells].map(([k, v]) => [k, [v.run, v.fail]])) };
  }
  save(extra = {}) { writeFileSync(`${this.dir}/${this.suite}.summary.json`, JSON.stringify({ ...this.summary(), ...extra }, null, 1)); }
}
// Violation collector for one case
export class Case {
  constructor() { this.v = []; this.trace = []; this.checks = 0; }
  ok(cond, code, detail) { this.checks++; if (!cond) this.v.push({ code, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }); return !!cond; }
  eq(a, b, code, detail) { this.checks++; if (a !== b) this.v.push({ code, detail: `${detail ?? ''} got ${JSON.stringify(a)} want ${JSON.stringify(b)}` }); return a === b; }
  note(x) { this.trace.push(x); }
}
export const loadProgress = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
