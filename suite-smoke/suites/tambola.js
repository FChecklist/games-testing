// Model-based smoke suite for Corporate Tambola (public repo FChecklist/corporate-tambola), in-process, no servers, no network.
// Drives the REAL TypeScript code (imported through lib/tsresolve.js): the engagement engine (packages/engine), tickets and pricing
// (packages/shared), billing (packages/billing), the phone-side settlement (packages/beacon game.ts, house-rules, claim-text, prize-status)
// and the credit + private-price money code (apps/edge credit.ts on an in-memory node:sqlite stand-in for D1, price-adjust.ts).
//
// The ORACLE below is written from the product's documents, not from its outputs:
//   docs/NOTES.md section 4 (ticket generation, patterns, claim validity, sharing, family for fun, bogeys, purge),
//   docs/IMPLEMENTATION.md (two-ticket model, ordinal gating, "never the same line twice"), docs/GAME_PRINCIPLES.md (claim before the next
//   number; two Bogeys on a prize), docs/DESIGN_CLAIM_PAUSE_1_4_4.md (claim exactly before the next number, ties on the same number share),
//   the house "how to win" texts (beacon config PRIZE_HOUSES), docs/PRICE_ADJUST.md (net >= 1, <= 2 x list, never zero),
//   docs/ROLES_AND_CONSOLE_SPEC_6.md (no refunds; credit for 365 days to the end of day 365 IST; oldest-expiring first; idempotent; no
//   negative remainder; restore keeps the same expiry), the golden INR/USD pack list (owner list, same as suites/pricing.js), the glossary.
// One case = one cell; all randomness comes from rng(seed, idx), so (seed, idx) replays exactly.
import '../lib/tsresolve.js';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { imp } from '../lib/roots.js';

const R = (p) => imp(`corporate-tambola/${p}`);
const TK = await R('packages/shared/src/ticket.ts');
const PR = await R('packages/shared/src/pricing.ts');
const EN = await R('packages/engine/src/engine.ts');
const BI = await R('packages/billing/src/index.ts');
const HR = await R('packages/beacon/src/house-rules.ts');
const CT = await R('packages/beacon/src/claim-text.ts');
const CF = await R('packages/beacon/src/config.ts');
const GM = await R('packages/beacon/src/game.ts');
const BX = await R('packages/beacon/src/index.ts');
const PS = await R('packages/beacon/src/prize-status.ts');
const CR = await R('apps/edge/src/credit.ts');
const PA = await R('apps/edge/src/price-adjust.ts');
await R('apps/edge/src/pay.ts'); // import check only: pay.ts loads under node (its routes need D1 + Razorpay and are not driven here)

// ================================================================ independent oracle (from the documents)
export const NAME = { early5: 'Early Five', early7: 'Early Seven', early10: 'Early Ten', top: 'Top Line', mid: 'Middle Line', bot: 'Bottom Line', twolines: 'Two Lines',
  corners: 'Four Corners', star: 'Star', plus: 'Plus', frame: 'Frame', topbottom: 'Top and Bottom', midcorners: 'Middle and Corners', odd5: 'Odd Five',
  even5: 'Even Five', low5: 'Low Five', high5: 'High Five', full: 'Full House', full2: 'Super Bumper House' };
const ENGINE_PATTERNS = ['early5', 'top', 'mid', 'bot', 'corners', 'star', 'full'];
export const HOUSES = ['early5', 'early7', 'early10', 'top', 'mid', 'bot', 'twolines', 'corners', 'star', 'plus', 'frame', 'topbottom', 'midcorners', 'odd5', 'even5', 'low5', 'high5', 'full', 'full2'];
const GOLDEN = [[100, 2399, 34], [250, 3499, 51], [500, 4699, 67], [750, 5899, 84], [1000, 7099, 101], [2500, 11799, 169], [5000, 17699, 253], [10000, 29499, 421]];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86_400_000, IST = 19_800_000;

/** NOTES 4: column c holds 1-9 / 10-19 / ... / 80-90. */
const colRange = (c) => [c === 0 ? 1 : c * 10, c === 8 ? 90 : c * 10 + 9];
/** NOTES 4 + IMPLEMENTATION 3.1: 3 x 9, 5 per row, every column >= 1 number, column ranges, ascending in a column, 15 distinct numbers. */
export function ticketProblems(t) {
  const p = [];
  if (!Array.isArray(t) || t.length !== 3) return ['not 3 rows'];
  for (let r = 0; r < 3; r++) {
    if (!Array.isArray(t[r]) || t[r].length !== 9) { p.push(`row ${r} is not 9 cells`); continue; }
    const k = t[r].filter((v) => v !== null).length;
    if (k !== 5) p.push(`row ${r} has ${k} numbers`);
  }
  if (p.length) return p;
  const seen = new Set();
  for (let c = 0; c < 9; c++) {
    const col = [0, 1, 2].map((r) => t[r][c]).filter((v) => v !== null);
    if (!col.length) p.push(`column ${c} empty`);
    const [lo, hi] = colRange(c);
    col.forEach((v, i) => {
      if (!Number.isInteger(v) || v < lo || v > hi) p.push(`column ${c} holds ${v}`);
      if (seen.has(v)) p.push(`${v} twice`);
      seen.add(v);
      if (i > 0 && !(v > col[i - 1])) p.push(`column ${c} not ascending`);
    });
  }
  if (seen.size !== 15) p.push(`${seen.size} distinct numbers`);
  return p;
}
export const rowN = (t, r) => t[r].filter((v) => v !== null);
export const allN = (t) => [0, 1, 2].flatMap((r) => rowN(t, r));
/** The house rules, from the "how to win" texts: kind set (every number of a shape), any (k of a pool), lines (two of the three lines). */
export function houseRule(t, key) {
  const a = rowN(t, 0), b = rowN(t, 1), c = rowN(t, 2), all = allN(t);
  const corners = [a[0], a[a.length - 1], c[0], c[c.length - 1]];
  const set = (s) => ({ kind: 'set', pool: s }), any = (pool, k) => ({ kind: 'any', pool, k });
  switch (key) {
    case 'early5': return any(all, 5);
    case 'early7': return any(all, 7);
    case 'early10': return any(all, 10);
    case 'top': return set(a);
    case 'mid': return set(b);
    case 'bot': return set(c);
    case 'twolines': return { kind: 'lines', lines: [a, b, c] };
    case 'corners': return set(corners);
    case 'star': return set([...corners, b[2]]); // "the centre number of the middle line": the 3rd of its 5 numbers
    case 'plus': return set([...b, a[2], c[2]]);
    case 'frame': return set([...a, ...c, b[0], b[b.length - 1]]);
    case 'topbottom': return set([...a, ...c]);
    case 'midcorners': return set([...b, ...corners]);
    case 'odd5': return any(all.filter((n) => n % 2 === 1), 5);
    case 'even5': return any(all.filter((n) => n % 2 === 0), 5);
    case 'low5': return any(all.filter((n) => n >= 1 && n <= 30), 5);
    case 'high5': return any(all.filter((n) => n >= 61 && n <= 90), 5);
    case 'full': return set(all);
    default: throw new Error(`oracle: no rule for ${key}`);
  }
}
/** Call index (0-based) at which a rule completes on a log, computed from positions (a different route from a running counter). */
export function ruleDoneAt(rule, pos) {
  const setDone = (s) => (s.every((n) => pos.has(n)) ? Math.max(...s.map((n) => pos.get(n))) : -1);
  if (rule.kind === 'set') return setDone(rule.pool);
  if (rule.kind === 'any') { if (rule.pool.length < rule.k) return -1; const ix = rule.pool.filter((n) => pos.has(n)).map((n) => pos.get(n)).sort((x, y) => x - y); return ix.length >= rule.k ? ix[rule.k - 1] : -1; }
  const d = rule.lines.map(setDone).filter((i) => i >= 0).sort((x, y) => x - y);
  return d.length >= 2 ? d[1] : -1;
}
export const posOf = (log) => new Map(log.map((n, i) => [n, i]));
/** Earliest completion of a house over a participant's tickets (full2 = all 30 numbers of two tickets together). */
function houseDoneAt(tickets, key, pos) {
  if (key === 'full2') { if (tickets.length < 2) return -1; const s = tickets.slice(0, 2).flatMap(allN); return s.every((n) => pos.has(n)) ? Math.max(...s.map((n) => pos.get(n))) : -1; }
  let best = -1;
  for (const t of tickets) { const i = ruleDoneAt(houseRule(t, key), pos); if (i >= 0 && (best < 0 || i < best)) best = i; }
  return best;
}
/** "Still to win": numbers this participant still needs (99 = cannot happen on this ticket). */
export function stillNeeds(tickets, key, called) {
  if (key === 'full2') return tickets.length < 2 ? 30 : tickets.slice(0, 2).flatMap(allN).filter((n) => !called.has(n)).length;
  let best = Infinity;
  for (const t of tickets) {
    const r = houseRule(t, key); let v;
    if (r.kind === 'set') v = r.pool.filter((n) => !called.has(n)).length;
    else if (r.kind === 'any') v = r.pool.length < r.k ? 99 : Math.max(0, r.k - r.pool.filter((n) => called.has(n)).length);
    else { const l = r.lines.map((x) => x.filter((n) => !called.has(n)).length).sort((x, y) => x - y); v = l[0] + l[1]; }
    best = Math.min(best, v);
  }
  return best;
}
/**
 * The engine's claim rule (NOTES 4 "Validity"): the pattern must be complete with numbers that were called AND cut, and complete exactly at the
 * latest call (claim before the next number). Early Five: the 5th cut called number must be the latest. Two-ticket house: all 30 numbers.
 */
export function claimVerdict(ts, pattern, cut, log, pos = posOf(log)) {
  const last = log.length - 1;
  const own = new Set(ts.flatMap(allN));
  const cs = new Set(cut.filter((n) => own.has(n) && pos.has(n)));
  if (pattern === 'early5') { const ix = [...cs].map((n) => pos.get(n)).sort((x, y) => x - y); if (ix.length < 5) return 'incomplete'; return ix[4] === last ? 'ok' : 'late'; }
  const need = ts.flatMap((t) => houseRule(t, pattern).pool);
  if (!need.every((n) => pos.has(n))) return 'not_called';
  if (!need.every((n) => cs.has(n))) return 'not_cut';
  return Math.max(...need.map((n) => pos.get(n))) === last ? 'ok' : 'late';
}
/** Plain English ordinals (1st 2nd 3rd 4th ... 11th 12th 13th ... 21st 22nd 23rd). */
const ordEn = (k) => { const t = k % 100; if (t >= 11 && t <= 13) return `${k}th`; return k + (k % 10 === 1 ? 'st' : k % 10 === 2 ? 'nd' : k % 10 === 3 ? 'rd' : 'th'); };
/** Indian digit grouping (12,34,567) and western grouping (1,234,567), written by hand (not toLocaleString). */
const groupIN = (n) => { const s = String(n); if (s.length <= 3) return s; const head = s.slice(0, -3), tail = s.slice(-3); return head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail; };
const groupUS = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const money2 = (minor, cur) => { const maj = Math.floor(minor / 100), p = String(minor % 100).padStart(2, '0'); return (cur === 'INR' ? '₹' + groupIN(maj) : 'US$' + groupUS(maj)) + '.' + p; };
/** IST calendar date of an instant, and the instant a credit lapses: 00:00 IST of the day after day 365 (payment date = day 0). */
const istParts = (ms) => { const d = new Date(ms + IST); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const creditExpiryOracle = (paidMs) => { const [y, m, d] = istParts(paidMs); return Date.UTC(y, m, d + 366) - IST; };

// ================================================================ cells
const PLAYERS = [1, 2, 5, 20];
const FAULTS = ['valid', 'incomplete', 'uncut', 'late', 'duplicate', 'after_awarded', 'second_window', 'bogey2_block', 'family_fun', 'family_can_win', 'tie2', 'ordinal2', 'wrong_ticket', 'during_pause', 'pre_live'];
const NEEDS_TWO = new Set(['tie2', 'ordinal2', 'second_window']);
const claimCells = [];
for (const mode of ['single', 'double']) for (const pat of mode === 'double' ? [...ENGINE_PATTERNS, 'AB'] : ENGINE_PATTERNS) for (const n of PLAYERS) for (const f of FAULTS) {
  if (n === 1 && NEEDS_TWO.has(f)) continue;
  claimCells.push(`claim|${mode}|${pat}|${n}|${f}`);
}
const CREDIT_SCEN = ['full', 'remainder', 'partial', 'two_oldest', 'expired_old', 'at_expiry', 'before_expiry', 'cancelled_game', 'idempotent', 'restore', 'restore_lapsed', 'dup_payment', 'other_org', 'other_currency'];
export const CELLS = [
  ...cross(['ticket'], ['engine', 'generator', 'beacon'], ['single', 'double'], ['1', '2', '5', '20', '50', '100']).map((c) => c.join('|')),
  ...claimCells,
  ...cross(['game'], ['default6', 'all7', 'multi', 'double'], ['1', '2', '5', '20', '50'], ['ai', 'manual'], ['none', 'breaks', 'emergency', 'family']).map((c) => c.join('|')),
  ...cross(['beacon'], HOUSES, ['share', 'next'], ['valid', 'late', 'edge_in_time', 'wrong_idx', 'bogey1', 'bogey2', 'bogey_after', 'no_claim'], ['3', '20']).map((c) => c.join('|')),
  ...cross(['price'], GOLDEN.map((g) => String(g[0])), ['INR', 'USD'], ['none', 'zero', 'fraction', 'min_exact', 'below_min', 'max_exact', 'above_max', 'random_ok']).map((c) => c.join('|')),
  ...cross(['credit'], CREDIT_SCEN, ['INR', 'USD'], ['mid_day', 'ist_midnight']).map((c) => c.join('|')),
  ...['bill|fy|apr1_edge', 'bill|fy|mar31', 'bill|fy|mid', 'bill|sig|valid', 'bill|sig|tampered', 'bill|sig|wrong_secret', 'bill|sig|empty', 'bill|invoice|INR', 'bill|invoice|USD', 'bill|minor|INR', 'bill|minor|USD', 'bill|gst_off|INR', 'bill|gst_off|USD'],
  ...cross(['word'], ['ordinal'], [...ENGINE_PATTERNS, 'AB'], ['1', '2', '3', '4', '11', '12', '13', '21', '22', '23', '30']).map((c) => c.join('|')),
  ...['word|lost|later', 'word|lost|same', 'word|lost|earlier', 'word|lost|none', 'word|lost|two', 'word|rule|share', 'word|rule|next', 'word|rule|unknown'],
];

export async function newWorld() { return { cases: 0 }; }

// ================================================================ shared helpers
export const shuffle = (r, a) => { for (let i = a.length - 1; i > 0; i--) { const j = r.int(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };
export const randOf = (r) => (n) => Math.floor(r.next() * n);
export const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ================================================================ engine world + claim model
/** One engagement on the real engine with an injected clock and seeded randomness. The model mirrors the documented rules. */
function engineWorld(r, c, tag, o) {
  const W = { clk: 1_800_000_000_000 + r.int(0, 1e9), events: [], log: [], pausedFlag: false, ended: false, names: [], refs: [], c };
  const rand = randOf(r);
  const deps = { now: () => W.clk, rand, emit: (ev) => onEvent(W, ev) };
  W.deps = deps;
  W.e = new EN.EngagementEngine({ name: 'Smoke engagement', orgName: 'Smoke Org', limit: o.limit, ticketMode: o.mode, callMode: o.callMode, familyCanWin: o.familyCanWin }, deps);
  c.eq(W.e.setRewards('organizer', o.rewards), null, 'organizer_can_set_rewards_before_start');
  c.ok(W.e.setRewards('host', o.rewards) !== null, 'host_cannot_change_rewards');
  // people: names and refs are opaque tokens (no phone numbers anywhere), used to prove nothing personal reaches the public stream
  const items = Array.from({ length: o.players }, (_, i) => ({ name: `Nm${tag}q${i}z`, info: 'Dept', e164: `ref${tag}q${i}z` }));
  W.names.push(...items.map((x) => x.name)); W.refs.push(...items.map((x) => x.e164));
  const add = W.e.addParticipants(items);
  c.ok(add.ok === true, 'harness_add_participants', add);
  W.e.participants.forEach((p, i) => c.eq(W.e.confirmJoin(`dev${tag}q${i}`, p.id), null, 'harness_join'));
  W.pids = W.e.participants.map((p) => p.id);
  W.family = [];
  for (let j = 0; j < (o.family ?? 0); j++) {
    const sender = W.e.participants[j % o.players];
    const nm = `Fam${tag}q${j}z`, ref = `fref${tag}q${j}z`;
    W.names.push(nm); W.refs.push(ref);
    const used = W.e.participants.filter((x) => x.invitedBy === sender.id && x.kind === 'family').length;
    const pass = W.e.createPass(sender.id, { name: nm, e164: ref, kind: 'family' });
    c.eq(pass.ok === true, used < W.e.settings.familyLimit, 'family_passes_up_to_family_limit', `used ${used} of ${W.e.settings.familyLimit}`);
    if (!pass.ok) continue;
    const op = W.e.openPass(`fdev${tag}q${j}`, pass.p.passCode);
    c.eq(op.t, 'pass', 'pass_link_opens');
    c.eq(W.e.confirmJoin(`fdev${tag}q${j}`, pass.p.id), null, 'harness_family_join');
    W.family.push(pass.p.id);
  }
  c.ok(W.e.participants.length <= o.limit, 'participant_limit_never_exceeded');
  // model state
  W.lines = new Map(); // line id -> { line, idx, tids: [] }
  for (const l of W.e.settings.rewards) W.lines.set(l.id, { line: l, idx: -1, tids: [] });
  W.bogeys = new Map(); W.blocked = new Set(); W.window = [];
  return W;
}
function onEvent(W, ev) {
  W.events.push(ev);
  const c = W.c;
  if (ev.to !== 'console') {
    const s = JSON.stringify(ev);
    c.ok(!W.names.some((n) => s.includes(n)) && !W.refs.some((n) => s.includes(n)), 'public_event_has_no_name_or_number', ev.type);
  }
  if (ev.type === 'pause') W.pausedFlag = true;
  if (ev.type === 'resume') W.pausedFlag = false;
  if (ev.type === 'call') {
    c.ok(!W.pausedFlag, 'no_number_called_while_paused', ev.callNo);
    c.ok(!W.ended, 'no_number_after_end', ev.callNo);
    c.eq(ev.callNo, W.log.length + 1, 'call_numbers_count_up_by_one');
    c.ok(Number.isInteger(ev.number) && ev.number >= 1 && ev.number <= 90 && !W.log.includes(ev.number), 'number_new_and_1_to_90', ev.number);
    W.log.push(ev.number);
  }
  if (ev.type === 'break') { const b = W.e.settings.breaks.find((x) => x.title === ev.title); c.ok(!!b && W.e.called.length === b.after, 'brand_break_after_its_number', { title: ev.title, called: W.e.called.length }); W.breaksSeen = (W.breaksSeen ?? 0) + 1; }
  if (ev.type === 'ended') W.ended = true;
}
const P = (W, id) => W.e.participants.find((p) => p.id === id);
function ticketsOfModel(p, which) {
  if (which === 'A') return p.tickets[0] ? [p.tickets[0]] : null;
  if (which === 'B') return p.tickets[1] ? [p.tickets[1]] : null;
  if (which === 'C') return p.tickets[2] ? [p.tickets[2]] : null;
  return p.tickets.length >= 2 ? [p.tickets[0], p.tickets[1]] : null;
}
const scopeOfWhich = (w) => (w === 'AB' ? 'two_ticket' : 'ticket');
const linesOf = (W, pattern, scope) => [...W.lines.values()].filter((x) => x.line.pattern === pattern && x.line.scope === scope).sort((a, b) => a.line.ordinal - b.line.ordinal);
/** Docs: ordinal k only after k-1 is awarded; claims at the same call share one position. */
const openLineModel = (W, pattern, scope, idx) => linesOf(W, pattern, scope).find((x) => x.tids.length === 0 || x.idx === idx) ?? null;
/** Model: will the engine accept this claim for checking? (running, not blocked, not in another pause, a number called, ticket held, an open line, not a repeat in the window) */
function acceptModel(W, pid, which, pattern) {
  const e = W.e, p = P(W, pid);
  if (!p || e.status !== 'started' || W.blocked.has(pid)) return false;
  if (e.paused && e.paused.type !== 'claim') return false;
  if (W.log.length === 0) return false;
  if (!ticketsOfModel(p, which)) return false;
  if (which === 'AB' && pattern !== 'full') return false;
  if (!linesOf(W, pattern, scopeOfWhich(which)).length) return false;
  if (!openLineModel(W, pattern, scopeOfWhich(which), W.log.length - 1)) return false;
  if (W.window.some((x) => x.pid === pid && x.which === which && x.pattern === pattern)) return false;
  return true;
}
/** Make a claim on the real engine and record what the model expects. */
function claimNow(W, pid, which, pattern, cut, label) {
  const c = W.c, e = W.e;
  const want = acceptModel(W, pid, which, pattern);
  const err = e.claim(pid, { ticket: which, pattern, cut });
  c.eq(err === null, want, `claim_accepted_exactly_when_rules_allow${label ? ':' + label : ''}`, `${pattern} ${which} err=${err}`);
  if (err === null && want) {
    const p = P(W, pid);
    W.window.push({ pid, which, pattern, cut: [...cut], verdict: claimVerdict(ticketsOfModel(p, which), pattern, cut, W.log), idx: W.log.length - 1, tid: e.ticketId(p, which), fun: p.kind === 'family' && !e.settings.familyCanWin });
    c.eq(e.paused?.type, 'claim', 'claim_pauses_everybody');
  } else c.ok(e.paused?.type !== 'claim' || W.window.length > 0, 'refused_claim_opens_no_window');
  return err;
}
/** Close the claim window (CLAIM_CHECK), compare results with the model, then the result screen (RESULT_SHOW). */
function settleWindow(W) {
  const c = W.c, e = W.e;
  if (!W.window.length) return;
  const n0 = W.log.length;
  c.ok(e.draw() !== null && e.called.length === n0, 'no_draw_during_claim_check');
  W.clk += EN.CFG.CLAIM_CHECK; e.tick();
  c.eq(e.paused?.type, 'result', 'claim_check_then_result');
  const res = [...W.events].reverse().find((x) => x.type === 'result');
  // model: valid & not for fun -> the open line of that kind (shared by every valid claim in the window); not valid -> one Bogey, two = blocked
  for (const cl of W.window) {
    const scope = scopeOfWhich(cl.which);
    const line = openLineModel(W, cl.pattern, scope, cl.idx);
    const ok = cl.verdict === 'ok' && !!line;
    const item = res?.items.find((x) => x.ticketId === cl.tid && (x.reward.endsWith(cl.which === 'AB' ? 'Full Two-Ticket House' : NAME[cl.pattern])));
    c.ok(!!item, 'every_checked_claim_gets_a_public_result', `${cl.pattern} ${cl.which}`);
    if (item) {
      c.eq(item.ok, ok, 'claim_valid_exactly_per_rules', `${cl.pattern} ${cl.which} verdict=${cl.verdict} log=${W.log.length}`);
      c.eq(item.fun, ok && cl.fun, 'family_for_fun_flag');
      if (ok && line) { const total = linesOf(W, cl.pattern, scope).length; c.eq(item.reward, total > 1 ? `${ordEn(line.line.ordinal)} ${cl.which === 'AB' ? 'Full Two-Ticket House' : NAME[cl.pattern]}` : (cl.which === 'AB' ? 'Full Two-Ticket House' : NAME[cl.pattern]), 'result_names_the_position_won'); }
    }
    if (ok && !cl.fun) { if (!line.tids.includes(cl.tid)) line.tids.push(cl.tid); line.idx = cl.idx; }
    if (!ok) { const b = (W.bogeys.get(cl.pid) ?? 0) + 1; W.bogeys.set(cl.pid, b); if (b >= 2) W.blocked.add(cl.pid); }
  }
  W.window = [];
  compareWinners(W);
  W.clk += EN.CFG.RESULT_SHOW; e.tick();
  const allDone = [...W.lines.values()].every((x) => x.tids.length > 0);
  if (allDone) c.eq(e.status, 'ended', 'ends_when_every_reward_is_awarded');
  else c.ok(e.status === 'started' && e.paused?.type !== 'result', 'resumes_after_result_window', e.paused?.type);
}
function compareWinners(W) {
  const c = W.c, e = W.e;
  for (const [id, m] of W.lines) {
    const ws = e.winners.get(id) ?? [];
    c.ok(sameSet(ws.map((w) => w.ticketId), m.tids), 'winners_match_model', `${id} engine=${ws.map((w) => w.ticketId).join(',')} model=${m.tids.join(',')}`);
    c.ok(ws.every((w) => w.share === ws.length), 'shared_position_split_equally', id);
    c.ok(new Set(ws.map((w) => w.ticketId)).size === ws.length, 'never_the_same_line_twice', id);
  }
  for (const pid of W.pids.concat(W.family)) {
    const p = P(W, pid); if (!p) continue;
    c.eq(p.notValid, W.bogeys.get(pid) ?? 0, 'not_valid_count_matches_model');
    c.eq(p.blocked, W.blocked.has(pid), 'blocked_after_two_not_valid');
  }
}
function goLive(W) {
  const c = W.c, e = W.e;
  c.eq(e.start(), null, 'start_once');
  c.ok(e.start() !== null, 'second_start_refused');
  c.ok(e.updateSettings('organizer', { name: 'changed' }) !== null, 'settings_locked_after_start');
  W.clk += EN.CFG.PRE_START_MS; e.tick();
  c.eq(e.status, 'started', 'live_after_pre_start_window');
  c.ok(e.addParticipants([{ name: 'late', e164: `late${W.clk}` }]).ok === false, 'entry_closed_after_live');
}
/** Steer the next number (the engine's rand is public "so tests can steer draws"); returns true when x was called. */
function callNumber(W, x) {
  const e = W.e, save = e.rand;
  e.rand = (n) => (n === e.remaining.length ? e.remaining.indexOf(x) : save(n));
  const err = e.draw();
  e.rand = save;
  W.c.ok(err === null && e.current === x, 'harness_steered_call', { x, err });
  return err === null;
}
function publicChecks(W) {
  const c = W.c, e = W.e, ps = e.publicState(), s = JSON.stringify(ps);
  c.ok(!W.names.some((n) => s.includes(n)) && !W.refs.some((n) => s.includes(n)), 'public_state_has_no_name_or_number');
  c.ok(!('called' in ps) && !('remaining' in ps) && !('callOrder' in ps), 'public_state_has_no_past_numbers');
  c.eq(ps.callNo, e.called.length, 'public_call_count');
  if (e.called.length) c.eq(ps.current, e.called[e.called.length - 1], 'public_current_is_last_call');
}
function ticketIdChecks(W) {
  const c = W.c, e = W.e, seen = new Set();
  for (const p of e.participants) for (const w of p.tickets.length >= 2 ? ['A', 'B', 'AB'] : ['A']) {
    const id = e.ticketId(p, w);
    c.ok(/^TMB-[A-Z]{1,4}-[A-Z0-9]+-\d{6}-(A|B|AB)$/.test(id) && !id.includes(p.name), 'ticket_id_public_and_nameless', id);
    c.ok(!seen.has(id), 'ticket_id_unique'); seen.add(id);
  }
  const keys = new Set(); let n = 0;
  for (const p of e.participants) for (const t of p.tickets) { n++; keys.add(JSON.stringify(t)); c.ok(ticketProblems(t).length === 0, 'engine_ticket_valid', ticketProblems(t)); }
  c.eq(keys.size, n, 'no_two_tickets_alike_in_one_engagement');
}

// ---------------------------------------------------------------- claim cells
function needSet(r, ts, pattern) {
  if (pattern === 'early5') return shuffle(r, allN(ts[0]).slice()).slice(0, 5);
  return [...new Set(ts.flatMap((t) => houseRule(t, pattern).pool))];
}
function claimCase(c, r, parts, tag) {
  const [, mode, pat, nS, fault] = parts;
  const players = +nS, pattern = pat === 'AB' ? 'full' : pat;
  const background = NEEDS_TWO.has(fault) ? 40 : 0; // non-claiming extra seats, so two tickets sharing a completing number can always be found
  const famFault = fault === 'family_fun' || fault === 'family_can_win';
  const spec = ENGINE_PATTERNS.map((p) => ({ pattern: p, texts: p === pattern && pat !== 'AB' && fault === 'ordinal2' ? ['Prize A', 'Prize B'] : ['Prize'] }));
  if (mode === 'double') spec.push({ pattern: 'full', scope: 'two_ticket', texts: pat === 'AB' && fault === 'ordinal2' ? ['Bumper A', 'Bumper B'] : ['Bumper'] });
  const W = engineWorld(r, c, tag, { mode, callMode: 'manual', players: players + background, limit: players + background + 5, familyCanWin: fault !== 'family_fun', rewards: EN.makeRewardLines(spec), family: famFault ? 1 : 0 });
  const e = W.e;
  ticketIdChecks(W);
  let Tid = famFault ? W.family[0] : W.pids[0];
  let which = pat === 'AB' ? 'AB' : mode === 'double' ? r.pick(['A', 'B']) : 'A';
  if (fault === 'pre_live') { c.eq(e.status, 'open', 'harness_status'); claimNow(W, Tid, which, pattern, [], 'pre_live'); e.start(); claimNow(W, Tid, which, pattern, [], 'starting'); W.clk += EN.CFG.PRE_START_MS; e.tick(); c.eq(e.status, 'started', 'live_after_pre_start_window'); }
  else goLive(W);
  let pre, S, X, U = null, SU = null;
  if (fault === 'tie2' || fault === 'second_window') {
    const cands = shuffle(r, W.pids.slice());
    let found = null;
    for (let i = 0; i < cands.length && !found; i++) for (let j = i + 1; j < cands.length && !found; j++) {
      const tw = which === 'AB' ? 'AB' : 'A';
      const tT = ticketsOfModel(P(W, cands[i]), tw), tU = ticketsOfModel(P(W, cands[j]), tw);
      if (pattern === 'early5') {
        const a = allN(tT[0]), b = new Set(allN(tU[0])), common = a.filter((n) => b.has(n));
        if (!common.length) continue;
        const x = r.pick(common);
        const ST = [x, ...shuffle(r, a.filter((n) => !b.has(n))).slice(0, 4)], SUx = [x, ...shuffle(r, [...b].filter((n) => !a.includes(n))).slice(0, 4)];
        found = { T: cands[i], U: cands[j], which: tw, ST, SU: SUx, X: x };
      } else {
        const PT = needSet(r, tT, pattern), PU = new Set(needSet(r, tU, pattern)), inter = PT.filter((n) => PU.has(n));
        if (!inter.length) continue;
        found = { T: cands[i], U: cands[j], which: tw, ST: PT, SU: [...PU], X: r.pick(inter) };
      }
    }
    if (!c.ok(!!found, 'harness_tie_constructible', `${pattern} among ${cands.length}`)) return;
    Tid = found.T; U = found.U; which = found.which; S = found.ST; SU = found.SU; X = found.X;
    pre = shuffle(r, [...new Set([...S, ...SU])].filter((n) => n !== X));
  } else {
    const ts = ticketsOfModel(P(W, Tid), which === 'AB' ? 'AB' : which) ?? ticketsOfModel(P(W, Tid), 'A');
    S = needSet(r, ts, pattern); X = r.pick(S);
    const mine = new Set(P(W, Tid).tickets.flatMap(allN));
    const noise = shuffle(r, Array.from({ length: 90 }, (_, i) => i + 1).filter((n) => !mine.has(n)));
    pre = shuffle(r, [...S.filter((n) => n !== X), ...noise.slice(0, r.int(0, 5))]);
    W.noise = noise.slice(5);
    if (pre.length < 2) pre.push(...W.noise.splice(0, 2));
  }
  const noiseNext = () => { const pool = (W.noise ?? []).filter((n) => !W.log.includes(n)); const x = pool.length ? pool[0] : e.remaining.find((n) => !S.includes(n) && !(SU ?? []).includes(n)); if (W.noise) W.noise = pool.slice(1); return x; };
  const T = () => P(W, Tid);
  const cutT = () => (pattern === 'early5' ? S.slice() : [...new Set([...S, ...shuffle(r, T().tickets.flatMap(allN)).slice(0, r.int(0, 3))])].filter((n) => pattern !== 'early5'));
  const intended = (v, want) => c.eq(v, want, 'harness_scenario_reaches_intended_case', fault);

  if (fault === 'bogey2_block') {
    callNumber(W, pre[0]); intended(claimVerdict(ticketsOfModel(T(), which), pattern, S, W.log), pattern === 'early5' ? 'incomplete' : 'not_called');
    claimNow(W, Tid, which, pattern, S); settleWindow(W);
    callNumber(W, pre[1]); claimNow(W, Tid, which, pattern, S); settleWindow(W);
    c.ok(W.blocked.has(Tid), 'harness_two_bogeys_made');
    for (const x of pre.slice(2)) callNumber(W, x);
    callNumber(W, X);
    intended(claimVerdict(ticketsOfModel(T(), which), pattern, S, W.log), 'ok');
    c.ok(e.claim(Tid, { ticket: which, pattern, cut: S }) !== null, 'blocked_ticket_cannot_claim');
    settleWindow(W); compareWinners(W); publicChecks(W); return;
  }
  if (fault === 'incomplete') {
    for (const x of pre) callNumber(W, x);
    intended(['incomplete', 'not_called'].includes(claimVerdict(ticketsOfModel(T(), which), pattern, S, W.log)) ? 'yes' : 'no', 'yes');
    claimNow(W, Tid, which, pattern, S); settleWindow(W); publicChecks(W); return;
  }
  for (const x of pre) callNumber(W, x);
  callNumber(W, X);
  if (fault === 'uncut') {
    const drop = r.pick(S), cut = S.filter((n) => n !== drop);
    intended(['incomplete', 'not_cut'].includes(claimVerdict(ticketsOfModel(T(), which), pattern, cut, W.log)) ? 'yes' : 'no', 'yes');
    claimNow(W, Tid, which, pattern, cut); settleWindow(W); publicChecks(W); return;
  }
  if (fault === 'late') {
    callNumber(W, noiseNext());
    intended(claimVerdict(ticketsOfModel(T(), which), pattern, S, W.log), 'late');
    claimNow(W, Tid, which, pattern, S); settleWindow(W); publicChecks(W); return;
  }
  if (fault === 'wrong_ticket') {
    const bad = mode === 'single' ? r.pick(['B', 'AB', 'C']) : r.pick(['C', 'AB']);
    const badPattern = bad === 'AB' ? r.pick(ENGINE_PATTERNS.filter((p) => p !== 'full')) : pattern;
    c.ok(e.claim(Tid, { ticket: bad, pattern: badPattern, cut: S }) !== null && e.paused === null, 'claim_on_a_ticket_not_held_refused', `${bad} ${badPattern}`);
    compareWinners(W); return;
  }
  if (fault === 'during_pause') {
    c.eq(e.emergency('Smoke pause'), null, 'organizer_can_pause');
    c.ok(e.draw() !== null, 'no_draw_in_emergency_pause');
    claimNow(W, Tid, which, pattern, cutT(), 'paused');
    W.clk += 30_000; e.tick();
    c.eq(e.called.length, W.log.length, 'clock_moves_no_numbers_while_paused');
    e.resume();
    c.ok(e.paused === null, 'resume_clears_pause');
    intended(claimVerdict(ticketsOfModel(T(), which), pattern, cutT(), W.log), 'ok');
    claimNow(W, Tid, which, pattern, cutT(), 'after_resume'); settleWindow(W); publicChecks(W); return;
  }
  // valid claim by T (and U in tie cases)
  const cut = cutT();
  intended(claimVerdict(ticketsOfModel(T(), which), pattern, cut, W.log), 'ok');
  claimNow(W, Tid, which, pattern, cut);
  if (fault === 'duplicate') c.ok(e.claim(Tid, { ticket: which, pattern, cut }) !== null, 'same_claim_twice_in_window_refused');
  if (fault === 'tie2') { intended(claimVerdict(ticketsOfModel(P(W, U), which), pattern, SU, W.log), 'ok'); claimNow(W, U, which, pattern, SU); }
  settleWindow(W);
  if (fault === 'tie2') { const l = linesOf(W, pattern, scopeOfWhich(which))[0]; c.eq(l.tids.length, 2, 'tie_on_same_number_both_win'); }
  if (fault === 'second_window') { // DESIGN_CLAIM_PAUSE 1.4.3 + GAME_PRINCIPLES 4: a claim before the next number counts; ties on the same number share
    claimNow(W, U, which, pattern, SU, 'second_window'); settleWindow(W);
  }
  if (fault === 'after_awarded') {
    callNumber(W, noiseNext());
    c.ok(e.claim(Tid, { ticket: which, pattern, cut }) !== null, 'prize_already_won_is_rejected');
    const others = W.pids.filter((x) => x !== Tid);
    if (others.length) claimNow(W, others[0], which === 'AB' ? 'AB' : 'A', pattern, allN(P(W, others[0]).tickets[0]), 'after_awarded_other');
    settleWindow(W);
  }
  if (fault === 'ordinal2') {
    const ul = shuffle(r, W.pids.filter((x) => x !== Tid));
    let done = false;
    for (const u of ul) {
      const tsU = ticketsOfModel(P(W, u), which);
      let set, y;
      if (pattern === 'early5') { const un = allN(tsU[0]).filter((n) => !W.log.includes(n)); if (!un.length) continue; y = r.pick(un); set = [y, ...shuffle(r, allN(tsU[0]).filter((n) => n !== y)).slice(0, 4)]; }
      else { set = needSet(r, tsU, pattern); const un = set.filter((n) => !W.log.includes(n)); if (!un.length) continue; y = r.pick(un); }
      for (const x of set.filter((n) => n !== y && !W.log.includes(n))) callNumber(W, x);
      callNumber(W, y);
      if (pattern === 'early5' && claimVerdict(tsU, pattern, set, W.log) !== 'ok') continue;
      intended(claimVerdict(tsU, pattern, set, W.log), 'ok');
      claimNow(W, u, which, pattern, set, 'second_position'); settleWindow(W);
      const ls = linesOf(W, pattern, scopeOfWhich(which));
      c.ok(ls[0].tids.length >= 1 && ls[1].tids.length >= 1 && ls[1].idx > ls[0].idx, 'second_position_after_first', ls.map((x) => x.idx));
      done = true; break;
    }
    c.ok(done, 'harness_second_position_constructible');
  }
  if (fault === 'family_fun') { const l = linesOf(W, pattern, scopeOfWhich(which))[0]; c.eq(l.tids.length, 0, 'family_for_fun_wins_nothing'); c.eq(e.status, 'started', 'line_stays_open_after_fun_win'); }
  if (fault === 'family_can_win') { const l = linesOf(W, pattern, scopeOfWhich(which))[0]; c.eq(l.tids.length, 1, 'family_can_win_when_allowed'); }
  if (fault === 'valid') { const l = linesOf(W, pattern, scopeOfWhich(which))[0]; c.eq(l.tids.length, 1, 'valid_claim_wins'); }
  compareWinners(W); publicChecks(W);
  // purge: anonymous summary, then nothing personal left (NOTES 4)
  e.end('Smoke end');
  c.eq(e.status, 'ended', 'organizer_can_end');
  const total = e.participants.length, fam = e.participants.filter((p) => p.kind === 'family').length;
  c.eq(e.purge(), null, 'purge_after_end');
  c.ok(e.summary && e.summary.players === total && e.summary.family === fam, 'purge_keeps_anonymous_summary', e.summary);
  const snap = e.snapshot();
  c.ok(!W.names.some((n) => snap.includes(n)) && !W.refs.some((n) => snap.includes(n)), 'purge_leaves_no_name_or_number');
}

// ---------------------------------------------------------------- full game cells
function gameCase(c, r, parts, tag) {
  const [, variant, nS, callMode, extra] = parts;
  const players = +nS;
  const mode = variant === 'double' ? 'double' : 'single';
  let spec;
  if (variant === 'default6') spec = null;
  else if (variant === 'all7') spec = ENGINE_PATTERNS.map((p) => ({ pattern: p, texts: ['Prize'] }));
  else if (variant === 'multi') spec = [{ pattern: 'early5', texts: ['a', 'b'] }, { pattern: 'top', texts: ['a'] }, { pattern: 'full', texts: ['a', 'b', 'c'] }];
  else spec = [...ENGINE_PATTERNS.slice(0, 6).map((p) => ({ pattern: p, texts: ['Prize'] })), { pattern: 'full', scope: 'two_ticket', texts: ['Bumper'] }];
  const rewards = spec ? EN.makeRewardLines(spec) : EN.DEFAULT_REWARDS();
  const fam = extra === 'family' ? r.int(1, 3) : 0;
  const W = engineWorld(r, c, tag, { mode, callMode, players, limit: players + fam + r.int(0, 10), familyCanWin: extra === 'family' ? r.chance(0.5) : true, rewards, family: fam });
  const e0 = W.e;
  if (extra === 'breaks') {
    const k = r.int(1, 3), pos = [...new Set(Array.from({ length: k }, () => r.int(1, 89)))].sort((a, b) => a - b);
    const brks = pos.map((after, i) => ({ id: `b${i}`, after, kind: 'speech', title: `Brand ${i}`, seconds: r.int(5, 30) }));
    c.eq(e0.setBreaks('organizer', brks), null, 'organizer_sets_breaks');
    c.ok(e0.setBreaks('organizer', [...brks, ...brks, ...brks, ...brks].map((b, i) => ({ ...b, after: i + 1 }))) !== null || brks.length * 4 <= EN.CFG.MAX_BREAKS, 'at_most_three_breaks');
    c.eq(e0.setBreaks('organizer', brks), null, 'organizer_sets_breaks_again');
  }
  ticketIdChecks(W);
  goLive(W);
  const emergencyAt = extra === 'emergency' ? r.int(1, 60) : -1, holdMs = r.int(5, 40) * 1000;
  const restoreAt = r.int(5, 80);
  let emergencySince = null, lastHost = -1e12, steps = 0, seenCalls = 0, earlyChecked = false, restored = false, emergencyDone = false;
  while (W.e.status === 'started' && steps++ < 8000) {
    const e = W.e;
    if (callMode === 'manual' && !e.paused && W.clk - lastHost >= 6000) {
      const err = e.hostDraw('host');
      c.eq(err, null, 'host_draw_after_gap');
      lastHost = W.clk;
      if (!earlyChecked && e.called.length > 0) { earlyChecked = true; const n0 = e.called.length; c.ok(e.hostDraw('host') !== null && e.called.length === n0, 'host_draw_too_soon_refused'); }
    }
    e.tick();
    if (e.status !== 'started') break;
    if (e.called.length > seenCalls) {
      seenCalls = e.called.length;
      botClaims(W, r);
      if (seenCalls === emergencyAt && !emergencyDone) { emergencyDone = true; c.eq(e.emergency('Smoke pause'), null, 'organizer_pause_accepted'); }
      if (W.window.length) settleWindow(W);
      if (seenCalls === restoreAt && !restored && W.e.status === 'started') {
        restored = true;
        const before = JSON.stringify(W.e.publicState());
        W.e = EN.EngagementEngine.restore(W.e.snapshot(), W.deps);
        c.eq(JSON.stringify(W.e.publicState()), before, 'snapshot_restore_keeps_public_state');
      }
    }
    if (W.e.paused?.type === 'emergency') {
      emergencySince ??= W.clk;
      if (W.clk - emergencySince >= holdMs) { W.e.resume(); c.ok(W.e.paused === null, 'resume_after_pause'); emergencySince = null; }
    }
    W.clk += 500;
  }
  const e = W.e;
  c.eq(e.status, 'ended', 'game_reaches_an_end');
  const allAwarded = [...W.lines.values()].every((x) => x.tids.length > 0);
  c.ok(allAwarded || e.called.length === 90, 'ends_only_when_all_awarded_or_90_called', { called: e.called.length, allAwarded });
  c.ok(new Set(e.called).size === e.called.length && e.called.every((n) => n >= 1 && n <= 90), 'no_repeat_number');
  c.ok(JSON.stringify(e.called) === JSON.stringify(W.log), 'public_calls_equal_engine_log');
  if (extra === 'emergency' && emergencyAt <= e.called.length && emergencyAt > 0) c.ok(W.events.some((x) => x.type === 'pause' && x.kind === 'emergency'), 'emergency_pause_happened');
  if (extra === 'breaks') { const due = e.settings.breaks.filter((b) => b.after < e.called.length).length; c.ok((W.breaksSeen ?? 0) >= due, 'every_due_brand_break_shown', { due, seen: W.breaksSeen }); }
  compareWinners(W); publicChecks(W);
  const rep = e.report();
  const total = [...W.lines.values()].reduce((s, x) => s + x.tids.length, 0);
  c.eq(rep.winners.length, total, 'report_lists_every_winner');
  c.eq(JSON.stringify(rep.callOrder), JSON.stringify(W.log), 'report_call_order');
  c.eq(rep.notAwarded.length, [...W.lines.values()].filter((x) => !x.tids.length).length, 'report_lists_rewards_not_awarded');
  const n = e.participants.length;
  c.eq(e.purge(), null, 'purge_after_end');
  c.eq(e.summary?.players, n, 'purge_summary_players');
  const snap = e.snapshot();
  c.ok(!W.names.some((x) => snap.includes(x)) && !W.refs.some((x) => snap.includes(x)), 'purge_leaves_no_name_or_number');
}
/** Bots cut every called number and claim each completed house at once (90%); now and then someone presses Claim wrongly. */
function botClaims(W, r) {
  const e = W.e, log = W.log, last = log.length - 1, pos = posOf(log);
  const kinds = [...new Set(e.settings.rewards.map((l) => `${l.pattern}|${l.scope}`))].map((k) => k.split('|'));
  for (const pid of W.pids.concat(W.family)) {
    const p = P(W, pid);
    if (!p || W.blocked.has(pid)) continue;
    const own = (ts) => ts.flatMap(allN).filter((n) => pos.has(n));
    for (const [pattern, scope] of kinds) {
      const whiches = scope === 'two_ticket' ? ['AB'] : p.tickets.length >= 2 ? ['A', 'B'] : ['A'];
      for (const which of whiches) {
        const ts = ticketsOfModel(p, which); if (!ts) continue;
        if (claimVerdict(ts, pattern, own(ts), log, pos) !== 'ok') continue;
        if (!openLineModel(W, pattern, scope, last)) continue;
        if (r.chance(0.1)) continue; // principle 5: a complete ticket nobody claims wins nothing
        claimNow(W, pid, which, pattern, own(ts));
      }
    }
  }
  if (r.chance(0.04)) {
    const pid = r.pick(W.pids), p = P(W, pid);
    if (p && !W.blocked.has(pid)) {
      const [pattern, scope] = r.pick(kinds), which = scope === 'two_ticket' ? 'AB' : 'A';
      const ts = ticketsOfModel(p, which);
      if (ts && openLineModel(W, pattern, scope, last) && claimVerdict(ts, pattern, own2(ts, log), log) !== 'ok' && !W.window.some((x) => x.pid === pid && x.which === which && x.pattern === pattern)) claimNow(W, pid, which, pattern, own2(ts, log), 'false_claim');
    }
  }
}
const own2 = (ts, log) => ts.flatMap(allN).filter((n) => log.includes(n));

// ---------------------------------------------------------------- ticket cells
function ticketCase(c, r, parts, tag) {
  const [, source, mode, nS] = parts, n = +nS;
  const tickets = []; // [ownerKey, ticket]
  if (source === 'engine') {
    const W = engineWorld(r, c, tag, { mode, callMode: 'ai', players: n, limit: n, familyCanWin: true, rewards: EN.DEFAULT_REWARDS() });
    for (const p of W.e.participants) { c.eq(p.tickets.length, mode === 'double' ? 2 : 1, 'tickets_per_participant'); p.tickets.forEach((t) => tickets.push([p.id, t])); }
    c.ok(W.e.addParticipants([{ name: 'one more', e164: `x${tag}` }]).ok === false, 'limit_refuses_one_more');
    const e = W.e;
    const keep = e.participants.length;
    c.ok(e.updateSettings('organizer', { limit: keep - 1 }) !== null || keep === 0, 'limit_cannot_drop_below_used');
    c.ok(e.updateSettings('host', { name: 'x' }) !== null, 'host_cannot_change_settings');
    c.eq(e.updateSettings('organizer', { ticketMode: mode === 'double' ? 'single' : 'double' }), null, 'ticket_mode_switch_before_start');
    for (const p of e.participants) { c.eq(p.tickets.length, mode === 'double' ? 1 : 2, 'ticket_mode_switch_regenerates'); p.tickets.forEach((t) => c.ok(ticketProblems(t).length === 0, 'switched_ticket_valid')); }
    const ks = e.participants.flatMap((p) => p.tickets.map((t) => JSON.stringify(t)));
    c.eq(new Set(ks).size, ks.length, 'no_two_tickets_alike_after_switch');
  } else if (source === 'generator') {
    const rand = randOf(r);
    for (let i = 0; i < n * (mode === 'double' ? 2 : 1); i++) tickets.push([String(i), TK.generateTicket(rand)]);
  } else {
    const eid = `E${tag}`;
    for (let i = 0; i < n; i++) { const ts = GM.ticketsFor(eid, `s${i}`, mode === 'double' ? 2 : 1); if (ts.length === 2) c.ok(JSON.stringify(ts[0]) !== JSON.stringify(ts[1]), 'second_ticket_differs_from_first'); ts.forEach((t) => tickets.push([String(i), t])); c.eq(JSON.stringify(GM.ticketsFor(eid, `s${i}`, mode === 'double' ? 2 : 1)), JSON.stringify(ts), 'same_ticket_on_every_device'); }
  }
  if (source === 'engine') { const ks = tickets.map(([, t]) => JSON.stringify(t)); c.eq(new Set(ks).size, ks.length, 'no_two_tickets_alike_in_one_engagement'); }
  for (const [, t] of tickets) {
    const pr = ticketProblems(t);
    c.ok(pr.length === 0, 'ticket_3x9_15_numbers_column_ranges_sorted', pr);
    c.eq(TK.isValidTicket(t), pr.length === 0, 'isValidTicket_agrees_with_rules');
    for (const p of ENGINE_PATTERNS) {
      const mine = p === 'early5' ? null : houseRule(t, p).pool;
      const theirs = TK.patternNumbers(t, p);
      c.ok(mine === null ? theirs === null : sameSet(theirs.map(String), mine.map(String)), 'pattern_numbers_match_rules', p);
    }
    for (const k of HOUSES.filter((x) => x !== 'full2')) {
      const o = houseRule(t, k), pr2 = HR.ruleOf(t, k);
      if (o.kind === 'lines') c.ok(!!pr2?.lines && pr2.lines.length === 3, 'house_rule_two_lines');
      else c.ok(!!pr2 && sameSet(pr2.pool.map(String), o.pool.map(String)) && pr2.k === (o.kind === 'set' ? o.pool.length : o.k), 'house_rule_matches_how_to_win_text', k);
    }
  }
  // the validator must also say NO to broken tickets (each mutation breaks one documented rule)
  const base = tickets[0][1];
  for (const m of ['out_of_range', 'duplicate', 'row_four', 'unsorted', 'empty_column']) {
    const t = base.map((row) => row.slice());
    if (m === 'out_of_range') { const r0 = t[0].findIndex((v) => v !== null); t[0][r0] = r0 === 8 ? 79 : colRange(r0)[1] + 1; }
    if (m === 'duplicate') { const nums = allN(t); const a = nums[0]; const rr = [0, 1, 2].find((x) => t[x].includes(nums[14])); t[rr][t[rr].indexOf(nums[14])] = a; }
    if (m === 'row_four') { const i = t[1].findIndex((v) => v !== null); t[1][i] = null; }
    if (m === 'unsorted') { let done = false; for (let col = 0; col < 9 && !done; col++) { const rs = [0, 1, 2].filter((x) => t[x][col] !== null); if (rs.length >= 2) { const [a, b] = rs; [t[a][col], t[b][col]] = [t[b][col], t[a][col]]; done = true; } } if (!done) continue; }
    if (m === 'empty_column') { let done = false; for (let col = 0; col < 9 && !done; col++) { const rs = [0, 1, 2].filter((x) => t[x][col] !== null); if (rs.length === 1) { const row = rs[0]; t[row][col] = null; const free = t[row].findIndex((v, j) => v === null && j !== col); const [lo] = colRange(free); t[row][free] = lo; done = true; } } if (!done) continue; }
    c.eq(TK.isValidTicket(t), false, 'isValidTicket_refuses_broken_ticket', m);
    c.ok(ticketProblems(t).length > 0, 'harness_mutation_breaks_a_rule', m);
  }
}

// ---------------------------------------------------------------- beacon settlement cells (phone-side, v2)
function beaconCase(c, r, parts, tag) {
  const [, key, ties, fault, nS] = parts, n = +nS;
  const ntk = key === 'full2' ? 2 : r.pick([1, 2]);
  const pids = Array.from({ length: n }, (_, i) => `s${tag}x${i}`);
  // A fault needs a ticket that can complete the house at all. "any 5 of a kind" houses (low5 / high5 / odd5 / even5) are impossible on a
  // ticket with fewer than 5 such numbers, and with 3 seats every ticket may be like that (T2 run: 37 cases, all low5/high5 with 3 players).
  // So: pick the engagement id (deterministically: E<tag>, E<tag>r1, ...) until some seat's tickets can complete the house; then pick a call
  // order in which someone completes it before the last call. Tickets stay the product's own tickets for that id.
  let eid, tickets;
  for (let a = 0; a < 40; a++) {
    eid = a ? `E${tag}r${a}` : `E${tag}`;
    tickets = new Map(pids.map((p) => [p, GM.ticketsFor(eid, p, ntk)]));
    if (pids.some((p) => houseDoneAt(tickets.get(p), key, posOf(Array.from({ length: 90 }, (_, i) => i + 1))) >= 0)) break;
  }
  for (const ts of tickets.values()) for (const t of ts) c.ok(ticketProblems(t).length === 0, 'beacon_ticket_valid');
  let log, pos, done;
  for (let tries = 0; tries < 30; tries++) {
    const perm = shuffle(r, Array.from({ length: 90 }, (_, i) => i + 1));
    log = perm.slice(0, tries < 10 ? r.int(30, 90) : 90); pos = posOf(log);
    done = new Map(pids.map((p) => [p, houseDoneAt(tickets.get(p), key, pos)]));
    if ([...done.values()].some((i) => i >= 0 && i < log.length - 1)) break;
  }
  const m = r.int(1, 3);
  const rewards = Array.from({ length: m }, (_, i) => ({ pattern: key === 'full2' ? 'full' : key, scope: key === 'full2' ? 'two_ticket' : 'ticket', ordinal: i + 1, text: '' }));
  const cfg = { ...CF.defaultCfg(), tickets: ntk, ties, rewards };
  const R0 = r.int(1_000_000, 20_000_000), callRounds = log.map((_, k) => R0 + 3 * k); // 9 s calls = 3 beacon rounds
  c.eq(BX.roundTimeMs(R0 + 1) - BX.roundTimeMs(R0), 3000, 'beacon_round_every_3_seconds');
  const deadline = (i) => (i + 1 < log.length ? BX.roundTimeMs(callRounds[i + 1]) : Infinity);
  const claims = [];
  for (const p of pids) { const i = done.get(p); if (i >= 0) claims.push({ pid: p, pattern: key, round: 1, idx: i, atMs: BX.roundTimeMs(callRounds[i]) + r.int(0, 8999) }); }
  const cand = claims.filter((x) => x.idx < log.length - 1);
  const target = cand.length ? r.pick(cand) : null;
  if (!c.ok(!!target || fault === 'valid', 'harness_fault_target_exists', `${key} ${fault}`)) return;
  if (target) {
    const dl = deadline(target.idx);
    if (fault === 'late') target.atMs = dl + r.int(0, 20_000);
    if (fault === 'edge_in_time') target.atMs = dl - 1;
    if (fault === 'wrong_idx') target.idx = target.idx === 0 ? 1 : target.idx + r.pick([-1, 1]);
    if (fault === 'bogey1') claims.push({ pid: target.pid, pattern: key, round: 1, idx: -1, atMs: target.atMs - r.int(1, 50_000), bogey: true });
    if (fault === 'bogey2') for (let k = 0; k < 2; k++) claims.push({ pid: target.pid, pattern: key, round: 1, idx: -1, atMs: target.atMs - r.int(1, 50_000), bogey: true });
    if (fault === 'bogey_after') for (let k = 0; k < 2; k++) claims.push({ pid: target.pid, pattern: key, round: 1, idx: -1, atMs: target.atMs + r.int(1, 50_000), bogey: true });
    if (fault === 'no_claim') claims.splice(claims.indexOf(target), 1);
  }
  // oracle: counted = real completion call, before the next number (store clock), fewer than 2 Bogeys before the claim
  const counted = [];
  for (const p of pids) {
    const cl = claims.filter((x) => x.pid === p && !x.bogey).sort((a, b) => a.atMs - b.atMs)[0];
    if (!cl) continue;
    const bog = claims.filter((x) => x.pid === p && x.bogey && x.atMs < cl.atMs).length;
    if (cl.idx === done.get(p) && cl.atMs < deadline(cl.idx) && bog < 2) counted.push([cl.idx, p]);
  }
  const groups = new Map(); for (const [i, p] of counted) groups.set(i, [...(groups.get(i) ?? []), p]);
  const order = [...groups.keys()].sort((a, b) => a - b);
  const positions = ties === 'share' ? order.map((i) => ({ idx: i, pids: groups.get(i) })) : order.flatMap((i) => groups.get(i).map(() => ({ idx: i, pids: groups.get(i), many: groups.get(i).length > 1 })));
  const randomness = log.map((_, k) => createHmac('sha256', 'smoke').update(`${tag}|${k}`).digest('hex'));
  const out = GM.settleAll(eid, pids, log, cfg, 1, undefined, { randomness }, { claims, callRounds }).filter((x) => x.pattern === key);
  const out2 = GM.settleAll(eid, pids.slice().reverse(), log, cfg, 1, undefined, { randomness }, { claims: claims.slice().reverse(), callRounds }).filter((x) => x.pattern === key);
  c.eq(out.length, Math.min(m, positions.length), 'one_result_per_position_awarded', `${key} ${ties} ${fault}`);
  for (let o = 0; o < Math.min(m, positions.length); o++) {
    const got = out.find((x) => x.ordinal === o + 1), want = positions[o];
    if (!c.ok(!!got, 'position_awarded', o + 1)) continue;
    c.eq(got.idx, want.idx, 'position_goes_to_earliest_valid_claim', `pos ${o + 1}`);
    if (ties === 'share') c.ok(sameSet(got.pids, want.pids), 'share_rule_everyone_on_same_number_shares', `pos ${o + 1}`);
    else c.ok(got.pids.length === 1 && want.pids.includes(got.pids[0]), 'next_rule_one_person_per_position', `pos ${o + 1}`);
  }
  if (ties === 'next') { const ppl = out.map((x) => x.pids[0]); c.eq(new Set(ppl).size, ppl.length, 'next_rule_nobody_twice'); }
  c.eq(JSON.stringify(out2.map((x) => [x.ordinal, x.idx, [...x.pids].sort()])), JSON.stringify(out.map((x) => [x.ordinal, x.idx, [...x.pids].sort()])), 'tie_break_not_steered_by_list_order');
  c.ok(out.every((x) => counted.some(([, p]) => x.pids.includes(p))), 'no_winner_without_a_counted_claim');
  if (target && ['late', 'wrong_idx', 'bogey2', 'no_claim'].includes(fault)) c.ok(!out.some((x) => x.pids.includes(target.pid)), 'faulty_claim_never_wins', fault);
  if (target && fault === 'edge_in_time') c.ok(GM.claimInTime(target.atMs, callRounds[target.idx + 1]) && !GM.claimInTime(target.atMs + 1, callRounds[target.idx + 1]), 'claim_window_ends_exactly_at_next_number');
  // checkClaims: good exactly when the claimed call is the real completion call
  const plain = claims.filter((x) => !x.bogey).map(({ pid, pattern, idx }) => ({ pid, pattern, idx, round: 1 }));
  const cc = GM.checkClaims(eid, plain, log, cfg);
  for (const x of plain) c.eq(cc.good.includes(x), x.idx === done.get(x.pid), 'claim_check_recomputes_from_public_log');
  // still to win
  const k = r.int(0, log.length), called = new Set(log.slice(0, k));
  for (const p of pids.slice(0, 5)) c.eq(GM.stillToWin(tickets.get(p), key, log.slice(0, k)), stillNeeds(tickets.get(p), key, called), 'still_to_win_count', `${key} ${p}`);
  // the two-line "why you lost" text: numbers counted from 1, the right comparison
  const first = out.find((x) => x.ordinal === 1);
  if (first && target && !out.some((x) => x.pids.includes(target.pid))) {
    const mine = done.get(target.pid);
    const [l1, l2] = CT.lostClaimLines(NAME[key], [{ idx: first.idx, tickets: [7] }], mine);
    c.ok(l1.includes(`at number ${first.idx + 1}.`) && l1.startsWith('Ticket 7 won '), 'lost_text_names_winner_and_number_from_1', l1);
    if (mine > first.idx) c.ok(l2.includes(`later, at number ${mine + 1}`), 'lost_text_later', l2);
    else if (mine === first.idx) c.ok(l2.includes(`same number, ${mine + 1}`), 'lost_text_same_number', l2);
    else c.ok(l2.includes(`at number ${mine + 1}`) && l2.includes(`after number ${mine + 2}`), 'lost_text_too_late', l2);
  }
}

// ---------------------------------------------------------------- money: pack prices and the private price
function priceCase(c, r, parts) {
  const [, packS, cur, adj] = parts, pack = +packS, g = GOLDEN.find((x) => x[0] === pack);
  const want = cur === 'INR' ? g[1] : g[2];
  const pr = PR.price(pack, cur);
  c.eq(pr.total, want, 'price_is_owner_list_price', `${pack} ${cur}`);
  c.eq(pr.tax, 0, 'gst_off_no_tax');
  c.eq(pr.base, pr.total, 'base_equals_total_without_gst');
  if (cur === 'INR') c.ok(want % 100 === 99, 'harness_inr_list_ends_99');
  c.ok(Number.isInteger(pr.total), 'whole_currency_units');
  const list = PA.listMinor(pack, cur);
  c.eq(list, want * 100, 'list_minor_exact_integer');
  c.eq(PR.PACKS.length, GOLDEN.length, 'eight_packs');
  let threw = false; try { PR.price(pack + 1, cur); } catch (err) { threw = err instanceof RangeError; }
  c.ok(threw, 'unknown_pack_refused');
  const cap = r.int(1, 12000), wantPack = GOLDEN.find((x) => x[0] >= cap)?.[0] ?? null;
  c.eq(PA.packOf(cap), wantPack, 'pack_for_a_limit_is_smallest_that_fits', cap);
  c.eq(CR.rs(want, cur), (cur === 'INR' ? 'Rs ' + groupIN(want) : 'US$' + groupUS(want)), 'money_words_grouping');
  const k = r.int(0, 4);
  if (k > 3) { let t = false; try { PR.proposeBreakPositions(k); } catch { t = true; } c.ok(t, 'at_most_3_brand_breaks'); }
  else { const b = PR.proposeBreakPositions(k); c.eq(b.length, k, 'break_count'); const gaps = [...b, 90].map((x, i) => x - (i ? b[i - 1] : 0)); c.ok(b.every((x, i) => x >= 1 && x <= 89 && (!i || x > b[i - 1])) && (k === 0 || Math.max(...gaps) - Math.min(...gaps) <= 1), 'breaks_near_equal_over_90_calls', b); }
  if (adj === 'none') return;
  let a, ok, net;
  if (adj === 'zero') { a = 0; ok = false; }
  if (adj === 'fraction') { a = r.int(-list + 200, list) + 0.5; ok = false; }
  if (adj === 'min_exact') { a = 100 - list; ok = true; net = 100; }
  if (adj === 'below_min') { a = 99 - list - r.int(0, 50); ok = false; }
  if (adj === 'max_exact') { a = list; ok = true; net = 2 * list; }
  if (adj === 'above_max') { a = list + 1 + r.int(0, 1000); ok = false; }
  if (adj === 'random_ok') { do a = r.int(100 - list, list); while (a === 0); ok = true; net = list + a; }
  const res = PA.netOf(list, a);
  c.eq(res.ok, ok, 'private_price_bounds_net_1_to_2x_list_never_zero', `${pack} ${cur} adj=${a}`);
  if (ok && res.ok) { c.eq(res.net, net, 'private_price_net_exact'); c.ok(Number.isInteger(res.net), 'net_integer_minor'); }
  if (!res.ok) c.ok(typeof res.error === 'string' && res.error.length > 5 && !/adjust|discount/i.test(res.error.replace(/Enter an amount to reduce or to add/, '')), 'refusal_is_plain_words', res.error);
}

// ---------------------------------------------------------------- money: credit (no refunds) on an in-memory D1 stand-in
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql) => { let args = []; const s = {
    bind: (...a) => { args = a.map((v) => (v === undefined ? null : v)); return s; },
    first: async (col) => { const row = db.prepare(sql).get(...args); return row === undefined ? null : col ? row[col] : { ...row }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map((x) => ({ ...x })) }),
    run: async () => { const x = db.prepare(sql).run(...args); return { meta: { changes: Number(x.changes) } }; } }; return s; };
  return { prepare: stmt, raw: db };
}
async function creditCase(c, r, parts, tag) {
  const [, scen, cur, edge] = parts;
  const db = d1();
  db.raw.exec('CREATE TABLE engagement (id TEXT PRIMARY KEY, org TEXT, pack INTEGER, cancelled_ms INTEGER)');
  for (const s of CR.CREDIT_SCHEMA) db.raw.exec(s);
  const org = `org${tag}`, eid = `g${tag}`;
  const now = Date.UTC(2027, r.int(0, 11), r.int(1, 28), r.int(0, 23), r.int(0, 59), r.int(0, 59));
  db.raw.prepare('INSERT INTO engagement (id, org, pack, cancelled_ms) VALUES (?,?,0,?)').run(eid, org, scen === 'cancelled_game' ? now - 1000 : null);
  const g = r.pick(GOLDEN), pricePaise = (cur === 'INR' ? g[1] : g[2]) * 100, price = pricePaise / 100;
  const paidAt = (daysAgo) => {
    if (edge === 'ist_midnight') { const [y, m, d] = istParts(now - daysAgo * DAY); return Date.UTC(y, m, d) - IST + r.pick([-1, 0, 1]); }
    return now - daysAgo * DAY - r.int(0, DAY - 1);
  };
  const mk = async (id, paise, paid, o = org, cu = cur) => {
    const row = await CR.creditFromPayment(db, { id, amount: paise / 100, currency: cu, paid_ms: paid }, o, null, now, 'cancel');
    c.ok(!!row, 'credit_made_from_paid_amount');
    if (row) {
      c.eq(row.expires_ms, creditExpiryOracle(paid), 'credit_lapses_at_end_of_day_365_ist', { paid });
      c.eq(Math.round(row.total_inr * 100), paise, 'credit_keeps_exact_amount');
      const [y, m, d] = istParts(paid), last = new Date(Date.UTC(y, m, d + 365));
      const txt = CR.creditLastDay(row.expires_ms), mm = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(txt);
      c.ok(!!mm && +mm[1] === last.getUTCDate() && mm[2].slice(0, 3) === MON[last.getUTCMonth()] && +mm[3] === last.getUTCFullYear(), 'last_usable_day_told_is_day_365', txt);
    }
    return row;
  };
  const rows = async () => (await db.prepare('SELECT * FROM credit ORDER BY created_ms').all()).results;
  const uses = async () => (await db.prepare('SELECT * FROM credit_use').all()).results;
  const totalPaise = async () => { let s = 0; for (const x of await rows()) s += Math.round(x.total_inr * 100); return s; };
  const invariants = async () => {
    for (const x of await rows()) {
      for (const f of ['total_inr', 'remaining_inr', 'lapsed_inr']) c.ok(Math.abs(x[f] * 100 - Math.round(x[f] * 100)) < 1e-6, 'credit_amount_whole_paise_no_float_drift', `${f}=${x[f]}`);
      c.ok(x.remaining_inr >= 0, 'credit_never_negative', x.remaining_inr);
      const used = (await uses()).filter((u) => u.credit_id === x.id && u.status === 'applied').reduce((s, u) => s + Math.round(u.amount_inr * 100), 0);
      c.eq(Math.round(x.remaining_inr * 100) + used + Math.round(x.lapsed_inr * 100), Math.round(x.total_inr * 100), 'credit_conserved_remaining_plus_used_plus_lapsed');
    }
    const applied = Math.round((await CR.creditAppliedFor(db, eid)) * 100);
    c.ok(applied <= pricePaise, 'credit_applied_never_above_price', applied);
  };
  const apply = async (t = now) => CR.applyCreditToGame(db, org, eid, price, cur, t);
  let res, want;
  if (scen === 'full' || scen === 'remainder' || scen === 'partial' || scen === 'idempotent' || scen === 'restore' || scen === 'restore_lapsed') {
    const amt = scen === 'full' ? pricePaise : scen === 'remainder' ? pricePaise + r.int(1, 500_000) : scen === 'partial' ? r.int(100, pricePaise - 1) : r.int(100, pricePaise * 2);
    const paid = paidAt(r.int(1, 300));
    const row = await mk(`pay_${tag}_1`, amt, paid);
    res = await apply();
    want = Math.min(amt, pricePaise);
    c.eq(Math.round(res.appliedInr * 100), want, 'credit_applied_up_to_price', `${scen} amt=${amt} price=${pricePaise}`);
    const after = (await rows())[0];
    c.eq(Math.round(after.remaining_inr * 100), amt - want, 'remainder_stays_as_credit');
    c.eq(after.status, amt - want > 0 ? 'active' : 'used', 'credit_status_after_use');
    c.eq(after.expires_ms, row.expires_ms, 'remainder_keeps_same_expiry');
    if (scen === 'idempotent') { const again = await apply(); c.eq(again.usedNow.length, 0, 'apply_twice_uses_nothing_more'); c.eq(Math.round(again.appliedInr * 100), want, 'apply_twice_same_total'); }
    if (scen === 'restore') {
      await CR.restoreCreditUses(db, eid, now + 1000);
      const back = (await rows())[0];
      c.eq(Math.round(back.remaining_inr * 100), amt, 'cancel_puts_credit_back');
      c.eq(back.expires_ms, row.expires_ms, 'restore_never_stretches_365_days');
      c.eq(Math.round((await CR.creditAppliedFor(db, eid)) * 100), 0, 'nothing_applied_after_restore');
    }
    if (scen === 'restore_lapsed') {
      await CR.restoreCreditUses(db, eid, row.expires_ms + r.int(0, 10 * DAY));
      const back = (await rows())[0];
      c.eq(Math.round(back.remaining_inr * 100), amt - want, 'lapsed_credit_does_not_come_back_usable');
      c.eq(Math.round(back.lapsed_inr * 100), want, 'restored_after_lapse_counts_as_lapsed');
    }
  } else if (scen === 'two_oldest') {
    const a1 = r.int(100, pricePaise - 100), a2 = r.int(pricePaise - a1 + 1, pricePaise * 2);
    const older = await mk(`pay_${tag}_old`, a1, paidAt(r.int(200, 360)));
    const newer = await mk(`pay_${tag}_new`, a2, paidAt(r.int(1, 150)));
    res = await apply();
    c.eq(Math.round(res.appliedInr * 100), pricePaise, 'two_credits_cover_price');
    const rs2 = await rows(), o = rs2.find((x) => x.id === older.id), nw = rs2.find((x) => x.id === newer.id);
    c.eq(Math.round(o.remaining_inr * 100), 0, 'oldest_expiring_used_first');
    c.eq(Math.round(nw.remaining_inr * 100), a2 - (pricePaise - a1), 'newer_credit_pays_only_the_rest');
  } else if (scen === 'expired_old' || scen === 'at_expiry' || scen === 'before_expiry') {
    const amt = r.int(100, pricePaise * 2);
    let paid = paidAt(scen === 'expired_old' ? r.int(367, 700) : 200);
    const row = await mk(`pay_${tag}_e`, amt, paid);
    const t = scen === 'expired_old' ? now : scen === 'at_expiry' ? row.expires_ms : row.expires_ms - 1;
    res = await apply(t);
    want = scen === 'before_expiry' ? Math.min(amt, pricePaise) : 0;
    c.eq(Math.round(res.appliedInr * 100), want, 'expired_credit_unusable_valid_until_last_ms', `${scen} t-exp=${t - row.expires_ms}`);
    if (scen === 'expired_old') c.eq(row.status, 'expired', 'credit_from_old_payment_is_born_lapsed');
  } else if (scen === 'cancelled_game') {
    await mk(`pay_${tag}_c`, r.int(100, pricePaise * 2), paidAt(10));
    res = await apply();
    c.eq(Math.round(res.appliedInr * 100), 0, 'no_credit_on_a_cancelled_game');
  } else if (scen === 'dup_payment') {
    const amt = r.int(100, pricePaise * 2), paid = paidAt(10);
    const a = await mk(`pay_${tag}_d`, amt, paid);
    const b = await CR.creditFromPayment(db, { id: `pay_${tag}_d`, amount: amt / 100, currency: cur, paid_ms: paid }, org, null, now + 5000, 'late');
    c.eq(b?.id, a?.id, 'one_credit_per_payment');
    c.eq((await rows()).length, 1, 'no_second_credit_row');
    c.eq(await totalPaise(), amt, 'credit_total_not_doubled');
  } else if (scen === 'other_org' || scen === 'other_currency') {
    await mk(`pay_${tag}_x`, r.int(100, pricePaise * 2), paidAt(10), scen === 'other_org' ? `${org}b` : org, scen === 'other_currency' ? (cur === 'INR' ? 'USD' : 'INR') : cur);
    res = await apply();
    c.eq(Math.round(res.appliedInr * 100), 0, scen === 'other_org' ? 'credit_isolated_between_organizations' : 'credit_only_in_its_own_currency');
  }
  await invariants();
  c.ok(/365 days/.test(CR.NO_REFUND_LINE) && /credit/.test(CR.NO_REFUND_LINE) && !/refund (is|will be) (given|made|paid)/i.test(CR.NO_REFUND_LINE), 'no_refund_wording');
}

// ---------------------------------------------------------------- billing
function billCase(c, r, parts) {
  const [, what, v] = parts;
  if (what === 'fy') {
    const y = r.int(2025, 2035);
    const apr1 = Date.UTC(y, 3, 1) - IST; // 00:00 IST on 1 April
    const t = v === 'apr1_edge' ? apr1 + r.pick([-1, 0]) : v === 'mar31' ? apr1 - r.int(1, DAY) : Date.UTC(y, r.int(4, 11), r.int(1, 28), r.int(0, 23));
    const [iy, im] = istParts(t), start = im >= 3 ? iy : iy - 1;
    c.eq(BI.financialYear(new Date(t)), `${start}-${String((start + 1) % 100).padStart(2, '0')}`, 'financial_year_turns_at_1_april_ist', new Date(t).toISOString());
    const seq = r.int(1, 999_999), num = BI.formatInvoiceNumber(BI.BRANDS.corporate_tambola, `${start}-${String((start + 1) % 100).padStart(2, '0')}`, seq);
    c.ok(new RegExp(`^CT/${start}-\\d{2}/${String(seq).padStart(6, '0')}$`).test(num), 'invoice_number_brand_year_series', num);
  } else if (what === 'sig') {
    const secret = Array.from({ length: 32 }, () => r.int(0, 15).toString(16)).join('');
    const order = `order_${r.int(1e6, 9e6)}`, pay = `pay_${r.int(1e6, 9e6)}`;
    const good = createHmac('sha256', secret).update(`${order}|${pay}`).digest('hex');
    if (v === 'valid') c.eq(BI.verifyPaymentSignature(secret, order, pay, good), true, 'checkout_signature_accepted');
    if (v === 'tampered') { const i = r.int(0, 63), bad = good.slice(0, i) + (good[i] === 'a' ? 'b' : 'a') + good.slice(i + 1); c.eq(BI.verifyPaymentSignature(secret, order, pay, bad), false, 'tampered_signature_refused'); }
    if (v === 'wrong_secret') c.eq(BI.verifyPaymentSignature(secret + '0', order, pay, good), false, 'wrong_secret_refused');
    if (v === 'empty') { c.eq(BI.verifyPaymentSignature(secret, order, pay, ''), false, 'empty_signature_refused'); c.eq(BI.verifyPaymentSignature(secret, order, pay, undefined), false, 'missing_signature_refused'); }
    const body = JSON.stringify({ event: 'payment.captured', n: r.int(0, 1e9) }), hook = createHmac('sha256', secret).update(body).digest('hex');
    c.eq(BI.verifyWebhookSignature(secret, body, hook), true, 'webhook_signature_accepted');
    c.eq(BI.verifyWebhookSignature(secret, body + ' ', hook), false, 'webhook_body_change_refused');
  } else if (what === 'minor') {
    for (let i = 0; i < 20; i++) { const x = r.int(0, 2_000_000_000); c.eq(BI.toMinor(x / 100), x, 'to_minor_exact_no_float_drift', x); }
    for (const g of GOLDEN) c.eq(BI.toMinor(PR.price(g[0], v).total), (v === 'INR' ? g[1] : g[2]) * 100, 'pack_price_minor_exact');
  } else if (what === 'gst_off') {
    const amt = r.int(100, 5_000_000) / 100, s = BI.splitGst(amt, v, '07', '07ABCDE1234F1Z5');
    c.ok(s.mode === 'none' && s.total === amt && s.taxable === amt && s.cgst + s.sgst + s.igst === 0, 'gst_off_price_is_whole_amount', s);
    c.eq(BI.companyGaps(BI.DEFAULT_COMPANY).length, 0, 'no_gst_details_needed_when_off');
  } else if (what === 'invoice') {
    const g = r.pick(GOLDEN), minor = (v === 'INR' ? g[1] : g[2]) * 100 - r.pick([0, 0, r.int(1, 99)]), amt = minor / 100;
    const inv = { number: 'CT/2026-27/000001', issuedAt: Date.UTC(2026, 10, 1), brand: BI.BRANDS.corporate_tambola, company: BI.DEFAULT_COMPANY, draft: false, buyer: { name: 'Smoke Buyer' }, currency: v,
      lines: [{ description: `Corporate Tambola, up to ${g[0]} participants`, quantity: 1, amount: amt }], tax: BI.splitGst(amt, v, '', undefined) };
    const txt = BI.renderInvoiceText(inv), html = BI.renderInvoiceHtml(inv);
    c.ok(txt.includes(`TOTAL: ${money2(minor, v)}`), 'invoice_total_exact_2_decimals_right_symbol', money2(minor, v));
    c.ok(txt.split('\n')[0] === 'INVOICE' && !/TAX INVOICE|CGST|SGST|IGST/.test(txt), 'invoice_has_no_tax_lines_when_gst_off');
    c.ok(!/TAX INVOICE|CGST|SGST|IGST/.test(html), 'invoice_html_no_tax_lines_when_gst_off');
    c.ok(BI.INVOICE_TERMS.some((x) => /credit/.test(x) && /365 days/.test(x)) && !BI.INVOICE_TERMS.some((x) => /we (will )?refund/i.test(x)), 'terms_say_credit_not_refund');
  }
}

// ---------------------------------------------------------------- wording
function wordCase(c, r, parts) {
  const [, what, a, b] = parts;
  if (what === 'ordinal') {
    const k = +b, isAB = a === 'AB', pattern = isAB ? 'full' : a, base = isAB ? 'Full Two-Ticket House' : NAME[pattern];
    const of = k === 1 ? r.pick([1, 3]) : 30;
    c.eq(TK.rewardName(pattern, isAB ? 'two_ticket' : 'ticket', k, of), of > 1 ? `${ordEn(k)} ${base}` : base, 'reward_name_plain_english_ordinal', `${k} of ${of}`);
    if (!isAB) {
      const rewards = Array.from({ length: of }, (_, i) => ({ pattern, scope: 'ticket', ordinal: i + 1, text: '' }));
      const st = PS.prizeStatus({ ...CF.defaultCfg(), rewards }, []).find((x) => x.ordinal === k);
      c.eq(st?.name, of > 1 ? `${ordEn(k)} ${NAME[pattern]}` : NAME[pattern], 'prize_list_name_plain_english_ordinal');
    }
  } else if (what === 'lost') {
    const name = NAME[r.pick(ENGINE_PATTERNS)], w = r.int(0, 80);
    if (a === 'none') { const [l1, l2] = CT.lostClaimLines(name, [], -1); c.ok(l1.startsWith(name) && /too late/.test(l2), 'lost_text_without_results', [l1, l2]); return; }
    const mine = a === 'later' ? w + r.int(1, 8) : a === 'same' ? w : a === 'earlier' ? w - r.int(1, Math.max(1, w)) : w + 2;
    const wins = a === 'two' ? [{ idx: w + 3, tickets: [9] }, { idx: w, tickets: [4, 5] }] : [{ idx: w, tickets: [4] }];
    const [l1, l2] = CT.lostClaimLines(name, wins, Math.max(-1, mine));
    c.ok(l1.includes(`at number ${w + 1}.`), 'lost_text_first_winner_number_from_1', l1);
    if (a === 'two') c.ok(l1.startsWith('Tickets 4 and 5 won') && l1.includes(`at number ${w + 4}.`), 'lost_text_both_positions_in_order', l1);
    if (mine > w) c.ok(l2.includes(`at number ${mine + 1}.`) && /later/.test(l2), 'lost_text_later', l2);
    if (mine === w) c.ok(l2.includes(`same number, ${w + 1}.`), 'lost_text_same_number', l2);
    if (mine >= 0 && mine < w) c.ok(l2.includes(`at number ${mine + 1},`) && l2.includes(`after number ${mine + 2}`), 'lost_text_too_late', l2);
  } else if (what === 'rule') {
    const t = CF.claimRuleText(a === 'unknown' ? null : a);
    c.ok(t.includes('before the next number is called'), 'rule_text_claim_before_next_number', t);
    if (a === 'share') c.ok(/together/.test(t), 'share_rule_text_says_together');
    if (a === 'next') c.ok(/one after the other/.test(t), 'next_rule_text_says_one_after_other');
    c.ok(CF.CLAIM_RULE_TEXT.includes('before the next number is called'), 'claim_rule_text');
    for (const h of CF.PRIZE_HOUSES) if (NAME[h.id]) c.eq(h.label, NAME[h.id], 'house_label_matches_docs', h.id);
  }
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
    if (parts[0] === 'ticket') ticketCase(c, r, parts, tag);
    else if (parts[0] === 'claim') claimCase(c, r, parts, tag);
    else if (parts[0] === 'game') gameCase(c, r, parts, tag);
    else if (parts[0] === 'beacon') beaconCase(c, r, parts, tag);
    else if (parts[0] === 'price') priceCase(c, r, parts);
    else if (parts[0] === 'credit') await creditCase(c, r, parts, tag);
    else if (parts[0] === 'bill') billCase(c, r, parts);
    else if (parts[0] === 'word') wordCase(c, r, parts);
  } catch (err) {
    c.ok(false, 'no_exception', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '));
  }
  return { cell, c };
}
