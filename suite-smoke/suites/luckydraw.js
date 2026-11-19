// Seeded, deterministic, in-process smoke suite for Corporate Lucky Draw (repo corporate-luckydraw, branch feat/luckydraw-on-engine-2026-10-31).
// Same harness contract as suites/tambola.js and suites/tambola2.js: exports CELLS, newWorld, runCase(w, idx, seed) -> {cell, c}; Case methods ok/eq/note; rng(seed, idx).
// One case = one cell; all randomness comes from rng(seed, idx), so (seed, idx) replays exactly. No server, no network, no bun: the TypeScript is imported by lib/tsresolve.js.
//
// WHAT THE GAME IS (read from the code and its comments, nothing else is assumed): a single draw, no rounds. People enter (one entry per person, cleaned ID, a cap), registration
// closes at the draw time (auto) or when Organizer/Host presses Draw (manual), the draw takes the public beacon value, the lowest sha256 ranks win, one entry never wins twice.
// Real code driven:
//   vendor/game-core/packages/luckydraw (rules module: register, registerMany, tick, draw, winnersFor, rankOf, registerWhy, prizePlaces), core (clock, pause/resume, IDs, late-join rule),
//   manifest, apps/edge/src/draw.ts (checkDrawSettings, registrationClosed, runDraw end to end on a real node:sqlite database built from the product SCHEMA, with the REAL signed beacon
//   round that the product's own beacon test keeps as a fixture - nothing is faked except the network call that returns it; drawFacts), apps/edge/src/credit.ts (credit instead of refunds),
//   packages/shared/src/pricing.ts.
// The ORACLE is independent: sha256 from node:crypto for the published rank formula, its own ID cleaning, ordinals, model of entries, model of the pause clock, own IST date maths.
//
// WHAT THE GAME LACKS (so the suite has no cells for it; cells "lacks|..." fail the day one of these appears, as a reminder to extend the suite):
//   per-round draws (there is exactly one draw per game; state has no round), Unlucky prize, boosters (Joker, extra ticket, lucky-draw pass), game-over vote / quorum
//   (the game ends by itself when the draw is made; organizerFinalSay is false), claims and Bogeys (claimType auto, the button says "You won"), any payment by a participant.
import '../lib/tsresolve.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { ROOT } from '../lib/roots.js';

// The clone: LUCKYDRAW_DIR, else <SUITE_ROOT>/corporate-luckydraw, else <SUITE_ROOT>/sc/corporate-luckydraw.
const REPO = realpathSync(process.env.LUCKYDRAW_DIR ?? [resolve(ROOT, 'corporate-luckydraw'), resolve(ROOT, 'sc/corporate-luckydraw')].find((p) => existsSync(p)) ?? resolve(ROOT, 'sc/corporate-luckydraw'));
const R = (p) => import(pathToFileURL(resolve(REPO, p)).href);
const LD = await R('vendor/game-core/packages/luckydraw/src/index.ts');
const CO = await R('vendor/game-core/packages/core/src/index.ts');
const MF = await R('vendor/game-core/packages/manifest/src/index.ts');
const DR = await R('apps/edge/src/draw.ts');
const CR = await R('apps/edge/src/credit.ts');
const PR = await R('packages/shared/src/pricing.ts');
const WK = await R('apps/edge/src/worker.ts');
const rules = LD.luckyDrawRules;
const rd = (p) => readFileSync(resolve(REPO, p), 'utf8');

// the genuine signed beacon round kept as a fixture by the product's own beacon test (public randomness, read at load, not copied here)
const FX = (() => { try { const m = /round:\s*(\d+),\s*randomness:\s*"([0-9a-f]{64})",\s*signature:\s*"([0-9a-f]+)"/.exec(rd('packages/beacon/test/beacon.test.ts')); return m ? { round: +m[1], randomness: m[2], signature: m[3] } : null; } catch { return null; } })();

// ================================================================ independent oracle
const AT = String.fromCharCode(64);
const DAY = 86_400_000, IST = 19_800_000;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The published rank: anybody holding the entries and the beacon value can compute it. */
const rankO = (eid, ref, beacon, id) => sha(`CB1-LUCKY|${eid}|${ref}|${beacon}|${id}`);
/** Lowest ranks win, one entry once, the first n. */
const winnersO = (eid, ref, beacon, entries, n) => [...new Set(entries)].map((id) => [rankO(eid, ref, beacon, id), id]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).slice(0, Math.max(0, n)).map((x) => x[1]);
/** Employee ID: letters and numbers only, upper case, up to 30; an e-mail typed here is refused, not mangled. */
const normEmpO = (raw) => { const s = String(raw ?? ''); if (s.trim() === '') return null; const k = s.normalize('NFKC'); if (k.includes(AT)) return null; const cl = k.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); return cl && cl.length <= 30 ? cl : null; };
/** E-mail ID: NFKC, every space removed, lower case. */
const ZW = new RegExp('[\\s' + [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x85, 0x2028, 0x2029].map((x) => String.fromCharCode(x)).join('') + ']', 'g');
const normEmailO = (raw) => { const cl = String(raw ?? '').normalize('NFKC').replace(ZW, '').toLowerCase(); return cl || null; };
const normO = (kind, raw) => (kind === 'email' ? normEmailO(raw) : normEmpO(raw));
const ordEn = (k) => { const t = k % 100; if (t >= 11 && t <= 13) return `${k}th`; return k + (k % 10 === 1 ? 'st' : k % 10 === 2 ? 'nd' : k % 10 === 3 ? 'rd' : 'th'); };
/** The entries a draw should hold: cleaned, first come first kept, no repeat, at most cap. */
const modelEntries = (kind, raws, cap) => { const seen = new Set(), out = []; for (const raw of raws) { const id = normO(kind, raw); if (!id || seen.has(id) || out.length >= cap) continue; seen.add(id); out.push(id); } return out; };
const hex = (r, n) => Array.from({ length: n }, () => r.int(0, 15).toString(16)).join('');
const ALN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const alnum = (r, n) => Array.from({ length: n }, () => ALN[r.int(0, ALN.length - 1)]).join('');
const shuffle = (r, a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = r.int(0, i); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const fullwidth = (s) => s.replace(/[A-Za-z0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
const j = (a) => a.join('|');
const BASE = 1_800_000_000_000;
const ROLES5 = ['organizer', 'host', 'cohost', 'participant', 'family'];
const MODES = ['auto', 'manual'];
const GOLDEN = [[100, 2399, 34], [250, 3499, 51], [500, 4699, 67], [750, 5899, 84], [1000, 7099, 101], [2500, 11799, 169], [5000, 17699, 253], [10000, 29499, 421]];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const istParts = (ms) => { const d = new Date(ms + IST); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const creditExpiryOracle = (paidMs) => { const [y, m, d] = istParts(paidMs); return Date.UTC(y, m, d + 366) - IST; };

// ================================================================ cells
const EMP_FAULTS = ['ok', 'dup_exact', 'dup_format', 'invalid_mix', 'symbols', 'length', 'email_typed', 'fullwidth', 'cap', 'rehearsal_cap', 'manual_open'];
const EMAIL_FAULTS = ['ok', 'dup_case', 'dup_space', 'empty', 'cap'];
const LATE_WHEN = ['long_before', 'one_ms_before', 'at_close', 'one_ms_after', 'long_after', 'after_draw'];
const PAUSE_SCEN = [['auto', 'register_while_paused'], ['auto', 'draw_while_paused'], ['auto', 'resume_extends_registration'], ['auto', 'draw_waits_after_resume'], ['auto', 'nonhost_cannot_pause'], ['auto', 'two_pauses'],
  ['manual', 'register_while_paused'], ['manual', 'press_while_paused'], ['manual', 'nonhost_cannot_pause']];
const WIN_VARIANTS = ['undefined', 'one', 'two', 'ten', 'thousand', 'over_max', 'zero', 'negative', 'fraction', 'string', 'null', 'nan', 'over_cap'];
const MODE_VARIANTS = ['auto', 'manual', 'undefined', 'null', 'weird', 'number'];
const PRIZE_VARIANTS = ['array', 'string', 'too_many', 'dirty', 'long', 'non_string', 'rehearsal_drops', 'empty', 'fewer'];
const INIT_VARIANTS = ['winners_zero', 'winners_negative', 'winners_nan', 'winners_fraction', 'auto_no_closeAt', 'manual_no_closeAt', 'cap_clamped', 'rehearsal_cap', 'prizes_split', 'defaults'];
const ORD_K = [1, 2, 3, 4, 10, 11, 12, 13, 20, 21, 22, 23, 24, 100, 101, 102, 111, 121, 1000];
const E2E_COMMON = ['normal', 'mixed', 'fewer', 'zero', 'twice', 'paused', 'beacon_down', 'over_cap', 'facts', 'no_row'];
const E2E_BY = { auto: [...E2E_COMMON, 'too_early', 'wrong_mode'], manual: [...E2E_COMMON, 'wrong_role', 'wrong_mode'] };
export const CELLS = [
  // entries
  ...cross(['entry'], ['emp'], EMP_FAULTS).map(j),
  ...cross(['entry'], ['email'], EMAIL_FAULTS).map(j),
  // late joiners (a late entry counts until the draw time; none after) and the documented late-join rule
  ...cross(['late'], MODES, LATE_WHEN, ['one', 'batch']).map(j),
  ...cross(['late'], MODES, ['can_win'], ['late_joiner']).map(j),
  ...['rule', 'before', 'at', 'after', 'over', 'no_close_at'].map((v) => j(['latejoin', v])),
  // the one draw: when it happens, who may press, what it needs
  ...cross(['draw'], ['auto'], ['tick'], ['before', 'at', 'after'], ['beacon', 'nobeacon'], ['-']).map(j),
  ...cross(['draw'], ['auto'], ['press'], ['after'], ['beacon'], ROLES5).map(j),
  ...cross(['draw'], ['manual'], ['tick'], ['before', 'after'], ['beacon'], ['-']).map(j),
  ...cross(['draw'], ['manual'], ['press'], ['after'], ['beacon', 'nobeacon'], ROLES5).map(j),
  // game over: nothing registers, nothing draws again, winners never change
  ...cross(['over'], MODES, ['register', 'registerMany', 'tick', 'press_org', 'press_host', 'second_beacon']).map(j),
  // pause: the draw time waits, nothing registers while paused
  ...PAUSE_SCEN.map(([m, s]) => j(['pause', m, s])),
  // the organizer's draw settings, engine init, and the "registration closed" truth table
  ...WIN_VARIANTS.map((v) => j(['setup', 'winners', v])),
  ...MODE_VARIANTS.map((v) => j(['setup', 'mode', v])),
  ...PRIZE_VARIANTS.map((v) => j(['setup', 'prizes', v])),
  ...INIT_VARIANTS.map((v) => j(['setup', 'init', v])),
  ...cross(['closed'], MODES, ['no_draw_row', 'open', 'closing', 'drawn'], ['running', 'paused'], ['before', 'at', 'after']).map(j),
  // winner selection fairness
  ...cross(['fair'], ['oracle'], ['1', '2', '3', '7', '50', '300'], ['1', '3', 'all', 'more']).map(j),
  ...[['2', '1'], ['3', '1'], ['3', '2'], ['5', '1'], ['5', '2'], ['8', '1'], ['8', '2']].map(([n, w]) => j(['fair', 'every', n, w])),
  ...cross(['fair'], ['engine'], ['1', '4', '25'], ['1', '3']).map(j),
  ...cross(['fair'], ['perm'], ['3', '10'], ['1', '2']).map(j),
  // wording
  ...ORD_K.map((k) => j(['word', 'ordinal', String(k)])),
  ...['invalid', 'closed', 'dup', 'full', 'done', 'ok'].map((v) => j(['word', 'why', v])),
  ...['fairness', 'manifest', 'fields', 'banned'].map((v) => j(['word', v])),
  // what the game does not have
  ...['unlucky', 'boosters', 'game_over_vote', 'per_round', 'claims', 'participant_payment'].map((v) => j(['lacks', v])),
  // credits / money (the shared platform code the game uses): credit instead of refunds, and the price list
  ...cross(['credit'], ['full', 'remainder', 'partial', 'idempotent', 'restore', 'restore_lapsed', 'two_oldest', 'expired_old', 'at_expiry', 'before_expiry', 'cancelled_game', 'dup_payment', 'other_org', 'other_currency'], ['INR', 'USD'], ['plain', 'ist_midnight']).map(j),
  ...cross(['price'], GOLDEN.map((g) => String(g[0])), ['INR', 'USD']).map(j),
  j(['price', 'unknown', 'INR']),
  // the whole path on a real database: seats -> entries -> runDraw (real signed beacon round) -> result, prizes, life, facts
  ...MODES.flatMap((m) => ['live', 'rehearsal'].flatMap((l) => E2E_BY[m].map((s) => j(['e2e', m, l, s])))),
];
export async function newWorld() { return { cases: 0 }; }

// ================================================================ shared small helpers
const runningClock = () => CO.start(CO.newClock());
const newRules = (o) => rules.init({ eid: o.eid ?? 'E1', ref: o.ref ?? '0', winners: o.winners ?? 1, draw: o.mode ?? 'auto', idKind: o.kind ?? 'emp', cap: o.cap ?? 100_000, rehearsal: o.rehearsal, closeAt: o.mode === 'manual' ? undefined : o.closeAt, prizes: o.prizes ?? '' }, [], BASE);
const regMany = (s, ids, t, clk = runningClock()) => rules.step(s, { type: 'registerMany', players: ids }, t, clk).state;
const personId = (r, i) => `${r.pick(['E', 'emp', 'Z9', 'ab'])}${String(i).padStart(3, '0')}${r.int(1000, 9999)}`;
const ids30 = (r, n) => Array.from({ length: n }, (_, i) => `P${i}${alnum(r, 5)}`);
/** The shape of a finished draw: wins in place order, then exactly one end. */
function checkOutcomes(c, out, drawn, label) {
  c.eq(out.length, drawn.length + 1, 'outcomes_are_one_win_per_winner_then_end', label);
  c.eq(out.filter((o) => o.kind === 'end').length, 1, 'exactly_one_end_outcome', label);
  c.eq(out[out.length - 1]?.kind, 'end', 'end_outcome_is_last', label);
  drawn.forEach((p, i) => { const o = out[i]; c.ok(o?.kind === 'win' && o.player === p && o.position === ordEn(i + 1), 'win_outcome_names_winner_and_plain_place', { i, o }); });
}

// ================================================================ entries
function rawIds(r, kind, fault) {
  const n = fault === 'cap' ? r.int(6, 20) : fault === 'rehearsal_cap' ? r.int(12, 25) : r.int(1, 12);
  const emailOf = (i) => `${r.pick(['kim', 'lee', 'ana'])}${i}x${r.int(10, 99)}${AT}corp.test`;
  const base = Array.from({ length: n }, (_, i) => (kind === 'email' ? emailOf(i) : personId(r, i)));
  const vEmp = [(s) => s, (s) => s.toLowerCase(), (s) => s.replace(/(.{2})/g, '$1-'), (s) => ` ${s} `, (s) => s.split('').join(' '), fullwidth];
  const vMail = [(s) => s, (s) => s.toUpperCase(), (s) => ` ${s}  `, (s) => s.replace(AT, ` ${AT}`), (s) => `${s.slice(0, 2)}\u200b${s.slice(2)}`];
  let out = [];
  if (fault === 'dup_exact') for (const b of base) for (let k = r.int(1, 3); k > 0; k--) out.push(b);
  else if (fault === 'dup_format' || fault === 'fullwidth') for (const b of base) for (let k = r.int(1, 4); k > 0; k--) out.push(fault === 'fullwidth' && k % 2 ? fullwidth(b) : r.pick(vEmp)(b));
  else if (fault === 'dup_case') for (const b of base) for (let k = r.int(1, 4); k > 0; k--) out.push(r.chance(0.5) ? b.toUpperCase() : b);
  else if (fault === 'dup_space') for (const b of base) for (let k = r.int(1, 4); k > 0; k--) out.push(r.pick(vMail)(b));
  else if (fault === 'invalid_mix') out = [...base, '', '   ', null, undefined, '---', `a${AT}b`, 'x'.repeat(31), '_'];
  else if (fault === 'symbols') out = [...base.slice(0, 3), '---', '___', '!!!', '  -  ', '***'];
  else if (fault === 'length') out = [...base.slice(0, 2), ...[27, 28, 29, 30, 31, 32, 40].map((L) => alnum(r, L))];
  else if (fault === 'email_typed') out = [...base.slice(0, 4), ...Array.from({ length: 4 }, (_, i) => emailOf(i + 50))];
  else if (fault === 'empty') out = [...base, '', '  ', null, undefined, '\u200b'];
  else if (fault === 'cap') out = [...base, ...base.slice(0, 3)];
  else out = base;
  return shuffle(r, out);
}
function entryCase(c, r, parts) {
  const [, kind, fault] = parts;
  const base = BASE + r.int(0, 1e9), closeAt = base + r.int(60_000, 3_600_000), manual = fault === 'manual_open', rehearsal = fault === 'rehearsal_cap';
  const capWanted = fault === 'cap' ? r.int(1, 6) : 100_000, cap = rehearsal ? 10 : capWanted;
  const o = { eid: `E${r.int(1, 1e6)}`, kind, cap: capWanted, rehearsal, mode: manual ? 'manual' : 'auto', closeAt };
  const raws = rawIds(r, kind, fault), want = modelEntries(kind, raws, cap);
  const t = manual ? base + r.int(0, 1e12) : closeAt - r.int(1, 3_000_000);
  const clk = runningClock();
  // one by one
  let s = newRules(o);
  for (const raw of raws) {
    const prev = s.entries, why = LD.registerWhy(s, raw, t, clk), snap = JSON.stringify(s);
    const res = rules.step(s, { type: 'register', player: raw }, t, clk);
    c.ok(JSON.stringify(s) === snap, 'step_never_mutates_its_input_state');
    const id = normO(kind, raw), dup = id && prev.includes(id), full = prev.length >= cap;
    const exp = id && !dup && !full ? 1 : 0, added = res.state.entries.length - prev.length;
    c.eq(added, exp, 'register_adds_exactly_one_valid_new_entry_under_cap', { raw, id, dup, full });
    if (added) c.eq(res.state.entries[res.state.entries.length - 1], id, 'entry_kept_in_cleaned_form');
    c.eq(why === null, exp === 1, 'register_why_agrees_with_what_register_does', { raw, why });
    if (why !== null) c.eq(why, !id ? 'That ID is not valid.' : dup ? 'You are already in the draw.' : 'The draw is full.', 'refusal_message_names_the_real_cause', { raw });
    c.ok(res.out.length === 0, 'registering_gives_no_outcome');
    s = res.state;
  }
  c.ok(same(s.entries, want), 'entries_match_model_one_by_one', { got: s.entries, want });
  c.ok(new Set(s.entries).size === s.entries.length, 'one_person_one_entry');
  c.ok(s.entries.length <= cap, 'entries_never_above_cap', s.entries.length);
  // the same people in batches (the host collects a tick's registrations): same rules per person
  let b = newRules(o);
  for (let i = 0; i < raws.length;) { const k = r.int(1, 6); b = regMany(b, raws.slice(i, i + k), t, clk); i += k; }
  c.ok(same(b.entries, want), 'entries_match_model_in_batches', { got: b.entries, want });
  c.ok(same(b.entries, s.entries), 'batch_and_one_by_one_give_the_same_entries');
  if (fault === 'manual_open') { c.ok(s.entries.length === want.length && want.length > 0, 'manual_draw_registration_never_closes_by_time'); }
}

// ================================================================ late joiners
function lateCase(c, r, parts) {
  const [, mode, when, via] = parts;
  const base = BASE + r.int(0, 1e9), closeAt = base + r.int(100_000, 3_600_000), clk = runningClock();
  const manual = mode === 'manual', beacon = hex(r, 64);
  const o = { eid: `E${r.int(1, 1e6)}`, mode, closeAt, winners: 2 };
  let s = newRules(o);
  const early = ids30(r, r.int(0, 5)).map((x) => `${x}A`);
  s = regMany(s, early, base + 1, clk);
  if (when === 'can_win') return lateWins(c, r, mode, o, s, closeAt, clk);
  const drawn = when === 'after_draw';
  if (drawn) s = manual ? rules.step(s, { type: 'draw', by: 'organizer', beacon }, closeAt + 5, clk).state : rules.step(s, { type: 'tick', beacon }, closeAt + 5, clk).state;
  const T = { long_before: closeAt - r.int(100_000, 3_000_000), one_ms_before: closeAt - 1, at_close: closeAt, one_ms_after: closeAt + 1, long_after: closeAt + r.int(100_000, 3_000_000), after_draw: closeAt + 5000 }[when];
  const fresh = `LATE${alnum(r, 6)}`, before = s.entries.length;
  const s2 = via === 'one' ? rules.step(s, { type: 'register', player: fresh }, T, clk).state : regMany(s, [fresh], T, clk);
  const expIn = !drawn && (manual || T < closeAt);
  c.eq(s2.entries.length - before, expIn ? 1 : 0, 'late_entry_accepted_until_draw_time_and_never_after', { mode, when, via, T: T - closeAt });
  if (expIn) c.ok(s2.entries.includes(fresh), 'late_entry_is_in_the_list');
  const verdict = CO.canJoinLate(MF.MANIFESTS.luckydraw.lateJoin, { round: 1, over: drawn, msSinceRound1End: 0, now: T, closeAt: manual ? Infinity : closeAt });
  c.eq(verdict, expIn, 'late_join_rule_agrees_with_what_register_does', { mode, when });
  const why = LD.registerWhy(s, fresh, T, clk);
  c.eq(why === null, expIn, 'register_why_agrees_for_late_entry', { why });
  if (!expIn) c.eq(why, drawn ? 'The draw is done.' : 'Registration is closed.', 'late_refusal_says_closed_or_done');
}
function lateWins(c, r, mode, o, s, closeAt, clk) {
  // three people, the last one a late joiner one millisecond before the draw time: each of them must be able to win
  const fresh = [`ONE${alnum(r, 4)}`, `TWO${alnum(r, 4)}`, `LATE${alnum(r, 4)}`];
  let st = newRules({ ...o, winners: 1 });
  st = regMany(st, fresh.slice(0, 2), closeAt - 100_000, clk);
  st = rules.step(st, { type: 'register', player: fresh[2] }, mode === 'manual' ? closeAt : closeAt - 1, clk).state;
  c.eq(st.entries.length, 3, 'late_joiner_entered');
  const tally = new Map(fresh.map((x) => [x, 0]));
  for (let k = 0; k < 400; k++) {
    const beacon = sha(`late${k}${o.eid}`), res = mode === 'manual' ? rules.step(st, { type: 'draw', by: 'host', beacon }, closeAt + 1, clk) : rules.step(st, { type: 'tick', beacon }, closeAt, clk);
    const w = res.state.drawn?.[0]; if (w) tally.set(w, (tally.get(w) ?? 0) + 1);
  }
  for (const [id, n] of tally) c.ok(n >= 1, 'every_entrant_including_the_late_joiner_can_win', { id, n });
}
function latejoinCase(c, r, parts) {
  const v = parts[1], lj = MF.MANIFESTS.luckydraw.lateJoin, closeAt = BASE + r.int(1e6, 1e9);
  const ctx = (o) => ({ round: 1, over: false, msSinceRound1End: 0, now: closeAt - 1, closeAt, ...o });
  if (v === 'rule') {
    c.eq(lj.kind, 'until-draw', 'lucky_draw_late_join_is_until_the_draw');
    c.eq(rules.lateJoin.kind, 'until-draw', 'rules_module_late_join_is_until_the_draw');
    c.ok(same(CO.withLateWindow(lj, r.int(-5, 900)), lj), 'a_late_window_changes_nothing_for_a_draw');
  } else if (v === 'before') c.eq(CO.canJoinLate(lj, ctx({ now: closeAt - r.int(1, 1e6) })), true, 'can_join_before_draw_time');
  else if (v === 'at') c.eq(CO.canJoinLate(lj, ctx({ now: closeAt })), false, 'cannot_join_at_draw_time');
  else if (v === 'after') c.eq(CO.canJoinLate(lj, ctx({ now: closeAt + r.int(1, 1e6) })), false, 'cannot_join_after_draw_time');
  else if (v === 'over') c.eq(CO.canJoinLate(lj, ctx({ over: true })), false, 'cannot_join_a_finished_draw');
  else c.eq(CO.canJoinLate(lj, { round: 1, over: false, msSinceRound1End: 0, now: closeAt, closeAt: undefined }), false, 'no_draw_time_no_late_join');
}

// ================================================================ the one draw
function drawnState(r, mode, o, ids, closeAt, clk, beacon) {
  let s = regMany(newRules(o), ids, mode === 'auto' ? closeAt - 1 : BASE, clk);
  s = mode === 'auto' ? rules.step(s, { type: 'tick', beacon }, closeAt, clk).state : rules.step(s, { type: 'draw', by: 'organizer', beacon }, closeAt, clk).state;
  return s;
}
function drawCase(c, r, parts) {
  const [, mode, ev, when, bc, role] = parts;
  const base = BASE + r.int(0, 1e9), closeAt = base + r.int(60_000, 3_600_000), clk = runningClock();
  const n = r.int(0, 30), W = r.int(1, 5), ref = r.pick(['0', '1', '7']), eid = `E${r.int(1, 1e6)}`;
  const o = { eid, ref, winners: W, mode, closeAt };
  const ids = ids30(r, n);
  const s = regMany(newRules(o), ids, mode === 'auto' ? closeAt - 1 : base, clk);
  c.eq(s.entries.length, n, 'all_registered_before_the_draw');
  const beacon = hex(r, 64);
  const t = when === 'before' ? closeAt - r.int(1, 5e6) : when === 'at' ? closeAt : closeAt + r.int(1, 5e6);
  const evt = ev === 'tick' ? (bc === 'beacon' ? { type: 'tick', beacon } : r.pick([{ type: 'tick' }, { type: 'tick', beacon: '' }])) : { type: 'draw', by: role, beacon: bc === 'beacon' ? beacon : '' };
  const snap = JSON.stringify(s), res = rules.step(s, evt, t, clk);
  c.ok(JSON.stringify(s) === snap, 'step_never_mutates_its_input_state');
  const may = bc === 'beacon' && ((mode === 'auto' && ev === 'tick' && t >= closeAt) || (mode === 'manual' && ev === 'press' && (role === 'organizer' || role === 'host')));
  if (may) {
    const want = winnersO(eid, ref, beacon, ids.map((x) => normEmpO(x)), W);
    c.ok(same(res.state.drawn, want), 'winners_are_the_lowest_ranks_of_the_beacon', { got: res.state.drawn, want });
    c.eq(res.state.drawn.length, Math.min(W, n), 'exactly_the_configured_number_of_winners');
    c.eq(res.state.beacon, beacon, 'draw_records_the_beacon_it_used');
    c.eq(res.state.over, true, 'game_is_over_after_the_draw');
    checkOutcomes(c, res.out, res.state.drawn, `n=${n} W=${W}`);
  } else {
    c.ok(JSON.stringify(res.state) === snap && res.out.length === 0, 'no_draw_without_time_or_role_or_beacon', { mode, ev, when, bc, role });
    c.eq(res.state.drawn, null, 'nobody_drawn_yet');
  }
}
function overCase(c, r, parts) {
  const [, mode, kind] = parts;
  const base = BASE + r.int(0, 1e9), closeAt = base + r.int(60_000, 3_600_000), clk = runningClock();
  const ids = ids30(r, r.int(1, 20)), eid = `E${r.int(1, 1e6)}`, o = { eid, mode, closeAt, winners: r.int(1, 4) }, beacon = hex(r, 64);
  const s = drawnState(r, mode, o, ids, closeAt, clk, beacon);
  c.eq(s.over, true, 'drawn_game_is_over');
  const snap = JSON.stringify(s), b2 = hex(r, 64), T = closeAt + r.int(1, 1e6);
  const ev = { register: { type: 'register', player: 'NEWONE1' }, registerMany: { type: 'registerMany', players: ['NEWONE2', 'NEWONE3'] }, tick: { type: 'tick', beacon: b2 },
    press_org: { type: 'draw', by: 'organizer', beacon: b2 }, press_host: { type: 'draw', by: 'host', beacon: b2 }, second_beacon: mode === 'auto' ? { type: 'tick', beacon: b2 } : { type: 'draw', by: 'organizer', beacon: b2 } }[kind];
  const res = rules.step(s, ev, T, clk);
  c.ok(JSON.stringify(res.state) === snap && res.out.length === 0, 'nothing_changes_after_the_draw', kind);
  c.ok(same(res.state.drawn, winnersO(eid, '0', beacon, ids.map((x) => normEmpO(x)), o.winners)), 'winners_never_change_after_the_draw');
  c.eq(LD.registerWhy(s, 'NEWONE9', T, clk), 'The draw is done.', 'registering_after_the_draw_says_done');
}

// ================================================================ pause
function pauseCase(c, r, parts) {
  const [, mode, scen] = parts;
  const base = BASE + r.int(0, 1e9), D = r.int(600_000, 3_600_000), closeAt = base + D;
  const tp = base + r.int(1000, D - 1000), P = r.int(10_000, 900_000), tr = tp + P;
  const clk0 = runningClock(), paused = CO.pause(clk0, 'organizer', tp), resumed = CO.resume(paused, 'host', tr);
  c.eq(paused.phase, 'paused', 'organizer_can_pause');
  c.eq(resumed.pausedMs, P, 'resume_adds_exactly_the_paused_time');
  const probe = tr + r.int(0, 5e6);
  c.eq(CO.gameNow(resumed, probe), probe - P, 'game_time_is_wall_time_minus_paused_time');
  c.eq(CO.gameNow(paused, tp + r.int(1, P - 1)), tp, 'game_time_stands_still_while_paused');
  const ids = ids30(r, r.int(0, 8)), eid = `E${r.int(1, 1e6)}`, o = { eid, mode, closeAt, winners: 2 }, beacon = hex(r, 64);
  const s = regMany(newRules(o), ids, base + 1, clk0);
  const fresh = `PZ${alnum(r, 5)}`, reg = (st, t, cl) => rules.step(st, { type: 'register', player: fresh }, t, cl).state.entries.length - st.entries.length;
  const go = (st, t, cl) => (mode === 'auto' ? rules.step(st, { type: 'tick', beacon }, t, cl) : rules.step(st, { type: 'draw', by: 'organizer', beacon }, t, cl));
  if (scen === 'register_while_paused') {
    c.eq(reg(s, tp + r.int(1, P - 1), paused), 0, 'nothing_registers_while_paused');
    c.eq(reg(s, tp - 1, clk0), 1, 'registering_works_before_the_pause');
  } else if (scen === 'draw_while_paused' || scen === 'press_while_paused') {
    const res = go(s, closeAt + r.int(1, 1e6), paused);
    c.ok(res.state.drawn === null && res.out.length === 0, 'nothing_draws_while_paused');
    if (scen === 'press_while_paused') { const after = go(s, closeAt + P + r.int(0, 1e6), resumed); c.ok(after.state.drawn !== null, 'manual_press_works_after_resume'); }
  } else if (scen === 'resume_extends_registration') {
    c.eq(reg(s, closeAt + r.int(0, P - 1), resumed), 1, 'resume_moves_the_close_time_later_by_the_paused_time');
    c.eq(reg(s, closeAt + P - 1, resumed), 1, 'last_millisecond_before_shifted_close_still_registers');
    c.eq(reg(s, closeAt + P, resumed), 0, 'shifted_close_time_closes_registration');
  } else if (scen === 'draw_waits_after_resume') {
    const early = go(s, closeAt + r.int(0, P - 1), resumed);
    c.ok(early.state.drawn === null, 'draw_time_waits_for_the_paused_time');
    const ok = go(s, closeAt + P + r.int(0, 100), resumed);
    c.ok(ok.state.drawn !== null && same(ok.state.drawn, winnersO(eid, '0', beacon, ids.map((x) => normEmpO(x)), 2)), 'draw_happens_at_the_shifted_time');
  } else if (scen === 'nonhost_cannot_pause') {
    const who = r.pick(['cohost', 'participant', 'family']);
    const cl = CO.pause(clk0, who, tp);
    c.eq(cl.phase, 'running', 'only_organizer_or_host_can_pause', who);
    c.eq(reg(s, tp + 1, cl), 1, 'registration_keeps_running_when_a_guest_tries_to_pause');
    c.eq(CO.resume(paused, who, tr).phase, 'paused', 'only_organizer_or_host_can_resume', who);
  } else if (scen === 'two_pauses') {
    const P2 = r.int(10_000, 400_000), tp2 = tr + r.int(1, 1000), tr2 = tp2 + P2;
    const cl = CO.resume(CO.pause(resumed, 'organizer', tp2), 'organizer', tr2);
    c.eq(cl.pausedMs, P + P2, 'two_pauses_add_up');
    c.eq(cl.pauses.length, 2, 'each_pause_is_logged');
    const t = closeAt + P + P2 - 1;
    c.eq(reg(s, t, cl), 1, 'close_time_moves_by_both_pauses');
    c.eq(reg(s, t + 1, cl), 0, 'closed_after_both_pauses');
  }
}

// ================================================================ the organizer's settings, init, closed truth table
function setupCase(c, r, parts) {
  const [, what, v] = parts;
  if (what === 'winners') {
    const cap = r.pick([1, 5, 10, 100, 100_000]);
    const val = { undefined: undefined, one: 1, two: 2, ten: 10, thousand: 1000, over_max: r.int(1001, 5000), zero: 0, negative: -r.int(1, 9), fraction: r.pick([1.5, 2.9, 0.5]), string: r.pick(['3', 'two']), null: null, nan: NaN, over_cap: cap + r.int(1, 50) }[v];
    const res = DR.checkDrawSettings(val === undefined ? {} : { winners: val }, cap, false);
    const w = val === undefined ? 1 : val;
    const exp = !Number.isInteger(w) || w < 1 ? 'whole' : w > 1000 ? 'up to 1000' : w > cap ? 'more winners than' : null;
    if (exp === null) { c.ok(res.ok === true && res.winners === w && res.mode === 'auto' && res.ref === '0' && same(res.prizes, []), 'valid_winner_count_accepted', { val, cap, res }); }
    else { c.ok(res.ok === false && res.error.includes(exp) && /\.$/.test(res.error), 'bad_winner_count_refused_in_plain_words', { val, cap, res }); }
  } else if (what === 'mode') {
    const val = { auto: 'auto', manual: 'manual', undefined: undefined, null: null, weird: 'sometimes', number: 5 }[v];
    const res = DR.checkDrawSettings(val === undefined ? { winners: 1 } : { winners: 1, mode: val }, 100, false);
    const exp = val === 'manual' ? 'manual' : val === undefined || val === 'auto' ? 'auto' : null;
    if (exp) c.ok(res.ok === true && res.mode === exp, 'draw_mode_auto_unless_manual', { val, res }); else c.ok(res.ok === false && /automatic/.test(res.error) && /manual/.test(res.error), 'unknown_draw_mode_refused_in_plain_words', { val, res });
  } else if (what === 'prizes') {
    const W = r.int(1, 6), gift = (i) => `Gift ${i} ${alnum(r, 3)}`;
    const mk = { array: () => Array.from({ length: r.int(0, W) }, (_, i) => gift(i)), string: () => Array.from({ length: r.int(1, W) }, (_, i) => gift(i)).join(', '), too_many: () => Array.from({ length: W + r.int(1, 3) }, (_, i) => gift(i)),
      dirty: () => ['  <b>Tea  set</b>  `x` ', 'Mug\n\n  pair'].slice(0, W), long: () => ['y'.repeat(r.int(81, 200))], non_string: () => [7, null, { a: 1 }].slice(0, W), rehearsal_drops: () => [gift(1)], empty: () => [], fewer: () => [gift(1)] }[v];
    const raw = mk(), rehearsal = v === 'rehearsal_drops';
    const res = DR.checkDrawSettings({ winners: W, prizes: raw }, 100, rehearsal);
    const rawN = Array.isArray(raw) ? raw : raw.split(',');
    if (!rehearsal && rawN.length > W) { c.ok(res.ok === false && /more prizes than winners/.test(res.error), 'more_prizes_than_winners_refused', res); return; }
    c.ok(res.ok === true, 'prizes_accepted', res); if (!res.ok) return;
    if (rehearsal) { c.ok(same(res.prizes, []), 'rehearsal_has_no_prizes', res.prizes); return; }
    c.ok(res.prizes.length <= W, 'prizes_never_more_than_winners');
    for (const p of res.prizes) { c.ok(typeof p === 'string' && p.length <= 80 && !/[<>`]/.test(p) && !/\s{2}/.test(p) && p === p.trim(), 'prize_text_is_clean_short_plain', p); }
    if (v === 'long') c.eq(res.prizes[0].length, 80, 'long_prize_cut_at_80');
    if (v === 'dirty') { c.eq(res.prizes[0], 'bTea set/b x', 'dirty_prize_text_cleaned'); if (res.prizes.length > 1) c.eq(res.prizes[1], 'Mug pair', 'prize_whitespace_collapsed'); }
  } else if (what === 'init') initCase(c, r, v);
}
function initCase(c, r, v) {
  const closeAt = BASE + r.int(1e6, 1e9), thr = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };
  const base = { eid: 'E1', winners: 1, draw: 'auto', closeAt, cap: 50 };
  if (v === 'winners_zero' || v === 'winners_negative' || v === 'winners_nan') {
    const w = v === 'winners_zero' ? 0 : v === 'winners_negative' ? -r.int(1, 5) : r.pick(['abc', NaN, 0.4]);
    c.ok(/at least one winner/.test(thr(() => rules.init({ ...base, winners: w }, [], BASE)) ?? ''), 'a_draw_needs_at_least_one_winner', w);
  } else if (v === 'winners_fraction') c.eq(rules.init({ ...base, winners: 2.9 }, [], BASE).winnersWanted, 2, 'fraction_winner_count_floored');
  else if (v === 'auto_no_closeAt') c.ok(/draw time/.test(thr(() => rules.init({ eid: 'E1', winners: 1, draw: 'auto' }, [], BASE)) ?? ''), 'automatic_draw_needs_its_time');
  else if (v === 'manual_no_closeAt') { const s = rules.init({ eid: 'E1', winners: 1, draw: 'manual' }, [], BASE); c.eq(s.closeAt, Infinity, 'manual_draw_has_no_close_time'); c.eq(s.mode, 'manual', 'manual_mode_kept'); }
  else if (v === 'cap_clamped') c.eq(rules.init({ ...base, cap: 1e9 }, [], BASE).cap, LD.DRAW_CAP, 'cap_never_above_draw_cap');
  else if (v === 'rehearsal_cap') c.eq(rules.init({ ...base, cap: 5000, rehearsal: true }, [], BASE).cap, MF.MANIFESTS.luckydraw.rehearsalMax, 'rehearsal_is_limited_to_the_manifest_size');
  else if (v === 'prizes_split') c.ok(same(rules.init({ ...base, prizes: ' a , b,, c ,' }, [], BASE).prizes, ['a', 'b', 'c']), 'prizes_split_on_commas_blanks_dropped');
  else { const s = rules.init({ draw: 'whatever', closeAt }, [], BASE); c.ok(s.winnersWanted === 1 && s.ref === '0' && s.idKind === 'emp' && s.mode === 'auto' && s.entries.length === 0 && s.drawn === null && s.over === false && s.cap === LD.DRAW_CAP, 'init_defaults', s); }
}
function closedCase(c, r, parts) {
  const [, mode, st, pz, tm] = parts;
  const drawMs = BASE + r.int(1e6, 1e9), now = tm === 'before' ? drawMs - r.int(1, 1e6) : tm === 'at' ? drawMs : drawMs + r.int(1, 1e6), paused = pz === 'paused';
  const row = st === 'no_draw_row' ? null : { mode, drawn_ms: st === 'drawn' ? drawMs - 5 : null, closing_ms: st === 'closing' ? drawMs - 5 : null };
  const exp = st === 'no_draw_row' ? false : st === 'drawn' || st === 'closing' ? true : mode === 'auto' && !paused && now >= drawMs;
  c.eq(DR.registrationClosed(row, now, drawMs, paused), exp, 'registration_closed_truth_table', { mode, st, pz, tm });
}

// ================================================================ winner selection fairness
function fairCase(c, r, parts) {
  const [, kind, nS, wS] = parts, N = +nS;
  const W = wS === 'all' ? N : wS === 'more' ? N + r.int(1, 6) : +wS;
  const eid = `E${r.int(1, 1e9)}`, ref = String(r.int(0, 50)), ids = Array.from({ length: N }, (_, i) => `ID${i}${alnum(r, 6)}`);
  if (kind === 'oracle') {
    const beacon = hex(r, 64), got = LD.winnersFor(eid, ref, beacon, shuffle(r, ids), W), want = winnersO(eid, ref, beacon, ids, W);
    c.ok(same(got, want), 'winners_are_the_lowest_sha256_ranks', { got, want });
    c.eq(got.length, Math.min(W, N), 'exactly_the_configured_number_of_winners_or_everybody');
    c.eq(new Set(got).size, got.length, 'no_duplicate_winner');
    c.ok(got.every((x) => ids.includes(x)), 'every_winner_is_an_entrant');
    const rk = got.map((x) => LD.rankOf(eid, ref, beacon, x));
    c.ok(rk.every((x, i) => i === 0 || rk[i - 1] <= x), 'places_follow_rank_order');
    c.eq(LD.rankOf(eid, ref, beacon, ids[0]), rankO(eid, ref, beacon, ids[0]), 'rank_is_the_published_sha256_formula');
    const dup = LD.winnersFor(eid, ref, beacon, [...ids, ...ids.slice(0, r.int(0, N)), ...ids], W);
    c.ok(same(dup, want), 'repeated_entries_never_win_twice_or_change_the_result', { dup, want });
    c.ok(same(LD.winnersFor(eid, ref, beacon, ids, 0), []) && same(LD.winnersFor(eid, ref, beacon, ids, -3), []), 'zero_or_negative_winners_gives_nobody');
  } else if (kind === 'every') {
    const K = N <= 5 ? 160 * N : 100 * N, tally = new Map(ids.map((x) => [x, 0])), p = W / N;
    for (let k = 0; k < K; k++) {
      const w = LD.winnersFor(eid, ref, sha(`b${k}${eid}`), ids, W);
      if (w.length !== W || new Set(w).size !== W) c.ok(false, 'exactly_the_configured_number_of_distinct_winners_each_draw', { k, w });
      for (const x of w) tally.set(x, tally.get(x) + 1);
    }
    const sd = Math.sqrt(K * p * (1 - p));
    for (const [id, n] of tally) {
      c.ok(n >= 1, 'every_eligible_entrant_can_win', { id, n, K });
      c.ok(Math.abs(n - K * p) <= 6 * sd, 'every_entry_is_equally_likely_within_six_sigma', { id, n, expected: K * p, sd });
    }
  } else if (kind === 'engine') {
    // through the rules module: untidy IDs in, cleaned unique IDs out, same winners as the oracle, outcomes in place order
    const closeAt = BASE + r.int(1e6, 1e9), clk = runningClock(), beacon = hex(r, 64);
    const people = Array.from({ length: N }, (_, i) => `Em${String(i).padStart(3, '0')}${alnum(r, 4)}`);
    const raws = shuffle(r, people.flatMap((x) => [x, r.pick([x.toLowerCase(), ` ${x} `, x.replace(/(.{2})/g, '$1-')])].slice(0, r.int(1, 2))));
    let s = newRules({ eid, ref, winners: W, closeAt });
    for (let i = 0; i < raws.length; i += 7) s = regMany(s, raws.slice(i, i + 7), closeAt - 1 - r.int(0, 100), clk);
    const norm = people.map((x) => normEmpO(x));
    c.ok(same([...s.entries].sort(), [...norm].sort()), 'engine_holds_each_person_once_cleaned', { n: s.entries.length });
    const res = rules.step(s, { type: 'tick', beacon }, closeAt + r.int(0, 5000), clk);
    c.ok(same(res.state.drawn, winnersO(eid, ref, beacon, norm, W)), 'engine_winners_match_oracle', { got: res.state.drawn });
    c.eq(res.state.drawn.length, Math.min(W, N), 'exactly_the_configured_number_of_winners');
    c.eq(new Set(res.state.drawn).size, res.state.drawn.length, 'no_duplicate_winner');
    checkOutcomes(c, res.out, res.state.drawn, `N=${N} W=${W}`);
  } else if (kind === 'perm') {
    const beacon = hex(r, 64), want = LD.winnersFor(eid, ref, beacon, ids, W);
    c.ok(same(LD.winnersFor(eid, ref, beacon, shuffle(r, ids), W), want), 'entry_order_never_changes_the_winners');
    c.ok(same(LD.winnersFor(eid, ref, beacon, [...ids].reverse(), W), want), 'reversed_entries_same_winners');
    let moveBeacon = false, moveEid = false, moveRef = false;
    for (let k = 0; k < 24; k++) {
      if (!same(LD.winnersFor(eid, ref, sha(`x${k}`), ids, W), want)) moveBeacon = true;
      if (!same(LD.winnersFor(`${eid}z${k}`, ref, beacon, ids, W), want)) moveEid = true;
      if (!same(LD.winnersFor(eid, `${ref}.${k}`, beacon, ids, W), want)) moveRef = true;
    }
    c.ok(moveBeacon, 'a_different_beacon_value_gives_different_winners');
    c.ok(moveEid, 'a_different_game_gives_different_winners');
    c.ok(moveRef, 'a_different_beacon_reference_gives_different_winners');
  }
}

// ================================================================ wording
function wordCase(c, r, parts) {
  const [, what, v] = parts;
  if (what === 'ordinal') {
    const k = +v, places = LD.prizePlaces(k);
    c.eq(places.length, k, 'one_place_name_per_winner');
    const bad = []; places.forEach((p, i) => { if (p !== ordEn(i + 1)) bad.push([i + 1, p, ordEn(i + 1)]); });
    c.ok(bad.length === 0, 'place_name_plain_english_ordinal', bad.slice(0, 4));
    c.ok(same(rules.prizePositions({ winners: k }), places), 'rules_prize_positions_are_the_place_names');
    if (k === 1) c.ok(same(rules.prizePositions({}), ['1st']) && same(rules.prizePositions({ winners: 0 }), ['1st']), 'at_least_one_place_even_without_a_setting');
  } else if (what === 'why') {
    const clk = runningClock(), closeAt = BASE + 1e6;
    const open = rules.init({ eid: 'E', winners: 1, draw: 'auto', closeAt, cap: 2 }, [], BASE);
    const full = regMany(open, ['AA1', 'BB2'], BASE + 5, clk);
    const done = rules.step(regMany(open, ['AA1'], BASE + 5, clk), { type: 'tick', beacon: hex(r, 64) }, closeAt, clk).state;
    const msg = { invalid: [LD.registerWhy(open, '--', BASE + 5, clk), 'That ID is not valid.'], closed: [LD.registerWhy(open, 'CC3', closeAt, clk), 'Registration is closed.'],
      dup: [LD.registerWhy(regMany(open, ['AA1'], BASE + 5, clk), ' aa-1 ', BASE + 6, clk), 'You are already in the draw.'], full: [LD.registerWhy(full, 'CC3', BASE + 6, clk), 'The draw is full.'],
      done: [LD.registerWhy(done, 'ZZ9', BASE + 6, clk), 'The draw is done.'], ok: [LD.registerWhy(open, 'DD4', BASE + 6, clk), null] }[v];
    c.eq(msg[0], msg[1], 'guided_refusal_message', v);
    if (msg[0]) c.ok(/^[A-Z][^]*\.$/.test(msg[0]) && msg[0].length <= 40 && !/error|exception|null|undefined|NaN|invalid input/i.test(msg[0]), 'refusal_message_is_a_short_plain_sentence', msg[0]);
  } else if (what === 'fairness') {
    const f = DR.DRAW_FAIRNESS, p = DR.NO_PERSONAL_LINE;
    c.ok(/Same entries/.test(f) && /same winners/.test(f) && /public beacon/.test(f) && /drand/.test(f) && /nobody can choose or predict/.test(f), 'fairness_line_states_what_the_code_proves', f);
    c.ok(!/guarantee|100 ?%|tamper|unhackable|rigged/i.test(f), 'fairness_line_makes_no_promise_beyond_the_code', f);
    c.ok(/^No personal details needed\./.test(p) && /24 hours/.test(p), 'privacy_line_names_24_hours', p);
    c.eq(DR.MAX_WINNERS, 1000, 'at_most_1000_winners');
  } else if (what === 'manifest') {
    const m = MF.MANIFESTS.luckydraw;
    c.eq(m.title, 'Lucky Draw', 'title'); c.eq(m.goldenButton, 'You won', 'button_says_you_won'); c.eq(rules.goldenButton, 'You won', 'rules_button_says_you_won');
    c.eq(rules.claimType, 'auto', 'no_claim_press_needed'); c.eq(m.caps.auto, LD.DRAW_CAP, 'size_cap_is_the_draw_cap'); c.eq(m.rehearsalMax, 10, 'try_it_first_is_limited_to_10');
    c.eq(m.pauseSupport, true, 'pause_supported'); c.eq(m.organizerFinalSay, false, 'organizer_has_no_final_say_over_the_draw');
    c.ok(same(m.prizePositions, ['1st', '2nd', '3rd']), 'manifest_default_places'); c.ok(same(m.playModes, ['start-only']), 'one_play_mode_start_only');
    c.ok(same(CO.labelsAgree(rules), []), 'labels_agree_with_claim_type');
    c.ok(m.startModes.includes('auto') && m.startModes.includes('manual'), 'both_draw_modes_offered');
  } else if (what === 'fields') {
    c.ok(same(LD.setupFields.map((f) => f.key), ['winners', 'prizes', 'draw', 'ref']), 'setup_fields_are_the_draw_settings', LD.setupFields.map((f) => f.key));
    for (const f of LD.setupFields) c.ok(typeof f.label === 'string' && f.label.length > 2 && (f.kind !== 'choice' || (f.choices ?? []).includes(String(f.default))), 'field_has_plain_label_and_valid_default', f.key);
    c.eq(LD.setupFields.find((f) => f.key === 'winners').default, 1, 'default_one_winner');
  } else if (what === 'banned') {
    const texts = [DR.DRAW_FAIRNESS, DR.NO_PERSONAL_LINE, MF.MANIFESTS.luckydraw.title, MF.MANIFESTS.luckydraw.goldenButton, ...LD.setupFields.flatMap((f) => [f.label, f.help ?? '']), 'The draw is full.', 'The draw is done.', 'Registration is closed.', 'You are already in the draw.', 'That ID is not valid.'];
    for (const t of texts) c.ok(!/bingo|tambola|housie|snake|ladder|dice|ticket|house\b/i.test(t), 'no_other_games_words_in_lucky_draw_wording', t);
  }
}

// ================================================================ what the game lacks (cells fail the day a feature appears: extend the suite then)
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
function lacksCase(c, r, parts) {
  const v = parts[1];
  const code = stripComments(['vendor/game-core/packages/luckydraw/src/index.ts', 'vendor/game-core/packages/core/src/luckydraw.ts', 'apps/edge/src/draw.ts'].map(rd).join('\n'));
  if (v === 'unlucky') c.ok(!/unlucky|fewest/i.test(code), 'no_unlucky_prize_in_the_lucky_draw');
  else if (v === 'boosters') c.ok(!/booster|joker|extra ?ticket|lucky ?draw ?pass|scratch/i.test(code), 'no_boosters_in_the_lucky_draw');
  else if (v === 'game_over_vote') { c.ok(!/vote|quorum|overvote/i.test(code), 'no_game_over_vote_in_the_lucky_draw'); c.eq(MF.MANIFESTS.luckydraw.organizerFinalSay, false, 'game_ends_by_itself_no_final_say'); }
  else if (v === 'per_round') {
    const s = newRules({ closeAt: BASE + 1e6 });
    c.ok(!Object.keys(s).some((k) => /round/i.test(k)), 'draw_state_has_no_round', Object.keys(s));
    const clk = runningClock(), res = rules.step(regMany(s, ['A1', 'B2', 'C3'], BASE + 10, clk), { type: 'tick', beacon: hex(r, 64) }, BASE + 1e6, clk);
    c.ok(res.out.every((o) => o.kind === 'win' || o.kind === 'end') && !res.out.some((o) => o.kind === 'round' || o.kind === 'out'), 'draw_gives_only_win_and_end_outcomes');
  } else if (v === 'claims') { c.ok(!MF.MANIFESTS.luckydraw.labels.includes('Claim') && rules.claimType === 'auto' && !/bogey/i.test(code), 'no_claims_or_bogeys_in_the_lucky_draw'); }
  else c.ok(!/razorpay|credit|price\(|refund|invoice|PACKS/i.test(code), 'draw_code_takes_no_money_from_participants');
}

// ================================================================ credit (no refunds) on an in-memory D1 stand-in, and prices
function d1(db) {
  const stmt = (sql) => { let args = []; const s = {
    bind: (...a) => { args = a.map((v) => (v === undefined ? null : v)); return s; },
    first: async (col) => { const row = db.prepare(sql).get(...args); return row === undefined ? null : col ? row[col] : { ...row }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map((x) => ({ ...x })) }),
    run: async () => { const x = db.prepare(sql).run(...args); return { meta: { changes: Number(x.changes) } }; } }; return s; };
  return { prepare: stmt, batch: async (xs) => { const out = []; for (const x of xs) out.push(await x.run()); return out; }, raw: db };
}
async function creditCase(c, r, parts, tag) {
  const [, scen, cur, edge] = parts;
  const db = d1(new DatabaseSync(':memory:'));
  try {
    db.raw.exec('CREATE TABLE engagement (id TEXT PRIMARY KEY, org TEXT, pack INTEGER, cancelled_ms INTEGER)');
    for (const s of CR.CREDIT_SCHEMA) db.raw.exec(s);
    const org = `org${tag}`, eid = `g${tag}`, now = Date.UTC(2027, r.int(0, 11), r.int(1, 28), r.int(0, 23), r.int(0, 59), r.int(0, 59));
    db.raw.prepare('INSERT INTO engagement (id, org, pack, cancelled_ms) VALUES (?,?,0,?)').run(eid, org, scen === 'cancelled_game' ? now - 1000 : null);
    const g = r.pick(GOLDEN), pricePaise = (cur === 'INR' ? g[1] : g[2]) * 100, price = pricePaise / 100;
    const paidAt = (daysAgo) => { if (edge === 'ist_midnight') { const [y, m, d] = istParts(now - daysAgo * DAY); return Date.UTC(y, m, d) - IST + r.pick([-1, 0, 1]); } return now - daysAgo * DAY - r.int(0, DAY - 1); };
    const mk = async (id, paise, paid, o = org, cu = cur) => {
      const row = await CR.creditFromPayment(db, { id, amount: paise / 100, currency: cu, paid_ms: paid }, o, null, now, 'cancel');
      c.ok(!!row, 'credit_made_from_paid_amount');
      if (row) {
        c.eq(row.expires_ms, creditExpiryOracle(paid), 'credit_lapses_at_end_of_day_365_ist', { paid });
        c.eq(Math.round(row.total_inr * 100), paise, 'credit_keeps_exact_amount');
        const [y, m, d] = istParts(paid), last = new Date(Date.UTC(y, m, d + 365)), txt = CR.creditLastDay(row.expires_ms), mm = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(txt);
        c.ok(!!mm && +mm[1] === last.getUTCDate() && mm[2].slice(0, 3) === MON[last.getUTCMonth()] && +mm[3] === last.getUTCFullYear(), 'last_usable_day_told_is_day_365', txt);
      }
      return row;
    };
    const rows = async () => (await db.prepare('SELECT * FROM credit ORDER BY created_ms').all()).results;
    const uses = async () => (await db.prepare('SELECT * FROM credit_use').all()).results;
    const invariants = async () => {
      for (const x of await rows()) {
        for (const f of ['total_inr', 'remaining_inr', 'lapsed_inr']) c.ok(Math.abs(x[f] * 100 - Math.round(x[f] * 100)) < 1e-6, 'credit_amount_whole_paise_no_float_drift', `${f}=${x[f]}`);
        c.ok(x.remaining_inr >= 0, 'credit_never_negative', x.remaining_inr);
        const used = (await uses()).filter((u) => u.credit_id === x.id && u.status === 'applied').reduce((s, u) => s + Math.round(u.amount_inr * 100), 0);
        c.eq(Math.round(x.remaining_inr * 100) + used + Math.round(x.lapsed_inr * 100), Math.round(x.total_inr * 100), 'credit_conserved_remaining_plus_used_plus_lapsed');
      }
      c.ok(Math.round((await CR.creditAppliedFor(db, eid)) * 100) <= pricePaise, 'credit_applied_never_above_price');
    };
    const apply = async (t = now) => CR.applyCreditToGame(db, org, eid, price, cur, t);
    let res, want;
    if (['full', 'remainder', 'partial', 'idempotent', 'restore', 'restore_lapsed'].includes(scen)) {
      const amt = scen === 'full' ? pricePaise : scen === 'remainder' ? pricePaise + r.int(1, 500_000) : scen === 'partial' ? r.int(100, pricePaise - 1) : r.int(100, pricePaise * 2);
      const row = await mk(`pay_${tag}_1`, amt, paidAt(r.int(1, 300)));
      res = await apply(); want = Math.min(amt, pricePaise);
      c.eq(Math.round(res.appliedInr * 100), want, 'credit_applied_up_to_price', `${scen} amt=${amt} price=${pricePaise}`);
      const after = (await rows())[0];
      c.eq(Math.round(after.remaining_inr * 100), amt - want, 'remainder_stays_as_credit');
      c.eq(after.status, amt - want > 0 ? 'active' : 'used', 'credit_status_after_use');
      c.eq(after.expires_ms, row.expires_ms, 'remainder_keeps_same_expiry');
      if (scen === 'idempotent') { const again = await apply(); c.eq(again.usedNow.length, 0, 'apply_twice_uses_nothing_more'); c.eq(Math.round(again.appliedInr * 100), want, 'apply_twice_same_total'); }
      if (scen === 'restore') {
        await CR.restoreCreditUses(db, eid, now + 1000);
        const back = (await rows())[0];
        c.eq(Math.round(back.remaining_inr * 100), amt, 'cancel_puts_credit_back'); c.eq(back.expires_ms, row.expires_ms, 'restore_never_stretches_365_days');
        c.eq(Math.round((await CR.creditAppliedFor(db, eid)) * 100), 0, 'nothing_applied_after_restore');
      }
      if (scen === 'restore_lapsed') {
        await CR.restoreCreditUses(db, eid, row.expires_ms + r.int(0, 10 * DAY));
        const back = (await rows())[0];
        c.eq(Math.round(back.remaining_inr * 100), amt - want, 'lapsed_credit_does_not_come_back_usable'); c.eq(Math.round(back.lapsed_inr * 100), want, 'restored_after_lapse_counts_as_lapsed');
      }
    } else if (scen === 'two_oldest') {
      const a1 = r.int(100, pricePaise - 100), a2 = r.int(pricePaise - a1 + 1, pricePaise * 2);
      const older = await mk(`pay_${tag}_old`, a1, paidAt(r.int(200, 360))), newer = await mk(`pay_${tag}_new`, a2, paidAt(r.int(1, 150)));
      res = await apply();
      c.eq(Math.round(res.appliedInr * 100), pricePaise, 'two_credits_cover_price');
      const rs2 = await rows(), o = rs2.find((x) => x.id === older.id), nw = rs2.find((x) => x.id === newer.id);
      c.eq(Math.round(o.remaining_inr * 100), 0, 'oldest_expiring_used_first'); c.eq(Math.round(nw.remaining_inr * 100), a2 - (pricePaise - a1), 'newer_credit_pays_only_the_rest');
    } else if (['expired_old', 'at_expiry', 'before_expiry'].includes(scen)) {
      const amt = r.int(100, pricePaise * 2), row = await mk(`pay_${tag}_e`, amt, paidAt(scen === 'expired_old' ? r.int(367, 700) : 200));
      const t = scen === 'expired_old' ? now : scen === 'at_expiry' ? row.expires_ms : row.expires_ms - 1;
      res = await apply(t); want = scen === 'before_expiry' ? Math.min(amt, pricePaise) : 0;
      c.eq(Math.round(res.appliedInr * 100), want, 'expired_credit_unusable_valid_until_last_ms', `${scen} t-exp=${t - row.expires_ms}`);
      if (scen === 'expired_old') c.eq(row.status, 'expired', 'credit_from_old_payment_is_born_lapsed');
    } else if (scen === 'cancelled_game') {
      await mk(`pay_${tag}_c`, r.int(100, pricePaise * 2), paidAt(10)); res = await apply();
      c.eq(Math.round(res.appliedInr * 100), 0, 'no_credit_on_a_cancelled_game');
    } else if (scen === 'dup_payment') {
      const amt = r.int(100, pricePaise * 2), paid = paidAt(10), a = await mk(`pay_${tag}_d`, amt, paid);
      const b = await CR.creditFromPayment(db, { id: `pay_${tag}_d`, amount: amt / 100, currency: cur, paid_ms: paid }, org, null, now + 5000, 'late');
      c.eq(b?.id, a?.id, 'one_credit_per_payment'); c.eq((await rows()).length, 1, 'no_second_credit_row');
      c.eq((await rows()).reduce((s, x) => s + Math.round(x.total_inr * 100), 0), amt, 'credit_total_not_doubled');
    } else {
      await mk(`pay_${tag}_x`, r.int(100, pricePaise * 2), paidAt(10), scen === 'other_org' ? `${org}b` : org, scen === 'other_currency' ? (cur === 'INR' ? 'USD' : 'INR') : cur);
      res = await apply();
      c.eq(Math.round(res.appliedInr * 100), 0, scen === 'other_org' ? 'credit_isolated_between_organizations' : 'credit_only_in_its_own_currency');
    }
    await invariants();
    c.ok(/365 days/.test(CR.NO_REFUND_LINE) && /credit/.test(CR.NO_REFUND_LINE) && /no refunds/i.test(CR.NO_REFUND_LINE), 'no_refund_wording');
  } finally { try { db.raw.close(); } catch { /* closed */ } }
}
function priceCase(c, r, parts) {
  const [, p, cur] = parts;
  if (p === 'unknown') { let err = null; try { PR.price(r.pick([0, 7, 99, 101, 100_000]), cur); } catch (e) { err = e; } c.ok(err instanceof RangeError, 'unknown_pack_refused', String(err)); return; }
  const g = GOLDEN.find((x) => x[0] === +p), want = cur === 'INR' ? g[1] : g[2], got = PR.price(+p, cur);
  c.eq(got.total, want, 'pack_price_matches_owner_list', `${p} ${cur}`); c.eq(got.tax, 0, 'no_tax_added_while_gst_is_off'); c.eq(got.base, want, 'base_price_is_the_list_price');
  c.eq(PR.GST_ON, false, 'gst_switch_is_off');
  c.ok(PR.PACKS.length === GOLDEN.length && PR.PACKS.every((x, i) => x[0] === GOLDEN[i][0] && x[1] === GOLDEN[i][1] && x[2] === GOLDEN[i][2]), 'pack_list_is_the_owner_list');
}

// ================================================================ end to end on a real database
const GENESIS = 1692803367; // the public drand quicknet chain: genesis second, one round every 3 seconds
const serveBeacon = (up) => { globalThis.fetch = async (url) => (up && FX && String(url).endsWith(`/public/${FX.round}`) ? { ok: true, status: 200, json: async () => FX } : { ok: false, status: 404, json: async () => ({}) }); };
const cleanPid = (p) => p.toUpperCase().replace(/[^A-Z0-9]/g, '');
async function e2eCase(c, r, parts, tag) {
  const [, mode, live, scen] = parts;
  if (!FX) { c.ok(false, 'harness_beacon_fixture_present', 'packages/beacon/test/beacon.test.ts holds no round fixture'); return; }
  const db = new DatabaseSync(':memory:'), saveFetch = globalThis.fetch;
  try {
    for (const s of [...WK.SCHEMA, ...DR.DRAW_SCHEMA]) { try { db.exec(s); } catch { /* an ALTER that is already in the CREATE */ } }
    const D = d1(db), env = { DB: D }, rehearsal = live === 'rehearsal', eid = `E${tag}`, R0 = FX.round, T0 = (GENESIS + (R0 - 1) * 3) * 1000;
    const cap = rehearsal ? 100 : r.pick([30, 100, 250]), engCap = rehearsal ? 10 : cap;
    const e = { id: eid, cap, org: `org${tag}`, config: '{"name":"Smoke Draw"}', start_round: R0, rehearsal_of: rehearsal ? `base${tag}` : null };
    // seats
    const nEl = { zero: 0, fewer: r.int(1, 3), over_cap: engCap + r.int(1, 12), mixed: r.int(4, Math.min(engCap, 40)) }[scen] ?? r.int(2, Math.min(engCap, 60));
    const seats = [];
    for (let i = 1; i <= nEl; i++) seats.push({ seq: i, pid: `${i}x${hex(r, 12)}`, ph: `ph${tag}${i}`, dev: `dev${i}`, src: 'link', blocked: null, ok: true });
    if (scen === 'mixed' || scen === 'zero') for (const s of seats) { s.blocked = r.pick([null, 0, 1]); s.src = r.pick([null, 'link', 'roster']); s.dev = r.chance(0.5) ? null : s.dev; }
    if (scen === 'zero') for (let i = 0; i < r.int(0, 4); i++) seats.push({ seq: seats.length + 1, pid: `${seats.length + 1}x${hex(r, 12)}`, ph: `ph${tag}z${i}`, dev: null, src: 'roster', blocked: r.pick([null, 1]), ok: true });
    for (const s of seats) s.ok = (s.blocked === null || s.blocked === 0) && (s.src === null || s.src !== 'roster' || s.dev !== null);
    if (scen === 'zero') for (const s of seats) { s.ok = false; s.blocked = 1; }
    for (const s of seats) db.prepare('INSERT INTO seat(eid,seq,pid,ph,dev,src,blocked) VALUES(?,?,?,?,?,?,?)').run(eid, s.seq, s.pid, s.ph, s.dev, s.src, s.blocked);
    const entries = seats.filter((s) => s.ok).slice(0, engCap), W = scen === 'fewer' ? entries.length + r.int(1, 4) : Math.max(1, r.chance(0.35) && entries.length >= 24 ? r.int(21, 24) : r.int(1, Math.max(1, Math.min(entries.length, 6))));
    const prizesIn = rehearsal ? [] : Array.from({ length: r.int(0, Math.min(W, 4)) }, (_, i) => `Gift ${i + 1}`);
    const ck = DR.checkDrawSettings({ winners: W, mode, prizes: prizesIn }, cap, rehearsal);
    c.ok(ck.ok === true, 'e2e_settings_accepted', ck.error); if (!ck.ok) return;
    if (scen !== 'no_row') await DR.saveDrawSettings(D, eid, ck, T0 - 1_000_000);
    const now = mode === 'auto' ? T0 + 3000 + r.int(0, 600_000) : T0 + r.int(0, 8999), by = mode === 'auto' ? 'auto' : r.pick(['organizer', 'host']);
    const t = { drawRound: R0, paused: false };
    const wantPids = (() => { const m = new Map(entries.map((s) => [cleanPid(s.pid), s.pid])); return winnersO(eid, '0', FX.randomness, entries.map((s) => cleanPid(s.pid)), W).map((x) => m.get(x)); })();
    serveBeacon(true);
    const rowOf = () => DR.drawRow(D, eid);
    const untouched = async (label) => { const row = await rowOf(); c.ok(row && row.drawn_ms === null && row.closing_ms === null && row.result === null, 'refused_draw_changes_nothing', label); };
    if (scen === 'no_row') { const res = await DR.runDraw(env, e, now, t, by); c.ok(res.ok === false && res.status === 404, 'draw_without_settings_is_refused_404', res); return; }
    if (scen === 'too_early') {
      const res = await DR.runDraw(env, e, T0 + r.int(0, 2999), t, 'auto'); c.ok(res.ok === false && res.status === 409, 'auto_draw_waits_for_its_time', res); await untouched('too_early');
    } else if (scen === 'paused') {
      const res = await DR.runDraw(env, e, now, { ...t, paused: true }, by); c.ok(res.ok === false && res.status === 409 && /paused/i.test(res.error), 'paused_draw_waits', res); await untouched('paused');
    } else if (scen === 'beacon_down') {
      serveBeacon(false); const res = await DR.runDraw(env, e, now, t, by);
      c.ok(res.ok === false && res.status === 503, 'beacon_down_gives_503_and_nothing_changes', res); await untouched('beacon_down'); serveBeacon(true);
    } else if (scen === 'wrong_role') {
      for (const who of ['cohost', 'participant', 'family']) { const res = await DR.runDraw(env, e, now, t, who); c.ok(res.ok === false && res.status === 403, 'only_organizer_or_host_can_press_draw', { who, res }); }
      await untouched('wrong_role');
    } else if (scen === 'wrong_mode') {
      const res = mode === 'auto' ? await DR.runDraw(env, e, now, t, r.pick(['organizer', 'host'])) : await DR.runDraw(env, e, now, t, 'auto');
      c.ok(res.ok === false && res.status === 409, 'draw_refused_when_it_is_not_this_kind_of_draw', res); await untouched('wrong_mode');
    }
    // every scenario ends by making the draw once (the refusals above must not have spent it)
    const res = await DR.runDraw(env, e, now, t, by);
    c.ok(res.ok === true && !res.already, 'draw_made', res); if (!res.ok) return;
    const row = await rowOf();
    c.ok(row.drawn_ms === now && row.round === R0 && row.beacon === FX.randomness && row.by_role === by && row.closing_ms !== null, 'draw_row_records_time_round_beacon_and_role', { drawn: row.drawn_ms === now, round: row.round, by: row.by_role });
    c.eq(row.entries, entries.length, 'entry_count_is_eligible_seats_up_to_the_cap');
    const result = JSON.parse(row.result);
    c.ok(same(result, wantPids.map((pid, place) => ({ pid, place }))), 'winners_match_independent_oracle', { got: result.map((x) => x.pid), want: wantPids });
    c.eq(result.length, Math.min(W, entries.length), 'exactly_the_configured_number_of_winners_or_everybody');
    c.eq(new Set(result.map((x) => x.pid)).size, result.length, 'no_duplicate_winner');
    const byPid = new Map(seats.map((s) => [s.pid, s]));
    for (const x of result) { const s = byPid.get(x.pid); c.ok(!!s && s.ok, 'winner_is_an_eligible_entrant_never_blocked_or_unjoined', x.pid); c.ok(entries.includes(s), 'winner_is_inside_the_cap'); }
    const life = db.prepare('SELECT * FROM life WHERE eid=?').get(eid);
    c.ok(life && life.end_ms === now && life.end_src === 'phones', 'game_over_is_recorded_when_the_draw_is_made');
    const prizeRows = db.prepare('SELECT ordinal, seat FROM prize WHERE eid=? ORDER BY ordinal').all(eid).map((x) => ({ ordinal: x.ordinal, seat: x.seat }));
    if (rehearsal) c.eq(prizeRows.length, 0, 'rehearsal_awards_no_prizes');
    else c.ok(same(prizeRows, result.map((x) => ({ ordinal: x.place + 1, seat: Number(x.pid.split('x')[0]) }))), 'prize_rows_follow_the_result', { prizeRows });
    if (scen === 'twice') {
      const again = await DR.runDraw(env, e, now + 60_000, t, by); const row2 = await rowOf();
      c.ok(again.ok === true && again.already === true && same(row2, row), 'second_draw_changes_nothing', again);
      c.eq(db.prepare('SELECT COUNT(*) AS n FROM prize WHERE eid=?').get(eid).n, rehearsal ? 0 : result.length, 'no_prize_rows_added_by_a_second_draw');
    }
    if (scen === 'facts') {
      const winPid = result[0]?.pid, other = entries.find((s) => !result.some((x) => x.pid === s.pid));
      const f = await DR.drawFacts(env, e, now + 5000, t, winPid ?? null), d = f.draw;
      c.ok(d && d.drawn === true && d.closed === true && d.entries === entries.length && d.winners === W && d.mode === mode && d.rehearsal === rehearsal && d.round === R0 && d.beacon === FX.randomness, 'facts_show_the_finished_draw', d && { drawn: d.drawn, closed: d.closed, entries: d.entries });
      if (d) {
        c.eq(d.result.length, result.length, 'facts_list_every_winner');
        d.result.forEach((x, i) => { c.eq(x.place, ordEn(i + 1), 'draw_place_plain_english_ordinal', i + 1); c.ok(/^Winner \d+$/.test(x.who), 'winner_without_details_is_shown_as_winner_number', x.who); });
        if (winPid) c.ok(d.mine && d.mine.place === ordEn(1) && d.mine.prize === (prizesIn[0] ?? ''), 'you_won_button_data_for_the_winner', d.mine);
        c.eq(d.fairness, DR.DRAW_FAIRNESS, 'facts_carry_the_fairness_line'); c.eq(d.privacy, DR.NO_PERSONAL_LINE, 'facts_carry_the_privacy_line');
      }
      if (other) { const g = await DR.drawFacts(env, e, now + 5000, t, other.pid); c.eq(g.draw?.mine, null, 'a_non_winner_has_no_you_won'); }
    }
  } finally { globalThis.fetch = saveFetch; try { db.close(); } catch { /* closed */ } }
}

// ================================================================ one case
export async function runCase(w, idx, seed) {
  const cell = CELLS[idx % CELLS.length];
  const parts = cell.split('|');
  const r = rng(seed, idx);
  const c = new Case();
  const tag = `${String(seed).replace(/\W/g, '')}n${idx}`;
  w.cases++;
  try {
    const k = parts[0];
    if (k === 'entry') entryCase(c, r, parts);
    else if (k === 'late') lateCase(c, r, parts);
    else if (k === 'latejoin') latejoinCase(c, r, parts);
    else if (k === 'draw') drawCase(c, r, parts);
    else if (k === 'over') overCase(c, r, parts);
    else if (k === 'pause') pauseCase(c, r, parts);
    else if (k === 'setup') setupCase(c, r, parts);
    else if (k === 'closed') closedCase(c, r, parts);
    else if (k === 'fair') fairCase(c, r, parts);
    else if (k === 'word') wordCase(c, r, parts);
    else if (k === 'lacks') lacksCase(c, r, parts);
    else if (k === 'credit') await creditCase(c, r, parts, tag);
    else if (k === 'price') priceCase(c, r, parts);
    else if (k === 'e2e') await e2eCase(c, r, parts, tag);
  } catch (err) {
    c.ok(false, 'no_exception', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '));
  }
  return { cell, c };
}
