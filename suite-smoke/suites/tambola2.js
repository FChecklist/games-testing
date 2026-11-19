// Tambola suite, part 2: the gaps that need no live server. Same harness contract as suites/tambola.js (CELLS, newWorld, runCase).
//   ptk     per-ticket prizes in a two-ticket game (key "top@1" / "top@2": only that ticket can win it), beside a plain prize of the same house
//   late    late joiners: their numbers count only from their count-from beacon round (docs/dev/06-BUSINESS-LOGIC G6, LATE_LAG_ROUNDS = 30)
//   unlucky the Unlucky prize (G5b): fewest numbers marked when the first Full House is completed / every other prize awarded / the game is over
//   lucky   phone-side lucky draws (section 8): first N of sha256("CT1-LUCKY|eid|breakAfter|randomness|pid"), nobody twice
//   lround  which beacon round decides a lucky draw: the round in which the break ends (B6: every break pushes later calls by seconds/3 rounds)
//   quorum  winner quorum and voters (G7)
//   sx      the server engine's optional features (NOTES 17, CR-08): rounds with fresh tickets, lucky draws with "I'm here" and one redraw,
//           scratch cards with exactly N winning cards decided up front and auto-reveal, boosters (Joker, Extra ticket, Lucky draw pass),
//           a bumper draw that is always last, counters that never rise, names never broadcast, Not valid blocks for the whole engagement
//   sxm     the same moments started by hand (manual mode): only when not paused, bumper last, nothing when none are left
//   joker   the Joker booster: marks one called number on the ticket that was not cut; never consumed for nothing
// The oracle is written from the documents (docs/NOTES.md 17, docs/dev/06-BUSINESS-LOGIC.md sections 8 and 9, docs/GAME_PRINCIPLES.md) and the
// house "how to win" texts; helpers shared with part 1 are imported from suites/tambola.js.
import '../lib/tsresolve.js';
import { createHash } from 'node:crypto';
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { imp } from '../lib/roots.js';
import { NAME, HOUSES, ticketProblems, allN, houseRule, ruleDoneAt, posOf, stillNeeds, claimVerdict, shuffle, randOf, sameSet } from './tambola.js';

const R = (p) => imp(`corporate-tambola/${p}`);
const EN = await R('packages/engine/src/engine.ts');
const CF = await R('packages/beacon/src/config.ts');
const GM = await R('packages/beacon/src/game.ts');
const BX = await R('packages/beacon/src/index.ts');

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const KEYS1 = HOUSES.filter((k) => k !== 'full2');

// ================================================================ cells
export const CELLS = [
  ...cross(['ptk'], KEYS1, ['1', '2'], ['share', 'next'], ['valid', 'late', 'no_claim', 'other_ticket_idx']).map((c) => c.join('|')),
  ...cross(['late'], ['early5', 'top', 'corners', 'twolines', 'high5', 'full'], ['none', 'before_start', 'mid', 'boundary', 'after_end'], ['share', 'next']).map((c) => c.join('|')),
  ...cross(['unlucky'], ['3', '20'], ['1', '2'], ['over', 'running'], ['fullprize', 'nofull']).map((c) => c.join('|')),
  ...cross(['lucky'], ['1', '3', '5', '10'], ['1', '3', '10', '50', '200'], ['plain', 'dups']).map((c) => c.join('|')),
  ...cross(['lround'], ['1', '2', '3'], ['2', '3', '4', '5']).map((c) => c.join('|')),
  ...cross(['quorum'], ['tiny', 'small', 'mid', 'large', 'huge'], ['a', 'b', 'c', 'd']).map((c) => c.join('|')),
  ...cross(['sx'], ['1', '2', '3'], ['0', '1', '3'], ['0', '2'], ['5', '20'], ['all', 'none', 'some']).map((c) => c.join('|')),
  ...cross(['sxm'], ['1', '2'], ['0', '1'], ['bumper', 'nobumper']).map((c) => c.join('|')),
  ...cross(['joker'], ['missed', 'all_cut', 'none_left', 'off'], ['A', 'B']).map((c) => c.join('|')),
];
export async function newWorld() { return {}; }

// ================================================================ the documented settlement (claims, ties) as an oracle
/** Who wins which position of one house: a claim counts at the real completion call, before the next number, with fewer than 2 Bogeys before it. */
function settleOracle(pids, doneOf, claims, deadline, ties) {
  const counted = [];
  for (const p of pids) {
    const cl = claims.filter((x) => x.pid === p && !x.bogey).sort((a, b) => a.atMs - b.atMs)[0];
    if (!cl) continue;
    const bog = claims.filter((x) => x.pid === p && x.bogey && x.atMs < cl.atMs).length;
    if (cl.idx === doneOf(p) && cl.atMs < deadline(cl.idx) && bog < 2) counted.push([cl.idx, p]);
  }
  const groups = new Map(); for (const [i, p] of counted) groups.set(i, [...(groups.get(i) ?? []), p]);
  const order = [...groups.keys()].sort((a, b) => a - b);
  return ties === 'share' ? order.map((i) => ({ idx: i, pids: groups.get(i) })) : order.flatMap((i) => groups.get(i).map(() => ({ idx: i, pids: groups.get(i) })));
}
function comparePositions(c, out, positions, m, ties, label) {
  c.eq(out.length, Math.min(m, positions.length), 'one_result_per_position_awarded', label);
  for (let o = 0; o < Math.min(m, positions.length); o++) {
    const got = out.find((x) => x.ordinal === o + 1), want = positions[o];
    if (!c.ok(!!got, 'position_awarded', `${label} ${o + 1}`)) continue;
    c.eq(got.idx, want.idx, 'position_goes_to_earliest_valid_claim', `${label} ${o + 1}`);
    if (ties === 'share') c.ok(sameSet(got.pids, want.pids), 'share_rule_everyone_on_same_number_shares', label);
    else c.ok(got.pids.length === 1 && want.pids.includes(got.pids[0]), 'next_rule_one_person_per_position', label);
  }
}
const schedule = (log, R0) => log.map((_, k) => R0 + 3 * k);

// ---------------------------------------------------------------- per-ticket prizes
function ptkCase(c, r, parts, tag) {
  const [, key, tnS, ties, fault] = parts, tn = +tnS, k = `${key}@${tn}`;
  const pids = Array.from({ length: 5 }, (_, i) => `s${tag}x${i}`);
  let eid, tickets, log, pos, doneK, doneP;
  for (let a = 0; a < 60; a++) {
    eid = a ? `E${tag}r${a}` : `E${tag}`;
    tickets = new Map(pids.map((p) => [p, GM.ticketsFor(eid, p, 2)]));
    const perm = shuffle(r, Array.from({ length: 90 }, (_, i) => i + 1));
    log = perm.slice(0, a < 20 ? r.int(40, 90) : 90); pos = posOf(log);
    doneK = new Map(pids.map((p) => [p, ruleDoneAt(houseRule(tickets.get(p)[tn - 1], key), pos)]));
    doneP = new Map(pids.map((p) => { const x = tickets.get(p).map((t) => ruleDoneAt(houseRule(t, key), pos)).filter((i) => i >= 0); return [p, x.length ? Math.min(...x) : -1]; }));
    const ok = pids.some((p) => doneK.get(p) >= 0 && doneK.get(p) < log.length - 1);
    const otherOk = fault !== 'other_ticket_idx' || pids.some((p) => { const o = ruleDoneAt(houseRule(tickets.get(p)[2 - tn], key), pos); return doneK.get(p) >= 0 && o >= 0 && o !== doneK.get(p) && doneK.get(p) < log.length - 1; });
    if (ok && otherOk) break;
  }
  for (const ts of tickets.values()) { ts.forEach((t) => c.ok(ticketProblems(t).length === 0, 'ticket_valid')); c.ok(JSON.stringify(ts[0]) !== JSON.stringify(ts[1]), 'two_tickets_differ'); }
  const m = r.int(1, 2);
  const rewards = [...Array.from({ length: m }, (_, i) => ({ pattern: key, scope: tn === 1 ? 'ticket_1' : 'ticket_2', ordinal: i + 1, text: '' })), { pattern: key, scope: 'ticket', ordinal: 1, text: '' }];
  const cfg = { ...CF.defaultCfg(), tickets: 2, ties, rewards };
  const callRounds = schedule(log, r.int(1e6, 2e7));
  const deadline = (i) => (i + 1 < log.length ? BX.roundTimeMs(callRounds[i + 1]) : Infinity);
  const at = (i) => BX.roundTimeMs(callRounds[i]) + r.int(0, 8999);
  const claimsK = [], claimsP = [];
  for (const p of pids) { if (doneK.get(p) >= 0) claimsK.push({ pid: p, pattern: k, round: 1, idx: doneK.get(p), atMs: at(doneK.get(p)) }); if (doneP.get(p) >= 0) claimsP.push({ pid: p, pattern: key, round: 1, idx: doneP.get(p), atMs: at(doneP.get(p)) }); }
  const cand = claimsK.filter((x) => x.idx < log.length - 1);
  if (!c.ok(cand.length > 0, 'harness_fault_target_exists', `${k} ${fault}`)) return;
  let target = r.pick(cand);
  if (fault === 'late') target.atMs = deadline(target.idx) + r.int(0, 20000);
  if (fault === 'no_claim') claimsK.splice(claimsK.indexOf(target), 1);
  if (fault === 'other_ticket_idx') { // claims Ticket N's prize at the call where the OTHER ticket completed the house: must not count
    const cs = cand.filter((x) => { const o = ruleDoneAt(houseRule(tickets.get(x.pid)[2 - tn], key), pos); return o >= 0 && o !== x.idx; });
    if (!c.ok(cs.length > 0, 'harness_fault_target_exists', `${k} other`)) return;
    target = r.pick(cs); target.idx = ruleDoneAt(houseRule(tickets.get(target.pid)[2 - tn], key), pos); target.atMs = at(target.idx);
  }
  const claims = [...claimsK, ...claimsP];
  const out = GM.settleAll(eid, pids, log, cfg, 1, undefined, { randomness: log.map((_, i) => sha(`${tag}|${i}`)) }, { claims, callRounds });
  comparePositions(c, out.filter((x) => x.pattern === k), settleOracle(pids, (p) => doneK.get(p), claimsK, deadline, ties), m, ties, k);
  comparePositions(c, out.filter((x) => x.pattern === key), settleOracle(pids, (p) => doneP.get(p), claimsP, deadline, ties), 1, ties, key);
  if (fault !== 'valid') c.ok(!out.some((x) => x.pattern === k && x.pids.includes(target.pid)), 'faulty_per_ticket_claim_never_wins', fault);
  const cc = GM.checkClaims(eid, claimsK.map(({ pid, pattern, idx }) => ({ pid, pattern, idx, round: 1 })), log, cfg);
  for (const x of cc.good) c.eq(x.idx, doneK.get(x.pid), 'per_ticket_claim_checked_on_that_ticket_only');
  for (const x of cc.bad) c.ok(x.idx !== doneK.get(x.pid), 'per_ticket_claim_refused_only_when_wrong');
  const cut = r.int(0, log.length), called = new Set(log.slice(0, cut));
  for (const p of pids) c.eq(GM.stillToWin(tickets.get(p), k, log.slice(0, cut)), stillNeeds([tickets.get(p)[tn - 1]], key, called), 'still_to_win_counts_that_ticket_only', k);
}

// ---------------------------------------------------------------- late joiners
function lateCase(c, r, parts, tag) {
  const [, key, lag, ties] = parts;
  c.eq(CF.LATE_LAG_ROUNDS, 30, 'late_joiner_lag_is_90_seconds');
  const pids = Array.from({ length: 6 }, (_, i) => `s${tag}x${i}`), eid = `E${tag}`;
  const tickets = new Map(pids.map((p) => [p, GM.ticketsFor(eid, p, 1)]));
  const log = shuffle(r, Array.from({ length: 90 }, (_, i) => i + 1)).slice(0, lag === "boundary" ? 90 : r.int(50, 90));
  const R0 = r.int(1e6, 2e7), callRounds = schedule(log, R0);
  const late = pids.filter((_, i) => i % 2 === 1);
  const countFrom = new Map();
  for (const p of late) {
    // at the boundary, join exactly at a call whose number is on this person's house: whether that call counts then decides the result
    const rule = houseRule(tickets.get(p)[0], key), mine = new Set(rule.kind === 'lines' ? rule.lines.flat() : rule.pool);
    const onHouse = log.map((x, k) => (k >= 1 && k <= log.length - 2 && mine.has(x) ? k : -1)).filter((k) => k >= 0);
    const j = lag === 'boundary' && onHouse.length ? r.pick(onHouse) : r.int(1, log.length - 2);
    const cf = lag === 'before_start' ? R0 - r.int(1, 100) : lag === 'mid' ? callRounds[j] - r.int(1, 2) : lag === 'boundary' ? callRounds[j] : lag === 'after_end' ? callRounds[log.length - 1] + r.int(1, 50) : 0;
    if (lag !== 'none') countFrom.set(p, cf);
  }
  // the numbers that count for a person: calls whose beacon round is at or after their count-from round ("from" = inclusive)
  const mineOf = (p) => { const cf = countFrom.get(p) ?? 0; return log.map((n, k) => (callRounds[k] >= cf ? n : 0)); };
  const doneOf = new Map(pids.map((p) => [p, ruleDoneAt(houseRule(tickets.get(p)[0], key), posOf(mineOf(p).map((n, i) => (n === 0 ? -1 - i : n))))]));
  const deadline = (i) => (i + 1 < log.length ? BX.roundTimeMs(callRounds[i + 1]) : Infinity);
  const claims = pids.filter((p) => doneOf.get(p) >= 0).map((p) => ({ pid: p, pattern: key, round: 1, idx: doneOf.get(p), atMs: BX.roundTimeMs(callRounds[doneOf.get(p)]) + r.int(0, 8999) }));
  const m = r.int(1, 3);
  const cfg = { ...CF.defaultCfg(), tickets: 1, ties, rewards: Array.from({ length: m }, (_, i) => ({ pattern: key, scope: 'ticket', ordinal: i + 1, text: '' })) };
  const lateArg = { countFrom, callRounds };
  const out = GM.settleAll(eid, pids, log, cfg, 1, lateArg, { randomness: log.map((_, i) => sha(`${tag}|${i}`)) }, { claims, callRounds }).filter((x) => x.pattern === key);
  comparePositions(c, out, settleOracle(pids, (p) => doneOf.get(p), claims, deadline, ties), m, ties, `${key} ${lag}`);
  // each late joiner alone (nobody to compete with): their own first position must sit at the call where THEIR counted numbers complete it
  for (const p of late) {
    const solo = GM.settleAll(eid, [p], log, cfg, 1, lateArg, { randomness: log.map((_, i) => sha(`${tag}|${i}`)) }, { claims: claims.filter((x) => x.pid === p), callRounds }).filter((x) => x.pattern === key && x.ordinal === 1);
    c.eq(solo.length ? solo[0].idx : -1, doneOf.get(p) >= 0 && doneOf.get(p) < log.length ? doneOf.get(p) : -1, 'late_joiner_wins_on_own_counted_numbers_only', `${key} ${lag}`);
  }
  if (lag === 'after_end') c.ok(!out.some((x) => x.pids.some((p) => late.includes(p))), 'joined_after_last_call_cannot_win');
  // a late joiner claiming at the call where the numbers WITHOUT the lag would have completed it: refused by the check
  const cheat = late.map((p) => ({ p, i: ruleDoneAt(houseRule(tickets.get(p)[0], key), posOf(log)) })).filter((x) => x.i >= 0 && x.i !== doneOf.get(x.p));
  const cc = GM.checkClaims(eid, [...cheat.map((x) => ({ pid: x.p, pattern: key, idx: x.i, round: 1 })), ...claims.map(({ pid, idx }) => ({ pid, pattern: key, idx, round: 1 }))], log, cfg, { countFrom, callRounds: { 1: callRounds } });
  c.eq(cc.bad.length, cheat.length, 'late_joiner_claim_on_numbers_before_joining_refused', `${key} ${lag}`);
  c.eq(cc.good.length, claims.length, 'late_joiner_claim_on_own_numbers_accepted');
}

// ---------------------------------------------------------------- Unlucky
function unluckyCase(c, r, parts, tag) {
  const [, nS, tkS, overS, fp] = parts, n = +nS, ntk = +tkS, over = overS === 'over';
  const eid = `E${tag}`, pids = Array.from({ length: n }, (_, i) => `s${tag}x${i}`);
  const tickets = new Map(pids.map((p) => [p, GM.ticketsFor(eid, p, ntk)]));
  const log = shuffle(r, Array.from({ length: 90 }, (_, i) => i + 1)).slice(0, r.int(20, 90)), pos = posOf(log);
  const callRounds = schedule(log, r.int(1e6, 2e7)), randomness = log.map((_, i) => sha(`${tag}|rand|${i}`));
  const rewards = [{ pattern: 'unlucky', scope: 'ticket', ordinal: 1, text: '' }, { pattern: 'early5', scope: 'ticket', ordinal: 1, text: '' }, ...(fp === 'fullprize' ? [{ pattern: 'full', scope: 'ticket', ordinal: 1, text: '' }] : [])];
  const cfg = { ...CF.defaultCfg(), tickets: ntk, ties: 'share', rewards };
  const best = (p, key) => { const x = tickets.get(p).map((t) => ruleDoneAt(houseRule(t, key), pos)).filter((i) => i >= 0); return x.length ? Math.min(...x) : -1; };
  const deadline = (i) => (i + 1 < log.length ? BX.roundTimeMs(callRounds[i + 1]) : Infinity);
  const claims = [];
  for (const key of fp === 'fullprize' ? ['early5', 'full'] : ['early5']) for (const p of pids) { const i = best(p, key); if (i >= 0) claims.push({ pid: p, pattern: key, round: 1, idx: i, atMs: BX.roundTimeMs(callRounds[i]) + r.int(0, 8999) }); }
  // oracle (G5b)
  const fulls = pids.map((p) => best(p, 'full')).filter((i) => i >= 0);
  const firstFull = fulls.length ? Math.min(...fulls) : -1;
  const pe = settleOracle(pids, (p) => best(p, 'early5'), claims.filter((x) => x.pattern === 'early5'), deadline, 'share');
  const pf = fp === 'fullprize' ? settleOracle(pids, (p) => best(p, 'full'), claims.filter((x) => x.pattern === 'full'), deadline, 'share') : null;
  const othersDone = pe.length && (!pf || pf.length) ? Math.max(pe[0].idx, pf ? pf[0].idx : -1) : -1;
  const ats = [firstFull, othersDone].filter((x) => x >= 0); if (over || log.length >= 90) ats.push(log.length - 1);
  const at = ats.length ? Math.min(...ats) : -1;
  const out = GM.settleAll(eid, pids, log, cfg, 1, undefined, { randomness, over }, { claims, callRounds });
  const u = out.filter((x) => x.pattern === 'unlucky');
  if (at < 0) { c.eq(u.length, 0, 'unlucky_open_while_nothing_decides_it'); return; }
  const upto = new Set(log.slice(0, at + 1));
  const marked = (p) => Math.min(...tickets.get(p).map((t) => allN(t).filter((x) => upto.has(x)).length));
  const want = pids.map((p) => [marked(p), sha(`CT1-UNLUCKY|${eid}|${randomness[at]}|${p}`), p]).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))[0][2];
  c.eq(u.length, 1, 'unlucky_decided_once', `at=${at}`);
  if (u[0]) { c.eq(u[0].idx, at, 'unlucky_decided_at_first_full_house_or_end', { firstFull, othersDone, over, L: log.length }); c.eq(u[0].pids.join(), want, 'unlucky_goes_to_fewest_marked_tie_by_public_hash'); }
}

// ---------------------------------------------------------------- lucky draws (phone side)
function luckyCase(c, r, parts, tag) {
  const [, nS, peopleS, dup] = parts, n = +nS, people = +peopleS;
  const eid = `E${tag}`, after = r.int(1, 89), rand = sha(`${tag}|lucky`);
  let pids = Array.from({ length: people }, (_, i) => `s${tag}x${i}`);
  if (dup === 'dups') pids = [...pids, ...pids.slice(0, r.int(1, people))];
  shuffle(r, pids);
  const got = GM.luckyWinners(eid, after, rand, pids, n);
  const want = [...new Set(pids)].map((p) => [sha(`CT1-LUCKY|${eid}|${after}|${rand}|${p}`), p]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, n).map((x) => x[1]);
  c.eq(JSON.stringify(got), JSON.stringify(want), 'lucky_winners_are_first_n_by_public_hash');
  c.eq(new Set(got).size, got.length, 'lucky_nobody_wins_twice');
  c.eq(got.length, Math.min(n, new Set(pids).size), 'lucky_draws_n_or_everyone');
  c.eq(JSON.stringify(GM.luckyWinners(eid, after, rand, shuffle(r, pids.slice()), n)), JSON.stringify(got), 'lucky_not_steered_by_list_order');
}
function lroundCase(c, r, parts) {
  const [, kS, strideS] = parts, k = +kS, stride = +strideS, start = r.int(1e6, 2e7);
  const pos = [...new Set(Array.from({ length: k }, () => r.int(1, 89)))].sort((a, b) => a - b);
  const breaks = pos.map((after, i) => ({ after, seconds: 15 + 3 * r.int(0, 60), kind: 'lucky', title: `Draw ${i}`, winners: 3 }));
  const callRound = (j) => start + j * stride + breaks.filter((b) => b.after <= j).reduce((s, b) => s + b.seconds / 3, 0);
  for (const b of breaks) c.eq(GM.luckyRound(null, start, stride, breaks, b), callRound(b.after - 1) + 1 + b.seconds / 3, 'lucky_round_is_the_round_the_break_ends', b);
  for (let j = 0; j < 90; j += r.int(1, 10)) c.eq(GM.callRoundFull(null, start, stride, breaks, j), callRound(j), 'break_pushes_later_calls_by_its_length', j);
}
function quorumCase(c, r, parts) {
  const band = parts[1];
  const [lo, hi] = { tiny: [1, 6], small: [7, 12], mid: [13, 60], large: [61, 500], huge: [501, 100000] }[band];
  for (let i = 0; i < 25; i++) {
    const n = r.int(lo, hi), q = CF.quorumFor(n), v = CF.votersFor(n);
    const wq = n <= 6 ? Math.max(1, Math.ceil(n / 2)) : Math.min(25, Math.max(3, Math.ceil(n * 0.05)));
    c.eq(q, wq, 'quorum_half_of_tiny_else_5_percent_3_to_25', n);
    c.eq(v, n <= 12 ? n : 4 * wq, 'voters_everyone_up_to_12_else_4x_quorum', n);
    c.ok(q >= 1 && q <= v && v <= n && q <= 25, 'quorum_within_voters_within_people', { n, q, v });
    c.ok(CF.quorumFor(n + 1) >= q, 'quorum_never_shrinks_as_game_grows', n);
  }
}

// ---------------------------------------------------------------- the server engine's optional features
function mkEngine(r, c, tag, o) {
  const W = { clk: 1_800_000_000_000 + r.int(0, 1e9), events: [], names: [], refs: [], c, round: 1, roundCalls: [], between: false, paused: false, results: [], starts: [], toConfirm: [], scratchOut: new Map(), boost: new Map(), seen: 0, ended: false, still: null };
  W.deps = { now: () => W.clk, rand: randOf(r), emit: (ev) => onEv(W, ev) };
  W.e = new EN.EngagementEngine({ name: 'Smoke engagement', orgName: 'Smoke Org', limit: o.players + 3, familyCanWin: o.familyCanWin, callMode: o.callMode ?? 'ai', ticketMode: o.ticketMode ?? 'single' }, W.deps);
  const e = W.e;
  if (o.surprise) {
    const bad = r.pick([{ rounds: 6 }, { rounds: 0 }, { luckyWinners: 4 }, { scratchWinning: 7 }, { luckyDraws: 11 }, { scratchCards: -1 }, { callSeconds: 10 }]);
    const before = JSON.stringify(e.settings.surprise);
    c.ok(e.updateSettings('organizer', { surprise: bad }) !== null && JSON.stringify(e.settings.surprise) === before, 'out_of_range_surprise_setting_refused', bad);
    c.ok(e.updateSettings('host', { surprise: o.surprise }) !== null, 'host_cannot_change_surprise_settings');
    c.eq(e.updateSettings('organizer', { surprise: o.surprise }), null, 'organizer_sets_surprise_settings');
    if (!o.surprise.boostersAllowed) c.ok(e.settings.surprise.luckyPrize === 'gift' && e.settings.surprise.scratchPrize === 'gift', 'boosters_off_means_gifts_only');
  }
  c.eq(e.setRewards('organizer', EN.makeRewardLines([{ pattern: 'early5', texts: ['a'] }, { pattern: 'top', texts: ['b'] }, { pattern: 'full', texts: ['c'] }])), null, 'organizer_sets_rewards');
  const items = Array.from({ length: o.players }, (_, i) => ({ name: `Nm${tag}q${i}z`, info: 'Dept', e164: `ref${tag}q${i}z` }));
  W.names.push(...items.map((x) => x.name)); W.refs.push(...items.map((x) => x.e164));
  c.ok(e.addParticipants(items).ok === true, 'harness_add');
  e.participants.forEach((p, i) => e.confirmJoin(`dev${tag}q${i}`, p.id));
  W.pids = e.participants.map((p) => p.id);
  if (o.family) {
    const nm = `Fam${tag}z`, ref = `fref${tag}z`; W.names.push(nm); W.refs.push(ref);
    const pass = e.createPass(W.pids[0], { name: nm, e164: ref, kind: 'family' });
    if (c.ok(pass.ok, 'harness_family_pass')) { e.openPass(`fd${tag}`, pass.p.passCode); e.confirmJoin(`fd${tag}`, pass.p.id); W.fam = pass.p.id; }
  }
  return W;
}
const Pp = (W, id) => W.e.participants.find((p) => p.id === id);
const eligibleIds = (W) => W.e.participants.filter((p) => p.status === 'joined' && !(p.kind === 'family' && !W.e.settings.familyCanWin)).map((p) => p.id);
function onEv(W, ev) {
  const c = W.c, e = W.e;
  W.events.push(ev);
  if (ev.to === 'all') { const s = JSON.stringify(ev); c.ok(!W.names.some((n) => s.includes(n)) && !W.refs.some((n) => s.includes(n)), 'broadcast_has_no_name_or_number', ev.type); }
  if (ev.type === 'pause') W.paused = true;
  if (ev.type === 'resume') W.paused = false;
  if (ev.type === 'round_end') { c.eq(ev.round, W.round, 'round_end_in_order'); W.between = true; W.endAt = W.clk; W.prevTickets = new Set(e.participants.flatMap((p) => p.tickets.map((t) => JSON.stringify(t)))); }
  if (ev.type === 'round_start') {
    c.eq(ev.round, W.round + 1, 'rounds_count_up'); W.round = ev.round; W.between = false; W.roundCalls = []; W.seen = 0; W.paused = false;
    c.ok(W.clk - W.endAt >= 20_000, 'at_least_20_s_between_rounds', W.clk - W.endAt);
    const keys = [];
    for (const p of e.participants) {
      const known = W.boost.get(p.id)?.extra ?? 0;
      const extraUsed = known > 0 && e.settings.surprise.boostersAllowed;
      c.eq(p.tickets.length, 1 + (extraUsed ? 1 : 0), 'extra_ticket_booster_adds_one_ticket_next_round', { known });
      if (extraUsed) { c.eq(p.boosters.extra, known - 1, 'extra_ticket_used_once'); W.boost.set(p.id, { ...p.boosters }); W.extraUsed = (W.extraUsed ?? 0) + 1; }
      for (const t of p.tickets) { c.ok(ticketProblems(t).length === 0, 'new_round_ticket_valid'); c.ok(!W.prevTickets.has(JSON.stringify(t)), 'fresh_tickets_every_round'); keys.push(JSON.stringify(t)); }
    }
    c.eq(new Set(keys).size, keys.length, 'no_two_tickets_alike_in_a_round');
  }
  if (ev.type === 'call') {
    c.ok(!W.between, 'no_number_between_rounds');
    c.ok(!W.paused, 'no_number_while_paused');
    c.eq(ev.callNo, W.roundCalls.length + 1, 'call_count_restarts_each_round');
    c.ok(ev.number >= 1 && ev.number <= 90 && !W.roundCalls.includes(ev.number), 'number_new_within_round');
    W.roundCalls.push(ev.number);
  }
  if (ev.type === 'moment_start') W.starts.push(ev);
  if (ev.type === 'moment_result') {
    W.results.push(ev);
    if (ev.kind === 'lucky') {
      c.ok(ev.winners.length <= e.settings.surprise.luckyWinners && new Set(ev.winners).size === ev.winners.length, 'lucky_winners_at_most_n_distinct');
      c.ok(ev.winners.every((x) => /^TMB-[A-Z]{1,4}-[A-Z0-9]+-\d{6}-A$/.test(x)), 'lucky_winners_shown_by_ticket_id', ev.winners);
    } else c.eq(ev.winningCards, Math.min(e.settings.surprise.scratchWinning, eligibleIds(W).length), 'exactly_n_winning_scratch_cards');
  }
  if (ev.type === 'lucky_won') { c.ok(eligibleIds(W).includes(ev.pid), 'lucky_winner_is_eligible'); W.toConfirm.push(ev); }
  if (ev.type === 'scratch_result') { const a = W.scratchOut.get(ev.momentId) ?? []; a.push([ev.pid, ev.outcome]); W.scratchOut.set(ev.momentId, a); }
  if (ev.type === 'booster') { c.ok(ev.boosters.joker >= 0 && ev.boosters.extra >= 0 && ev.boosters.pass >= 0, 'boosters_never_negative'); W.boost.set(ev.pid, { ...ev.boosters }); }
  if (ev.type === 'ended') W.ended = true;
}
function checkStill(W) {
  const c = W.c, s = W.e.sx.still();
  if (W.still) {
    c.ok(s.lucky <= W.still.lucky && s.scratch <= W.still.scratch, 'moment_counters_never_rise', { was: W.still, now: s });
    c.ok(s.prizes <= W.still.prizes, 'prize_counter_never_rises', { was: W.still.prizes, now: s.prizes });
  }
  c.ok(s.lucky >= 0 && s.scratch >= 0 && s.prizes >= 0, 'counters_never_below_zero');
  W.still = s;
}
function botsClaim(W, r) {
  const e = W.e, log = e.called;
  for (const pid of W.pids.concat(W.fam ? [W.fam] : [])) {
    const p = Pp(W, pid); if (!p) continue;
    p.tickets.forEach((t, i) => {
      const which = 'ABC'[i];
      for (const pattern of ['early5', 'top', 'full']) {
        if (claimVerdict([t], pattern, allN(t).filter((n) => log.includes(n)), log) !== 'ok') continue;
        const err = e.claim(pid, { ticket: which, pattern, cut: allN(t).filter((n) => log.includes(n)) });
        if (pid === W.victim && W.victimBlocked && W.round > 1) W.c.ok(err !== null, 'two_not_valid_block_for_the_whole_engagement');
      }
    });
  }
  // the victim presses Claim wrongly twice early in round 1
  if (W.round === 1 && !W.victimBlocked && log.length >= 3 && log.length < 14) {
    const err = e.claim(W.victim, { ticket: 'A', pattern: 'full', cut: [] });
    if (err === null) { W.victimTries = (W.victimTries ?? 0) + 1; }
  }
}
function sxCase(c, r, parts, tag) {
  const [, roundsS, luckyS, scratchS, nS, policy] = parts;
  const sur = { rounds: +roundsS, luckyDraws: +luckyS, luckyWinners: r.pick([1, 3, 5, 10]), bumper: r.chance(0.6), scratchCards: +scratchS, scratchWinning: r.pick([5, 10, 20, 50]),
    luckyPrize: r.pick(['gift', 'booster']), scratchPrize: r.pick(['gift', 'booster', 'mix']), boostersAllowed: r.chance(0.7), autoMark: r.chance(0.5), callSeconds: 6, momentsMode: 'auto' };
  const W = mkEngine(r, c, tag, { players: +nS, familyCanWin: r.chance(0.5), surprise: sur, family: true });
  const e = W.e;
  W.victim = W.pids[1];
  const st0 = e.sx.still();
  c.ok(st0.lucky === sur.luckyDraws && st0.scratch === sur.scratchCards && st0.prizes === sur.rounds * 3, 'counters_before_start_show_what_was_configured', st0);
  c.eq(e.start(), null, 'start');
  W.clk += EN.CFG.PRE_START_MS;
  let steps = 0, jokerTests = 0;
  const scratchSeen = new Set();
  while (e.status !== 'ended' && steps++ < 30000) {
    e.tick();
    if (e.status === 'ended') break;
    for (const x of W.toConfirm.splice(0)) if (policy === 'all' || (policy === 'some' && r.chance(0.5))) c.eq(e.confirmPresent(x.pid, x.momentId), null, 'lucky_winner_confirms_im_here');
    for (const s of W.starts.filter((m) => m.kind === 'scratch' && !scratchSeen.has(m.id))) {
      scratchSeen.add(s.id);
      for (const pid of eligibleIds(W)) if (r.chance(0.4)) { const res = e.revealScratch(pid, s.id); c.ok(typeof res === 'object', 'participant_can_scratch'); const again = e.revealScratch(pid, s.id); c.ok(typeof again === 'object' && again.outcome === res.outcome, 'scratching_again_shows_same_result'); }
    }
    if (e.status === 'started' && e.called.length > W.seen) {
      W.seen = e.called.length;
      botsClaim(W, r);
      if (W.victimTries >= 2 && !W.victimBlocked) { W.victimBlocked = true; }
      // a Joker: mark the one called number left uncut
      if (e.settings.surprise.boostersAllowed && jokerTests < 3) for (const pid of W.pids) {
        const p = Pp(W, pid); if (!(p.boosters.joker > 0)) continue;
        const own = allN(p.tickets[0]).filter((n) => e.called.includes(n)); if (!own.length) continue;
        jokerTests++;
        const j0 = p.boosters.joker;
        const all = e.useJoker(pid, 'A', own);
        c.ok(typeof all === 'string' && p.boosters.joker === j0, 'joker_not_used_when_nothing_to_mark');
        const miss = r.pick(own), res = e.useJoker(pid, 'A', own.filter((n) => n !== miss));
        c.ok(typeof res === 'object' && res.number === miss && p.boosters.joker === j0 - 1, 'joker_marks_the_called_uncut_number', { res, miss });
        break;
      }
    }
    checkStill(W);
    W.clk += 500;
  }
  c.eq(e.status, 'ended', 'engagement_ends_after_last_round');
  c.eq(e.sx.round, sur.rounds, 'every_round_played');
  c.eq(W.events.filter((x) => x.type === 'round_end').length, sur.rounds, 'one_round_end_per_round');
  const lr = W.results.filter((x) => x.kind === 'lucky'), sr = W.results.filter((x) => x.kind === 'scratch');
  c.eq(lr.length, sur.luckyDraws, 'every_lucky_draw_happens');
  c.eq(sr.length, sur.scratchCards, 'every_scratch_card_happens');
  const bump = W.results.filter((x) => x.bumper);
  if (sur.bumper && sur.luckyDraws > 0) { c.eq(bump.length, 1, 'one_bumper'); c.ok(W.results[W.results.length - 1]?.bumper === true, 'bumper_is_the_last_moment'); } else c.eq(bump.length, 0, 'no_bumper_unless_set');
  const fin = e.sx.still(); c.ok(fin.lucky === 0 && fin.scratch === 0, 'counters_reach_zero', fin);
  // lucky draws: "I'm here" within 60 s, one redraw
  const elig = eligibleIds(W).length;
  for (const x of e.sx.results.filter((y) => y.kind === 'lucky')) {
    c.ok(x.redraws <= 1, 'at_most_one_redraw');
    c.eq(new Set(x.winners.map((w) => w.pid)).size, x.winners.length, 'lucky_nobody_twice');
    c.ok(x.winners.every((w) => eligibleIds(W).includes(w.pid)), 'lucky_only_eligible_people');
    if (policy === 'all') { c.eq(x.redraws, 0, 'no_redraw_when_everyone_confirms'); c.eq(x.winners.length, Math.min(sur.luckyWinners, elig), 'lucky_draws_n_or_everyone'); }
    if (policy === 'none' && elig > 0) c.eq(x.redraws, 1, 'redraw_when_winners_do_not_confirm');
    if (!e.settings.surprise.boostersAllowed || e.settings.surprise.luckyPrize === 'gift') c.ok(x.winners.every((w) => w.prize === 'gift'), 'gift_prize_when_set');
  }
  // scratch cards: exactly N winning cards decided before anyone scratches, everyone eligible sees a result
  for (const s of W.starts.filter((m) => m.kind === 'scratch')) {
    const outs = W.scratchOut.get(s.id) ?? [];
    const per = new Map(); for (const [pid, o] of outs) per.set(pid, [...(per.get(pid) ?? []), o]);
    c.ok(eligibleIds(W).every((pid) => per.has(pid)), 'every_eligible_person_gets_a_card_result', s.id);
    c.ok([...per.values()].every((a) => a.length === 1), 'one_card_result_each');
    const wins = [...per.values()].map((a) => a[0]).filter((o) => o !== 'none');
    const k = Math.min(e.settings.surprise.scratchWinning, elig);
    c.eq(wins.length, k, 'exactly_n_winning_cards_revealed');
    const sp = e.settings.surprise.boostersAllowed ? e.settings.surprise.scratchPrize : 'gift';
    if (sp === 'gift') c.ok(wins.every((o) => o === 'gift'), 'scratch_gift_cards_only');
    if (sp === 'booster') c.ok(wins.every((o) => ['joker', 'extra', 'pass'].includes(o)), 'scratch_booster_cards_only');
    if (sp === 'mix') c.eq(wins.filter((o) => o === 'gift').length, Math.ceil(k / 2), 'scratch_half_and_half');
  }
  if (W.victimBlocked) c.ok(Pp(W, W.victim).blocked, 'victim_blocked_after_two_not_valid');
  const rep = e.report();
  c.eq(rep.roundsPlayed, sur.rounds, 'report_rounds_played');
  for (let k = 1; k <= sur.rounds; k++) c.ok(rep.winners.some((x) => x.round === k), 'report_has_winners_of_every_round', k);
  c.eq(rep.moments.length, sur.luckyDraws + sur.scratchCards, 'report_lists_every_moment');
}
function sxmCase(c, r, parts, tag) {
  const [, lS, sS, b] = parts;
  const sur = { rounds: 1, luckyDraws: +lS, luckyWinners: 3, bumper: b === 'bumper', scratchCards: +sS, scratchWinning: 5, luckyPrize: 'gift', scratchPrize: 'gift', boostersAllowed: true, autoMark: false, callSeconds: 6, momentsMode: 'manual' };
  const W = mkEngine(r, c, tag, { players: 8, familyCanWin: true, surprise: sur, callMode: 'manual' });
  const e = W.e;
  c.ok(e.triggerMoment('lucky') !== null, 'no_moment_before_live');
  e.start(); W.clk += EN.CFG.PRE_START_MS; e.tick();
  c.eq(e.status, 'started', 'live');
  e.draw();
  c.eq(e.emergency('Smoke pause'), null, 'pause');
  c.ok(e.triggerMoment('lucky') !== null && e.triggerMoment('scratch') !== null, 'no_moment_while_paused');
  e.resume();
  const pend = { lucky: sur.luckyDraws, scratch: sur.scratchCards };
  for (let i = 0; i < 8; i++) {
    const kind = r.pick(['lucky', 'scratch']);
    const otherPending = pend.lucky + pend.scratch - 1;
    // the bumper (when set) is the last lucky draw and may only open when it is the very last moment
    const bumperLeftOnly = sur.bumper && pend.lucky === 1;
    const can = kind === 'scratch' ? pend.scratch > 0 : pend.lucky > 0 && (!bumperLeftOnly || otherPending === 0);
    const err = e.triggerMoment(kind);
    c.eq(err === null, can, 'manual_moment_allowed_exactly_when_rules_allow', { kind, pend, bumper: sur.bumper });
    if (err !== null) continue;
    pend[kind]--;
    for (let s = 0; s < 400 && e.paused; s++) { for (const x of W.toConfirm.splice(0)) e.confirmPresent(x.pid, x.momentId); W.clk += 500; e.tick(); }
    c.ok(!e.paused, 'moment_finishes');
  }
  if (pend.lucky + pend.scratch === 0) { c.ok(e.triggerMoment('lucky') !== null && e.triggerMoment('scratch') !== null, 'nothing_when_none_left'); if (sur.bumper && sur.luckyDraws) c.ok(W.results[W.results.length - 1]?.bumper === true, 'bumper_last_in_manual_mode'); }
  checkStill(W);
}
function jokerCase(c, r, parts, tag) {
  const [, state, which] = parts;
  const W = mkEngine(r, c, tag, { players: 3, familyCanWin: true, ticketMode: 'double', callMode: 'manual', surprise: { boostersAllowed: state !== 'off' } });
  const e = W.e;
  e.start(); W.clk += EN.CFG.PRE_START_MS; e.tick();
  const p = e.participants[0], t = p.tickets[which === 'A' ? 0 : 1];
  for (let i = 0; i < 90 && allN(t).filter((n) => e.called.includes(n)).length < 3; i++) e.draw();
  const own = allN(t).filter((n) => e.called.includes(n));
  p.boosters.joker = state === 'none_left' ? 0 : 1; // fixture: the participant holds one Joker (boosters come from draws and cards)
  const miss = shuffle(r, own.slice()).slice(0, r.int(1, own.length));
  const cut = state === 'all_cut' ? own : own.filter((n) => !miss.includes(n));
  const res = e.useJoker(p.id, which, cut);
  if (state === 'missed') { c.ok(typeof res === 'object' && miss.includes(res.number), 'joker_marks_a_called_uncut_number_of_that_ticket', { res, miss }); c.eq(p.boosters.joker, 0, 'joker_used_up'); }
  else { c.ok(typeof res === 'string', 'joker_refused', state); c.eq(p.boosters.joker, state === 'none_left' ? 0 : 1, 'joker_not_consumed_when_refused'); }
  c.ok(typeof e.useJoker(p.id, 'C', cut) === 'string', 'joker_on_ticket_not_held_refused');
}

// ================================================================ one case
export async function runCase(w, idx, seed) {
  const cell = CELLS[idx % CELLS.length], parts = cell.split('|');
  const r = rng(seed, idx), c = new Case(), tag = `${String(seed).replace(/\W/g, '')}n${idx}`;
  try {
    ({ ptk: ptkCase, late: lateCase, unlucky: unluckyCase, lucky: luckyCase, lround: lroundCase, quorum: quorumCase, sx: sxCase, sxm: sxmCase, joker: jokerCase })[parts[0]](c, r, parts, tag);
  } catch (err) { c.ok(false, 'no_exception', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ')); }
  return { cell, c };
}
