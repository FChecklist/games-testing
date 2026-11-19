// Corporate Snakes and Ladders: seeded, deterministic, in-process smoke suite. Same harness contract as suites/tambola.js (CELLS, newWorld, runCase).
// Code under test: SUITE_ROOT/sc/corporate-snakes-and-ladders (public head 5193f8b), packages/beacon, packages/shared, packages/billing, apps/edge/src/credit.ts (pure parts).
// Loaded by plain node with lib/tsresolve.js (no bun, no build, no network). The product source is only read.
//
// Lifecycle steps and the cells that cover them (explicit matrix; every cell is hit by idx % CELLS.length):
//   board   fair board per seat: legal snakes/ladders, equally hard, sealed by B0         board|size|finish|snakes, board|b0|sealed, board|cfg|rejects
//   dice    sealed dice, fate tie-break numbers, seat ids, spectators                       dice|*, seat|*
//   move    one throw: ladders, snakes, overshoot, exact finish                             move|finish|size|kind
//   round   a whole race per turn: positions, end rule, strict ranking, determinism         run|play|size|finish
//   prize   milestone, 1st-5th home, climb, comeback, never missed; one winner per line    prize|play|exclusive|endPrizes|milestones
//   team    team race: fair deal, team ranking, team prizes                                 team|teams|sizes|play
//   table   table mode: one shared board, sealed turn order                                 table|players|winners
//   lucky   lucky draws in breaks (draw or scratch reveal), removals, hosts                 lucky|*
//   sched   when turns open: breaks, pauses, stop                                           sched|breaks|control|window
//   vote    how many phones must agree on a result (quorum)                                 vote|people
//   money   pack prices, GST split, credit expiry, rupee text                               price|*, credit|*
//   wording prize names, ranks, house texts, rank notes, spectator view, throw record       word|*, view|*, throw|*
// NOT in this game (so no cells): per-round restarts (one round only), late joiners (nobody joins after the start), Unlucky / consolation prize,
// Joker / Extra ticket / booster items, manual "start moment" mode. Reachable only with a database (not covered): the vote counting itself
// (apps/edge/src/winners.ts acceptVotes), applying credit to a game (credit.ts creditFromPayment / spend), payment capture. Scratch cards exist only as the reveal
// style of a lucky draw (BreakCfg.style); the winners come from luckyWinners either way, which lucky|* covers.
import '../lib/tsresolve.js';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { imp, ROOT } from '../lib/roots.js';

const REPO = existsSync(resolve(ROOT, 'sc/corporate-snakes-and-ladders')) ? 'sc/corporate-snakes-and-ladders' : 'corporate-snakes-and-ladders';
const R = (p) => imp(`${REPO}/${p}`);
const BD = await R('packages/beacon/src/board.ts');
const PL = await R('packages/beacon/src/play.ts');
const RC = await R('packages/beacon/src/race.ts');
const TB = await R('packages/beacon/src/table.ts');
const VW = await R('packages/beacon/src/view.ts');
const CF = await R('packages/beacon/src/config.ts');
const GM = await R('packages/beacon/src/game.ts');
const SC = await R('packages/beacon/src/schedule.ts');
const SE = await R('packages/beacon/src/seat.ts');
const PR = await R('packages/shared/src/pricing.ts');
const BL = await R('packages/billing/src/index.ts');
const CR = await R('apps/edge/src/credit.ts');

const J = JSON.stringify;
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const SIZES = [100, 144, 225], FIN = ['exact', 'pass'];
const GIDS = ['SA', 'SB', 'SC', 'SD', 'SE', 'SF']; // a small pool of games keeps boards cached (a board costs about 30 ms)
const b0Of = (gid) => sha(`B0|${gid}`);
const hex = (r) => Array.from({ length: 64 }, () => '0123456789abcdef'[r.int(0, 15)]).join('');
const bag = (r, n) => Array.from({ length: n }, () => hex(r));
const squareOf = (x) => (x.pos.length ? x.pos[x.pos.length - 1] : 1);
const ord = (n) => { const m = n % 100; const s = m >= 11 && m <= 13 ? 'th' : ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][n % 10]; return `${n}${s}`; };
const shuffle = (r, a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = r.int(0, i); [x[i], x[j]] = [x[j], x[i]]; } return x; };

// ================================================================ cells
const PATTERNS = ['milestone', 'finish', 'team', 'climb', 'comeback', 'nevermissed'];
const PEOPLE = [2, 3, 4, 5, 6, 7, 12, 13, 60, 200, 500, 2500, 10000];
export const CELLS = [
  ...cross(['board'], SIZES, FIN, [6, 9, 12]).map((c) => c.join('|')),
  'board|b0|sealed', 'board|cfg|rejects',
  ...['range', 'uniform', 'sealed', 'det', 'fate'].map((k) => `dice|${k}`),
  ...['pid_valid', 'pid_invalid', 'role', 'second_round'].map((k) => `seat|${k}`),
  ...cross(['move'], FIN, SIZES, ['ladder', 'snake', 'overshoot', 'finish', 'plain']).map((c) => c.join('|')),
  ...cross(['run'], ['fate', 'presence'], SIZES, FIN).map((c) => c.join('|')),
  ...cross(['prize'], ['fate', 'presence'], ['incl', 'excl'], [1, 3, 5], [0, 1, 3]).map((c) => c.join('|')),
  ...cross(['team'], [2, 3, 5, 10], ['even', 'uneven'], ['fate', 'presence']).map((c) => c.join('|')),
  ...cross(['table'], [2, 5, 12, 20], [1, 2, 3]).map((c) => c.join('|')),
  ...cross(['lucky'], [1, 3, 5, 10], [2, 10, 60], ['plain', 'dups', 'ex', 'removed']).map((c) => c.join('|')),
  'lucky|fair',
  ...cross(['sched'], ['0', '1', '3'], ['none', 'pause', 'stop'], [15, 20, 25, 30]).map((c) => c.join('|')),
  ...PEOPLE.map((p) => `vote|${p}`), 'vote|monotone',
  ...cross(['price'], ['INR', 'USD'], PR.PACKS.map((p) => p[0])).map((c) => c.join('|')),
  'price|packs|table', 'price|unknown_pack', 'price|breaks', 'price|gst|split',
  ...['random', 'ist_edge', 'leap', 'text_inr', 'text_usd'].map((k) => `credit|${k}`),
  ...PATTERNS.map((p) => `word|name|${p}`), 'word|rank|small', 'word|rank|teens', 'word|houses', 'word|ranknote|finishers', 'word|ranknote|nonfinishers',
  ...['race', 'team', 'table'].map((k) => `view|${k}`),
  ...['ok', 'wrong_device', 'early', 'edge_open', 'edge_close', 'late', 'dup', 'unknown_seat'].map((k) => `throw|${k}`),
];
export async function newWorld() { return {}; }

// ================================================================ independent oracles
const boardCache = new Map();
function boardFor(gid, seat, cfg) {
  const k = `${gid}|${seat}|${J(cfg)}`;
  let b = boardCache.get(k); if (!b) { if (boardCache.size > 4000) boardCache.clear(); b = BD.generateBoard(gid, seat, b0Of(gid), cfg); boardCache.set(k, b); }
  return b;
}
/** The result of one throw, written from the rules in the SPEC (landing on a head or a bottom moves you; exact finish). */
function expStep(b, from, roll, finish) {
  const t = from + roll;
  if (t > b.size) return finish === 'pass' ? { to: b.size, kind: 'finish' } : { to: from, kind: 'overshoot' };
  if (t === b.size) return { to: t, kind: 'finish' };
  if (b.ladders[t] !== undefined) return { to: b.ladders[t], kind: 'ladder' };
  if (b.snakes[t] !== undefined) return { to: b.snakes[t], kind: 'snake' };
  return { to: t, kind: 'move' };
}
/** A whole player run from the dice: positions per turn, finish turn, ladders, snakes, missed, best climb, best comeback. */
function sim2(b, seat, gid, betas, finish, throws) {
  let pos = 1, fin = null, lad = 0, sn = 0, missed = 0, climb = 0, come = 0; const ps = [], pend = [];
  for (let t = 0; t < betas.length; t++) {
    if (fin !== null) { ps.push(pos); continue; }
    if (!throws(seat, t)) { missed++; ps.push(pos); continue; }
    const roll = PL.rollFor(gid, seat, t, betas[t]), land = pos + roll, e = expStep(b, pos, roll, finish), before = pos;
    if (e.kind === 'ladder') { lad++; climb = Math.max(climb, e.to - land); }
    if (e.kind === 'snake') { sn++; pend.push({ before, drop: land - e.to }); }
    pos = e.to; ps.push(pos);
    if (pos === b.size) fin = t;
    for (let i = pend.length - 1; i >= 0; i--) if (pos >= pend[i].before) { come = Math.max(come, pend[i].drop); pend.splice(i, 1); }
  }
  return { ps, fin, lad, sn, missed, climb, come };
}
/** Every consecutive pair of squares must be explainable by one throw of 1 to 6 (or a missed / overshot / finished turn). */
function legalMoves(c, b, ps, finish, tag) {
  let prev = 1;
  for (const p of ps) {
    c.ok(Number.isInteger(p) && p >= 1 && p <= b.size, 'position_on_the_board', `${tag} ${p}`);
    if (p !== prev) {
      let ok = false;
      for (let r = 1; r <= 6; r++) { const e = expStep(b, prev, r, finish); if (e.to === p && e.to !== prev) ok = true; }
      c.ok(ok, 'move_is_one_legal_throw', `${tag} ${prev}->${p}`);
      c.ok(prev !== b.size, 'finished_pawn_never_moves', tag);
    }
    prev = p;
  }
}
function boardChecks(c, b, cfg, tag) {
  const side = Math.round(Math.sqrt(cfg.size)), f = side / 10;
  const minR = Math.ceil(8 * f), maxR = Math.floor(30 * f), minD = Math.ceil(8 * f), maxD = Math.floor(40 * f);
  const sn = Object.entries(b.snakes).map(([k, v]) => [+k, v]), ld = Object.entries(b.ladders).map(([k, v]) => [+k, v]);
  c.eq(sn.length, cfg.snakes, 'board_has_the_asked_number_of_snakes', tag); c.eq(ld.length, cfg.ladders, 'board_has_the_asked_number_of_ladders', tag);
  const used = new Set(); let dup = false; const use = (x) => { if (used.has(x)) dup = true; used.add(x); };
  for (const [h, t] of sn) { use(h); use(t); c.ok(h > 1 && h < cfg.size && t >= 1 && t < h && h - t >= minD && h - t <= maxD, 'snake_is_legal', `${tag} ${h}->${t}`); }
  for (const [bo, t] of ld) { use(bo); use(t); c.ok(bo > 1 && t < cfg.size && t > bo && t - bo >= minR && t - bo <= maxR, 'ladder_is_legal', `${tag} ${bo}->${t}`); }
  c.ok(!dup, 'no_square_used_twice', tag);
  c.eq(BD.boardProblem(b), null, 'product_accepts_its_own_board', tag);
  // every square can still reach the end (own reverse search)
  const n = cfg.size, rev = Array.from({ length: n + 1 }, () => []);
  for (let s = 1; s < n; s++) for (let r = 1; r <= 6; r++) { const e = expStep(b, s, r, cfg.finish); if (e.to !== s) rev[e.to].push(s); }
  const seen = new Set([n]), q = [n]; while (q.length) { const x = q.pop(); for (const p of rev[x]) if (!seen.has(p)) { seen.add(p); q.push(p); } }
  let trapped = 0; for (let s = 1; s < n; s++) if (!seen.has(s) && b.snakes[s] === undefined && b.ladders[s] === undefined) trapped++;
  c.eq(trapped, 0, 'nobody_is_trapped', tag);
  // equally hard: expected turns by own value iteration, chance to finish within the window by own distribution walk
  let E = new Float64Array(n + 1);
  for (let it = 0; it < 30000; it++) { let d = 0; for (let s = n - 1; s >= 1; s--) { let v = 1; for (let r = 1; r <= 6; r++) { const e = expStep(b, s, r, cfg.finish); v += (e.to === n ? 0 : E[e.to]) / 6; } d = Math.max(d, Math.abs(v - E[s])); E[s] = v; } if (d < 1e-9) break; }
  const target = cfg.size === 144 ? 54 : cfg.size === 225 ? 80 : 40;
  c.ok(E[1] >= target * 0.95 - 1e-6 && E[1] <= target * 1.05 + 1e-6, 'expected_turns_inside_5_percent_band', `${tag} ${E[1].toFixed(3)} target ${target}`);
  c.ok(Math.abs(E[1] - b.expectedTurns) < 1e-4, 'stored_expected_turns_is_true', `${tag} ${E[1]} vs ${b.expectedTurns}`);
  let dist = new Float64Array(n + 1); dist[1] = 1; const win = cfg.size === 144 ? 30 : cfg.size === 225 ? 52 : 20;
  for (let t = 0; t < win; t++) { const nd = new Float64Array(n + 1); nd[n] = dist[n]; for (let s = 1; s < n; s++) if (dist[s]) for (let r = 1; r <= 6; r++) nd[expStep(b, s, r, cfg.finish).to] += dist[s] / 6; dist = nd; }
  c.ok(dist[n] >= 0.07 - 1e-9 && dist[n] <= 0.25 + 1e-9, 'finish_within_window_chance_in_band', `${tag} ${dist[n].toFixed(4)}`);
}

// ================================================================ race builder
function raceOf(r, o) {
  const gid = o.gid ?? r.pick(GIDS), b0 = b0Of(gid), nb = o.nb ?? r.int(1, o.cap + 4);
  const betas = bag(r, nb), p = r.pick([0.5, 0.8, 0.95]);
  const th = Array.from({ length: nb }, () => Array.from({ length: o.players }, () => r.chance(p)));
  const thrown = (s, t) => !!th[t]?.[s - 1];
  const cfg = { ...RC.defaultRaceCfg(gid, o.players), board: { size: o.size, snakes: 9, ladders: 9, finish: o.finish }, play: o.play, turnCap: o.cap, endPrizes: o.endPrizes, exclusive: !!o.exclusive, milestones: o.ms ?? [75], ...(o.teams ? { teams: o.teams } : {}) };
  const input = { b0, betas, thrown };
  const st = RC.playRace(cfg, input);
  const throws = (s, t) => cfg.play === 'fate' || thrown(s, t);
  const sims = st.boards.map((b, i) => sim2(b, i + 1, gid, betas, o.finish, throws));
  return { cfg, input, st, sims, betas, thrown, gid, b0, throws };
}
function endOracle(cfg, sims, nb, teamOf) {
  for (let t = 0; t < nb; t++) {
    let done;
    if (cfg.teams) { const m = new Map(); sims.forEach((s, i) => { const k = teamOf[i]; const a = m.get(k) ?? { n: 0, d: 0 }; a.n++; if (s.fin !== null && s.fin <= t) a.d++; m.set(k, a); }); done = [...m.values()].some((a) => a.n > 0 && a.d === a.n); }
    else done = sims.filter((s) => s.fin !== null && s.fin <= t).length >= cfg.endPrizes;
    if (done) return { turns: t + 1, ended: true, reason: 'finishers' };
    if (t + 1 >= cfg.turnCap) return { turns: t + 1, ended: true, reason: 'cap' };
  }
  return { turns: nb, ended: false, reason: 'running' };
}
function compareRace(c, x, tag) {
  const { cfg, st, sims, betas } = x;
  c.eq(st.runs.length, cfg.players, 'one_pawn_per_player', tag);
  const eo = endOracle(cfg, sims, betas.length, cfg.teams ? RC.teamsOf(cfg, x.b0) : null);
  c.eq(st.turnsPlayed, eo.turns, 'turns_played_match_the_end_rule', tag); c.eq(st.ended, eo.ended, 'game_ends_exactly_by_the_end_rule', tag); c.eq(st.endReason, eo.reason, 'end_reason_is_right', tag);
  c.ok(st.turnsPlayed <= cfg.turnCap, 'turn_cap_never_exceeded', tag);
  sims.forEach((s, i) => {
    const run = st.runs[i], seat = i + 1;
    const upto = s.ps.slice(0, eo.turns);
    c.eq(J(run.pos), J(upto), 'positions_match_independent_replay', `${tag} seat ${seat}`);
    // the product stops at the end turn; the oracle walked every beta, so compare only what was played
    const fin = s.fin !== null && s.fin < eo.turns ? s.fin : null;
    c.eq(run.finishedTurn, fin, 'finish_turn_matches', `${tag} seat ${seat}`);
    const sub = sim2(st.boards[i], seat, cfg.gameId, x.betas.slice(0, eo.turns), cfg.board.finish, x.throws);
    c.eq(run.ladders, sub.lad, 'ladders_counted_exactly', `${tag} seat ${seat}`); c.eq(run.snakes, sub.sn, 'snakes_counted_exactly', `${tag} seat ${seat}`);
    c.eq(run.missed, sub.missed, 'missed_turns_counted_exactly', `${tag} seat ${seat}`); c.eq(run.bestClimb, sub.climb, 'best_climb_exact', `${tag} seat ${seat}`); c.eq(run.bestComeback, sub.come, 'best_comeback_exact', `${tag} seat ${seat}`);
    legalMoves(c, st.boards[i], run.pos, cfg.board.finish, `${tag} seat ${seat}`);
    c.eq(BD.boardProblem(st.boards[i]), null, 'every_seat_board_is_legal', `${tag} seat ${seat}`);
  });
  c.eq(st.finishedCount, st.runs.filter((q) => q.finishedTurn !== null).length, 'finished_count_is_true', tag);
}
function replayChecks(c, x, tag) {
  const again = RC.playRace(x.cfg, x.input);
  c.eq(J(again.runs.map((q) => [q.pos, q.finishedTurn, q.ladders, q.missed])), J(x.st.runs.map((q) => [q.pos, q.finishedTurn, q.ladders, q.missed])), 'replay_is_identical', tag);
  const k = Math.max(1, Math.floor(x.st.turnsPlayed / 2)), part = RC.playRace(x.cfg, { ...x.input, betas: x.betas.slice(0, k) });
  part.runs.forEach((q, i) => c.eq(J(q.pos), J(x.st.runs[i].pos.slice(0, q.pos.length)), 'earlier_state_is_a_prefix_of_later_state', `${tag} seat ${i + 1}`));
  return { k, part };
}
/** The strict order of everybody, written from the SPEC chain: earlier finish, higher square, more ladders, fewer missed turns, fate. */
function rankChecks(c, x, tag) {
  const { st, cfg } = x, all = RC.orderPlayers(st);
  c.eq(J(all.map((q) => q.seat).sort((a, b) => a - b)), J(st.runs.map((q) => q.seat)), 'order_is_a_permutation_of_everyone', tag);
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1], b = all[i], fa = a.finishedTurn ?? Infinity, fb = b.finishedTurn ?? Infinity;
    let ok;
    if (fa !== fb) ok = fa < fb; else if (squareOf(a) !== squareOf(b)) ok = squareOf(a) > squareOf(b); else if (a.ladders !== b.ladders) ok = a.ladders > b.ladders; else if (a.missed !== b.missed) ok = a.missed < b.missed; else ok = PL.fateOf(cfg.gameId, a.seat, 'rank') < PL.fateOf(cfg.gameId, b.seat, 'rank');
    c.ok(ok, 'ranking_follows_the_documented_chain_no_ties', `${tag} ${a.seat} before ${b.seat}`);
  }
  const rows = RC.rankPlayers(st, 10);
  rows.forEach((row, i) => { c.eq(row.rank, i + 1, 'rank_numbers_are_consecutive', tag); c.eq(row.seat, all[i].seat, 'rank_rows_follow_the_order', tag); });
  const fin = all.filter((q) => q.finishedTurn !== null);
  c.ok(all.slice(0, fin.length).every((q) => q.finishedTurn !== null), 'finishers_rank_above_everyone_else', tag);
  return rows;
}

// ================================================================ prizes (properties, not a copy of the code)
const pidOf = (s) => `p${s}`;
function linesFor(r, cfg, ms) {
  const L = [];
  for (let k = 1; k <= cfg.endPrizes; k++) L.push({ pattern: 'finish', ordinal: k, text: '' });
  ms.forEach((_, i) => L.push({ pattern: 'milestone', ordinal: i + 1, text: '' }));
  L.push({ pattern: 'climb', ordinal: 1, text: '' }, { pattern: 'comeback', ordinal: 1, text: '' }, { pattern: 'nevermissed', ordinal: 1, text: '' });
  return cfg.exclusive ? shuffle(r, L) : L;
}
function settleChecks(c, x, lines, tag) {
  const { st, cfg, sims } = x, ended = st.ended, exclusive = cfg.exclusive;
  const res = RC.settleRace(st, lines, pidOf), res2 = RC.settleRace(st, lines, pidOf);
  c.eq(J(res), J(res2), 'settlement_is_deterministic', tag);
  const keys = res.map((q) => `${q.pattern}#${q.ordinal}`);
  c.eq(new Set(keys).size, keys.length, 'each_reward_line_has_at_most_one_result', tag);
  const seatOf = (pid) => +pid.slice(1), allPids = res.flatMap((q) => q.pids);
  if (exclusive) c.eq(new Set(allPids).size, allPids.length, 'no_player_wins_two_prizes_when_exclusive', tag);
  { const ps = res.filter((q) => q.pattern === 'finish').flatMap((q) => q.pids); c.eq(new Set(ps).size, ps.length, 'no_player_takes_two_finish_places', tag); }
  c.ok(res.every((q) => q.pids.length === 1), 'a_solo_prize_has_one_winner', tag);
  const runs = st.runs, ms = [...cfg.milestones].sort((a, b) => a - b);
  const reach = (i, m) => runs[i].pos.findIndex((p) => p >= m);
  const eligible = (l) => {
    if (l.pattern === 'finish') return runs.filter((q) => q.finishedTurn !== null).map((q) => q.seat);
    if (l.pattern === 'milestone') return runs.filter((q, i) => reach(i, ms[l.ordinal - 1]) >= 0).map((q) => q.seat);
    if (!ended) return [];
    if (l.pattern === 'climb') return runs.filter((q) => q.bestClimb > 0).map((q) => q.seat);
    if (l.pattern === 'comeback') return runs.filter((q) => q.bestComeback > 0).map((q) => q.seat);
    return cfg.play === 'presence' ? runs.filter((q) => q.missed === 0).map((q) => q.seat) : [];
  };
  if (exclusive && !ended) { c.eq(res.length, 0, 'exclusive_game_pays_nothing_before_it_ends', tag); return res; }
  const won = new Set(allPids.map(seatOf));
  for (const l of lines) {
    const got = res.find((q) => q.pattern === l.pattern && q.ordinal === l.ordinal), el = eligible(l), name = `${l.pattern}#${l.ordinal}`;
    if (!got) {
      if (exclusive) c.ok(el.every((s) => won.has(s)), 'no_line_left_empty_while_an_unpaid_player_qualifies', `${tag} ${name}`);
      else if (l.pattern === 'finish') c.ok(el.length < l.ordinal, 'finish_place_filled_when_enough_players_are_home', `${tag} ${name} home ${el.length}`);
      else c.eq(el.length, 0, 'prize_awarded_when_somebody_qualifies', `${tag} ${name}`);
      continue;
    }
    const s = seatOf(got.pids[0]), q = runs[s - 1];
    c.ok(el.includes(s), 'winner_really_qualifies', `${tag} ${name} seat ${s}`);
    if (exclusive) continue;
    if (l.pattern === 'milestone') {
      const m = ms[l.ordinal - 1], rs = runs.map((_, i) => reach(i, m)).filter((t) => t >= 0), best = Math.min(...rs);
      c.eq(reach(s - 1, m), best, 'milestone_goes_to_the_earliest_arrival', `${tag} ${name}`); c.eq(got.idx, best, 'milestone_turn_is_reported_right', `${tag} ${name}`);
    } else if (l.pattern === 'finish') {
      const fins = runs.filter((z) => z.finishedTurn !== null).map((z) => z.finishedTurn).sort((a, b) => a - b);
      c.eq(q.finishedTurn, fins[l.ordinal - 1], 'kth_home_wins_kth_place', `${tag} ${name}`); c.eq(got.idx, q.finishedTurn, 'finish_turn_is_reported_right', `${tag} ${name}`);
      for (const z of runs) {
        if (z.finishedTurn === null || won.has(z.seat)) continue;
        const better = z.finishedTurn < q.finishedTurn || (z.finishedTurn === q.finishedTurn && (z.ladders > q.ladders || (z.ladders === q.ladders && z.missed < q.missed)));
        c.ok(!better, 'nobody_better_is_passed_over_for_a_place', `${tag} ${name} seat ${z.seat} over ${s}`);
      }
    } else if (l.pattern === 'climb') c.eq(q.bestClimb, Math.max(...runs.map((z) => z.bestClimb)), 'climb_goes_to_the_biggest_ladder', `${tag}`);
    else if (l.pattern === 'comeback') c.eq(q.bestComeback, Math.max(...runs.map((z) => z.bestComeback)), 'comeback_goes_to_the_biggest_recovered_snake', `${tag}`);
    else c.eq(q.missed, 0, 'never_missed_winner_missed_nothing', `${tag}`);
  }
  if (cfg.play === 'fate') c.ok(!res.some((q) => q.pattern === 'nevermissed'), 'never_missed_only_exists_in_presence_play', tag);
  return res;
}
/** A winner announced earlier must still be the winner when the game goes on (nobody is told "you won" and then loses it). */
function stabilityChecks(c, x, lines, tag) {
  const { cfg, betas } = x; if (cfg.exclusive || betas.length < 4) return;
  const full = RC.settleRace(x.st, lines, pidOf);
  for (const k of [Math.floor(betas.length / 3), Math.floor(betas.length / 2), betas.length - 1]) {
    if (k < 1) continue;
    const part = RC.playRace(cfg, { ...x.input, betas: betas.slice(0, k) });
    for (const q of RC.settleRace(part, lines, pidOf)) {
      if (q.pattern !== 'finish' && q.pattern !== 'milestone') continue;
      const later = full.find((z) => z.pattern === q.pattern && z.ordinal === q.ordinal);
      c.ok(!!later && J(later.pids) === J(q.pids), q.pattern === 'milestone' ? 'milestone_winner_does_not_change_as_the_game_goes_on' : 'finish_winner_does_not_change_as_the_game_goes_on', `${tag} ${q.pattern}#${q.ordinal} at turn ${k}: ${q.pids} then ${later?.pids}`);
    }
  }
}

// ================================================================ cases
function boardCase(c, r, p) {
  const size = +p[1], finish = p[2], n = +p[3], cfg = { size, snakes: n, ladders: n, finish }, gid = `BG${r.int(1, 1e9)}`, seat = r.int(1, 400), b0 = hex(r);
  const b = BD.generateBoard(gid, seat, b0, cfg), b2 = BD.generateBoard(gid, seat, b0, cfg);
  boardChecks(c, b, cfg, `${size}/${finish}/${n}`);
  c.eq(J(b), J(b2), 'same_inputs_make_the_same_board');
  const o = BD.generateBoard(gid, seat + 1, b0, cfg);
  c.ok(BD.boardKey(o) !== BD.boardKey(b), 'each_seat_has_its_own_board');
  c.ok(Math.abs(o.expectedTurns - b.expectedTurns) <= 0.1 * b.expectedTurns + 1e-9, 'every_seat_is_about_equally_hard');
}
function boardSealed(c, r) {
  const gid = `BS${r.int(1, 1e9)}`, a = hex(r), b = hex(r), cfg = { size: 100, snakes: 9, ladders: 9, finish: 'exact' };
  c.ok(BD.boardKey(BD.generateBoard(gid, 1, a, cfg)) !== BD.boardKey(BD.generateBoard(gid, 1, b, cfg)), 'board_depends_on_the_published_b0');
  c.eq(J(BD.generateBoard(gid, 1, a.toUpperCase(), cfg)), J(BD.generateBoard(gid, 1, a, cfg)), 'b0_case_does_not_change_the_board');
  for (const bad of ['', 'zz', a.slice(1), a + '0', 'g'.repeat(64)]) { let t = false; try { BD.generateBoard(gid, 1, bad, cfg); } catch { t = true; } c.ok(t, 'board_cannot_be_made_without_a_real_b0', bad.slice(0, 6)); }
}
function boardRejects(c) {
  const bad = [{ size: 99, snakes: 9, ladders: 9, finish: 'exact' }, { size: 100, snakes: 5, ladders: 9, finish: 'exact' }, { size: 100, snakes: 9, ladders: 13, finish: 'exact' }];
  for (const b of bad) { let t = false; try { BD.generateBoard('X', 1, b0Of('X'), b); } catch { t = true; } c.ok(t, 'illegal_board_settings_are_refused', J(b)); }
  c.eq(RC.validateRaceCfg({ ...RC.defaultRaceCfg('X', 1) }) !== null, true, 'one_player_game_is_refused');
  c.eq(RC.validateRaceCfg({ ...RC.defaultRaceCfg('X', 10001) }) !== null, true, 'more_than_10000_players_refused');
  c.eq(RC.validateRaceCfg({ ...RC.defaultRaceCfg('X', 5), endPrizes: 6 }) !== null, true, 'more_than_5_end_prizes_refused');
  c.eq(RC.validateRaceCfg({ ...RC.defaultRaceCfg('X', 5), milestones: [10, 10] }) !== null, true, 'duplicate_milestones_refused');
  c.eq(RC.validateRaceCfg({ ...RC.defaultRaceCfg('X', 5), milestones: [100] }) !== null, true, 'milestone_on_last_square_refused');
  c.eq(RC.validateRaceCfg({ ...RC.defaultRaceCfg('X', 5), teams: 6 }) !== null, true, 'more_teams_than_players_refused');
}
function diceCase(c, r, k) {
  const g = r.pick(GIDS);
  if (k === 'range') for (let i = 0; i < 40; i++) { const v = PL.rollFor(g, r.int(1, 99), r.int(0, 149), hex(r)); c.ok(Number.isInteger(v) && v >= 1 && v <= 6, 'roll_is_1_to_6', v); }
  if (k === 'uniform') { const cnt = [0, 0, 0, 0, 0, 0, 0]; const bt = hex(r); for (let i = 0; i < 1200; i++) cnt[PL.rollFor(g, i + 1, 3, bt)]++; for (let f = 1; f <= 6; f++) c.ok(cnt[f] >= 120 && cnt[f] <= 280, 'dice_are_fair_over_1200_throws', `face ${f}: ${cnt[f]}`); }
  if (k === 'sealed') {
    for (const bad of ['', 'zz', 'a'.repeat(63), 'a'.repeat(65), 'x'.repeat(64)]) { let t = false; try { PL.rollFor(g, 1, 0, bad); } catch { t = true; } c.ok(t, 'no_roll_without_a_published_beacon_value', bad.length); }
    let t = false; try { PL.rollFor(g, 1, -1, hex(r)); } catch { t = true; } c.ok(t, 'negative_turn_refused');
    const h = hex(r); c.eq(PL.rollFor(g, 3, 4, h), PL.rollFor(g, 3, 4, h.toUpperCase()), 'beacon_value_case_does_not_change_the_roll');
  }
  if (k === 'det') { const h = hex(r); c.eq(PL.rollFor(g, 3, 4, h), PL.rollFor(g, 3, 4, h), 'same_inputs_same_roll'); const s = new Set(); for (let i = 0; i < 30; i++) s.add(PL.rollFor(g, 1 + i, 4, h)); c.ok(s.size > 1, 'rolls_depend_on_the_seat'); const t = new Set(); for (let i = 0; i < 30; i++) t.add(PL.rollFor(g, 1, i, h)); c.ok(t.size > 1, 'rolls_depend_on_the_turn'); }
  if (k === 'fate') { const a = PL.fateOf(g, 3, 'rank'); c.eq(a, PL.fateOf(g, 3, 'rank'), 'fate_is_deterministic'); c.ok(/^[0-9a-f]{64}$/.test(a), 'fate_is_64_hex'); c.ok(a !== PL.fateOf(g, 4, 'rank') && a !== PL.fateOf(g, 3, 'finish') && a !== PL.fateOf('SZ', 3, 'rank'), 'fate_depends_on_seat_label_and_game'); }
}
function seatCase(c, r, k) {
  if (k === 'pid_valid') { const s = r.int(1, 9999999), p = `${s}x${hex(r).slice(0, r.int(8, 30))}`; c.eq(SE.seatOfPid(p), s, 'seat_is_read_from_the_player_id', p); }
  if (k === 'pid_invalid') for (const p of ['0xabcdef12', 'xabcdef12', '7xabc', '7x', '12345678x' + 'a'.repeat(8), '7xABCDEF12', '-3xabcdef12', '', '7abcdef12', ' 7xabcdef12']) c.eq(SE.seatOfPid(p), null, 'a_bad_player_id_has_no_seat', p);
  if (k === 'role') { c.eq(VW.mayThrow('player'), true, 'players_may_throw'); c.eq(VW.mayThrow('spectator'), false, 'spectators_never_throw'); }
  if (k === 'second_round') { // one round only: no second round and no intermission, and nobody joins after the start
    c.eq(CF.MAX_ROUNDS, 1, 'one_round_only'); c.eq(GM.callRoundR(null, 1000, 9, [], 2, 3), null, 'second_round_has_no_turns'); c.eq(GM.activeIntermission(), null, 'no_intermission'); c.eq(CF.roundEid('E', 1), 'E', 'round_one_keeps_the_game_id');
    c.eq(CF.LATE_LAG_ROUNDS, 30, 'late_lag_constant_unchanged'); c.eq(CF.GRACE_ROUNDS, 40, 'grace_is_two_minutes');
  }
}
function moveCase(c, r, p) {
  const finish = p[1], size = +p[2], kind = p[3], gid = r.pick(GIDS), seat = r.int(1, 6), cfg = { size, snakes: 9, ladders: 9, finish }, b = boardFor(gid, seat, cfg);
  let from, roll;
  if (kind === 'ladder' || kind === 'snake') { const keys = Object.keys(kind === 'ladder' ? b.ladders : b.snakes).map(Number), at = r.pick(keys); roll = r.int(1, Math.min(6, at - 1)); from = at - roll; }
  else if (kind === 'finish') { roll = r.int(1, 6); from = size - roll; }
  else if (kind === 'overshoot') { from = size - r.int(0, 5); roll = r.int(size - from + 1, 6); }
  else for (;;) { from = r.int(1, size - 1); roll = r.int(1, 6); const t = from + roll; if (t < size && b.ladders[t] === undefined && b.snakes[t] === undefined && !(t > size)) break; }
  const e = expStep(b, from, roll, finish), s = PL.step(b, from, roll, finish);
  c.eq(s.to, e.to, 'throw_lands_on_the_right_square', `${kind} ${from}+${roll}`);
  if (kind === 'overshoot' && finish === 'exact') c.eq(s.to, from, 'exact_finish_keeps_the_pawn_when_the_throw_is_too_big');
  if (kind === 'overshoot' && finish === 'pass') c.eq(s.to, size, 'pass_finish_ends_on_the_last_square');
  if (kind === 'ladder') c.ok(s.to > s.landed, 'ladder_goes_up'); if (kind === 'snake') c.ok(s.to < s.landed, 'snake_goes_down');
  const run = PL.newRun(seat); run.pos = [from]; const before = { l: run.ladders, s: run.snakes };
  PL.advance(b, run, roll, finish);
  c.eq(squareOf(run), e.to, 'advance_moves_the_pawn_exactly_there', kind);
  c.eq(run.ladders - before.l, e.kind === 'ladder' ? 1 : 0, 'ladder_counted_once_or_not_at_all'); c.eq(run.snakes - before.s, e.kind === 'snake' ? 1 : 0, 'snake_counted_once_or_not_at_all');
  c.eq(run.finishedTurn !== null, e.to === size, 'finish_flag_set_exactly_on_the_last_square');
  if (run.finishedTurn !== null) { const f = run.finishedTurn; PL.advance(b, run, r.int(1, 6), finish); c.eq(squareOf(run), size, 'finished_pawn_stays_home'); c.eq(run.finishedTurn, f, 'finish_turn_never_changes'); }
  for (const bad of [0, 7, 1.5, -1, NaN]) { let t = false; try { PL.step(b, from, bad, finish); } catch { t = true; } c.ok(t, 'a_roll_outside_1_to_6_is_refused', bad); }
  const missed = PL.newRun(seat); missed.pos = [from]; PL.advance(b, missed, null, finish); c.eq(squareOf(missed), from, 'missed_turn_keeps_the_pawn'); c.eq(missed.missed, 1, 'missed_turn_counted');
}
function raceRunCase(c, r, p) {
  const play = p[1], size = +p[2], finish = p[3], players = r.int(3, 8), cap = r.int(10, 150);
  const x = raceOf(r, { players, size, finish, play, cap, endPrizes: r.int(1, 5) }), tag = p.join('|');
  c.note(`gid ${x.gid} players ${players} cap ${cap} betas ${x.betas.length}`);
  compareRace(c, x, tag); replayChecks(c, x, tag);
  const rows = rankChecks(c, x, tag), view = VW.spectatorView(x.st);
  c.eq(view.bands.reduce((a, b) => a + b, 0), players, 'crowd_bands_add_up_to_the_players', tag);
  c.ok(rows.length === Math.min(10, players), 'top_list_has_up_to_10_rows', tag);
  const cr = RC.crowdOf(x.st); x.st.runs.forEach((q) => c.ok(cr.aheadOf(q.seat) >= 0 && cr.aheadOf(q.seat) <= 100, 'ahead_of_is_a_percentage', tag));
}
function prizeCase(c, r, p) {
  const play = p[1], excl = p[2] === 'excl', endPrizes = +p[3], mCount = +p[4], size = r.pick(SIZES), finish = r.pick(FIN), players = r.int(3, 8), cap = r.int(30, 150);
  const ms = Array.from(new Set(Array.from({ length: mCount }, () => r.int(Math.floor(size * 0.2), size - 1)))).slice(0, 3);
  const x = raceOf(r, { players, size, finish, play, cap, endPrizes, exclusive: excl, ms, nb: r.int(Math.min(cap, 20), cap + 2) }), tag = p.join('|');
  c.note(`gid ${x.gid} players ${players} size ${size} ${finish} ms ${ms}`);
  compareRace(c, x, tag);
  const lines = linesFor(r, x.cfg, ms);
  settleChecks(c, x, lines, tag); stabilityChecks(c, x, lines, tag);
  const fin = x.st.runs.filter((q) => q.finishedTurn !== null).length;
  if (!excl) c.eq(RC.settleRace(x.st, lines, pidOf).filter((q) => q.pattern === 'finish').length, Math.min(endPrizes, fin), 'finish_prizes_paid_equal_players_home_up_to_the_limit', tag);
}
function teamCase(c, r, p) {
  const T = +p[1], uneven = p[2] === 'uneven', play = p[3], size = r.pick(SIZES);
  const players = uneven ? T * r.int(1, 3) + r.int(1, T - 1 || 1) : T * r.int(1, 3);
  const n = Math.min(Math.max(players, T), 30), cap = r.int(60, 150);
  const x = raceOf(r, { players: n, size, finish: 'exact', play, cap, endPrizes: 5, teams: T, ms: [50], nb: cap + 1 }), tag = p.join('|'), cfg = x.cfg;
  compareRace(c, x, tag);
  const teamOf = RC.teamsOf(cfg, x.b0), count = new Array(T).fill(0);
  c.eq(teamOf.length, n, 'everyone_is_dealt_into_a_team', tag); teamOf.forEach((t) => { c.ok(Number.isInteger(t) && t >= 0 && t < T, 'team_number_in_range', tag); count[t]++; });
  c.ok(Math.max(...count) - Math.min(...count) <= 1, 'team_sizes_differ_by_at_most_one', `${tag} ${count}`);
  c.eq(J(RC.teamsOf(cfg, x.b0)), J(teamOf), 'team_deal_is_deterministic', tag);
  c.ok(J(RC.teamsOf(cfg, b0Of('other'))) !== J(teamOf) || n < 4, 'team_deal_depends_on_b0', tag);
  const tab = RC.teamTable(cfg, x.st, teamOf);
  c.eq(J(tab.map((q) => q.rank)), J(Array.from({ length: T }, (_, i) => i + 1)), 'team_ranks_are_1_to_n_no_ties', tag);
  c.eq(J(tab.flatMap((q) => q.members).sort((a, b) => a - b)), J(Array.from({ length: n }, (_, i) => i + 1)), 'every_player_is_in_exactly_one_team', tag);
  for (const row of tab) {
    const mem = row.members.map((s) => x.st.runs[s - 1]), all = mem.every((q) => q.finishedTurn !== null);
    c.eq(row.finishedTurn, all ? Math.max(...mem.map((q) => q.finishedTurn)) : null, 'team_finishes_when_its_last_member_is_home', tag);
    c.ok(mem.every((q) => teamOf[q.seat - 1] === row.team), 'team_members_belong_to_the_team', tag);
  }
  for (let i = 1; i < tab.length; i++) { const a = tab[i - 1], b = tab[i]; if (a.finishedTurn !== null && b.finishedTurn !== null) c.ok(a.finishedTurn <= b.finishedTurn, 'finished_teams_ranked_by_finish_turn', tag); if (a.finishedTurn === null) c.ok(b.finishedTurn === null, 'unfinished_teams_never_outrank_finished_ones', tag); }
  const lines = Array.from({ length: Math.min(3, T) }, (_, i) => ({ pattern: 'team', ordinal: i + 1, text: '' })), res = RC.settleRace(x.st, lines, pidOf);
  if (!x.st.ended) c.eq(res.length, 0, 'team_prizes_wait_for_the_end', tag);
  else {
    c.eq(res.length, lines.length, 'every_team_prize_is_awarded', tag);
    const all = res.flatMap((q) => q.pids); c.eq(new Set(all).size, all.length, 'no_player_is_in_two_team_prizes', tag);
    res.forEach((q, i) => c.eq(J(q.pids), J(tab[i].members.map(pidOf)), 'team_prize_goes_to_the_whole_team_in_rank_order', tag));
  }
  c.eq(J(RC.settleRace(x.st, lines, pidOf)), J(res), 'team_settlement_is_deterministic', tag);
}
function tableCase(c, r, p) {
  const n = +p[1], w = Math.min(+p[2], n - 1), size = r.pick(SIZES), gid = r.pick(GIDS), b0 = b0Of(gid), maxT = r.int(n * 5, 500), nb = r.int(n, maxT + 3);
  const betas = bag(r, nb), abs = Array.from({ length: nb }, () => r.chance(0.1)), cfg = { ...TB.defaultTableCfg(gid, n), board: { size, snakes: 9, ladders: 9, finish: r.pick(FIN) }, winners: w, maxThrows: maxT, milestone: r.int(10, size - 1) };
  const tag = p.join('|'), absent = (_s, k) => abs[k], st = TB.playTable(cfg, { b0, betas, absent });
  const order = TB.turnOrder(gid, n, b0); c.eq(J([...order].sort((a, b) => a - b)), J(Array.from({ length: n }, (_, i) => i + 1)), 'turn_order_is_a_permutation', tag);
  c.eq(J(TB.turnOrder(gid, n, b0)), J(order), 'turn_order_is_deterministic', tag); c.eq(J(st.order), J(order), 'state_uses_the_sealed_order', tag);
  c.eq(BD.boardProblem(st.board), null, 'table_board_is_legal', tag);
  const pos = Array.from({ length: n }, () => [1]), fin = Array(n).fill(null), finOrder = [], ms = new Map(); let ptr = 0, throws = 0, ended = false, reason = 'running';
  const skip = () => { let g = 0; while (fin[order[ptr % n] - 1] !== null && g++ < n) ptr++; };
  for (let k = 0; k < nb && !ended; k++) {
    skip(); const seat = order[ptr % n]; let cur = pos[seat - 1].at(-1);
    if (!abs[k]) { const e = expStep(st.board, cur, PL.rollFor(gid, seat, k, betas[k]), cfg.board.finish); cur = e.to; }
    pos[seat - 1].push(cur); if (cur === st.board.size) { fin[seat - 1] = k; finOrder.push(seat); }
    if (!ms.has(seat) && cur >= cfg.milestone) ms.set(seat, k);
    throws = k + 1; ptr++;
    if (finOrder.length >= w) { ended = true; reason = 'winners'; } else if (throws >= maxT) { ended = true; reason = 'cap'; }
  }
  st.runs.forEach((q, i) => { c.eq(J(q.pos), J(pos[i].slice(1)), 'table_positions_match_replay', `${tag} seat ${i + 1}`); legalMoves(c, st.board, q.pos, cfg.board.finish, `${tag} seat ${i + 1}`); });
  c.eq(st.throws, throws, 'table_throw_count', tag); c.eq(st.ended, ended, 'table_end_rule', tag); c.eq(st.endReason, reason, 'table_end_reason', tag); c.eq(J(st.finishedOrder), J(finOrder), 'table_finish_order', tag);
  c.eq(new Set(st.finishedOrder).size, st.finishedOrder.length, 'nobody_finishes_twice_at_the_table', tag);
  c.ok(st.finishedOrder.length <= w + 0, 'no_more_winners_than_asked', tag);
  c.eq(st.runs.reduce((a, q) => a + q.pos.length, 0), throws, 'one_pawn_moves_per_throw', tag);
  const live = st.runs.filter((q) => q.finishedTurn === null).map((q) => q.pos.length); if (live.length) c.ok(Math.max(...live) - Math.min(...live) <= 1, 'pawns_take_turns_fairly', `${tag} ${live}`);
  if (!ended) { skip(); c.eq(st.whoseTurn, order[ptr % n], 'whose_turn_is_next_unfinished_pawn_in_order', tag); } else c.eq(st.whoseTurn, null, 'nobody_to_move_when_over', tag);
  const rk = TB.rankTable(st); c.eq(J(rk.map((q) => q.rank)), J(Array.from({ length: n }, (_, i) => i + 1)), 'table_ranks_consecutive', tag); c.eq(new Set(rk.map((q) => q.seat)).size, n, 'table_rank_lists_everyone_once', tag);
  c.eq(J(rk.slice(0, finOrder.length).map((q) => q.seat)), J(finOrder), 'finishers_rank_in_finishing_order', tag);
  const lines = [...Array.from({ length: w }, (_, i) => ({ pattern: 'finish', ordinal: i + 1 })), { pattern: 'milestone', ordinal: 1 }], res = TB.settleTable(st, lines, pidOf);
  finOrder.forEach((s, i) => c.eq(res.find((q) => q.pattern === 'finish' && q.ordinal === i + 1)?.pids[0], pidOf(s), 'table_finish_prize_goes_to_that_pawn', tag));
  c.eq(res.filter((q) => q.pattern === 'finish').length, finOrder.length, 'table_finish_prizes_paid_once_each', tag);
  const first = [...ms.entries()].sort((a, b) => a[1] - b[1])[0], mr = res.find((q) => q.pattern === 'milestone');
  c.eq(mr?.pids[0], first ? pidOf(first[0]) : undefined, 'table_milestone_goes_to_first_arrival', tag);
}
function luckyCase(c, r, p) {
  const n = +p[1], size = +p[2], kind = p[3], eid = `E${r.int(1, 1e6)}`, after = r.int(1, 59), rnd = hex(r);
  const seats = Array.from({ length: size }, (_, i) => ({ pid: `${i + 1}x${hex(r).slice(0, 12)}`, ex: kind === 'ex' && i % 3 === 0, removedMs: kind === 'removed' && i % 4 === 0 ? 1000 + r.int(-60000, 60000) : null }));
  const drawMs = 1000 + 30000 * r.int(0, 3) + r.int(0, 30000), elig = GM.luckyEligible(seats, drawMs);
  let pids = elig; if (kind === 'dups') pids = [...elig, ...elig.slice(0, Math.max(1, Math.floor(elig.length / 2)))];
  const tag = p.join('|'), w = GM.luckyWinners(eid, after, rnd, pids, n), uniq = new Set(pids);
  c.eq(w.length, Math.min(n, uniq.size), 'right_number_of_lucky_winners', tag); c.eq(new Set(w).size, w.length, 'nobody_wins_a_lucky_draw_twice', tag);
  c.ok(w.every((x) => uniq.has(x)), 'lucky_winner_is_a_participant', tag);
  c.eq(J(GM.luckyWinners(eid, after, rnd, pids, n)), J(w), 'lucky_draw_is_deterministic', tag); c.eq(J(GM.luckyWinners(eid, after, rnd, shuffle(r, pids), n)), J(w), 'lucky_draw_does_not_depend_on_list_order', tag);
  const rank = (pid) => sha(`SL1-LUCKY|${eid}|${after}|${rnd}|${pid}`), want = [...uniq].sort((a, b) => (rank(a) < rank(b) ? -1 : 1)).slice(0, n); c.eq(J(w), J(want), 'lucky_draw_matches_the_published_recipe', tag);
  if (kind === 'ex') { const ex = new Set(seats.filter((s) => s.ex).map((s) => s.pid)); c.ok(w.every((x) => !ex.has(x)), 'organizers_and_hosts_never_win_lucky_draws', tag); c.eq(elig.length, seats.filter((s) => !s.ex).length, 'only_hosts_are_left_out', tag); }
  if (kind === 'removed') for (const s of seats) { const out = typeof s.removedMs === 'number' && s.removedMs + 30000 <= drawMs; c.eq(elig.includes(s.pid), !out, 'removal_counts_only_when_recorded_30_seconds_before_the_draw', `${tag} removed ${s.removedMs} draw ${drawMs}`); }
  c.eq(GM.luckyWinners(eid, after, rnd, pids, 0).length, 0, 'zero_winners_is_empty', tag);
}
function luckyFair(c, r) {
  const pids = Array.from({ length: 6 }, (_, i) => `${i + 1}x${'ab'.repeat(6)}`), cnt = new Map(pids.map((x) => [x, 0]));
  for (let i = 0; i < 600; i++) { const w = GM.luckyWinners('EF', 7, hex(r), pids, 1)[0]; cnt.set(w, cnt.get(w) + 1); }
  for (const [pid, k] of cnt) c.ok(k >= 55 && k <= 150, 'lucky_draw_is_fair_to_every_participant', `${pid} won ${k} of 600`);
}
function schedCase(c, r, p) {
  const nb = +p[1], ctl = p[2], W = +p[3], first = r.int(1e6, 2e7), tr = SC.turnRounds(W);
  c.eq(SC.betaOffset(W), Math.floor(W / 3) + 1, 'beta_offset_formula', W); if (W === 20) c.eq(tr, 9, 'a_20_second_turn_is_9_rounds');
  c.ok(SC.betaOffset(W) * SC.ROUND_SEC > W, 'dice_value_is_published_after_the_window_closes', W);
  const afters = new Set(); while (afters.size < nb) afters.add(r.int(1, 59));
  const breaks = [...afters].sort((a, b) => a - b).map((a) => ({ after: a, seconds: 3 * r.int(1, 30), kind: 'speech', title: 't' }));
  let st = null;
  if (ctl !== 'none') { const s1 = first + r.int(10, 300), e1 = s1 + r.int(5, 100), s2 = e1 + r.int(40, 400), e2 = s2 + r.int(5, 100); st = { intervals: ctl === 'pause' ? [{ start: s1, end: e1 }, { start: s2, end: e2 }] : [], stopRound: ctl === 'stop' ? first + r.int(30, 400) : null }; }
  let prev = null, dead = false;
  for (let t = 0; t < 60; t++) {
    const o = SC.openRoundOf(st, first, W, breaks, t), b = SC.betaRoundOf(st, first, W, breaks, t), tag = `${p.join('|')} t${t}`;
    if (dead) { c.eq(o, null, 'after_a_stop_no_turn_opens', tag); continue; }
    if (o === null) { dead = true; c.ok(st?.stopRound != null, 'only_a_stop_ends_the_schedule', tag); continue; }
    if (st?.stopRound != null) c.ok(o < st.stopRound, 'no_turn_opens_after_the_stop', tag);
    c.eq(b, o + SC.betaOffset(W), 'dice_round_is_a_fixed_offset_after_opening', tag);
    if (prev !== null) { c.ok(o >= prev + tr, 'turns_never_overlap', tag); if (ctl === 'none') { const brk = breaks.find((x) => x.after === t); c.eq(o - prev, tr + (brk ? brk.seconds / 3 : 0), 'gap_is_a_turn_plus_the_break', tag); } }
    if (st) for (const i of st.intervals) c.ok(!(o >= i.start && o < i.end), 'no_turn_opens_inside_a_pause', `${tag} ${o} in ${i.start}-${i.end}`);
    prev = o;
  }
  if (nb) { const b = breaks[0], stride = tr, lb = { ...b, kind: 'lucky' }, bs = [lb], pv = GM.callRoundFull(null, first, stride, bs, lb.after - 1), lr = GM.luckyRound(null, first, stride, bs, lb), ab = GM.activeBreak(null, first, stride, bs, pv + stride);
    c.eq(lr, GM.callRoundFull(null, first, stride, bs, lb.after), 'lucky_draw_round_is_the_round_the_next_turn_opens', p.join('|'));
    c.ok(!!ab && ab.endsAtRound === lr, 'break_is_showing_from_the_end_of_the_previous_turn_until_the_draw_round', p.join('|')); c.eq(GM.activeBreak(null, first, stride, bs, lr), null, 'break_is_over_at_the_draw_round', p.join('|')); }
}
function voteCase(c, r, p) {
  const n = +p[1], q = CF.quorumFor(n), v = CF.votersFor(n);
  const want = n <= 6 ? Math.max(1, Math.ceil(n / 2)) : Math.min(25, Math.max(3, Math.ceil(n * 0.05)));
  c.eq(q, want, 'quorum_matches_the_documented_rule', n); c.ok(q >= 1 && q <= n, 'quorum_is_between_1_and_everyone', n);
  c.ok(v >= q && v <= n, 'voters_are_enough_for_the_quorum_and_not_more_than_the_players', `${n}: quorum ${q} voters ${v}`);
  if (n <= 12) c.eq(v, n, 'small_games_everyone_votes', n); else c.eq(v, 4 * q, 'big_games_vote_with_4x_quorum', n);
  if (n <= 6) c.ok(2 * q > n || n % 2 === 0 && 2 * q >= n, 'small_game_quorum_is_at_least_half', n);
}
function voteMono(c) { let prev = 0; for (let n = 2; n <= 12000; n += n < 400 ? 1 : 97) { const q = CF.quorumFor(n); c.ok(q >= prev || n === 7, 'quorum_never_shrinks_as_the_game_grows', `${n}: ${q} after ${prev}`); prev = q; c.ok(q <= 25, 'quorum_capped_at_25', n); } }
function priceCase(c, r, p) {
  const cur = p[1], pack = +p[2], x = PR.price(pack, cur), row = PR.PACKS.find((q) => q[0] === pack);
  c.ok(x.total > 0 && x.base > 0 && x.tax >= 0, 'price_and_tax_never_negative', p.join('|')); c.eq(Math.round((x.base + x.tax) * 100), Math.round(x.total * 100), 'total_is_base_plus_tax', p.join('|'));
  c.eq(x.base, cur === 'INR' ? row[1] : row[2], 'price_comes_from_the_pack_table', p.join('|'));
  if (!PR.GST_ON) c.eq(x.tax, 0, 'no_tax_is_added_while_gst_is_off', p.join('|'));
  if (cur === 'INR') c.eq(x.base % 100, 99, 'rupee_price_ends_in_99', p.join('|')); else c.ok(Number.isInteger(x.base), 'dollar_price_is_whole', p.join('|'));
  for (const gst of [false, true]) { const t = BL.splitGst(x.total, cur, '29', r.pick([undefined, '29ABCDE1234F1Z5', '27ABCDE1234F1Z5']), gst), sum = t.taxable + t.cgst + t.sgst + t.igst;
    c.ok(t.taxable >= 0 && t.cgst >= 0 && t.sgst >= 0 && t.igst >= 0, 'tax_parts_never_negative', `${p.join('|')} gst ${gst}`); c.ok(Math.abs(sum - x.total) <= 0.011, 'tax_parts_add_up_to_the_price', `${p.join('|')} gst ${gst} ${sum} vs ${x.total}`); c.eq(t.total, x.total, 'split_total_is_the_price_paid', p.join('|')); }
}
function priceTable(c) {
  const ps = PR.PACKS; for (let i = 1; i < ps.length; i++) { c.ok(ps[i][0] > ps[i - 1][0] && ps[i][1] > ps[i - 1][1] && ps[i][2] > ps[i - 1][2], 'bigger_pack_costs_more', ps[i][0]); c.ok(ps[i][1] / ps[i][0] < ps[i - 1][1] / ps[i - 1][0], 'bigger_pack_costs_less_per_participant', ps[i][0]); }
}
function priceUnknown(c, r) { for (const pk of [0, 99, 101, 249, 10001, -100]) { let e = null; try { PR.price(pk, 'INR'); } catch (x) { e = x; } c.ok(e instanceof RangeError, 'unknown_pack_is_refused', pk); } }
function priceBreaks(c) { for (let n = 0; n <= 3; n++) { const a = PR.proposeBreakPositions(n); c.eq(a.length, n, 'break_count_matches', n); c.ok(a.every((x, i) => x >= 1 && x <= 60 && (i === 0 || x > a[i - 1])), 'break_positions_inside_a_60_turn_game_and_rising', J(a)); } let t = false; try { PR.proposeBreakPositions(4); } catch { t = true; } c.ok(t, 'more_than_3_breaks_refused'); }
function gstSplit(c, r) {
  for (let i = 0; i < 25; i++) { const amt = r.int(1, 3000000) / 100, t = BL.splitGst(amt, 'INR', '29', r.pick(['29AAAAA0000A1Z5', '07AAAAA0000A1Z5', undefined]), true), sum = t.cgst + t.sgst + t.igst + t.taxable;
    c.ok(Math.abs(sum - amt) <= 0.011, 'gst_split_conserves_money', `${amt} ${J(t)}`); c.ok(t.taxable >= 0 && t.taxable <= amt, 'taxable_value_between_0_and_the_price', amt); if (t.mode === 'intra') c.ok(Math.abs(t.cgst - t.sgst) <= 0.011, 'cgst_and_sgst_are_equal', amt); }
}
function creditCase(c, r, k) {
  const DAY = 86400000, IST = 19800000;
  if (k === 'text_inr' || k === 'text_usd') {
    const cur = k === 'text_usd' ? 'USD' : 'INR', pre = cur === 'USD' ? 'US$' : 'Rs ';
    for (const n of [0, 1, 99, 2399, 29499, 12345.5, 7.05, 1000000]) { const s = CR.rs(n, cur); c.ok(s.startsWith(pre) && !/NaN|undefined|-/.test(s), 'money_text_has_the_symbol_and_no_junk', `${n} -> ${s}`); const digits = s.replace(/[^0-9.]/g, ''); c.eq(Math.round(parseFloat(digits) * 100), Math.round(n * 100), 'money_text_shows_the_exact_amount', `${n} -> ${s}`); if (Number.isInteger(n)) c.ok(!/\.\d/.test(s), 'whole_amounts_have_no_decimals', s); }
    return;
  }
  for (let i = 0; i < 12; i++) {
    let paid = Date.UTC(2026, 0, 1) + r.int(0, 4 * 365 * 24 * 3600) * 1000;
    if (k === 'ist_edge') { const d = Math.floor(paid / DAY) * DAY; paid = d + 18 * 3600000 + 30 * 60000 + r.pick([-1000, -1, 0, 1, 1000]) * 1; }
    if (k === 'leap') paid = Date.UTC(2027, 1, 28) + r.int(0, 3 * DAY / 1000) * 1000 + r.pick([0, 0, 1]) * 366 * DAY;
    const ex = CR.creditExpiryMs(paid), istDay = Math.floor((paid + IST) / DAY);
    c.eq(ex, (istDay + 366) * DAY - IST, 'credit_lapses_at_the_start_of_day_366_india_time', paid); c.ok(ex > paid, 'credit_expiry_is_in_the_future', paid);
    c.eq((ex + IST) % DAY, 0, 'credit_expiry_is_midnight_india_time', paid); c.ok(ex - paid >= 365 * DAY && ex - paid < 367 * DAY, 'credit_lasts_365_to_366_days', paid);
    const last = new Date(istDay * DAY + 365 * DAY), m = CR.creditLastDay(ex); c.ok(m.startsWith(String(last.getUTCDate()) + ' ') && m.endsWith(String(last.getUTCFullYear())), 'last_usable_day_is_day_365_india_time', `${m} vs ${last.toISOString()}`);
  }
}
function wordName(c, r, pat) {
  for (let tot = 1; tot <= 5; tot++) for (let o = 1; o <= tot; o++) { const s = PR.rewardName(pat, 'ticket', o, tot), label = CF.houseLabel(pat); c.eq(s, tot > 1 ? `${ord(o)} ${label}` : label, 'prize_name_is_plain_english_with_the_place', `${pat} ${o}/${tot}`); c.ok(!/undefined|NaN|\bID\b/.test(s), 'prize_name_has_no_junk', s); }
  c.ok(CF.maxWinnersFor(pat) >= 1, 'every_prize_has_a_winner_limit', pat);
}
function wordRank(c, r, k) {
  const list = k === 'small' ? Array.from({ length: 10 }, (_, i) => i + 1) : [11, 12, 13, 14, 20];
  for (const n of list) c.eq(GM.rankName(n), ord(n), 'rank_is_spoken_as_1st_2nd_3rd_4th', n);
}
function wordHouses(c) {
  const hs = CF.PRIZE_HOUSES; c.eq(hs.length, 6, 'six_prize_houses'); c.eq(new Set(hs.map((h) => h.id)).size, hs.length, 'house_ids_unique');
  c.eq(CF.maxWinnersFor('finish'), RC.MAX_END_PRIZES, 'finish_places_match_the_end_prize_limit'); c.eq(CF.maxWinnersFor('milestone'), 3, 'three_milestones');
  c.eq(J(CF.PATTERN_ORDER), J(['milestone', 'finish']), 'default_prize_set_is_milestone_and_first_five_home');
  for (const h of hs) { c.ok(h.label && h.how && h.how.endsWith('.') && h.max >= 1, 'house_text_is_a_full_sentence', h.id); c.ok(CF.HOUSES_HELP.includes(h.label) && CF.HOUSES_LINE.includes(h.id), 'help_text_lists_every_house', h.id); c.eq(PR.rewardName(h.id, 'ticket', 1, 1), h.label, 'prize_name_table_agrees_with_house_table', h.id); }
  c.eq(CF.HOUSES_HELP_LIST.length, hs.length, 'one_help_line_per_house');
  c.ok(!/pending|review/i.test(CF.HOUSES_HELP), 'house_help_text_has_no_pending_wording');
}
function wordRankNote(c, r, finishers) {
  const players = finishers ? r.int(15, 30) : 8, cap = finishers ? 150 : r.int(10, 14);
  const x = raceOf(r, { gid: finishers ? GIDS[r.int(0, 1)] : undefined, players, size: 100, finish: 'exact', play: finishers ? 'fate' : r.pick(['fate', 'presence']), cap, endPrizes: finishers ? 5 : 1, nb: cap }), tag = `note ${finishers}`;
  const rows = RC.rankPlayers(x.st, players), all = RC.orderPlayers(x.st);
  rows.forEach((row, i) => {
    const q = all[i], fin = q.finishedTurn !== null;
    const grp = all.filter((z) => (fin ? z.finishedTurn === q.finishedTurn : z.finishedTurn === null && squareOf(z) === squareOf(q)));
    c.eq(row.note !== '', grp.length > 1, 'a_note_appears_exactly_when_players_are_level', `${tag} rank ${row.rank}`);
    if (grp.length > 1) {
      let deep = 2; for (let j = 1; j < grp.length; j++) { const a = grp[j - 1], b = grp[j]; deep = Math.max(deep, a.ladders !== b.ladders ? 2 : a.missed !== b.missed ? 3 : 4); }
      const where = fin ? `finished on turn ${q.finishedTurn + 1}` : `are on square ${squareOf(q)}`, by = ['more ladders climbed', 'fewer turns missed', 'fate'][deep - 2];
      c.eq(row.note, `${grp.length} players ${where}; decided by ${by}`, 'rank_note_names_the_real_tie_breaker', `${tag} rank ${row.rank}`);
    }
  });
}
function viewCase(c, r, k) {
  const players = k === 'team' ? r.int(6, 12) : r.int(3, 10), tag = `view|${k}`;
  if (k === 'table') { const gid = r.pick(GIDS), n = r.int(2, 9), betas = bag(r, r.int(5, 80)), st = TB.playTable({ ...TB.defaultTableCfg(gid, n), winners: Math.min(3, n - 1) }, { b0: b0Of(gid), betas }), v = VW.spectatorView(st, (s) => `Nick${s}`);
    c.eq(v.kind, 'table', tag); c.eq(v.bands.reduce((a, b) => a + b, 0), n, 'table_bands_add_up_to_the_pawns', tag); c.ok(v.leaders.every((l, i) => l.rank === i + 1 && /^Nick\d+$/.test(l.name)), 'leaders_listed_by_nickname_in_rank_order', tag); c.ok(!J(v).includes(b0Of(gid)) && betas.every((b) => !J(v).includes(b)), 'spectator_view_leaks_no_seed', tag); return; }
  const x = raceOf(r, { players, size: 100, finish: 'exact', play: 'fate', cap: r.int(10, 80), endPrizes: 3, teams: k === 'team' ? 3 : undefined }), v = VW.spectatorView(x.st, (s) => `Nick${s}`);
  c.eq(v.kind, k, tag); c.eq(v.bands.reduce((a, b) => a + b, 0), players, 'bands_add_up_to_the_players', tag); c.eq(v.players, players, 'view_player_count', tag); c.eq(v.finished, x.st.finishedCount, 'view_finished_count', tag);
  c.ok(v.leaders.length === Math.min(10, players) && v.leaders.every((l, i) => l.rank === i + 1 && /^Nick\d+$/.test(l.name)), 'leaders_listed_by_nickname_in_rank_order', tag);
  c.ok(!J(v).includes(x.b0) && x.betas.every((b) => !J(v).includes(b)), 'spectator_view_leaks_no_seed', tag);
}
function throwCase(c, r, k) {
  const open = r.int(1e9, 2e9), W = r.pick([15, 20, 25, 30]), reg = (s) => (s === 1 ? 'devA' : undefined), win = { openMs: open, windowSec: W };
  const run = (arr) => VW.acceptThrow(arr, reg, win);
  const base = { seat: 1, turn: 0, device: 'devA', arrivalMs: open + r.int(0, W * 1000 - 1) };
  if (k === 'ok') c.eq(run(base).ok, true, 'a_throw_inside_the_window_counts');
  if (k === 'wrong_device') c.eq(run({ ...base, device: 'devB' }).reason, 'wrong device', 'another_device_cannot_throw_for_a_seat');
  if (k === 'early') c.eq(run({ ...base, arrivalMs: open - r.int(1, 5000) }).reason, 'window not open yet', 'a_throw_before_the_window_is_refused');
  if (k === 'edge_open') c.eq(run({ ...base, arrivalMs: open }).ok, true, 'a_throw_at_the_opening_instant_counts');
  if (k === 'edge_close') { c.eq(run({ ...base, arrivalMs: open + W * 1000 - 1 }).ok, true, 'last_millisecond_of_the_window_counts'); c.eq(run({ ...base, arrivalMs: open + W * 1000 }).reason, 'window closed', 'the_closing_instant_is_too_late'); }
  if (k === 'late') c.eq(run({ ...base, arrivalMs: open + W * 1000 + r.int(0, 60000) }).reason, 'window closed', 'a_late_throw_is_refused');
  if (k === 'unknown_seat') c.eq(run({ ...base, seat: 2 }).reason, 'unknown seat', 'unknown_seat_is_refused');
  if (k === 'dup') { const t = new VW.ThrowRecord(); c.eq(t.add(1, 0), true, 'first_throw_recorded'); c.eq(t.add(1, 0), false, 'same_throw_is_not_recorded_twice'); t.add(2, 0); t.add(1, 1); c.eq(t.count, 3, 'throw_count_counts_each_throw_once'); c.eq(t.throwsIn(0), 2, 'throws_in_a_turn'); c.eq(t.thrown(1, 0), true, 'throw_is_remembered'); c.eq(t.thrown(2, 1), false, 'a_throw_not_made_is_not_remembered'); }
}

// ================================================================ dispatcher
export async function runCase(w, idx, seed) {
  const cell = CELLS[idx % CELLS.length], p = cell.split('|'), r = rng(seed, idx), c = new Case();
  c.note(`cell ${cell}`);
  try {
    switch (p[0]) {
      case 'board': if (p[1] === 'b0') boardSealed(c, r); else if (p[1] === 'cfg') boardRejects(c); else boardCase(c, r, p); break;
      case 'dice': diceCase(c, r, p[1]); break;
      case 'seat': seatCase(c, r, p[1]); break;
      case 'move': moveCase(c, r, p); break;
      case 'run': raceRunCase(c, r, p); break;
      case 'prize': prizeCase(c, r, p); break;
      case 'team': teamCase(c, r, p); break;
      case 'table': tableCase(c, r, p); break;
      case 'lucky': if (p[1] === 'fair') luckyFair(c, r); else luckyCase(c, r, p); break;
      case 'sched': schedCase(c, r, p); break;
      case 'vote': if (p[1] === 'monotone') voteMono(c); else voteCase(c, r, p); break;
      case 'price': if (p[1] === 'packs') priceTable(c); else if (p[1] === 'unknown_pack') priceUnknown(c, r); else if (p[1] === 'breaks') priceBreaks(c); else if (p[1] === 'gst') gstSplit(c, r); else priceCase(c, r, p); break;
      case 'credit': creditCase(c, r, p[1]); break;
      case 'word': if (p[1] === 'name') wordName(c, r, p[2]); else if (p[1] === 'rank') wordRank(c, r, p[2]); else if (p[1] === 'houses') wordHouses(c); else wordRankNote(c, r, p[2] === 'finishers'); break;
      case 'view': viewCase(c, r, p[1]); break;
      case 'throw': throwCase(c, r, p[1]); break;
      default: c.ok(false, 'unknown_cell', cell);
    }
  } catch (e) { c.ok(false, 'no_unexpected_exception', `${cell}: ${String(e?.stack ?? e).split('\n').slice(0, 3).join(' / ')}`); }
  return { cell, c };
}
