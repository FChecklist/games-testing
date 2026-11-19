// Corporate Bingo smoke suite: seeded, deterministic, in-process (no server, no network, no bun). Same harness contract as suites/tambola.js and tambola2.js
// (exports CELLS, newWorld, runCase(w, idx, seed) -> {cell, c}; Case ok/eq/note; rng(seed, idx)). The product is the TypeScript source of the bingo clone, loaded by lib/tsresolve.js.
//   BINGO_DIR (env) points at another copy of the repo (used for the mutant copies in evidence/bingo.mutation.md); default <ROOT>/sc/corporate-bingo.
//
// What this game HAS (docs/BINGO_GAME.md, packages/beacon/src/{config,game,prize-engine,index}.ts, packages/shared/src/{bingo-card,pricing}.ts, apps/edge/src/credit.ts):
//   card    75-ball card, unique cards per seat, FREE centre, cards of one round never alike, rounds have their own cards
//   calls   the call order (pickNumber permutation), the call schedule with brand breaks, pauses and a stop
//   settle  per-house winners: ONE winner per prize line, ties decided by fate, no double payout; whole-log settleAll == incremental PrizeEngine == independent oracle
//   round   rounds 1..5 (own ids, own cards, own prizes), intermission-free settlement per round
//   tie     assignOrdinals (fate order, same-call groups)
//   late    late joiners: only numbers called at/after countFrom (join round + 30) count
//   claim   claim cross-check (checkClaims)
//   over    game over: every prize line awarded, or 75 numbers, or the organizer's stop (settlement is prefix-stable)
//   rank    ranking of winners (prize value, call number, fate) and its exact wording
//   lucky   lucky draws in a break (phone side, public hash), "draw" or "scratch" style, lround = the beacon round that decides it
//   vote    result quorum / voters (the phones' vote on the result)
//   cfg     validateCfg rules and their exact error wording
//   wording prize names, how-to-win texts, call labels, tie note, defaults, no-refund line, money format
//   price   price ladder (INR/USD), no tax, billing split and minor units
//   credit  credit ledger (apps/edge/src/credit.ts) on a real SQL engine (node:sqlite as D1): apply/restore/expiry/idempotence, money never negative
//   expiry  credit expiry date arithmetic (day 365 in India time)
// What this game does NOT have (so no cell): Unlucky/consolation prize, booster items (Joker/extra ticket), a separate scratch-card game (scratch is only a lucky-draw
// *style*), a per-ticket prize scope (scope is always "ticket"), a game-over *vote* by players (only the result quorum above), prize money handled by the product
// ("the product never holds or pays prize money"), a late-joiner-only draw. Parts that need a browser/network (PhoneRuntime, drand fetch, edge HTTP/worker routes,
// emails) are NOT covered here.
import '../lib/tsresolve.js';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { ROOT } from '../lib/roots.js';

const BINGO = process.env.BINGO_DIR ?? [resolve(ROOT, 'sc/corporate-bingo'), resolve(ROOT, 'corporate-bingo')].find(existsSync);
if (!BINGO) throw new Error('corporate-bingo clone not found (set BINGO_DIR)');
const R = (p) => import(pathToFileURL(resolve(BINGO, p)).href);
const CF = await R('packages/beacon/src/config.ts');
const GM = await R('packages/beacon/src/game.ts');
const PE = await R('packages/beacon/src/prize-engine.ts');
const BX = await R('packages/beacon/src/index.ts');
const SH = await R('packages/shared/src/index.ts');
const BL = await R('packages/billing/src/index.ts');
const CR = await R('apps/edge/src/credit.ts');

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const HOUSES = ['line', 'twolines', 'corners', 'plus', 'x', 'frame', 'stamp', 'letterL', 'letterT', 'blackout'];
// the most winners per house, copied from the table in docs/BINGO_GAME.md
const MAXW = { line: 3, twolines: 2, corners: 3, plus: 2, x: 2, frame: 2, stamp: 3, letterL: 2, letterT: 2, blackout: 2 };
const PACKS = [[100, 2399, 34], [250, 3499, 51], [500, 4699, 67], [750, 5899, 84], [1000, 7099, 101], [2500, 11799, 169], [5000, 17699, 253], [10000, 29499, 421]];

// ================================================================ cells
export const CELLS = [
  ...cross(['card'], ['seat', 'plain'], ['1', '2'], ['1', '2', '3', '4', '5']),
  ...cross(['calls'], ['6', '9', '12', '15'], ['0', '1', '3'], ['none', 'pause', 'stop']),
  ...cross(['settle'], HOUSES, ['1', '2'], ['one', 'max'], ['few', 'dense']),
  ...cross(['round'], ['1', '2', '3', '4', '5'], ['1', '2'], ['default', 'all', 'random']),
  ...cross(['tie'], ['2', '3', '10'], ['same_call', 'later_call'], ['line', 'corners', 'blackout']),
  ...cross(['late'], HOUSES, ['none', 'before_start', 'mid', 'boundary_in', 'boundary_out', 'after_end']),
  ...cross(['claim'], HOUSES, ['valid', 'wrong_idx', 'early_idx', 'never_completed', 'bad_round']),
  ...cross(['over'], ['prizes', 'all75', 'stop'], ['1', '2']),
  ...cross(['rank'], ['2', '5', '12'], ['plain', 'tied']),
  ...cross(['lucky'], ['1', '3', '5', '10'], ['1', '3', '10', '50', '200'], ['draw', 'scratch'], ['plain', 'dups']),
  ...cross(['lround'], ['1', '2', '3'], ['none', 'pause']),
  ...cross(['lcfg'], ['1', '3', '5', '10', '2', '0', '11'], ['draw', 'scratch', 'other', 'none']),
  ...cross(['cfg'], ['rounds', 'tickets', 'rewards_max', 'rewards_gap', 'rewards_dup', 'rewards_unknown', 'rewards_empty', 'breaks_limit', 'break_same_after', 'break_seconds', 'text_clean', 'omitted_keeps', 'proposed_breaks']),
  ...cross(['vote'], ['1', '2', '3', '6', '7', '12', '13', '61', '500', '5000'], ['a', 'b']),
  ...cross(['wording'], ['houses', 'help', 'patterns', 'names', 'calls', 'tie_note', 'defaults', 'schedule_text', 'no_refund', 'money_format']),
  ...cross(['price'], PACKS.map((p) => String(p[0])), ['INR', 'USD']),
  ...cross(['credit'], ['exact', 'partial', 'surplus', 'double', 'order', 'restore', 'expiry', 'isolation', 'arrival_after_expiry'], ['a', 'b']),
  ...cross(['expiry'], ['a', 'b', 'c', 'd']),
].map((c) => c.join('|'));
export async function newWorld() { return {}; }

// ================================================================ helpers
const shuffle = (r, a) => { for (let i = a.length - 1; i > 0; i--) { const j = r.int(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function mkPids(r, tag, n, mode) {
  const seats = new Set(); while (seats.size < n) seats.add(r.int(1, 9000));
  return [...seats].map((s, i) => { const h = sha(`${tag}|${s}|${i}`).slice(0, 12); return mode === 'seat' || (mode === 'mixed' && i % 2 === 0) ? `${s}x${h}` : `g${h}`; });
}
// the card, written from the rules in docs/BINGO_GAME.md (5 x 5, FREE centre, columns 1-15 / 16-30 / ..., no repeats)
function validCard(t) {
  if (!Array.isArray(t) || t.length !== 5 || t.some((x) => !Array.isArray(x) || x.length !== 5)) return false;
  if (t[2][2] !== null) return false;
  const seen = new Set();
  for (let c = 0; c < 5; c++) for (let rr = 0; rr < 5; rr++) {
    if (rr === 2 && c === 2) continue;
    const v = t[rr][c];
    if (!Number.isInteger(v) || v < c * 15 + 1 || v > c * 15 + 15 || seen.has(v)) return false;
    seen.add(v);
  }
  return seen.size === 24;
}
// the prize shapes, written from the table in docs/BINGO_GAME.md (row, column); every shape is a list of "sets", `need` of them must be marked
const rowS = (rr) => [0, 1, 2, 3, 4].map((c) => [rr, c]), colS = (c) => [0, 1, 2, 3, 4].map((rr) => [rr, c]);
const D1 = [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]], D2 = [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]];
const LINES12 = [0, 1, 2, 3, 4].map(rowS).concat([0, 1, 2, 3, 4].map(colS), [D1, D2]);
const block = (a, b) => [[a, b], [a, b + 1], [a + 1, b], [a + 1, b + 1]];
const SHAPES = {
  line: { sets: LINES12, need: 1 }, twolines: { sets: LINES12, need: 2 },
  corners: { sets: [[[0, 0], [0, 4], [4, 0], [4, 4]]], need: 1 },
  plus: { sets: [[...rowS(2), ...colS(2)]], need: 1 }, x: { sets: [[...D1, ...D2]], need: 1 },
  frame: { sets: [[...rowS(0), ...rowS(4), ...colS(0), ...colS(4)]], need: 1 },
  stamp: { sets: [block(0, 0), block(0, 3), block(3, 0), block(3, 3)], need: 1 },
  letterL: { sets: [[...colS(0), ...rowS(4)]], need: 1 }, letterT: { sets: [[...rowS(0), ...colS(2)]], need: 1 },
  blackout: { sets: [[0, 1, 2, 3, 4].flatMap(rowS)], need: 1 },
};
/** First index of `log` at which the card completes the house, or -1. A 0 in the log is a hidden number. */
function cardDone(card, house, log) {
  const sh = SHAPES[house], at = new Map();
  log.forEach((n, i) => { if (n > 0 && !at.has(n)) at.set(n, i); });
  const done = [];
  for (const set of sh.sets) {
    let last = -1, ok = true;
    for (const [rr, c] of set) { const v = card[rr][c]; if (v === null) continue; const i = at.get(v); if (i === undefined) { ok = false; break; } if (i > last) last = i; }
    if (ok) done.push(last);
  }
  if (done.length < sh.need) return -1;
  return done.sort((a, b) => a - b)[sh.need - 1];
}
const bestDone = (cards, house, log) => { const x = cards.map((t) => cardDone(t, house, log)).filter((i) => i >= 0); return x.length ? Math.min(...x) : -1; };
const seatOf = (pid) => { const m = /^(\d{1,7})x[0-9a-f]{8,}$/.exec(pid); const s = m ? Number(m[1]) : 0; return s >= 1 ? String(s) : pid; };
const fate = (eidR, pid, house, k) => sha(`CB1-TIE|${eidR}|${seatOf(pid)}|tie|${house}|${k}`); // docs/BINGO_GAME.md "No ties"
/** The "no ties" rule: earliest call first; one winner per ordinal; on the same call the lowest fate takes the next open ordinal. groups: Map(call index -> pids). */
function oracleAssign(eidR, house, groups, ordinals) {
  const out = []; let o = 0; const ord = [...ordinals].sort((a, b) => a - b);
  for (const idx of [...groups.keys()].sort((a, b) => a - b)) {
    const pids = groups.get(idx), left = [...pids];
    while (left.length && o < ord.length) {
      const k = ord[o]; left.sort((a, b) => { const fa = fate(eidR, a, house, k), fb = fate(eidR, b, house, k); return fa < fb ? -1 : fa > fb ? 1 : a < b ? -1 : 1; });
      out.push({ pattern: house, ordinal: k, idx, pid: left.shift(), tied: pids.length > 1 ? pids.length : 0 }); o++;
    }
    if (o >= ord.length) break;
  }
  return out;
}
function rewardsFor(r, houses, mode) {
  const rw = [];
  for (const h of houses) { const m = mode === 'one' ? 1 : mode === 'max' ? MAXW[h] : r.int(1, MAXW[h]); for (let k = 1; k <= m; k++) rw.push({ pattern: h, scope: 'ticket', ordinal: k, text: r.pick(['', 'Gift voucher', 'Trophy', 'Coffee mug']) }); }
  return rw;
}
function fixture(r, tag, o) {
  const eid = `E${tag}`, round = o.round ?? 1, eidR = CF.roundEid(eid, round), tickets = o.tickets ?? 1;
  const pids = mkPids(r, tag, o.players, o.seatMode ?? 'mixed');
  const rand = Array.from({ length: 75 }, (_, k) => sha(`${tag}|rand|${round}|${k}`));
  const log = BX.deriveCalls(eidR, rand);
  const cfg = { ...CF.defaultCfg(), tickets, rewards: o.rewards, rounds: Math.max(round, o.rounds ?? 1) };
  const cards = new Map(pids.map((p) => [p, GM.ticketsFor(eidR, p, tickets)]));
  const stride = o.stride ?? r.pick([2, 3, 4, 5]), R0 = r.int(1e6, 2e7);
  return { eid, round, eidR, pids, log, cfg, cards, stride, R0, callRounds: log.map((_, k) => R0 + k * stride), tickets };
}
/** Independent settlement of a fixture. maskOf(pid) = the log that counts for that person (late joiners). */
function oracleSettle(fx, maskOf = () => fx.log, log = fx.log) {
  const out = [];
  for (const house of CF.keysInPlay(fx.cfg.rewards)) {
    const groups = new Map();
    for (const pid of fx.pids) { const i = bestDone(fx.cards.get(pid), house, maskOf(pid).slice(0, log.length)); if (i >= 0) groups.set(i, [...(groups.get(i) ?? []), pid]); }
    out.push(...oracleAssign(fx.eidR, house, groups, fx.cfg.rewards.filter((l) => l.pattern === house).map((l) => l.ordinal)));
  }
  return out;
}
const lineId = (x) => `${x.pattern}#${x.ordinal}`;
function compareSettle(c, fx, want, got, label, extra = {}) {
  c.eq(got.length, want.length, 'prize_lines_awarded_count', label);
  const g = new Map(got.map((x) => [lineId(x), x]));
  c.eq(g.size, got.length, 'no_prize_line_awarded_twice', label);
  for (const w of want) {
    const x = g.get(lineId(w));
    if (!c.ok(!!x, 'prize_line_awarded_when_somebody_completed_it', `${lineId(w)} ${label}`)) continue;
    c.eq(x.pids.length, 1, 'exactly_one_winner_per_prize_line', `${lineId(w)} ${label}`);
    c.eq(x.pids[0], w.pid, 'winner_is_the_earliest_call_then_fate_order', `${lineId(w)} ${label}`);
    c.eq(x.idx, w.idx, 'winning_call_index_is_the_completion_call', `${lineId(w)} ${label}`);
    c.eq(x.tied ?? 0, w.tied, 'same_call_tie_count_reported', `${lineId(w)} ${label}`);
    c.eq(x.round, extra.round ?? fx.round, 'result_is_stamped_with_its_round', label);
  }
  // structure that must hold whatever the oracle says
  const byHouse = new Map();
  for (const x of got) byHouse.set(x.pattern, [...(byHouse.get(x.pattern) ?? []), x]);
  const lines = new Set(fx.cfg.rewards.map(lineId));
  for (const x of got) c.ok(lines.has(lineId(x)), 'only_configured_prize_lines_are_awarded', lineId(x));
  for (const [h, xs] of byHouse) {
    c.eq(new Set(xs.map((x) => x.pids[0])).size, xs.length, 'no_double_payout_one_person_wins_a_house_once', `${h} ${label}`);
    const s = [...xs].sort((a, b) => a.ordinal - b.ordinal);
    c.ok(s.every((x, i) => x.ordinal === s[0].ordinal + i), 'ordinals_are_awarded_in_order_without_gaps', h);
    c.ok(s.every((x, i) => i === 0 || x.idx >= s[i - 1].idx), 'a_later_prize_line_never_wins_on_an_earlier_call', h);
    c.ok(xs.every((x) => bestDone(fx.cards.get(x.pids[0]), h, fx.log) >= 0), 'a_winner_really_completed_the_house', h);
  }
  const completers = new Map(); for (const h of CF.keysInPlay(fx.cfg.rewards)) completers.set(h, fx.pids.filter((p) => bestDone(fx.cards.get(p), h, (extra.maskOf ?? (() => fx.log))(p)) >= 0).length);
  for (const h of CF.keysInPlay(fx.cfg.rewards)) c.eq((byHouse.get(h) ?? []).length, Math.min(completers.get(h), fx.cfg.rewards.filter((l) => l.pattern === h).length), 'every_line_is_filled_while_there_are_completers', `${h} ${label}`);
}
const norm = (xs) => xs.map((x) => `${lineId(x)}:${x.idx}:${x.pids.join(',')}:${x.tied ?? 0}`).sort().join(';');
/** the incremental engine every phone runs */
function runEngine(fx, seatsIn, calls = fx.log, callRounds = fx.callRounds, addLateAt = -1) {
  const e = new PE.PrizeEngine(fx.eid, fx.cfg, fx.round);
  const first = addLateAt < 0 ? seatsIn : seatsIn.slice(0, Math.ceil(seatsIn.length / 2));
  e.addSeats(first); e.work(1e12);
  calls.forEach((n, k) => { if (k === addLateAt) { e.addSeats(seatsIn.slice(first.length)); e.work(1e12); } e.feed(n, callRounds[k]); });
  if (addLateAt >= calls.length) { e.addSeats(seatsIn.slice(first.length)); e.work(1e12); }
  return e.results();
}

// ================================================================ cards
function cardCase(c, r, parts, tag) {
  const [, mode, tkS, rdS] = parts, n = +tkS, round = +rdS, eid = `E${tag}`, eidR = CF.roundEid(eid, round);
  c.eq(eidR, round <= 1 ? eid : `${eid}~r${round}`, 'round_id_derivation_matches_the_docs');
  const pids = mkPids(r, tag, 24, mode), seen = new Set();
  for (const pid of pids) {
    const ts = GM.ticketsFor(eidR, pid, n);
    c.eq(ts.length, n, 'cards_per_player_matches_the_setting', pid);
    ts.forEach((t) => { c.ok(validCard(t), 'card_is_valid_5x5_with_free_centre', pid); c.ok(SH.isValidTicket(t), 'product_validity_check_accepts_its_own_cards'); const k = JSON.stringify(t); c.ok(!seen.has(k), 'no_two_cards_of_one_round_are_alike', pid); seen.add(k); });
    c.ok(sameJson(ts, GM.ticketsFor(eidR, pid, n)), 'same_card_on_every_device_for_the_same_player', pid);
    if (n === 2) c.ok(!sameJson(ts[0], ts[1]), 'second_card_differs_from_the_first', pid);
    const other = CF.roundEid(eid, (round % 5) + 1);
    c.ok(!sameJson(ts[0], GM.ticketsFor(other, pid, 1)[0]), 'each_round_has_its_own_cards', pid);
    c.eq(JSON.stringify(GM.ticketsFor(eidR, pid, 1)[0]), JSON.stringify(ts[0]), 'first_card_is_the_same_whether_one_or_two_cards_are_dealt', pid);
  }
  const t0 = GM.ticketFor(eidR, pids[0]);
  for (const v of SH.ticketNumbers(t0)) { const cell = SH.cellOfNumber(t0, v); c.ok(cell >= 0 && t0[Math.floor(cell / 5)][cell % 5] === v, 'cell_of_number_finds_the_number'); }
  c.eq(SH.cellOfNumber(t0, 76), -1, 'cell_of_number_outside_1_75');
}

// ================================================================ calls and schedule
function callsCase(c, r, parts, tag) {
  const [, secS, nbS, pause] = parts, secs = +secS, stride = secs / 3, nb = +nbS, eid = `E${tag}`;
  const rand = Array.from({ length: 75 }, (_, k) => sha(`${tag}|rand|${k}`)), log = BX.deriveCalls(eid, rand);
  c.eq(log.length, 75, 'a_game_has_75_calls');
  c.eq(new Set(log).size, 75, 'every_number_is_called_exactly_once');
  c.ok(log.every((n) => Number.isInteger(n) && n >= 1 && n <= 75), 'calls_are_1_to_75');
  c.ok(sameJson(log, BX.deriveCalls(eid, rand)), 'same_public_data_same_calls');
  c.ok(!sameJson(log, BX.deriveCalls(eid + 'x', rand)), 'other_game_other_calls');
  let threw = ''; try { BX.pickNumber(eid, 75, rand[0], log); } catch (e) { threw = e.message; }
  c.eq(threw, 'All 75 numbers have been called.', 'a_76th_call_is_refused_with_the_exact_message');
  c.eq(BX.scheduleFor(100, secs).length, 75, 'schedule_has_75_calls');
  c.ok(BX.scheduleFor(100, secs).every((x, k) => x === 100 + k * stride), 'plain_schedule_steps_by_the_call_speed');
  for (const bad of [3, 4, 7, secs + 1]) { let m = ''; try { BX.scheduleFor(100, bad); } catch (e) { m = e.message; } c.eq(m, 'Call speed must be a multiple of 3 seconds, at least 6.', 'bad_call_speed_refused_with_exact_message', bad); }
  const breaks = [];
  const afters = shuffle(r, Array.from({ length: 70 }, (_, i) => i + 2)).slice(0, nb).sort((a, b) => a - b);
  for (const a of afters) breaks.push({ after: a, seconds: r.pick([15, 30, 60, 180]), kind: r.pick(['speech', 'lucky']), title: 'Break' });
  const start = r.int(1e6, 2e7);
  let st = null;
  if (pause === 'pause') { const a = start + r.int(5, 250), len = r.int(1, 400); st = { intervals: [{ start: a, end: a + len }], stopRound: null }; }
  if (pause === 'stop') st = { intervals: [], stopRound: start + r.int(2, 150) };
  const sched = GM.scheduleFull(st, start, stride, breaks, 75);
  c.eq(sched.length, 75, 'full_schedule_has_75_entries');
  let prev = null, seenNull = false;
  for (let k = 0; k < 75; k++) {
    const x = sched[k];
    if (x === null) { seenNull = true; c.ok(st?.stopRound != null && true, 'a_call_is_cancelled_only_by_a_stop'); continue; }
    c.ok(!seenNull, 'nothing_is_called_after_the_stop');
    c.ok(x >= start, 'no_call_before_the_start_round', k);
    if (st?.stopRound != null) c.ok(x < st.stopRound, 'no_call_at_or_after_the_stop_round', k);
    if (pause === 'pause') c.ok(!(x >= st.intervals[0].start && x < st.intervals[0].end), 'no_call_inside_a_pause', k);
    if (prev !== null) {
      const brk = breaks.filter((b) => b.after === k).reduce((s, b) => s + b.seconds / 3, 0);
      c.ok(x - prev >= stride, 'calls_are_never_closer_than_the_call_speed', k);
      const len = pause === 'pause' ? st.intervals[0].end - st.intervals[0].start : 0;
      c.ok(x - prev === stride + brk || (pause === 'pause' && x - prev === stride + brk + len), 'gap_is_the_speed_plus_a_break_plus_at_most_the_pause', `${k} gap=${x - prev}`);
      if (pause !== 'pause') c.eq(x - prev, stride + brk, 'plain_gap_is_exactly_the_call_speed_plus_breaks', k);
    }
    prev = x;
  }
  for (const b of breaks) {
    const before = GM.callRoundFull(st, start, stride, breaks, b.after - 1);
    if (before === null) continue;
    const ab = GM.activeBreak(st, start, stride, breaks, before + 1);
    c.ok(!!ab && ab.brk === b, 'the_break_shows_right_after_the_call_it_follows', b.after);
    c.eq(ab?.endsAtRound, before + 1 + b.seconds / 3, 'a_break_lasts_its_stated_seconds', b.after);
    c.ok(GM.activeBreak(st, start, stride, breaks, before) === null || GM.activeBreak(st, start, stride, breaks, before)?.brk !== b, 'no_break_before_its_call');
  }
  for (const k of [0, 1, 74]) if (sched[k] !== null) c.eq(GM.callRoundR(st, start, stride, breaks, 1, k), sched[k], 'round_1_schedule_is_the_full_schedule', k);
  const last1 = GM.callRoundR(null, start, stride, [], 1, 74), first2 = GM.callRoundR(null, start, stride, [], 2, 0);
  c.eq(first2 - last1, stride + CF.INTERMISSION_ROUNDS, 'intermission_between_rounds_is_stride_plus_90_seconds');
  const im = GM.activeIntermission(null, start, stride, [], 2, last1 + 1);
  c.eq(im?.endsAtRound, first2, 'intermission_ends_at_the_next_rounds_first_call');
  c.eq(GM.activeIntermission(null, start, stride, [], 2, first2), null, 'no_intermission_once_the_next_round_calls');
  c.eq(GM.activeIntermission(null, start, stride, [], 1, last1 + 1), null, 'no_intermission_before_round_1');
  c.eq(CF.GRACE_ROUNDS * 3, 120, 'first_call_is_two_minutes_after_the_start_time');
}

// ================================================================ settlement per house
function settleCase(c, r, parts, tag) {
  const [, house, tkS, lineMode, density] = parts;
  const fx = fixture(r, tag, { players: density === 'dense' ? r.int(30, 45) : r.int(2, 7), tickets: +tkS, rewards: rewardsFor(r, [house], lineMode) });
  settleChecks(c, r, fx, house);
}
function settleChecks(c, r, fx, label) {
  const want = oracleSettle(fx), got = GM.settleAll(fx.eid, fx.pids, fx.log, fx.cfg, fx.round);
  compareSettle(c, fx, want, got, label);
  c.ok(sameJson(got, GM.settleAll(fx.eid, fx.pids, fx.log, fx.cfg, fx.round)), 'replay_gives_the_same_result', label);
  c.eq(norm(GM.settleAll(fx.eid, shuffle(r, [...fx.pids]), fx.log, fx.cfg, fx.round)), norm(got), 'result_does_not_depend_on_the_order_of_the_guest_list', label);
  const seats = fx.pids.map((pid) => ({ pid, countFrom: 0 }));
  const eng = runEngine(fx, seats);
  c.eq(norm(eng), norm(got), 'every_phones_engine_equals_the_whole_log_settlement', label);
  c.eq(norm(runEngine(fx, shuffle(r, [...seats]))), norm(got), 'engine_does_not_depend_on_the_order_seats_arrive', label);
  c.eq(norm(runEngine(fx, seats, fx.log, fx.callRounds, r.int(1, 60))), norm(got), 'engine_with_seats_added_mid_game_equals_settlement', label);
  for (const x of eng) c.eq(x.round, fx.round, 'engine_result_is_stamped_with_its_round', label);
  for (const h of CF.keysInPlay(fx.cfg.rewards)) { const w = eng.filter((x) => x.pattern === h).map((x) => x.pids[0]); c.eq(new Set(w).size, w.length, 'engine_never_pays_one_person_twice_in_a_house', `${h} ${label}`); }
  // the settlement is the same when the earlier-id form of the round id is used
  if (fx.round > 1) c.eq(norm(GM.settleAll(fx.eidR, fx.pids, fx.log, fx.cfg, 1)), norm(got), 'round_id_composes_round_n_equals_derived_id_round_1', label);
  // still-to-win never negative and zero once complete
  const cut = r.int(0, 74), pid = r.pick(fx.pids);
  for (const h of CF.keysInPlay(fx.cfg.rewards)) {
    const left = GM.stillToWin(fx.cards.get(pid), h, fx.log.slice(0, cut)), done = bestDone(fx.cards.get(pid), h, fx.log.slice(0, cut)) >= 0;
    c.ok(left >= 0, 'still_to_win_is_never_negative', h);
    c.ok(done ? left === 0 : left > 0, 'still_to_win_is_zero_exactly_when_the_house_is_complete', `${h} cut=${cut}`);
  }
}

// ================================================================ rounds
function roundCase(c, r, parts, tag) {
  const [, rdS, tkS, setName] = parts, round = +rdS;
  const houses = setName === 'default' ? CF.PATTERN_ORDER : setName === 'all' ? HOUSES : shuffle(r, [...HOUSES]).slice(0, r.int(1, 5));
  const rewards = setName === 'default' ? CF.defaultRewards() : rewardsFor(r, houses, setName === 'all' ? 'max' : 'rand');
  const fx = fixture(r, tag, { players: r.int(8, 18), tickets: +tkS, round, rounds: 5, rewards });
  settleChecks(c, r, fx, `round ${round}`);
  if (round > 1) c.ok(!sameJson(fixture(r, tag, { players: 2, tickets: 1, round: 1, rewards }).log, fx.log), 'rounds_are_separate_games_with_their_own_numbers');
  // a later round never reuses the first round's cards
  if (round > 1) { const p = fx.pids[0]; c.ok(!sameJson(GM.ticketsFor(fx.eid, p, 1)[0], GM.ticketsFor(fx.eidR, p, 1)[0]), 'round_n_cards_differ_from_round_1_cards'); }
}

// ================================================================ ties (fate)
function tieCase(c, r, parts, tag) {
  const [, nS, kind, house] = parts, n = +nS, eidR = `E${tag}`, ords = Array.from({ length: MAXW[house] }, (_, i) => i + 1);
  const pids = mkPids(r, tag, n + 3, 'mixed'), groups = new Map();
  if (kind === 'same_call') { const i = r.int(0, 70); groups.set(i, pids.slice(0, n)); groups.set(i + r.int(1, 4), pids.slice(n)); }
  else pids.slice(0, n).forEach((p, j) => groups.set(r.int(0, 20) + j * 5, [p]));
  const g = [...groups.entries()], want = oracleAssign(eidR, house, groups, ords);
  const got = GM.assignOrdinals(eidR, house, shuffle(r, g.map(([i, ps]) => [i, shuffle(r, [...ps])])), ords, 1);
  c.eq(got.length, want.length, 'a_prize_line_is_awarded_for_each_open_ordinal');
  want.forEach((w, i) => {
    const x = got.find((y) => y.ordinal === w.ordinal);
    if (!c.ok(!!x, 'ordinal_awarded', w.ordinal)) return;
    c.eq(x.pids.length, 1, 'exactly_one_winner_per_prize_line');
    c.eq(x.pids[0], w.pid, 'same_call_tie_is_decided_by_the_lowest_fate_number');
    c.eq(x.idx, w.idx, 'earlier_call_always_beats_a_later_one');
    c.eq(x.tied ?? 0, w.tied, 'tie_size_is_reported');
  });
  c.eq(new Set(got.map((x) => x.pids[0])).size, got.length, 'no_double_payout_in_a_tie');
  c.eq(GM.fateOf(eidR, pids[0], house, 1), fate(eidR, pids[0], house, 1), 'fate_number_is_the_documented_hash');
  c.ok(GM.fateOf(eidR, pids[0], house, 1) !== GM.fateOf(eidR, pids[0], house, 2), 'fate_differs_per_ordinal');
}

// ================================================================ late joiners
function lateCase(c, r, parts, tag) {
  const [, house, lag] = parts;
  c.eq(CF.LATE_LAG_ROUNDS, 30, 'late_joiner_lag_is_90_seconds');
  c.eq(PE.countFromOf(0), 0, 'joined_in_time_everything_counts'); c.eq(PE.countFromOf(undefined), 0, 'no_join_round_everything_counts'); c.eq(PE.countFromOf(null), 0, 'null_join_round_everything_counts'); c.eq(PE.countFromOf(1000), 1030, 'count_from_is_join_round_plus_30');
  const fx = fixture(r, tag, { players: 8, tickets: r.int(1, 2), rewards: rewardsFor(r, [house], 'rand') });
  const late = fx.pids.filter((_, i) => i % 2 === 1), cf = new Map();
  const lastR = fx.callRounds[74];
  for (const p of late) {
    const j = r.int(1, 70);
    const v = lag === 'none' ? 0 : lag === 'before_start' ? fx.R0 - r.int(31, 400) : lag === 'mid' ? fx.callRounds[j] - r.int(0, 2) : lag === 'boundary_in' ? fx.callRounds[j] : lag === 'boundary_out' ? fx.callRounds[j] + 1 : lastR + r.int(1, 50);
    if (v > 0) cf.set(p, v);
  }
  const mask = (p) => { const f = cf.get(p) ?? 0; return fx.log.map((n, k) => (fx.callRounds[k] >= f ? n : 0)); };
  const want = oracleSettle(fx, mask), lateArg = { countFrom: cf, callRounds: fx.callRounds };
  const got = GM.settleAll(fx.eid, fx.pids, fx.log, fx.cfg, 1, lateArg);
  compareSettle(c, fx, want, got, `${house} ${lag}`, { maskOf: mask });
  const eng = runEngine(fx, fx.pids.map((pid) => ({ pid, countFrom: cf.get(pid) ?? 0 })));
  c.eq(norm(eng), norm(got), 'late_joiner_engine_equals_whole_log_settlement', `${house} ${lag}`);
  const eng2 = runEngine(fx, fx.pids.map((pid) => ({ pid, countFrom: cf.get(pid) ?? 0 })), fx.log, fx.callRounds, r.int(1, 70));
  c.eq(norm(eng2), norm(got), 'late_joiner_seat_built_mid_game_equals_settlement', `${house} ${lag}`);
  for (const x of got) { const p = x.pids[0], f = cf.get(p) ?? 0; c.ok(fx.callRounds[x.idx] >= f, 'nobody_wins_on_a_number_called_before_it_counted_for_them', `${p}`); }
  if (lag === 'after_end') c.ok(!got.some((x) => cf.has(x.pids[0])), 'joined_after_the_last_call_cannot_win');
  if (lag === 'none' || lag === 'before_start') c.eq(norm(got), norm(GM.settleAll(fx.eid, fx.pids, fx.log, fx.cfg, 1)), 'joining_in_time_changes_nothing', lag);
  // boundary: a late joiner whose only completing set starts exactly at count-from keeps the win (in) or loses it (out)
  if (lag.startsWith('boundary')) {
    const p = late[0], cards = fx.cards.get(p), full = bestDone(cards, house, fx.log);
    const solo = (f) => GM.settleAll(fx.eid, [p], fx.log, { ...fx.cfg, rewards: [{ pattern: house, scope: 'ticket', ordinal: 1, text: '' }] }, 1, { countFrom: new Map([[p, f]]), callRounds: fx.callRounds }).find((x) => x.ordinal === 1);
    const sets = cards.flatMap((t) => SHAPES[house].sets.map((s) => ({ t, s }))).map(({ t, s }) => ({ nums: s.map(([a, b]) => t[a][b]).filter((v) => v !== null) })).filter((x) => x.nums.length);
    const at = new Map(fx.log.map((n, k) => [n, k]));
    const hit = sets.map((x) => ({ last: Math.max(...x.nums.map((n) => at.get(n))), first: Math.min(...x.nums.map((n) => at.get(n))) })).filter((x) => x.last === full && SHAPES[house].need === 1);
    if (hit.length) {
      const e = hit[0].first;
      const inR = solo(fx.callRounds[e]);
      c.eq(inR ? inR.idx : -1, full, 'count_from_equal_to_a_calls_round_includes_that_call', house);
      const outR = solo(fx.callRounds[e] + 1);
      if (hit.length === 1 && SHAPES[house].sets.length === 1 && cards.length === 1) c.ok(!outR || outR.idx > full, 'count_from_one_round_after_a_call_excludes_it', house);
      else c.ok(!outR || outR.idx >= full, 'masking_a_call_never_makes_a_win_earlier', house);
    }
  }
}

// ================================================================ claims
function claimCase(c, r, parts, tag) {
  const [, house, fault] = parts;
  const fx = fixture(r, tag, { players: 5, tickets: r.int(1, 2), rewards: rewardsFor(r, [house], 'one'), rounds: 2 });
  const L = fault === 'never_completed' ? r.int(8, 30) : 75, log = fx.log.slice(0, L);
  const done = new Map(fx.pids.map((p) => [p, bestDone(fx.cards.get(p), house, log)]));
  const good = [], bad = [];
  for (const p of fx.pids) {
    const i = done.get(p);
    if (fault === 'valid') { if (i >= 0) good.push({ pid: p, pattern: house, idx: i, round: 1 }); }
    else if (fault === 'wrong_idx') { if (i >= 0) bad.push({ pid: p, pattern: house, idx: i + 1, round: 1 }); }
    else if (fault === 'early_idx') { if (i > 0) bad.push({ pid: p, pattern: house, idx: i - 1, round: 1 }); else if (i === 0) bad.push({ pid: p, pattern: house, idx: 1, round: 1 }); }
    else if (fault === 'never_completed') { if (i < 0) bad.push({ pid: p, pattern: house, idx: -1, round: 1 }, { pid: p, pattern: house, idx: L - 1, round: 1 }); else good.push({ pid: p, pattern: house, idx: i, round: 1 }); }
    else if (fault === 'bad_round') { if (i >= 0) { bad.push({ pid: p, pattern: house, idx: i, round: 0 }, { pid: p, pattern: house, idx: i, round: 3 }, { pid: p, pattern: house, idx: i, round: 2 }); good.push({ pid: p, pattern: house, idx: i, round: 1 }); } }
  }
  const res = GM.checkClaims(fx.eid, [...good, ...bad], fault === 'bad_round' ? { 1: log } : log, fx.cfg);
  const key = (x) => `${x.pid}|${x.idx}|${x.round}`;
  const gs = new Set(res.good.map(key)), bs = new Set(res.bad.map(key));
  for (const x of good) c.ok(gs.has(key(x)), 'a_true_claim_is_accepted', fault);
  for (const x of bad) c.ok(bs.has(key(x)) && !gs.has(key(x)), fault === 'never_completed' ? 'a_claim_of_a_house_nobody_completed_is_never_accepted' : 'a_claim_on_the_wrong_call_is_refused', `${fault} ${key(x)}`);
  c.eq(res.good.length + res.bad.length, good.length + bad.length, 'every_claim_is_judged_exactly_once');
}

// ================================================================ game over
function overCase(c, r, parts, tag) {
  const [, kind, tkS] = parts;
  const rewards = kind === 'prizes' ? CF.defaultRewards() : rewardsFor(r, HOUSES, 'max');
  const players = kind === 'prizes' ? r.int(6, 14) : r.int(1, 3);
  const fx = fixture(r, tag, { players, tickets: +tkS, rewards });
  const full = GM.settleAll(fx.eid, fx.pids, fx.log, fx.cfg, 1), total = fx.cfg.rewards.length;
  compareSettle(c, fx, oracleSettle(fx), full, `over ${kind}`);
  if (kind === 'prizes') {
    c.eq(full.length, total, 'every_prize_line_is_awarded_when_there_are_enough_players');
    const end = Math.max(...full.map((x) => x.idx));
    c.ok(end <= 74, 'the_game_ends_by_call_75');
    c.eq(norm(GM.settleAll(fx.eid, fx.pids, fx.log.slice(0, end + 1), fx.cfg, 1)), norm(full), 'ending_the_game_when_the_last_prize_is_awarded_changes_no_result');
    if (end > 0) c.ok(GM.settleAll(fx.eid, fx.pids, fx.log.slice(0, end), fx.cfg, 1).length < total, 'the_game_is_not_over_one_call_earlier');
    const e = new PE.PrizeEngine(fx.eid, fx.cfg, 1); e.addSeats(fx.pids.map((pid) => ({ pid, countFrom: 0 }))); e.work(1e12);
    fx.log.slice(0, end + 1).forEach((n, k) => e.feed(n, fx.callRounds[k]));
    c.eq(norm(e.results()), norm(full), 'engine_stopped_at_the_last_prize_equals_the_full_settlement');
  } else if (kind === 'all75') {
    c.eq(fx.log.length, 75, 'all_75_numbers_called');
    const want = HOUSES.reduce((s, h) => s + Math.min(MAXW[h], fx.pids.length), 0);
    c.eq(full.length, want, 'with_all_75_called_every_house_is_won_by_every_player_up_to_its_limit');
    c.ok(full.every((x) => x.idx <= 74), 'no_win_after_call_75');
  } else {
    const L = r.int(5, 74), pre = GM.settleAll(fx.eid, fx.pids, fx.log.slice(0, L), fx.cfg, 1);
    c.eq(norm(pre), norm(full.filter((x) => x.idx < L)), 'the_settlement_of_a_stopped_game_is_a_prefix_of_the_full_one');
    c.ok(pre.every((x) => x.idx < L), 'nobody_wins_on_a_call_that_was_never_made');
    const st = { intervals: [], stopRound: fx.R0 + L * fx.stride };
    const cnt = Array.from({ length: 75 }, (_, k) => GM.callRoundR(st, fx.R0, fx.stride, [], 1, k)).filter((x) => x !== null).length;
    c.eq(cnt, L, 'a_stop_at_round_n_cancels_exactly_the_calls_from_n_on');
  }
}

// ================================================================ ranking
function rankCase(c, r, parts, tag) {
  const [, nS, kind] = parts, n = +nS;
  let settled, cfg, eidR;
  if (kind === 'plain') { const fx = fixture(r, tag, { players: r.int(4, 12), tickets: 1, rewards: rewardsFor(r, shuffle(r, [...HOUSES]).slice(0, 5), 'rand') }); settled = GM.settleAll(fx.eid, fx.pids, fx.log, fx.cfg, 1); cfg = fx.cfg; eidR = fx.eidR; }
  else {
    eidR = `E${tag}`; const houses = shuffle(r, [...HOUSES]).slice(0, 4); cfg = { ...CF.defaultCfg(), rewards: rewardsFor(r, houses, 'rand') }; settled = [];
    const pids = mkPids(r, tag, 30, 'mixed'); let at = 0;
    for (const h of houses) { const o = cfg.rewards.filter((l) => l.pattern === h).map((l) => l.ordinal), g = new Map([[r.int(0, 60), pids.slice(at, at + 5)]]); at = (at + 5) % 25; settled.push(...GM.assignOrdinals(eidR, h, [...g], o, 1)); }
  }
  const rows = GM.rankWinners(eidR, cfg, settled, n);
  c.eq(rows.length, Math.min(n, settled.length), 'ranking_has_at_most_n_rows');
  c.ok(rows.every((x, i) => x.rank === i + 1), 'every_row_has_a_unique_rank_1_up');
  const val = (s) => cfg.rewards.findIndex((l) => l.pattern === s.pattern && l.ordinal === s.ordinal);
  const want = [...settled].sort((a, b) => val(a) - val(b) || a.idx - b.idx || (fate(eidR, a.pids[0], a.pattern, a.ordinal) < fate(eidR, b.pids[0], b.pattern, b.ordinal) ? -1 : 1));
  rows.forEach((x, i) => {
    c.eq(`${x.pattern}#${x.ordinal}`, lineId(want[i]), 'ranking_is_by_prize_value_then_call_then_fate', i);
    c.eq(x.pid, want[i].pids[0], 'ranking_names_the_winner', i);
    c.eq(x.text, cfg.rewards.find((l) => l.pattern === x.pattern && l.ordinal === x.ordinal)?.text ?? '', 'ranking_shows_the_organizers_prize_text', i);
    c.eq(x.note, want[i].tied > 1 ? `${want[i].tied} guests completed it on the same call; decided by fate` : '', 'tie_note_wording_is_exact', i);
    c.eq(GM.rankName(x.rank), ['', '1st', '2nd', '3rd'][x.rank] ?? `${x.rank}th`, 'rank_names', x.rank);
  });
  if (kind === 'tied') c.ok(settled.some((s) => s.tied > 1) && rows.some((x) => x.note !== '') || n < 2, 'tied_scenario_really_has_a_tie_note');
  const ids = new Set(rows.map((x) => `${x.pid}|${x.pattern}|${x.ordinal}`)); c.eq(ids.size, rows.length, 'a_prize_line_is_ranked_once');
}

// ================================================================ lucky draws
function luckyCase(c, r, parts, tag) {
  const [, nS, pS, style, dup] = parts, n = +nS, people = +pS, eid = `E${tag}`, after = r.int(1, 74), rand = sha(`${tag}|lucky`);
  let pids = mkPids(r, tag, people, 'mixed');
  if (dup === 'dups') pids = [...pids, ...pids.slice(0, r.int(1, people))];
  shuffle(r, pids);
  const got = GM.luckyWinners(eid, after, rand, pids, n);
  const uniq = [...new Set(pids)];
  const want = uniq.map((p) => [sha(`CB1-LUCKY|${eid}|${after}|${rand}|${p}`), p]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, n).map((x) => x[1]);
  c.eq(JSON.stringify(got), JSON.stringify(want), 'lucky_winners_are_the_first_n_by_the_public_hash');
  c.eq(new Set(got).size, got.length, 'nobody_wins_a_lucky_draw_twice');
  c.eq(got.length, Math.min(n, uniq.length), 'a_draw_picks_n_or_everybody_if_fewer');
  c.ok(got.every((p) => uniq.includes(p)), 'winners_are_guests');
  c.eq(JSON.stringify(GM.luckyWinners(eid, after, rand, shuffle(r, [...pids]), n)), JSON.stringify(got), 'lucky_result_does_not_depend_on_list_order');
  c.ok(sameJson(got, GM.luckyWinners(eid, after, rand, pids, n)), 'lucky_replay_is_identical');
  c.eq(GM.luckyWinners(eid, after, rand, pids, 0).length, 0, 'a_draw_of_zero_picks_nobody');
  c.eq(GM.luckyWinners(eid, after, rand, pids, -3).length, 0, 'a_negative_draw_picks_nobody');
  const small = GM.luckyWinners(eid, after, rand, pids, Math.max(1, n - 1)); c.ok(sameJson(small, got.slice(0, small.length)), 'a_smaller_draw_is_a_prefix_of_a_bigger_one');
  const v = CF.validateCfg({ breaks: [{ after, seconds: 30, kind: 'lucky', title: 'Lucky draw', winners: n, style }] });
  c.ok(v.ok, 'a_lucky_draw_break_is_accepted', JSON.stringify(v));
  if (v.ok) { c.eq(v.cfg.breaks[0].winners, n, 'draw_winner_count_is_kept'); c.eq(v.cfg.breaks[0].style ?? 'draw', style, 'draw_style_is_kept'); }
}
function lroundCase(c, r, parts, tag) {
  const [, nbS, pz] = parts, nb = +nbS, stride = r.pick([2, 3, 4, 5]), start = r.int(1e6, 2e7);
  const afters = shuffle(r, Array.from({ length: 70 }, (_, i) => i + 2)).slice(0, nb).sort((a, b) => a - b);
  const breaks = afters.map((a) => ({ after: a, seconds: r.pick([15, 30, 60]), kind: 'lucky', title: 'Lucky', winners: 3 }));
  const st = pz === 'pause' ? { intervals: [{ start: start + r.int(3, 100), end: start + 150 + r.int(1, 100) }], stopRound: null } : null;
  for (const b of breaks) {
    const lr = GM.luckyRound(st, start, stride, breaks, b), prev = GM.callRoundFull(st, start, stride, breaks, b.after - 1), nxt = GM.callRoundFull(st, start, stride, breaks, b.after);
    c.eq(lr, prev + 1 + b.seconds / 3, 'the_lucky_round_is_the_round_the_break_ends');
    c.ok(lr > prev, 'the_lucky_round_is_after_the_call_before_the_break');
    c.ok(lr <= nxt, 'the_lucky_round_is_known_by_the_next_call');
    const ab = GM.activeBreak(st, start, stride, breaks, prev + 1); c.eq(ab?.endsAtRound, lr, 'the_break_ends_in_the_lucky_round');
  }
  const stopped = { intervals: [], stopRound: start };
  c.eq(GM.luckyRound(stopped, start, stride, breaks.length ? breaks : [{ after: 5, seconds: 30, kind: 'lucky', title: 'L', winners: 3 }], breaks[0] ?? { after: 5, seconds: 30, kind: 'lucky', title: 'L', winners: 3 }), null, 'a_draw_after_a_stop_never_happens');
}
function lcfgCase(c, r, parts, tag) {
  const [, wS, sty] = parts, w = +wS, style = sty === 'other' ? 'bogus' : sty === 'none' ? undefined : sty;
  const br = { after: r.int(2, 70), seconds: 30, kind: 'lucky', title: 'Lucky', winners: w, ...(style !== undefined ? { style } : {}) };
  const res = CF.validateCfg({ breaks: [br] });
  const wOk = [1, 3, 5, 10].includes(w), sOk = sty !== 'other';
  c.eq(res.ok, wOk && sOk, 'lucky_draw_accepted_exactly_when_valid', JSON.stringify(res));
  if (!res.ok) c.eq(res.error, !wOk ? 'A lucky draw picks 1, 3, 5 or 10 people.' : 'A lucky draw is shown as a draw or as a scratch card.', 'lucky_draw_error_wording_is_exact');
  const d = CF.validateCfg({ breaks: [{ after: 9, seconds: 30, kind: 'lucky', title: 'Lucky' }] });
  c.ok(d.ok && d.cfg.breaks[0].winners === 3, 'a_draw_without_a_count_picks_3');
  const nl = CF.validateCfg({ breaks: [{ after: 9, seconds: 30, kind: 'speech', title: 'Hello', style: 'scratch' }] });
  c.eq(nl.ok, false, 'only_a_lucky_draw_has_a_style'); if (!nl.ok) c.eq(nl.error, 'Only a lucky draw has a style.', 'style_error_wording');
  const op = CF.validateCfg({ opening: [{ kind: 'lucky', title: 'Lucky' }] });
  c.eq(op.ok, false, 'a_lucky_draw_cannot_open_the_game'); if (!op.ok) c.eq(op.error, 'A lucky draw can only be placed during the game.', 'opening_lucky_error_wording');
}

// ================================================================ config rules
function cfgCase(c, r, parts) {
  const area = parts[1], v = (x, base) => CF.validateCfg(x, base);
  const bad = (x, msg, code) => { const res = v(x); c.eq(res.ok, false, `${code}_refused`); if (!res.ok) c.eq(res.error, msg, `${code}_error_wording_is_exact`); };
  if (area === 'rounds') { for (const k of [1, 2, 3, 4, 5]) c.eq(v({ rounds: k }).cfg.rounds, k, 'rounds_1_to_5_accepted'); for (const k of [0, 6, 1.5, -1, '2']) bad({ rounds: k }, 'An engagement has 1 to 5 rounds.', 'rounds'); }
  if (area === 'tickets') { for (const k of [1, 2]) c.eq(v({ tickets: k }).cfg.tickets, k, 'one_or_two_cards_accepted'); for (const k of [0, 3, '1', 1.5]) bad({ tickets: k }, 'Each participant gets 1 or 2 cards.', 'tickets'); }
  if (area === 'rewards_max') for (const h of HOUSES) { const rw = Array.from({ length: MAXW[h] + 1 }, (_, i) => ({ pattern: h, ordinal: i + 1 })); const ok = v({ rewards: rw.slice(0, MAXW[h]) }); c.ok(ok.ok, 'up_to_the_documented_winner_count_is_accepted', h); const lab = CF.houseLabel(h); bad({ rewards: rw }, `${lab} can have at most ${MAXW[h]} winners. Please remove the extra ones.`, `max_${h}`); }
  if (area === 'rewards_gap') bad({ rewards: [{ pattern: 'line', ordinal: 2 }] }, 'A 2nd, 3rd... reward needs the one before it. Note that sending rewards REPLACES the whole list, so send every reward line each time, with ordinals starting at 1 for each house.', 'gap');
  if (area === 'rewards_dup') bad({ rewards: [{ pattern: 'line', ordinal: 1 }, { pattern: 'line', ordinal: 1 }] }, 'The same reward is listed twice.', 'dup');
  if (area === 'rewards_unknown') { bad({ rewards: [{ pattern: 'snake', ordinal: 1 }] }, 'Unknown house in the rewards.', 'unknown'); bad({ rewards: [{ pattern: 'line', ordinal: 0 }] }, 'A winner number must be 1 or more.', 'zero_ordinal'); }
  if (area === 'rewards_empty') { bad({ rewards: [] }, `Add between 1 and ${CF.MAX_REWARD_LINES} rewards.`, 'empty'); const all = HOUSES.flatMap((h) => Array.from({ length: MAXW[h] }, (_, i) => ({ pattern: h, ordinal: i + 1 }))); c.ok(v({ rewards: all }).ok, 'every_house_at_its_maximum_fits_in_the_reward_limit'); c.ok(all.length <= CF.MAX_REWARD_LINES, 'reward_limit_is_enough'); }
  if (area === 'breaks_limit') { const mk = (n) => Array.from({ length: n }, (_, i) => ({ after: 5 + i * 7, seconds: 30, kind: 'speech', title: 'Hello' })); c.ok(v({ tickets: 1, breaks: mk(3) }).ok, 'three_breaks_with_one_card'); bad({ tickets: 1, breaks: mk(4) }, 'At most 3 brand moments during the game with 1 card per person (lucky draws count too).', 'breaks1'); c.ok(v({ tickets: 2, breaks: mk(6) }).ok, 'six_breaks_with_two_cards'); bad({ tickets: 2, breaks: mk(7) }, 'At most 6 brand moments during the game with 2 cards per person (lucky draws count too).', 'breaks2'); }
  if (area === 'break_same_after') bad({ breaks: [{ after: 10, seconds: 30, kind: 'speech', title: 'One' }, { after: 10, seconds: 30, kind: 'speech', title: 'Two' }] }, 'Two breaks cannot start at the same number.', 'same_after');
  if (area === 'break_seconds') { for (const s of [14, 601, 16, 20.5]) bad({ breaks: [{ after: 10, seconds: s, kind: 'speech', title: 'Hello' }] }, 'A break lasts 15 to 600 seconds, in steps of 3.', `seconds_${s}`); for (const s of [15, 30, 600]) c.ok(v({ breaks: [{ after: 10, seconds: s, kind: 'speech', title: 'Hello' }] }).ok, 'break_seconds_in_steps_of_3_accepted', s); for (const a of [0, 75, 76]) bad({ breaks: [{ after: a, seconds: 30, kind: 'speech', title: 'Hello' }] }, 'A break starts after 1 to 74 numbers have been called.', `after_${a}`); }
  if (area === 'text_clean') {
    for (let i = 0; i < 12; i++) {
      const raw = Array.from({ length: r.int(0, 140) }, () => r.pick(['a', 'B', ' ', '  ', '\n', '\t', '<', '>', '`', 'Rs', '9', '-'])).join('');
      const res = v({ rewards: [{ pattern: 'line', ordinal: 1, text: raw }] });
      if (!c.ok(res.ok, 'any_prize_text_is_accepted_and_cleaned')) continue;
      const t = res.cfg.rewards[0].text;
      c.ok(!/[<>`]/.test(t), 'prize_text_has_no_markup_characters', JSON.stringify(t)); c.ok(t.length <= 80, 'prize_text_is_at_most_80_characters'); c.ok(!/\s{2}|^\s|\s$|[\n\t]/.test(t), 'prize_text_has_single_spaces_and_no_edge_space', JSON.stringify(t));
      c.eq(v({ rewards: [{ pattern: 'line', ordinal: 1, text: t }] }).cfg.rewards[0].text, t, 'cleaning_prize_text_twice_changes_nothing');
      const letters = (x) => x.replace(/[^A-Za-z0-9]/g, ''); c.ok(letters(raw).startsWith(letters(t)), 'cleaning_only_removes_and_never_reorders_text');
    }
  }
  if (area === 'omitted_keeps') {
    const base = { ...CF.defaultCfg(), tickets: 2, rounds: 3, rewards: [{ pattern: 'frame', scope: 'ticket', ordinal: 1, text: 'Trophy' }] };
    const res = v({}, base); c.ok(res.ok && res.cfg.tickets === 2 && res.cfg.rounds === 3 && res.cfg.rewards[0].pattern === 'frame' && res.cfg.rewards[0].text === 'Trophy', 'a_field_left_out_keeps_its_value');
    c.ok(sameJson(CF.defaultRewards().map((x) => x.pattern), ['line', 'corners', 'x', 'blackout']), 'default_prizes_are_line_corners_x_blackout');
  }
  if (area === 'proposed_breaks') { c.eq(JSON.stringify(SH.proposeBreakPositions(0)), '[]', 'no_breaks_no_positions'); c.eq(JSON.stringify(SH.proposeBreakPositions(1)), '[38]', 'one_break_goes_after_38'); c.eq(JSON.stringify(SH.proposeBreakPositions(2)), '[25,50]', 'two_breaks'); c.eq(JSON.stringify(SH.proposeBreakPositions(3)), '[19,38,56]', 'three_breaks'); let m = ''; try { SH.proposeBreakPositions(4); } catch (e) { m = e.message; } c.eq(m, 'at most 3 brand breaks', 'four_breaks_refused_with_exact_message'); for (let n = 1; n <= 3; n++) for (let k = 1; k <= n; k++) c.ok(CF.autoAfter(n, k) >= 1 && CF.autoAfter(n, k) <= 74, 'auto_break_position_inside_the_game'); }
}

// ================================================================ result vote
function voteCase(c, r, parts) {
  const [, bS, v] = parts, p = v === 'a' ? +bS : +bS + r.int(0, 50);
  const q = CF.quorumFor(p), vt = CF.votersFor(p);
  c.ok(q >= 1 && q <= Math.max(1, p), 'quorum_is_between_one_and_the_number_of_people', p);
  c.ok(q <= 25, 'quorum_never_exceeds_25');
  c.ok(vt >= q && vt <= p, 'voters_cover_the_quorum_and_never_exceed_the_people', `${p} q=${q} v=${vt}`);
  c.ok(CF.quorumFor(p + 1) >= q, 'quorum_never_shrinks_when_people_join', p);
  if (p <= 12) c.ok(CF.votersFor(p + 1) >= vt, 'voters_never_shrink_in_a_small_game', p);
  const golden = { 1: [1, 1], 2: [1, 2], 3: [2, 3], 6: [3, 6], 7: [3, 7], 12: [3, 12], 13: [3, 12], 61: [4, 16], 500: [25, 100], 5000: [25, 100] };
  if (v === 'a' && golden[p]) { c.eq(q, golden[p][0], 'quorum_at_the_documented_boundaries', p); c.eq(vt, golden[p][1], 'voters_at_the_documented_boundaries', p); }
  if (p <= 6) c.ok(q * 2 >= p, 'a_tiny_game_needs_at_least_half_its_people', p);
  c.eq(CF.MAX_ROUNDS, 5, 'at_most_5_rounds'); c.eq(CF.MAX_CALLS, 75, 'a_game_calls_at_most_75_numbers'); c.eq(CF.DEMO_CAP, 10, 'a_game_for_at_most_10_people_is_free');
}

// ================================================================ wording
function wordingCase(c, r, parts) {
  const area = parts[1];
  const H = { line: ['Line', 'Mark any one row, column or diagonal. FREE counts.', 3], twolines: ['Two Lines', 'Mark any two different lines.', 2], corners: ['Four Corners', 'Mark the four corner squares.', 3], plus: ['Plus', 'Mark the whole middle row and the whole middle column.', 2], x: ['X', 'Mark both diagonals.', 2], frame: ['Frame', 'Mark the whole outer border.', 2], stamp: ['Postage Stamp', 'Mark a 2 x 2 block in any corner.', 3], letterL: ['Letter L', 'Mark the whole B column and the bottom row.', 2], letterT: ['Letter T', 'Mark the whole top row and the whole N column.', 2], blackout: ['Blackout', 'Mark every square on your card. FREE counts.', 2] };
  const P = { line: ['Line', 'Any one row, column or diagonal. FREE counts.'], twolines: ['Two Lines', 'Any two different lines.'], corners: ['Four Corners', 'The four corner squares.'], plus: ['Plus', 'The middle row and the middle column.'], x: ['X', 'Both diagonals.'], frame: ['Frame', 'The whole outer border.'], stamp: ['Postage Stamp', 'A 2 x 2 block in any corner.'], letterL: ['Letter L', 'The B column and the bottom row.'], letterT: ['Letter T', 'The top row and the N column.'], blackout: ['Blackout', 'Every square on the card.'] };
  if (area === 'houses') {
    c.eq(CF.PRIZE_HOUSES.map((h) => h.id).join(), HOUSES.join(), 'houses_are_the_documented_ten_in_order');
    for (const h of CF.PRIZE_HOUSES) { const g = H[h.id]; if (!g) continue; c.eq(h.label, g[0], 'house_label_wording', h.id); c.eq(h.how, g[1], 'house_how_to_win_wording', h.id); c.eq(h.max, g[2], 'house_max_winners_match_the_docs', h.id); c.eq(CF.maxWinnersFor(h.id), g[2], 'max_winners_lookup', h.id); c.eq(CF.houseLabel(h.id), g[0], 'house_label_lookup', h.id); }
    c.eq(CF.PRIZE_HOUSES.filter((h) => h.dflt).map((h) => h.id).join(), 'line,corners,x,blackout', 'default_set_is_line_corners_x_blackout');
    c.eq(CF.houseLabel('nope'), 'nope', 'unknown_house_label_is_its_id'); c.eq(CF.maxWinnersFor('nope'), 1, 'unknown_house_has_one_winner');
  }
  if (area === 'help') {
    const lines = HOUSES.map((h) => `${h}: ${H[h][0]}. ${H[h][1]} Up to ${H[h][2]} winners.`);
    c.eq(JSON.stringify(CF.HOUSES_HELP_LIST), JSON.stringify(lines), 'houses_help_list_wording_is_exact');
    c.eq(CF.HOUSES_HELP, lines.join('\n'), 'houses_help_text_is_the_lines_joined');
    c.eq(CF.HOUSES_LINE, HOUSES.map((h) => `${h} = ${H[h][0]} (up to ${H[h][2]} winners)`).join(', '), 'houses_line_wording_is_exact');
  }
  if (area === 'patterns') for (const h of HOUSES) { c.eq(SH.PATTERNS[h].name, P[h][0], 'pattern_name_wording', h); c.eq(SH.PATTERNS[h].desc, P[h][1], 'pattern_description_wording', h); }
  if (area === 'names') {
    for (let k = 1; k <= 12; k++) { const e = k === 1 ? '1st' : k === 2 ? '2nd' : k === 3 ? '3rd' : `${k}th`; c.eq(SH.ordinalName(k), e, 'ordinal_names', k); c.eq(GM.rankName(k), e, 'rank_names', k); }
    for (const h of HOUSES) { c.eq(SH.rewardName(h, 'ticket', 1, 1), P[h][0], 'a_single_prize_line_is_named_plainly', h); c.eq(SH.rewardName(h, 'ticket', 2, 3), `2nd ${P[h][0]}`, 'a_numbered_prize_line_is_named_with_its_ordinal', h); c.eq(SH.rewardName(h, 'ticket', 3, 3), `3rd ${P[h][0]}`, 'third_prize_line', h); }
  }
  if (area === 'calls') {
    const L = ['B', 'I', 'N', 'G', 'O'];
    for (let n = 1; n <= 75; n++) { c.eq(SH.letterOf(n), L[Math.floor((n - 1) / 15)], 'call_letter_by_column', n); c.eq(SH.callLabel(n), `${L[Math.floor((n - 1) / 15)]} ${n}`, 'call_label_is_letter_space_number', n); }
    c.eq(SH.callLabel(52), 'G 52', 'g_52'); c.eq(SH.callLabel(7), 'B 7', 'b_7'); for (const bad of [0, 76, -1, 1.5]) { c.eq(SH.callLabel(bad), String(bad), 'out_of_range_call_is_just_the_number', bad); c.eq(SH.letterOf(bad), '', 'out_of_range_has_no_letter', bad); }
  }
  if (area === 'tie_note') for (const t of [2, 3, 10]) { const eidR = `E${r.int(1, 99999)}`, pids = mkPids(r, `n${t}`, t, 'mixed'); const s = GM.assignOrdinals(eidR, 'line', [[5, pids]], [1, 2, 3], 1); const cfg = { ...CF.defaultCfg(), rewards: [1, 2, 3].map((o) => ({ pattern: 'line', scope: 'ticket', ordinal: o, text: '' })) }; for (const row of GM.rankWinners(eidR, cfg, s, 10)) c.eq(row.note, `${t} guests completed it on the same call; decided by fate`, 'tie_note_exact_wording', t); }
  if (area === 'defaults') { const d = CF.defaultCfg(); c.eq(d.tickets, 1, 'default_one_card'); c.eq(d.rounds, 1, 'default_one_round'); c.eq(d.rewards.length, 4, 'default_four_prize_lines'); c.eq(d.rewards.map((x) => SH.PATTERNS[x.pattern].name).join(), 'Line,Four Corners,X,Blackout', 'default_prizes_wording'); c.ok(d.rewards.every((x) => x.ordinal === 1 && x.text === '' && x.scope === 'ticket'), 'default_prize_lines_are_first_place_no_text'); c.eq(CF.LUCKY_WINNERS.join(), '1,3,5,10', 'lucky_draw_sizes'); }
  if (area === 'schedule_text') { c.eq(CF.INTERMISSION_ROUNDS * 3, 90, 'intermission_is_90_seconds'); c.eq(CF.LATE_LAG_ROUNDS * 3, 90, 'late_lag_is_90_seconds'); c.eq(CF.OPENING_WINDOW_SECONDS, 120, 'openings_fit_in_two_minutes'); let m = ''; const o = CF.validateCfg({ opening: [{ kind: 'speech', title: 'Hi', seconds: 123 }] }); if (!o.ok) m = o.error; c.eq(m, 'An opening lasts 15 to 120 seconds, in steps of 3 (for example 30, 60 or 90). A time left empty counts as 60.', 'opening_error_wording_is_exact'); }
  if (area === 'no_refund') { c.eq(CR.NO_REFUND_LINE, 'We do not give refunds. If you cancel a paid game before it starts, your payment stays as credit for your next game for 365 days. Unused credit lapses at the end of day 365.', 'no_refund_line_is_exact'); c.eq(CR.CREDIT_DAYS, 365, 'credit_lasts_365_days'); c.eq(BL.INVOICE_KEEP_NOTE, 'We keep billing data for audit and tax reasons.', 'invoice_keep_note_is_exact'); }
  if (area === 'money_format') {
    c.eq(CR.rs(2399), 'Rs 2,399', 'rupee_format_whole'); c.eq(CR.rs(29499), 'Rs 29,499', 'rupee_format_whole_29499'); c.eq(CR.rs(1234.5), 'Rs 1,234.50', 'rupee_format_two_decimals'); c.eq(CR.rs(100000), 'Rs 1,00,000', 'rupee_format_indian_grouping'); c.eq(CR.rs(34, 'USD'), 'US$34', 'dollar_format'); c.eq(CR.rs(0.5), 'Rs 0.50', 'rupee_format_fraction'); c.eq(CR.rs(0), 'Rs 0', 'rupee_format_zero');
    for (let i = 0; i < 20; i++) { const paise = r.int(1, 99999999), x = paise / 100, s = CR.rs(x); c.ok(/^Rs [\d,]+(\.\d\d)?$/.test(s), 'money_text_shape', s); c.eq(Math.round(Number(s.slice(3).replace(/,/g, '')) * 100), Math.abs(x - Math.round(x)) < 0.005 ? Math.round(x) * 100 : paise, 'money_text_reads_back_to_the_same_amount', s); }
  }
}

// ================================================================ prices
function priceCase(c, r, parts) {
  const pack = +parts[1], cur = parts[2], row = PACKS.find((p) => p[0] === pack);
  const p = SH.price(pack, cur), want = cur === 'INR' ? row[1] : row[2];
  c.eq(p.total, want, 'price_is_the_documented_ladder', `${pack} ${cur}`); c.eq(p.base, want, 'base_equals_price_no_tax_added'); c.eq(p.tax, 0, 'no_tax_is_added'); c.eq(SH.GST_ON, false, 'gst_is_switched_off');
  c.ok(Number.isFinite(p.total) && p.total > 0, 'a_price_is_positive_money');
  const i = PACKS.findIndex((x) => x[0] === pack); if (i > 0) c.ok(want > SH.price(PACKS[i - 1][0], cur).total, 'a_bigger_pack_costs_more');
  c.eq(JSON.stringify(SH.PACKS), JSON.stringify(PACKS), 'pack_ladder_is_exactly_the_documented_one');
  let m = ''; try { SH.price(pack + 1, cur); } catch (e) { m = `${e.constructor.name}:${e.message}`; } c.eq(m, `RangeError:unknown pack ${pack + 1}`, 'unknown_pack_refused_with_exact_message');
  for (const k of [0, -5, 99]) { let t = false; try { SH.price(k, cur); } catch { t = true; } c.ok(t, 'nonsense_pack_is_refused', k); }
  const s = BL.splitGst(p.total, cur, '29', undefined); c.eq(s.total, p.total, 'billing_total_equals_price'); c.eq(s.cgst + s.sgst + s.igst, 0, 'billing_adds_no_tax_when_not_registered'); c.eq(s.mode, 'none', 'billing_mode_none');
  for (const [st, g] of [['29', '29ABCDE1234F1Z5'], ['29', '07ABCDE1234F1Z5'], ['29', undefined]]) { const t = BL.splitGst(p.total, cur, st, g, true); c.ok(Math.abs(t.taxable + t.cgst + t.sgst + t.igst - t.total) < 0.011, 'gst_split_adds_back_to_the_total', `${cur} ${st} ${g}`); c.ok(t.taxable >= 0 && t.cgst >= 0 && t.sgst >= 0 && t.igst >= 0, 'gst_parts_are_never_negative'); }
  const x = r.int(1, 99999999) / 100; c.eq(BL.toMinor(x), Math.round(x * 100), 'minor_units_round_to_whole_paise'); c.ok(Number.isInteger(BL.toMinor(x)), 'minor_units_are_whole'); c.eq(BL.toMinor(x) / 100, x, 'minor_units_round_trip', x);
}

// ================================================================ credit ledger (real SQL through node:sqlite)
function mkD1(raw) {
  const stmt = (sql, vals = []) => ({
    bind: (...v) => stmt(sql, v),
    run: async () => { const x = raw.prepare(sql).run(...vals); return { meta: { changes: Number(x.changes) } }; },
    all: async () => ({ results: raw.prepare(sql).all(...vals).map((o) => ({ ...o })) }),
    first: async () => { const o = raw.prepare(sql).get(...vals); return o ? { ...o } : null; },
  });
  return { prepare: (s) => stmt(s), batch: async (xs) => Promise.all(xs.map((x) => x.run())) };
}
const P = (x) => Math.round(x * 100);
function ledgerChecks(c, raw, label) {
  const credits = raw.prepare('SELECT * FROM credit').all();
  for (const k of credits) {
    const applied = raw.prepare("SELECT COALESCE(SUM(ROUND(amount_inr*100)),0) AS s FROM credit_use WHERE credit_id=? AND status='applied'").get(k.id).s;
    c.ok(P(k.remaining_inr) >= 0, 'credit_balance_never_goes_negative', `${label} ${k.id} ${k.remaining_inr}`);
    c.ok(P(k.lapsed_inr) >= 0, 'lapsed_amount_never_negative', label);
    c.eq(P(k.remaining_inr) + Number(applied) + P(k.lapsed_inr), P(k.total_inr), 'credit_is_conserved_remaining_plus_used_plus_lapsed_equals_paid', `${label} ${k.id}`);
    if (k.status === 'used') c.eq(P(k.remaining_inr), 0, 'used_credit_has_nothing_left', label);
  }
  for (const u of raw.prepare('SELECT * FROM credit_use').all()) c.ok(P(u.amount_inr) > 0, 'every_credit_use_is_positive_money', label);
}
async function creditCase(c, r, parts, tag) {
  const [, sc] = parts, raw = new DatabaseSync(':memory:');
  try {
    raw.exec('CREATE TABLE engagement (id TEXT PRIMARY KEY, org TEXT, pack INTEGER NOT NULL DEFAULT 0, cancelled_ms INTEGER)');
    for (const s of CR.CREDIT_SCHEMA) raw.exec(s);
    const db = mkD1(raw), DAY = 86400000, now = 1.8e12 + r.int(0, 1e9), org = 'orgA';
    const game = (id, o = org) => raw.prepare('INSERT INTO engagement(id,org,pack) VALUES(?,?,0)').run(id, o);
    const money = () => r.int(100000, 3000000) / 100;
    const mk = (id, amt, paid, cur = 'INR', o = org) => CR.creditFromPayment(db, { id, amount: amt, currency: cur, paid_ms: paid }, o, null, now, 'cancel');
    const appliedFor = (eid) => P(raw.prepare("SELECT COALESCE(SUM(amount_inr),0) AS s FROM credit_use WHERE eid=? AND status='applied'").get(eid).s);
    if (sc === 'exact' || sc === 'partial' || sc === 'surplus') {
      const price = money(), amt = sc === 'exact' ? price : sc === 'partial' ? Math.max(1, Math.round(price * r.int(5, 90)) / 100) : price + money();
      const cr = await mk('pay1', amt, now - r.int(1, 100) * DAY); game('g1');
      const res = await CR.applyCreditToGame(db, org, 'g1', price, 'INR', now);
      const expect = Math.min(P(price), P(amt));
      c.eq(P(res.appliedInr), expect, 'credit_applied_is_the_smaller_of_price_and_balance', sc); c.eq(appliedFor('g1'), expect, 'recorded_use_matches_applied');
      const after = raw.prepare('SELECT * FROM credit WHERE id=?').get(cr.id);
      c.eq(P(after.remaining_inr), P(amt) - expect, 'balance_drops_by_exactly_what_was_applied', sc); c.eq(after.expires_ms, cr.expires_ms, 'using_credit_never_stretches_its_expiry');
      c.ok(P(res.appliedInr) <= P(price), 'a_game_never_gets_more_credit_than_its_price');
      c.eq(after.status, P(amt) === expect ? 'used' : 'active', 'status_follows_the_balance', sc);
      ledgerChecks(c, raw, sc);
    }
    if (sc === 'double') {
      const price = money(); await mk('pay1', price * 2, now - 5 * DAY); await mk('pay2', money(), now - 3 * DAY); game('g1');
      const [a, b] = await Promise.all([CR.applyCreditToGame(db, org, 'g1', price, 'INR', now), CR.applyCreditToGame(db, org, 'g1', price, 'INR', now)]);
      c.eq(appliedFor('g1'), P(price), 'a_double_tap_applies_credit_once', `${a.appliedInr} ${b.appliedInr}`);
      const again = await CR.applyCreditToGame(db, org, 'g1', price, 'INR', now);
      c.eq(again.usedNow.length, 0, 'applying_again_takes_nothing_more'); c.eq(P(again.appliedInr), P(price), 'applied_total_is_unchanged');
      ledgerChecks(c, raw, 'double');
    }
    if (sc === 'order') {
      const paid = [40, 10, 70].map((d) => now - d * DAY), amts = [money(), money(), money()];
      const ids = []; for (let i = 0; i < 3; i++) ids.push((await mk(`pay${i}`, amts[i], paid[i])).id);
      const price = r.int(Math.ceil(P(amts[2]) / 2), P(amts[0]) + P(amts[1]) + P(amts[2]) - 1) / 100; game('g1');
      const res = await CR.applyCreditToGame(db, org, 'g1', price, 'INR', now);
      c.eq(P(res.appliedInr), P(price), 'credit_pays_the_whole_price_when_there_is_enough');
      const order = [2, 0, 1]; // oldest payment first (earliest expiry)
      let left = P(price);
      for (const i of order) { const row = raw.prepare('SELECT * FROM credit WHERE id=?').get(ids[i]); const take = Math.min(left, P(amts[i])); c.eq(P(row.remaining_inr), P(amts[i]) - take, 'oldest_expiring_credit_is_used_first', `credit ${i}`); left -= take; }
      ledgerChecks(c, raw, 'order');
    }
    if (sc === 'restore') {
      const price = money(), amt = price + money(); const cr = await mk('pay1', amt, now - 20 * DAY); game('g1');
      await CR.applyCreditToGame(db, org, 'g1', price, 'INR', now);
      const keep = r.chance(0.5) ? 0 : Math.floor(r.int(0, P(price)) ) / 100;
      const back = await CR.restoreCreditUses(db, 'g1', now, keep);
      c.eq(back.reduce((s, x) => s + P(x.amount), 0), P(price) - P(keep), 'restoring_gives_back_exactly_the_excess');
      c.eq(appliedFor('g1'), P(keep), 'what_stays_applied_is_what_was_kept');
      const row = raw.prepare('SELECT * FROM credit WHERE id=?').get(cr.id);
      c.eq(row.expires_ms, cr.expires_ms, 'restoring_never_stretches_the_365_days'); c.eq(P(row.remaining_inr), P(amt) - P(keep), 'restored_balance_is_the_original_minus_what_stays');
      const again = await CR.restoreCreditUses(db, 'g1', now, keep); c.eq(again.length, 0, 'restoring_twice_gives_nothing_back_twice');
      ledgerChecks(c, raw, 'restore');
    }
    if (sc === 'expiry') {
      const amt = money(), paid = now - r.int(1, 300) * DAY, cr = await mk('pay1', amt, paid), exp = cr.expires_ms; game('g1'); game('g2'); game('g3');
      const a = await CR.applyCreditToGame(db, org, 'g1', amt, 'INR', exp - 1); c.eq(P(a.appliedInr), P(amt), 'credit_is_usable_up_to_the_last_millisecond_before_expiry');
      await CR.restoreCreditUses(db, 'g1', exp - 1, 0);
      const b = await CR.applyCreditToGame(db, org, 'g2', amt, 'INR', exp); c.eq(P(b.appliedInr), 0, 'credit_is_not_usable_at_the_expiry_instant');
      const x = await CR.applyCreditToGame(db, org, 'g3', amt, 'INR', exp - 1); c.eq(P(x.appliedInr), P(amt), 'credit_usable_again_just_before_expiry');
      await CR.restoreCreditUses(db, 'g3', exp + DAY, 0);
      const row = raw.prepare('SELECT * FROM credit WHERE id=?').get(cr.id);
      c.eq(P(row.lapsed_inr), P(amt), 'credit_restored_after_expiry_comes_back_lapsed_not_spendable'); c.eq(P(row.remaining_inr), 0, 'no_spendable_balance_after_expiry'); c.eq(row.status, 'expired', 'status_expired');
      const z = await CR.applyCreditToGame(db, org, 'g2', amt, 'INR', exp + DAY); c.eq(P(z.appliedInr), 0, 'lapsed_credit_pays_nothing');
      ledgerChecks(c, raw, 'expiry');
    }
    if (sc === 'isolation') {
      const price = money(); await mk('payB', price * 3, now - DAY, 'INR', 'orgB'); await mk('payU', price * 3, now - DAY, 'USD', org); game('g1');
      const a = await CR.applyCreditToGame(db, org, 'g1', price, 'INR', now); c.eq(P(a.appliedInr), 0, 'another_accounts_or_currencys_credit_is_never_used');
      const p1 = await mk('payX', price, now - DAY), p2 = await mk('payX', price * 5, now - DAY); c.eq(p2.id, p1.id, 'one_payment_makes_one_credit'); c.eq(raw.prepare("SELECT COUNT(*) AS n FROM credit WHERE payment_id='payX'").get().n, 1, 'no_second_credit_for_the_same_payment');
      c.eq(P(p2.total_inr), P(price), 'the_first_credit_amount_is_kept');
      c.eq(await mk('payZ', 0, now), null, 'zero_money_makes_no_credit'); c.eq(await mk('payN', -5, now), null, 'negative_money_makes_no_credit');
      const s = await CR.activeCreditSummary(db, org, now); c.eq(P(s.activeTotalInr), P(price), 'summary_counts_only_this_accounts_inr_credit');
      ledgerChecks(c, raw, 'isolation');
    }
    if (sc === 'arrival_after_expiry') {
      const amt = money(), cr = await mk('payOld', amt, now - (366 + r.int(0, 200)) * DAY);
      c.eq(cr.status, 'expired', 'a_payment_older_than_365_days_arrives_already_expired'); c.eq(P(cr.remaining_inr), 0, 'nothing_spendable'); c.eq(P(cr.lapsed_inr), P(amt), 'the_whole_amount_is_lapsed');
      game('g1'); const a = await CR.applyCreditToGame(db, org, 'g1', amt, 'INR', now); c.eq(P(a.appliedInr), 0, 'expired_on_arrival_credit_pays_nothing');
      ledgerChecks(c, raw, 'arrival');
    }
  } finally { raw.close(); }
}
function expiryCase(c, r, parts) {
  const IST = 19800000, DAY = 86400000;
  for (let i = 0; i < 25; i++) {
    const paid = r.int(1.6e12, 2.2e12), exp = CR.creditExpiryMs(paid);
    const d = new Date(paid + IST), want = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 366) - IST; // 00:00 India time at the start of day 366
    c.eq(exp, want, 'credit_expires_at_the_start_of_day_366_in_india_time', paid);
    c.ok(exp > paid + 365 * DAY - 1 && exp <= paid + 366 * DAY + DAY - 1, 'credit_lasts_between_365_and_367_days');
    const last = new Date(exp - 1 + IST); // the last usable day, India calendar
    const lw = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 365));
    c.eq(`${last.getUTCFullYear()}-${last.getUTCMonth()}-${last.getUTCDate()}`, `${lw.getUTCFullYear()}-${lw.getUTCMonth()}-${lw.getUTCDate()}`, 'last_usable_day_is_day_365_after_the_payment_date');
    const txt = CR.creditLastDay(exp), mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][lw.getUTCMonth()];
    c.ok(new RegExp(`^${lw.getUTCDate()} ${mon}[a-z]* ${lw.getUTCFullYear()}$`).test(txt), 'last_day_text_is_the_india_date', `${txt}`);
    c.eq(CR.creditExpiryMs(paid + 1) >= exp, true, 'a_later_payment_never_expires_earlier');
  }
  c.eq(CR.creditExpiryMs(Date.UTC(2026, 0, 1, 12) - IST) % DAY, (DAY - IST) % DAY, 'expiry_is_at_india_midnight');
}

// ================================================================ one case
export async function runCase(w, idx, seed) {
  const cell = CELLS[idx % CELLS.length], parts = cell.split('|');
  const r = rng(seed, idx), c = new Case(), tag = `${String(seed).replace(/\W/g, '')}n${idx}`;
  try {
    const f = { card: cardCase, calls: callsCase, settle: settleCase, round: roundCase, tie: tieCase, late: lateCase, claim: claimCase, over: overCase, rank: rankCase, lucky: luckyCase, lround: lroundCase, lcfg: lcfgCase, cfg: cfgCase, vote: voteCase, wording: wordingCase, price: priceCase, credit: creditCase, expiry: expiryCase }[parts[0]];
    await f(c, r, parts, tag);
  } catch (err) { c.ok(false, 'no_exception', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ')); }
  return { cell, c };
}
