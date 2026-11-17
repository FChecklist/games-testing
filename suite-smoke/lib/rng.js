// Seeded, deterministic random numbers. Same (seed, caseIndex) always gives the same case.
export function hash32(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) for (const c of String(p)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0; h ^= h >>> 13;
  return h >>> 0;
}
export function rng(seed, idx) {
  let a = hash32(seed, idx) || 1;
  const next = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = { next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p };
  return r;
}
export const cross = (...lists) => lists.reduce((acc, l) => acc.flatMap((a) => l.map((x) => [...a, x])), [[]]);
