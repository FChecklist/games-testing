// Corporate Tic Tac Toe suite: seeded, deterministic, in-process lifecycle smoke. Same harness contract as suites/tambola.js and tambola2.js
// (exports CELLS, newWorld, runCase(w, idx, seed) -> {cell, c}; Case methods ok/eq/note; rng(seed, idx)). One case = one cell; all randomness comes from
// rng(seed, idx), so (seed, idx) replays exactly. No server, no network, no browser: the real TypeScript of the game repo is imported through lib/tsresolve.js.
// Repo: SUITE_ROOT/sc/corporate-tic-tac-toe (public head 994c5ad), or TTT_REPO=<folder> (used for the mutation copies). The repo is only read.
//
// WHAT THE GAME HAS (docs/RULES.md R01-R37) AND WHAT THIS SUITE DRIVES
//   classic    R01-R06  the plain 3x3 game: every line, win detection, draw, refusals, whose turn
//   board      R07-R15  one board between two players: up to 3 games, draw -> swap marks, X coin, fate, the move clock, auto moves, 2 clock-outs = forfeit,
//                       stale / out-of-turn / taken / bad square refusals, pause shift, idempotent advance, "ended" wording
//   bracket    R16-R19  knockout from the sealed seed: power-of-two size, byes (round 1 only, never two meet), team format with reserve, roster order does not matter
//   tourney    R18,R20-R24  whole tournaments played to the end by simulated players (play / some absent / all absent / draw-prone), per round: both
//                       feeders done before a match opens, exactly one winner per match, winners move up to the right slot, champion, strict unique ranking
//   replay     R15,R27  the phone's replay of the server-stamped events (phone.ts replayMatch) equals what the engine produced
//   seal       R26      commit / reveal, seed depends on roster (a late joiner changes it), beacon, id; secrets are fresh
//   pause      R28      effOf / wallOf: a pause costs nobody time
//   credit     money    apps/edge/src/credit.ts on an in-memory sqlite stand-in for D1: credit instead of refunds (365 days to end of day in India time,
//                       oldest first, atomic, idempotent, never negative, no double use, no double restore) and pricing.ts (owner pack list, no GST)
//   word       wording  round names, how a board ended, tie lines, money formatting, refund line, ended message, spectator view without seed
//   lack       the features the game does NOT have (asserted absent, so the matrix is told when one appears)
// WHAT THE GAME LACKS (so there is nothing to test; the lack cells keep watch): boosters (no Joker / extra ticket / lucky pass); late joiners after the start
//   (the roster is closed when the host starts and goes into the seed; a missing player is a clock-out, not a late join); a game-over VOTE (the Organizer or a
//   Host ENDS the tournament, nobody votes; only the stored flag is on the server); prizes and payouts to players (R31: players never pay, no cash prizes, no
//   stakes; any gift is outside the product); a draw-based tie of a MATCH (a board always has one winner). Money exists only on the organizer side: pack price and credit.
// NOT DRIVEN (needs the Worker + D1 + browsers): apps/edge/src/tournament.ts mailbox routes (move/result/open/settle/finish/end), the End button (R28b), the 24-hour deletion,
//   pay.ts / Razorpay, TttPhone/TttConsole polling, the page scripts, the prototype scorer engine.ts (not used by the product).
import '../lib/tsresolve.js';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { ROOT } from '../lib/roots.js';

const REPO = process.env.TTT_REPO ? resolve(process.env.TTT_REPO) : resolve(ROOT, 'sc/corporate-tic-tac-toe');
const TTT = existsSync(REPO) ? realpathSync(REPO) : REPO;
const R = (p) => import(pathToFileURL(resolve(TTT, p)).href);
const CL = await R('packages/ttt/src/classic.ts');
const MA = await R('packages/ttt/src/match.ts');
const BR = await R('packages/ttt/src/bracket.ts');
const SE = await R('packages/ttt/src/seal.ts');
const PH = await R('packages/ttt/src/phone.ts');
const IX = await R('packages/ttt/src/index.ts');
const PR = await R('packages/shared/src/pricing.ts');
const CR = await R('apps/edge/src/credit.ts');

// ================================================================ cells
const SCRIPTS = ['random_play', 'win_x', 'win_o', 'draw', 'refusals', 'mark_to_move'];
const BOARD = ['g1_first_wins', 'g1_second_wins', 'draw_then_win', 'draw_draw_win', 'absent_both', 'absent_one', 'clockout_then_move', 'late_within_ready',
  'refusals', 'advance_idempotent', 'pause_shift', 'auto_cell_oracle', 'three_draws_fate|3', 'three_draws_fate|2', 'three_draws_fate|1'];
const SOLO_N = [1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 33, 64, 100];
const GOLDEN = [[100, 2399, 34], [250, 3499, 51], [500, 4699, 67], [750, 5899, 84], [1000, 7099, 101], [2500, 11799, 169], [5000, 17699, 253], [10000, 29499, 421]];
const SCEN = ['full', 'remainder', 'partial', 'idempotent', 'restore', 'restore_twice', 'restore_lapsed', 'reapply', 'two_oldest', 'expired_old', 'at_expiry', 'before_expiry', 'cancelled_game', 'dup_payment', 'other_org', 'other_currency'];
const LACKS = ['booster', 'joker', 'prize', 'vote', 'late_join', 'payout', 'stake'];

export const CELLS = [
  ...SCRIPTS.map((s) => `classic|${s}`),
  ...cross(['classic'], ['line'], ['0', '1', '2', '3', '4', '5', '6', '7'], ['1', '2']).map((c) => c.join('|')),
  ...BOARD.map((s) => `board|${s}`),
  ...SOLO_N.map((n) => `bracket|solo|${n}`),
  ...[3, 4, 5, 6, 7, 9, 10, 11, 15, 16, 21].map((n) => `bracket|team3|${n}`),
  ...[5, 9, 10, 11, 14, 15, 20, 25].map((n) => `bracket|team5|${n}`),
  ...['dup', 'empty', 'team_too_few', 'team_size_4', 'too_many'].map((e) => `bracket|err|${e}`),
  ...cross(['tourney'], ['2', '3', '4', '5', '6', '7', '8', '9', '12'], ['play', 'some_absent', 'all_absent', 'drawish']).map((c) => c.join('|')),
  ...cross(['team'], ['2', '3', '4'], ['3', '5'], ['play', 'all_absent'], ['0', '2']).map((c) => c.join('|')),
  ...['play', 'some_absent', 'all_absent', 'drawish'].map((s) => `replay|${s}`),
  ...['commit', 'seed_inputs', 'roster_order', 'late_roster_changes_seed', 'fresh_secret'].map((s) => `seal|${s}`),
  ...['none', 'one', 'many', 'open'].map((s) => `pause|eff_wall|${s}`),
  ...cross(['credit'], SCEN, ['INR', 'USD'], ['plain', 'ist_midnight']).map((c) => c.join('|')),
  ...cross(['price'], GOLDEN.map((g) => String(g[0])), ['INR', 'USD']).map((c) => c.join('|')),
  'price|unknown|x', 'price|monotone|x',
  ...['round_names|1', 'round_names|2', 'round_names|3', 'round_names|4', 'round_names|7', 'tie_lines|x', 'money_text|x', 'fixed_text|x', 'public_view|x'].map((s) => `word|${s}`),
  ...LACKS.map((s) => `lack|${s}`),
];
export async function newWorld() { return {}; }

// ================================================================ independent oracles (from the rules, with node's own crypto)
const sha = (s) => createHash('sha256').update(s, 'utf8').digest();
const shaHex = (s) => sha(s).toString('hex');
const u32 = (seed, label) => sha(`${seed}|${label}|0`).readUInt32BE(0); // first number of the documented stream
const coinO = (seed, label) => (u32(seed, label) & 1) === 1;
const belowO = (seed, label, n) => { const lim = Math.floor(0x100000000 / n) * n; for (let k = 0; ; k++) { const v = u32(seed, `${label}#${k}`); if (v < lim) return v % n; } };
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
/** R04/R05: the marks that own a full line, the lines, and whether the board is full. */
function winO(cells) {
  const marks = new Set(), lines = [];
  for (const l of LINES) { const m = cells[l[0]]; if (m && cells[l[1]] === m && cells[l[2]] === m) { marks.add(m); lines.push(l); } }
  return { marks, lines, full: cells.every((x) => x !== 0) };
}
const S = (r) => 'sd' + r.int(0, 2 ** 31 - 1).toString(16);
const shuf = (r, a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = r.int(0, i); [x[i], x[j]] = [x[j], x[i]]; } return x; };
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
const sameJson = (a, b) => canon(a) === canon(b);
const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };
/** the 8 symmetries of the 3x3 board, applied to a list of cells */
function sym(r, cells) {
  const rot = ([rr, cc]) => [cc, 2 - rr], ref = ([rr, cc]) => [rr, 2 - cc];
  let f = (p) => p; for (let i = r.int(0, 3); i > 0; i--) { const g = f; f = (p) => rot(g(p)); } if (r.chance(0.5)) { const g = f; f = (p) => ref(g(p)); }
  return cells.map((c) => { const [rr, cc] = f([Math.floor(c / 3), c % 3]); return rr * 3 + cc; });
}
const WIN_FIRST = [0, 3, 1, 4, 2], WIN_SECOND = [0, 1, 3, 4, 8, 7], DRAW9 = [0, 1, 2, 4, 3, 5, 7, 6, 8];

// ================================================================ classic (R01-R06)
function checkOutcome(c, cells, where) {
  const o = CL.outcomeOf(cells), w = winO(cells);
  if (w.marks.size === 1) {
    const m = [...w.marks][0];
    c.ok(o.kind === 'win' && o.mark === m, 'winner_detection_exact', `${where} ${cells.join('')} -> ${JSON.stringify(o)}`);
    if (o.kind === 'win') c.ok(w.lines.some((l) => sameJson(l, o.line)) && o.line.every((i) => cells[i] === m), 'winning_line_is_a_real_line_of_that_mark', where);
  } else if (w.marks.size === 0) c.ok(w.full ? o.kind === 'draw' : o.kind === 'playing', 'draw_only_on_full_board_without_line', `${where} ${cells.join('')} -> ${o.kind}`);
}
function classicCase(c, r, parts) {
  const [, script] = parts;
  if (script === 'line') { // every line, both marks: a line of three is a win even when other cells are filled at random
    const li = +parts[2], mark = +parts[3];
    for (let a = 0; a < 80; a++) {
      const cells = Array(9).fill(0); for (let i = 0; i < 9; i++) cells[i] = r.int(0, 2);
      for (const i of LINES[li]) cells[i] = mark;
      const w = winO(cells);
      if (w.marks.size !== 1) continue; // another mark also has a line: not a legal board, try again
      const o = CL.outcomeOf(cells);
      c.ok(o.kind === 'win' && o.mark === mark, 'every_line_wins', `line ${li} mark ${mark} ${cells.join('')} -> ${JSON.stringify(o)}`);
      return;
    }
    c.ok(false, 'harness_fault_target_exists', `line ${li}`);
    return;
  }
  if (script === 'refusals') {
    const cells = CL.emptyCells(); c.eq(cells.length, 9, 'board_has_nine_squares'); c.ok(cells.every((x) => x === 0), 'new_board_empty');
    const k = r.int(0, 8), b2 = CL.place(cells, k, 1);
    c.eq(cells[k], 0, 'place_returns_a_new_board'); c.eq(b2[k], 1, 'place_puts_the_mark');
    let msg = ''; try { CL.place(b2, k, 2); } catch (e) { msg = e.message; }
    c.ok(msg.length > 0, 'taken_square_refused'); c.ok(/taken/i.test(msg), 'refusal_is_plain_words', msg);
    for (const bad of [-1, 9, 10, 1.5, NaN, Infinity, '3', null, undefined]) { let m2 = ''; try { CL.place(cells, bad, 1); } catch (e) { m2 = e.message; } c.ok(m2.length > 0 && /not on the board/i.test(m2), 'off_board_square_refused', String(bad)); }
    return;
  }
  if (script === 'mark_to_move') {
    const cells = Array(9).fill(0), k = r.int(0, 9); const order = shuf(r, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (let i = 0; i < k; i++) cells[order[i]] = i % 2 === 0 ? 1 : 2;
    c.eq(CL.markToMove(cells), k % 2 === 0 ? 1 : 2, 'x_moves_first_then_alternate', `k=${k}`);
    c.eq(CL.emptiesOf(cells).length, 9 - k, 'empties_count');
    return;
  }
  // play one random legal game to the end (retry until the wanted result for the targeted scripts)
  for (let tries = 0; tries < 400; tries++) {
    let cells = CL.emptyCells(), mark = 1; const hist = [];
    while (true) {
      const o = CL.outcomeOf(cells);
      if (o.kind !== 'playing') break;
      const e = CL.emptiesOf(cells), k = r.pick(e);
      c.eq(CL.markToMove(cells), mark, 'turn_alternates_x_first');
      const n = CL.place(cells, k, mark);
      c.eq(CL.emptiesOf(n).length, e.length - 1, 'a_move_fills_exactly_one_square'); c.eq(n[k], mark, 'the_mark_is_placed');
      cells = n; hist.push(k); mark = mark === 1 ? 2 : 1;
      checkOutcome(c, cells, `ply ${hist.length}`);
    }
    const o = CL.outcomeOf(cells), w = winO(cells);
    c.ok(o.kind === 'win' ? w.marks.size === 1 : w.marks.size === 0, 'exactly_one_result_per_game');
    if (o.kind === 'win') c.ok(hist.length >= 5, 'no_win_before_five_moves');
    if (o.kind === 'draw') c.eq(hist.length, 9, 'draw_needs_nine_moves');
    const want = script === 'win_x' ? o.kind === 'win' && o.mark === 1 : script === 'win_o' ? o.kind === 'win' && o.mark === 2 : script === 'draw' ? o.kind === 'draw' : true;
    if (want) { c.note(hist.join('')); return; }
  }
  c.ok(false, 'harness_fault_target_exists', script);
}

// ================================================================ board (R07-R15)
const MID = 'r1m0', A = 'pA', B = 'pB', T0 = 1_000_000;
const cfgOf = (seed, o = {}) => ({ seed, moveMs: 20000, readyMs: 30000, ...o });
const nameOf = (p) => ({ pA: 'Alice A', pB: 'Bob B' }[p] ?? p);

/** Full audit of one board against the rules; `startAt` is when game 1 opened. */
function auditBoard(c, b, cfg, mid, startAt, label) {
  const maxG = cfg.maxGames ?? 3;
  c.ok(b.games.length >= 1 && b.games.length <= maxG, 'at_most_max_games', `${label} ${b.games.length}`);
  const pts = { [b.a]: 0, [b.b]: 0 };
  let gameStart = startAt, missedFinal = null;
  b.games.forEach((g, gi) => {
    const last = gi === b.games.length - 1;
    // marks: R09 coin, swap, fresh coin
    const wantX = gi === 0 ? (coinO(cfg.seed, `first|${mid}|${b.j}`) ? b.a : b.b) : gi === 1 ? b.games[0].o : (coinO(cfg.seed, `third|${mid}|${b.j}`) ? b.a : b.b);
    c.eq(g.x, wantX, 'x_assignment_follows_sealed_coin_and_swap', `${label} game ${gi + 1}`);
    c.ok(g.o !== g.x && [g.x, g.o].every((p) => p === b.a || p === b.b), 'two_distinct_players_per_game');
    c.eq(g.no, gi + 1, 'game_numbers_in_order');
    // replay the moves with the rules
    let cells = Array(9).fill(0); const missed = { [b.a]: 0, [b.b]: 0 }; let ended = null, deadline = gameStart + (gi === 0 ? cfg.readyMs : cfg.moveMs);
    for (let k = 0; k < g.moves.length; k++) {
      const m = g.moves[k], who = k % 2 === 0 ? g.x : g.o;
      c.ok(!ended, 'no_move_after_game_result', `${label} g${gi + 1} ply ${k}`);
      c.eq(m.pid, who, 'players_alternate_x_first', `${label} g${gi + 1} ply ${k}`); c.eq(m.ply, k, 'ply_numbers_in_order');
      c.ok(Number.isInteger(m.cell) && m.cell >= 0 && m.cell <= 8 && cells[m.cell] === 0, 'only_legal_moves_are_stored', `${label} g${gi + 1} ply ${k} cell ${m.cell}`);
      if (m.auto) {
        const e = []; for (let i = 0; i < 9; i++) if (cells[i] === 0) e.push(i);
        c.eq(m.at, deadline, 'auto_move_stamped_at_the_moment_the_clock_ran_out', `${label} g${gi + 1} ply ${k}`);
        c.eq(m.cell, e[belowO(cfg.seed, `auto|${mid}|${b.j}|${g.no}|${k}`, e.length)], 'auto_cell_is_the_sealed_seeded_choice', `${label} g${gi + 1} ply ${k}`);
        missed[who]++;
      } else { c.ok(m.at <= deadline, 'real_move_made_within_the_clock', `${label} ${m.at} > ${deadline}`); missed[who] = 0; }
      if (Number.isInteger(m.cell) && m.cell >= 0 && m.cell <= 8) cells[m.cell] = who === g.x ? 1 : 2;
      deadline = m.at + cfg.moveMs;
      const w = winO(cells); if (w.marks.size) ended = { kind: 'win', mark: [...w.marks][0], at: m.at }; else if (w.full) ended = { kind: 'draw', at: m.at };
    }
    c.ok(sameJson(g.cells, cells), 'cells_equal_the_replayed_moves', `${label} g${gi + 1}`);
    const res = g.result;
    if (ended?.kind === 'win') { c.ok(res?.kind === 'win' && res.winner === (ended.mark === 1 ? g.x : g.o) && res.at === ended.at, 'winner_detection_exact', `${label} g${gi + 1} ${cells.join('')} ${JSON.stringify(res)}`); if (res?.line) c.ok(res.line.every((i) => cells[i] === ended.mark) && LINES.some((l) => sameJson(l, res.line)), 'winning_line_is_a_real_line_of_that_mark'); }
    else if (ended?.kind === 'draw') c.ok(res?.kind === 'draw' && res.at === ended.at, 'draw_exactly_on_a_full_board_without_line', `${label} g${gi + 1} ${JSON.stringify(res)}`);
    else if (res) { // no line, not full: only a forfeit may end it
      const loser = g.moves.length % 2 === 0 ? g.x : g.o;
      c.ok(res.kind === 'forfeit' && res.winner !== loser && missed[loser] === 1 && res.at === deadline, 'forfeit_only_on_second_clock_out_in_a_row', `${label} g${gi + 1} ${JSON.stringify(res)} missed ${JSON.stringify(missed)}`);
    } else c.ok(last && !b.done, 'unfinished_game_only_while_board_is_live', `${label} g${gi + 1}`);
    if (res) { if (!last) c.eq(res.kind, 'draw', 'a_decided_game_ends_the_board_so_earlier_games_are_draws', `${label} g${gi + 1}`); gameStart = res.at; }
    if (last) missedFinal = missed;
    if (res?.kind === 'win' || res?.kind === 'forfeit') pts[res.winner] += 2; else if (res?.kind === 'draw') { pts[g.x] += 1; pts[g.o] += 1; }
  });
  // board
  const lg = b.games[b.games.length - 1], res = lg.result;
  const allDraw = b.games.every((g) => g.result?.kind === 'draw');
  const wantDone = !!res && (res.kind !== 'draw' || b.games.length >= maxG);
  c.eq(b.done, wantDone, 'board_done_exactly_when_decided', `${label} ${JSON.stringify(res)} games ${b.games.length}`);
  if (allDraw && b.games.length < maxG && res) c.ok(!b.done, 'a_draw_is_replayed_not_decided');
  if (b.done) {
    c.ok(b.winner === b.a || b.winner === b.b, 'exactly_one_winner_per_board', `${label} ${b.winner}`);
    if (res.kind === 'win') { c.eq(b.winner, res.winner, 'board_winner_is_the_game_winner'); c.eq(b.via, 'win', 'via_win'); }
    else if (res.kind === 'forfeit') { c.eq(b.winner, res.winner, 'board_winner_is_the_game_winner'); c.eq(b.via, 'forfeit', 'via_forfeit'); }
    else { // fate (R10): the lower fate number wins
      const fa = shaHex(`${cfg.seed}|TTT-FATE|${mid}|${b.j}|${b.a}`), fb = shaHex(`${cfg.seed}|TTT-FATE|${mid}|${b.j}|${b.b}`);
      c.eq(b.via, 'fate', 'via_fate'); c.eq(b.winner, fa < fb ? b.a : b.b, 'fate_lower_number_wins', label); c.eq(b.games.length, maxG, 'fate_only_after_all_games_drawn');
    }
  } else c.ok(b.winner === undefined && b.via === undefined, 'no_winner_while_live', label);
  c.ok(sameJson(b.points, pts), 'points_two_per_win_one_per_draw', `${label} got ${JSON.stringify(b.points)} want ${JSON.stringify(pts)}`);
  if (b.done) { // wording (R25-ish): one plain line, right names, right game number
    const t = MA.howBoardEnded(b, nameOf);
    c.ok(t.length > 10 && t.includes(nameOf(b.winner)) && !/undefined|null|NaN|\[object|\s{2}/.test(t), 'ended_line_is_plain_and_names_the_winner', t);
    if (b.via === 'fate') c.ok(/by fate/.test(t) && t.includes(`all ${b.games.length} games were drawn`), 'ended_line_fate_wording', t);
    else if (b.via === 'forfeit') c.ok(/clock ran out twice in a row/.test(t), 'ended_line_forfeit_wording', t);
    else { const gn = b.games.findIndex((g) => g.result?.kind === 'win') + 1; c.ok(/three in a row/.test(t) && (b.games.length === 1 ? !/game \d/.test(t) : t.includes(`in game ${gn}`) && /earlier games were drawn/.test(t)), 'ended_line_win_wording', t); }
  } else c.eq(MA.howBoardEnded(b, nameOf), '', 'no_ended_line_while_live');
  return missedFinal;
}

/** Plays a list of squares: the mover of the moment places each one; time moves 1 s per move. */
async function play(cfg, b, seq, t, c, label) {
  for (const cell of seq) {
    const g = MA.lastGame(b), who = MA.moverOf(g);
    const res = await MA.applyMove(cfg, MID, b, who, cell, t, g.moves.length);
    if (!c.ok(res.ok, 'legal_move_accepted', `${label} cell ${cell} ${res.ok ? '' : res.error}`)) return t;
    t += 1000;
  }
  return t;
}
const freshBoard = (cfg) => MA.newBoard(cfg, MID, 0, A, B, T0);

async function boardCase(c, r, parts) {
  let auditStart = T0; const sc = parts[1], seed = S(r), cfg = cfgOf(seed, sc === 'three_draws_fate' ? { maxGames: +parts[2] } : {});
  let b = await freshBoard(cfg), t = T0 + 1000;
  const L = sc;
  if (sc === 'g1_first_wins' || sc === 'g1_second_wins') {
    const seq = sym(r, sc === 'g1_first_wins' ? WIN_FIRST : WIN_SECOND), x = MA.lastGame(b).x;
    await play(cfg, b, seq, t, c, L);
    c.ok(b.done && b.via === 'win', 'board_decided_by_the_first_decided_game'); c.eq(b.games.length, 1, 'no_second_game_after_a_win');
    c.eq(b.winner, sc === 'g1_first_wins' ? x : MA.lastGame(b).o, 'winner_is_the_player_with_three_in_a_row');
    const after = await MA.applyMove(cfg, MID, b, x, 0, t + 5000); c.ok(!after.ok && after.error === 'match-over', 'no_move_after_the_board_is_decided');
  } else if (sc === 'draw_then_win' || sc === 'draw_draw_win') {
    const draws = sc === 'draw_then_win' ? 1 : 2;
    for (let d = 0; d < draws; d++) { t = await play(cfg, b, sym(r, DRAW9), t, c, `${L} draw ${d + 1}`); c.eq(b.games.length, d + 2, 'a_draw_starts_the_next_game_at_once'); c.ok(!b.done, 'a_draw_does_not_decide_the_board'); }
    const g1x = b.games[0].x, gx = MA.lastGame(b).x;
    c.eq(b.games[1].x, b.games[0].o, 'game_two_swaps_the_marks'); if (draws === 2) c.eq(gx, b.games[2].x, 'game_three_marks_noted');
    const firstWins = r.chance(0.5); await play(cfg, b, sym(r, firstWins ? WIN_FIRST : WIN_SECOND), t, c, `${L} win`);
    c.ok(b.done && b.via === 'win', 'win_after_draws_decides'); c.eq(b.winner, firstWins ? gx : MA.lastGame(b).o, 'winner_is_the_player_with_three_in_a_row'); c.eq(g1x === undefined, false, 'x_known');
  } else if (sc === 'three_draws_fate') {
    const n = cfg.maxGames;
    for (let d = 0; d < n; d++) t = await play(cfg, b, sym(r, DRAW9), t, c, `${L} draw ${d + 1}`);
    c.ok(b.done && b.via === 'fate', 'all_games_drawn_goes_to_fate'); c.eq(b.games.length, n, 'no_game_beyond_the_limit');
  } else if (sc === 'absent_both') { // R14: both stay away: the player due to start loses
    const x = MA.lastGame(b).x, dl = MA.lastGame(b).deadline;
    await MA.advanceBoard(cfg, MID, b, dl); c.ok(!b.done && MA.lastGame(b).moves.length === 0, 'clock_not_out_at_the_deadline_itself');
    await MA.advanceBoard(cfg, MID, b, dl + 1); c.eq(MA.lastGame(b).moves.length, 1, 'first_clock_out_plays_a_move_for_the_player');
    await MA.advanceBoard(cfg, MID, b, dl + 1 + cfg.moveMs + 1);
    c.ok(MA.lastGame(b).moves.length >= 2, 'second_player_also_timed_out');
    await MA.advanceBoard(cfg, MID, b, dl + 10 * cfg.moveMs);
    c.ok(b.done && b.via === 'forfeit', 'both_away_ends_in_a_forfeit'); c.eq(b.winner, x === A ? B : A, 'the_player_due_to_start_loses');
  } else if (sc === 'absent_one') { // the opponent plays, the absent player is clocked out twice
    const g0 = MA.lastGame(b), absent = g0.x === A ? A : B, t2 = T0 + 1000;
    await MA.advanceBoard(cfg, MID, b, g0.deadline + 1); // absent X clocked out, O to move
    let tt = MA.lastGame(b).deadline - 5000; let guard = 0;
    while (!b.done && guard++ < 20) {
      const g = MA.lastGame(b), who = MA.moverOf(g);
      if (who === absent) { await MA.advanceBoard(cfg, MID, b, g.deadline + 1); continue; }
      const res = await MA.applyMove(cfg, MID, b, who, r.pick(CL.emptiesOf(g.cells)), Math.min(tt, g.deadline), g.moves.length); tt = MA.lastGame(b).deadline - 5000;
      if (!res.ok) { c.ok(false, 'legal_move_accepted', res.error); break; }
    }
    c.ok(b.done, 'board_ends'); c.ok(b.via === 'forfeit' ? b.winner !== absent : b.winner !== undefined, 'absent_player_does_not_win_by_forfeit'); void t2;
  } else if (sc === 'clockout_then_move') { // one clock-out, then real moves: the count goes back to zero, so a later single clock-out does not forfeit
    const g0 = MA.lastGame(b), pl = g0.x;
    await MA.advanceBoard(cfg, MID, b, g0.deadline + 1); const g = MA.lastGame(b);
    c.eq(g.missed[pl], 1, 'one_clock_out_counted'); c.ok(g.moves[0].auto === true, 'auto_move_is_flagged');
    const o = g.o, now = g.moves[0].at + 1000;
    const r1 = await MA.applyMove(cfg, MID, b, o, r.pick(CL.emptiesOf(g.cells)), now, 1); c.ok(r1.ok, 'real_move_after_clock_out');
    const r2 = await MA.applyMove(cfg, MID, b, pl, r.pick(CL.emptiesOf(MA.lastGame(b).cells)), now + 1000, 2);
    if (r2.ok && !b.done) { c.eq(MA.lastGame(b).missed[pl], 0, 'real_move_resets_the_clock_out_count'); await MA.advanceBoard(cfg, MID, b, MA.lastGame(b).deadline + 1); c.ok(!b.done || b.via !== 'forfeit', 'single_clock_out_after_a_move_is_not_a_forfeit'); }
  } else if (sc === 'late_within_ready') { // first move has readyMs (30 s) so players can open the page: a move at the last ms is a real move, one ms later is a clock-out
    const g0 = MA.lastGame(b), x = g0.x, o = g0.o;
    c.eq(g0.deadline, T0 + cfg.readyMs, 'first_move_has_the_ready_time');
    const b2 = await freshBoard(cfg); const ok = await MA.applyMove(cfg, MID, b2, x, 4, T0 + cfg.readyMs, 0);
    c.ok(ok.ok && !MA.lastGame(b2).moves[0].auto, 'a_player_arriving_at_the_last_ms_of_the_ready_time_plays_for_real');
    const b3 = await freshBoard(cfg); const late = await MA.applyMove(cfg, MID, b3, x, 4, T0 + cfg.readyMs + 1, 0);
    c.ok(MA.lastGame(b3).moves[0]?.auto === true && MA.lastGame(b3).moves[0].pid === x, 'a_player_arriving_one_ms_late_has_a_move_played_for_them');
    c.ok(!late.ok && (late.error === 'not-your-turn' || late.error === 'square-taken' || late.error === 'stale'), 'late_move_refused_after_clock_out', JSON.stringify(late.error));
    c.eq(MA.moverOf(MA.lastGame(b3)), o, 'after_the_clock_out_play_passes_to_the_other_player');
  } else if (sc === 'refusals') {
    const g = MA.lastGame(b), x = g.x, o = g.o; let before = JSON.stringify(b);
    const chk = async (res, err, what) => { c.ok(!res.ok && res.error === err, 'refusal_code', `${what} got ${JSON.stringify(res.ok ? 'ok' : res.error)} want ${err}`); c.eq(JSON.stringify(b), before, 'refused_move_changes_nothing', what); };
    await chk(await MA.applyMove(cfg, MID, b, 'stranger', 0, t, 0), 'not-in-board', 'stranger');
    await chk(await MA.applyMove(cfg, MID, b, o, 0, t, 0), 'not-your-turn', 'out of turn');
    for (const bad of [-1, 9, 1.5, NaN, '3']) await chk(await MA.applyMove(cfg, MID, b, x, bad, t, 0), 'bad-square', `cell ${bad}`);
    await chk(await MA.applyMove(cfg, MID, b, x, 0, t, 5), 'stale', 'stale ply');
    c.ok((await MA.applyMove(cfg, MID, b, x, 0, t, 0)).ok, 'legal_move_accepted'); before = JSON.stringify(b);
    await chk(await MA.applyMove(cfg, MID, b, x, 1, t + 10, 1), 'not-your-turn', 'double tap by the same player');
    await chk(await MA.applyMove(cfg, MID, b, o, 0, t + 10, 1), 'square-taken', 'taken square');
    await chk(await MA.applyMove(cfg, MID, b, o, 1, t + 10, 0), 'stale', 'old screen');
  } else if (sc === 'advance_idempotent') { // R15: the result does not depend on when or how often anybody looks
    const plan = []; const g0 = MA.lastGame(b); const n = r.int(1, 5);
    const finalNow = g0.deadline + n * (cfg.moveMs + 1) + 1;
    const b1 = await freshBoard(cfg); await MA.advanceBoard(cfg, MID, b1, finalNow);
    const b2 = await freshBoard(cfg); let tt = T0; while (tt < finalNow) { tt = Math.min(finalNow, tt + r.int(1, 40000)); await MA.advanceBoard(cfg, MID, b2, tt); await MA.advanceBoard(cfg, MID, b2, tt); }
    const b3 = await freshBoard(cfg); await MA.advanceBoard(cfg, MID, b3, finalNow + 123456); await MA.advanceBoard(cfg, MID, b3, finalNow);
    c.ok(sameJson(b1, b2), 'advance_does_not_depend_on_how_often_it_is_called', `${JSON.stringify(b1).length}`);
    c.ok(sameJson(b1.games.map((g) => g.moves), b3.games.map((g) => g.moves)) || b3.done, 'advance_does_not_depend_on_when_it_is_called');
    auditBoard(c, b1, cfg, MID, T0, L); auditBoard(c, b2, cfg, MID, T0, L); void plan; return;
  } else if (sc === 'pause_shift') { // R28: while paused no clock runs; afterwards every clock has the same time left
    const g0 = MA.lastGame(b), pause = r.int(1000, 600000);
    MA.shiftBoard(b, pause); auditStart = T0 + pause; c.eq(MA.lastGame(b).deadline, g0.deadline, 'shift_mutates_the_same_deadline_object'); // same game object
    c.eq(MA.lastGame(b).deadline, T0 + cfg.readyMs + pause, 'every_open_clock_moves_later_by_the_pause');
    await MA.advanceBoard(cfg, MID, b, T0 + cfg.readyMs + 1); c.eq(MA.lastGame(b).moves.length, 0, 'no_clock_out_inside_the_paused_time');
    await MA.advanceBoard(cfg, MID, b, T0 + cfg.readyMs + pause + 1); c.eq(MA.lastGame(b).moves.length, 1, 'clock_out_comes_after_the_shifted_deadline');
    const d = await freshBoard(cfg); await play(cfg, d, sym(r, WIN_FIRST), T0 + 1000, c, 'done'); const before = JSON.stringify(d); MA.shiftBoard(d, 5000); c.eq(JSON.stringify(d), before, 'a_finished_board_has_no_clock_to_shift');
  } else if (sc === 'auto_cell_oracle') { // R12: many clock-outs: each played square equals the sealed seeded choice, stamped at its deadline
    const bb = await freshBoard(cfg); await MA.advanceBoard(cfg, MID, bb, T0 + cfg.readyMs + r.int(0, 1) * cfg.moveMs + 1);
    b = bb;
  }
  auditBoard(c, b, cfg, MID, auditStart, L);
  const again = await freshBoard(cfg); c.ok(sameJson(again.games[0].x, b.games[0].x), 'same_seed_same_first_mark');
}

// ================================================================ bracket (R16-R19)
const playersOf = (n, tag = 'p') => Array.from({ length: n }, (_, i) => ({ pid: `${tag}${String(i).padStart(3, '0')}`, name: `Player ${i}` }));
function auditBracket(c, t, n, format, teamSize, label) {
  const E = t.entrants.length, size = nextPow2(E), rounds = Math.log2(size);
  c.eq(t.size, size, 'bracket_size_is_next_power_of_two', label); c.eq(t.rounds, rounds, 'rounds_is_log2_of_size', label);
  c.eq(Object.keys(t.matches).length, Math.max(0, size - 1), 'a_knockout_has_size_minus_one_matches', label);
  const seen = new Map(), slotsR1 = [];
  for (let i = 0; i < size / 2 && rounds >= 1; i++) { const m = t.matches[`r1m${i}`]; slotsR1.push(m.a, m.b); }
  for (const id of slotsR1) if (id) seen.set(id, (seen.get(id) ?? 0) + 1);
  c.ok(t.entrants.every((e) => seen.get(e.id) === 1) || rounds === 0, 'every_entrant_has_exactly_one_place', label);
  if (rounds >= 1) {
    const byes = Object.values(t.matches).filter((m) => m.round === 1 && m.bye);
    c.eq(byes.length, size - E, 'number_of_byes_is_size_minus_entrants', label);
    for (let i = 0; i < size / 2; i++) { const m = t.matches[`r1m${i}`]; c.ok(!!(m.a || m.b), 'two_byes_never_meet', `${label} r1m${i}`); if (!m.a || !m.b) { c.ok(m.bye === true && m.status === 'done' && m.winner === (m.a ?? m.b), 'a_bye_wins_without_playing', `${label} r1m${i}`); c.eq(m.boards.length, 0, 'a_bye_has_no_board'); } else c.ok(!m.bye, 'no_bye_when_both_places_filled'); }
    for (const m of Object.values(t.matches)) if (m.round > 1) c.ok(!m.bye, 'byes_exist_only_in_round_one', `${label} ${m.mid}`);
    // a bye winner is already in round 2 at the right place (R18, R22)
    for (const m of byes) { const p = t.matches[`r2m${m.idx >> 1}`]; if (p) c.eq(p[m.idx % 2 === 0 ? 'a' : 'b'], m.winner, 'bye_winner_moves_up_to_the_right_slot', `${label} ${m.mid}`); }
  } else { c.ok(t.done && t.champion === t.entrants[0].id, 'a_single_entrant_is_champion_at_once', label); }
  c.ok(t.entrants.every((e) => e.members.length === teamSize), 'every_entrant_has_team_size_members', label);
  const all = t.entrants.flatMap((e) => e.members).concat(t.reserve);
  c.eq(new Set(all).size, all.length, 'no_player_is_seated_twice', label); c.eq(all.length, n, 'every_player_is_seated_or_in_reserve', label);
  if (format === 'team') { c.eq(t.reserve.length, n % teamSize, 'reserve_is_the_leftover_players', label); c.eq(E, Math.floor(n / teamSize), 'teams_are_full_teams_only', label); }
  else c.eq(t.reserve.length, 0, 'solo_has_no_reserve', label);
  for (const m of Object.values(t.matches)) if (m.status === 'live') { const k = m.boards.length; c.eq(k, teamSize, 'one_board_per_seat', `${label} ${m.mid}`); c.ok(m.boards.every((b, j) => b.j === j && b.a === t.entrants.find((e) => e.id === m.a).members[j] && b.b === t.entrants.find((e) => e.id === m.b).members[j]), 'board_j_pairs_seat_j_with_seat_j', `${label} ${m.mid}`); }
}
async function bracketCase(c, r, parts) {
  const kind = parts[1], seed = S(r), startAt = T0;
  if (kind === 'err') {
    const e = parts[2], ex = async (f, re, why) => { let msg = ''; try { await f(); } catch (x) { msg = x.message; } c.ok(re.test(msg), 'refused_with_plain_words', `${why}: ${msg || 'no error'}`); };
    const base = { eid: 'E1', seed, startAt };
    if (e === 'dup') await ex(() => BR.startTournament({ ...base, players: [{ pid: 'a', name: 'A' }, { pid: 'a', name: 'A2' }] }), /twice/i, 'dup');
    if (e === 'empty') await ex(() => BR.startTournament({ ...base, players: [] }), /at least one/i, 'empty');
    if (e === 'team_too_few') await ex(() => BR.startTournament({ ...base, players: playersOf(r.int(1, 2)), format: 'team', teamSize: 3 }), /not enough/i, 'few');
    if (e === 'team_size_4') await ex(() => BR.startTournament({ ...base, players: playersOf(8), format: 'team', teamSize: 4 }), /3 or 5/, 'size 4');
    if (e === 'too_many') await ex(() => BR.startTournament({ ...base, players: playersOf(BR.MAX_PLAYERS + 1) }), /too many/i, 'too many');
    return;
  }
  const format = kind === 'solo' ? 'solo' : 'team', teamSize = kind === 'team3' ? 3 : kind === 'team5' ? 5 : 1, n = +parts[2];
  const players = playersOf(n), opt = { eid: 'E1', seed, startAt, players, format, teamSize: format === 'team' ? teamSize : undefined };
  const t = await BR.startTournament(opt);
  auditBracket(c, t, n, format, teamSize, `${kind} ${n}`);
  const t2 = await BR.startTournament({ ...opt, players: shuf(r, players) }); // R16: the order the organizer typed the names in does not matter
  c.ok(sameJson(t, t2), 'typing_order_does_not_change_the_bracket', `${kind} ${n}`);
  const t3 = await BR.startTournament(opt); c.ok(sameJson(t, t3), 'same_input_same_bracket');
  if (t.entrants.length >= 8) { let diff = false; for (let k = 0; k < 4 && !diff; k++) diff = !sameJson((await BR.startTournament({ ...opt, seed: seed + k })).matches.r1m0, t.matches.r1m0); c.ok(diff, 'the_seed_decides_the_pairing', `${kind} ${n}`); }
}

// ================================================================ whole tournaments (R18, R20-R24)
const decideRng = (s) => rng(s, 7);
/** plays a tournament with simulated players; returns what is needed to audit it. */
async function playTournament(c, opts, decSeed, label) {
  const dr = decideRng(decSeed);
  const t = await BR.startTournament(opts);
  const absent = new Set();
  for (const p of opts.players) if (opts.style === 'all_absent' || (opts.style === 'some_absent' && dr.chance(0.3))) absent.add(p.pid);
  let T = opts.startAt, iter = 0;
  const moves = [];
  while (!t.done && iter++ < 6000) {
    await BR.advanceTournament(t, T);
    if (t.done) break;
    const live = []; for (const m of Object.values(t.matches)) if (m.status === 'live') for (const b of m.boards) if (!b.done) live.push([m, b]);
    if (!live.length) { c.ok(false, 'tournament_never_stalls', `${label} no live board but not done`); break; }
    let acted = false;
    for (const [m, b] of live) {
      if (b.done) continue;
      const g = MA.lastGame(b), who = MA.moverOf(g); if (absent.has(who)) continue;
      const e = CL.emptiesOf(g.cells); let cell = dr.pick(e);
      if (opts.style === 'drawish') { const mk = g.x === who ? 1 : 2; const ok = shuf(dr, e).find((k) => winO(CL.place(g.cells, k, mk)).marks.size === 0); if (ok !== undefined) cell = ok; }
      const res = await BR.moveInTournament(t, who, cell, T, g.moves.length);
      if (!c.ok(res.ok, 'legal_move_accepted_in_tournament', `${label} ${m.mid} ${res.ok ? '' : res.error}`)) return { t, absent, moves };
      moves.push([m.mid, b.j, who, cell, T]); acted = true;
    }
    if (acted) T += 500; else T = Math.min(...live.map(([, b]) => MA.lastGame(b).deadline)) + 1;
  }
  c.ok(t.done, 'tournament_terminates', `${label} iter ${iter}`);
  return { t, absent, moves, T };
}
async function auditTournament(c, t, absent, label) {
  const E = new Map(t.entrants.map((e) => [e.id, e]));
  const done = Object.values(t.matches);
  c.ok(done.every((m) => m.status === 'done'), 'every_match_is_played_or_a_bye', label);
  const losses = new Map();
  for (const m of done) {
    if (m.bye) continue;
    c.ok(!!m.a && !!m.b, 'a_played_match_has_two_sides', `${label} ${m.mid}`);
    c.ok(m.winner === m.a || m.winner === m.b, 'exactly_one_winner_per_match', `${label} ${m.mid} ${m.winner}`);
    c.eq(m.loser, m.winner === m.a ? m.b : m.a, 'loser_is_the_other_side', `${label} ${m.mid}`);
    c.ok(m.boards.length === E.get(m.a).members.length && m.boards.every((b) => b.done), 'every_board_decided_before_the_match', `${label} ${m.mid}`);
    const k = m.boards.length, wa = m.boards.filter((b) => E.get(m.a).members.includes(b.winner)).length;
    c.eq(m.winner, wa * 2 > k ? m.a : m.b, 'match_winner_is_the_side_that_won_more_boards', `${label} ${m.mid} ${wa}/${k}`); if (k % 2 === 1) c.ok(wa !== k - wa, 'teams_are_odd_so_no_tied_match');
    for (const b of m.boards) { auditBoard(c, b, cfgOf(t.seed, { moveMs: t.moveMs, readyMs: t.readyMs }), m.mid, m.startedAt, `${label} ${m.mid} b${b.j}`); }
    c.ok(m.startedAt >= t.startAt && m.doneAt >= m.startedAt, 'match_times_run_forward', `${label} ${m.mid}`);
    losses.set(m.loser, (losses.get(m.loser) ?? 0) + 1);
    // R22: a later match starts the moment both earlier matches are finished
    if (m.round > 1) { const f = [t.matches[`r${m.round - 1}m${2 * m.idx}`], t.matches[`r${m.round - 1}m${2 * m.idx + 1}`]]; c.eq(m.startedAt, Math.max(t.startAt, f[0].doneAt, f[1].doneAt), 'next_round_match_starts_when_both_feeders_are_done', `${label} ${m.mid}`); }
  }
  for (const m of done) { // winners move up to the right slot (independent of parentOf)
    if (m.round >= t.rounds) continue;
    const p = t.matches[`r${m.round + 1}m${m.idx >> 1}`]; c.eq(p[m.idx % 2 === 0 ? 'a' : 'b'], m.winner, 'winner_moves_up_to_the_right_slot', `${label} ${m.mid}`);
  }
  const fin = t.matches[`r${t.rounds}m0`];
  c.ok(t.done && t.champion === fin.winner, 'champion_is_the_winner_of_the_final', label);
  c.ok([...losses.values()].every((v) => v === 1), 'nobody_loses_twice', label); c.eq(losses.size, t.entrants.length - 1, 'everybody_but_the_champion_loses_exactly_once', label);
  c.ok(!losses.has(t.champion), 'champion_never_lost', label);
  // a loser never appears in a later round
  for (const m of done) if (m.round > 1) { const prev = (id) => [t.matches[`r${m.round - 1}m${2 * m.idx}`], t.matches[`r${m.round - 1}m${2 * m.idx + 1}`]].some((f) => f.winner === id); c.ok(prev(m.a) && prev(m.b), 'only_winners_reach_the_next_round', `${label} ${m.mid}`); }
  // a no-show never wins a board against a player who plays
  for (const m of done) if (!m.bye) for (const b of m.boards) if (absent.has(b.winner) && !absent.has(b.winner === b.a ? b.b : b.a)) c.ok(b.via === 'fate' || b.via === 'win', 'an_absent_player_wins_only_by_fate_or_by_the_clock_playing_a_winning_move', `${label} ${m.mid}`);
  // ranking (R24): unique ranks, order by (round reached, points, last match points, fate), each row says how it was separated
  const rows = await BR.rankings(t);
  c.eq(rows.length, t.entrants.length, 'everybody_is_ranked', label); c.ok(rows.every((x, i) => x.rank === i + 1), 'ranks_are_unique_and_in_order', label);
  c.eq(rows[0]?.id, t.champion, 'rank_one_is_the_champion', label); if (rows.length > 1) c.eq(rows[1].id, fin.loser, 'rank_two_is_the_runner_up', label);
  const pointsOf = (id) => { let p = 0, lastR = 0, lastP = 0; for (const m of done) { if (m.bye || (m.a !== id && m.b !== id)) continue; let q = 0; for (const b of m.boards) { for (const g of b.games) { const rs = g.result; if (!rs) continue; if (rs.kind === 'draw') { if (E.get(id).members.includes(g.x)) q++; if (E.get(id).members.includes(g.o)) q++; } else if (E.get(id).members.includes(rs.winner)) q += 2; } } p += q; if (m.round >= lastR) { lastR = m.round; lastP = q; } } return [p, lastP]; };
  for (const row of rows) { const [p, lp] = pointsOf(row.id); c.eq(row.points, p, 'ranking_points_are_two_per_game_won_one_per_draw', `${label} ${row.id}`); c.eq(row.lastMatchPoints, lp, 'ranking_last_match_points', `${label} ${row.id}`); }
  for (let i = 1; i < rows.length; i++) {
    const p = rows[i - 1], q = rows[i], key = (x) => [x.roundReached, x.points, x.lastMatchPoints];
    const kp = key(p), kq = key(q); let dec = 'fate'; const names = ['round reached', 'total points', 'points in the last match'];
    for (let k = 0; k < 3; k++) if (kp[k] !== kq[k]) { c.ok(kp[k] > kq[k], 'ranking_order_by_round_then_points_then_last_match', `${label} ${p.id} ${q.id}`); dec = names[k]; break; }
    if (dec === 'fate') c.ok(p.fate < q.fate, 'ranking_ties_end_in_fate_lower_wins', `${label}`);
    c.eq(q.decidedBy, dec, 'each_row_says_how_it_was_separated', `${label} rank ${i + 1}`);
    const line = BR.tieLine(q, p.name); if (dec === 'round reached') c.eq(line, '', 'no_tie_line_when_round_differs', label); else c.ok(line.includes(p.name) && line.includes(q.name) && line.includes(`separated by ${dec}`), 'tie_line_names_both_and_the_rule', line);
  }
  const fp = await PH.finishPayload(t); c.eq(fp.champion, t.champion, 'finish_payload_champion'); c.ok(fp.podium.length === Math.min(5, rows.length) && new Set(fp.podium.flat()).size === fp.podium.flat().length, 'podium_names_nobody_twice', label);
  // the view the audience sees
  const pv = BR.publicView(t); c.ok(!JSON.stringify(pv).includes(t.seed), 'public_view_has_no_seed', label); c.eq(pv.champion, t.names[t.champion] ?? t.entrants.find((e) => e.id === t.champion).name, 'public_view_names_the_champion', label);
  return rows;
}
async function tourneyCase(c, r, parts) {
  const team = parts[0] === 'team', teams = team ? +parts[1] : 0, size = team ? +parts[2] : 1;
  const n = team ? teams * size + +parts[4] : +parts[1], style = team ? parts[3] : parts[2];
  const players = playersOf(n), seed = S(r), dec = S(r), label = parts.join('|');
  const opts = { eid: 'E1', seed, players, format: team ? 'team' : 'solo', teamSize: team ? size : undefined, startAt: T0, style };
  const a = await playTournament(c, opts, dec, label);
  await auditTournament(c, a.t, a.absent, label);
  const b = await playTournament(new Case(), opts, dec, label);
  c.ok(sameJson(a.t, b.t), 'deterministic_replay_same_seed_same_tournament', label);
  const snap = JSON.stringify(a.t); await BR.advanceTournament(a.t, a.T + 99_999_999); c.eq(JSON.stringify(a.t), snap, 'a_finished_tournament_does_not_change_when_looked_at_later', label);
  const late = await BR.moveInTournament(a.t, players[0].pid, 0, a.T + 10, 0); c.ok(!late.ok, 'no_move_after_the_tournament_is_over', label);
  const after = await BR.rankings(a.t); c.ok(sameJson(after, await BR.rankings(a.t)), 'ranking_is_stable', label);
}

// ================================================================ the phone's replay equals the engine (R15, R27)
async function replayCase(c, r, parts) {
  const style = parts[1], seed = S(r), dec = S(r), players = playersOf(2), absentAll = style === 'all_absent';
  const opts = { eid: 'E1', seed, players, format: 'solo', startAt: T0, style };
  const run = await playTournament(c, opts, dec, `replay ${style}`);
  const eng = run.t.matches.r1m0;
  const setup = { eid: 'E1', state: 'running', commit: '', seed, roster: players, opts: { format: 'solo', teamSize: 1, moveMs: 20000, readyMs: 30000 }, startedMs: T0, pauses: [], serverNow: run.T, planDigest: null };
  const plan = await PH.planOf(setup); c.ok(sameJson(plan.t, (await BR.startTournament({ eid: 'E1', seed, players, startAt: T0 }))), 'every_phone_computes_the_same_bracket');
  const m = structuredClone(plan.t.matches.r1m0);
  const byBoard = new Map(); for (const [mid, j, who, cell, at] of run.moves) { if (mid !== 'r1m0') continue; byBoard.set(j, [...(byBoard.get(j) ?? []), { seq: (byBoard.get(j)?.length ?? 0) + 1, pid: who, sq: cell, ms: at }]); }
  const boards = [{ j: 0, a: eng.boards[0].a, b: eng.boards[0].b, events: byBoard.get(0) ?? [], result: null, reports: [] }];
  if (!eng.boards[0].done || !eng.boards[0].games.length) c.ok(false, 'engine_board_done');
  boards[0].events.push({ seq: boards[0].events.length + 1, pid: A, sq: PH.ABSENT, ms: run.T + 5 * 60000 }); // the waiting phone's claim at the end, so trailing clock-outs are replayed
  const rep = await PH.replayMatch(plan, T0, m, { mid: 'r1m0', reg: null, complete: false, boards, t: { state: 'running', pauses: [] } }, T0, [], run.T + 5 * 60000);
  const e = eng.boards[0], p = rep.m.boards[0];
  c.ok(sameJson(e.games.map((g) => g.moves), p.games.map((g) => g.moves)), 'phone_replay_has_the_same_moves_as_the_engine', style);
  c.eq(p.done, e.done, 'phone_replay_board_done_matches'); c.eq(p.winner, e.winner, 'phone_replay_winner_matches'); c.ok(sameJson(p.points, e.points), 'phone_replay_points_match');
  void absentAll;
}

// ================================================================ the sealed seed (R26)
async function sealCase(c, r, parts) {
  const k = parts[1], secret = SE.newSecret(), eid = `E${r.int(1, 999)}`, ps = playersOf(r.int(2, 12)).map((p) => p.pid);
  if (k === 'commit') {
    const commit = await SE.commitOf(secret);
    c.eq(commit, shaHex(`TTT-COMMIT|${secret}`), 'commit_is_the_documented_hash'); c.ok(await SE.verifyReveal(secret, commit), 'reveal_matches_the_commit');
    c.ok(!(await SE.verifyReveal(SE.newSecret(), commit)), 'a_different_secret_is_refused'); c.ok(!(await SE.verifyReveal(secret, shaHex('x'))), 'a_different_commit_is_refused');
    c.ok(!commit.includes(secret), 'commit_does_not_show_the_secret');
  } else if (k === 'seed_inputs') {
    const base = await SE.seedOf(secret, eid, ps, ''), bc = await SE.seedOf(secret, eid, ps, 'beacon' + r.int(1, 9));
    c.eq(base, await SE.seedOf(secret, eid, ps, ''), 'same_inputs_same_seed'); c.ok(base !== bc, 'a_public_beacon_changes_the_seed');
    c.ok(base !== (await SE.seedOf(SE.newSecret(), eid, ps)), 'the_secret_changes_the_seed'); c.ok(base !== (await SE.seedOf(secret, eid + 'x', ps)), 'the_tournament_id_changes_the_seed');
    c.eq(base, shaHex(`TTT-SEED|${secret}|${eid}|${shaHex(`TTT-ROSTER|${[...ps].sort().join(',')}`)}|`), 'seed_is_the_documented_hash');
  } else if (k === 'roster_order') {
    c.eq(await SE.seedOf(secret, eid, ps), await SE.seedOf(secret, eid, shuf(r, ps)), 'roster_order_does_not_change_the_seed'); c.eq(await SE.rosterHash(ps), await SE.rosterHash(shuf(r, ps)), 'roster_hash_is_order_free');
  } else if (k === 'late_roster_changes_seed') { // the roster is closed at the start and goes into the seed: somebody added afterwards would give another bracket, so nobody can join late
    const s0 = await SE.seedOf(secret, eid, ps), s1 = await SE.seedOf(secret, eid, [...ps, 'late-joiner']), s2 = await SE.seedOf(secret, eid, ps.slice(1));
    c.ok(s0 !== s1, 'adding_a_late_player_changes_the_seed'); c.ok(s0 !== s2, 'removing_a_player_changes_the_seed');
  } else if (k === 'fresh_secret') {
    const xs = Array.from({ length: 5 }, () => SE.newSecret()); c.ok(xs.every((x) => /^[0-9a-f]{64}$/.test(x)), 'secret_is_64_hex'); c.eq(new Set(xs).size, 5, 'secrets_are_fresh');
  }
}

// ================================================================ pause clock (R28)
function pauseCase(c, r, parts) {
  const kind = parts[2]; const ps = []; let t = r.int(1000, 5000);
  const n = kind === 'none' ? 0 : kind === 'one' || kind === 'open' ? 1 : r.int(2, 5);
  for (let i = 0; i < n; i++) { const from = t + r.int(100, 10000), to = from + r.int(100, 20000); ps.push([from, kind === 'open' && i === n - 1 ? null : to]); t = to; }
  let prev = -Infinity;
  for (let w = 0; w < t + 60000; w += r.int(100, 3000)) {
    const e = PH.effOf(ps, w);
    c.ok(e >= prev, 'tournament_clock_never_runs_backwards', `${w}`); prev = e; c.ok(e <= w, 'a_pause_only_ever_removes_time');
    let cut = 0, inside = false; for (const [f, to] of ps) { if (w > f) cut += Math.min(w, to ?? Infinity) - f; if (w > f && (to === null || w <= to)) inside = true; }
    c.eq(e, w - cut, 'effective_time_is_wall_time_minus_paused_time', `${w}`);
    if (!inside && ps.every(([, to]) => to !== null && to < w)) c.eq(PH.wallOf(ps, e), w, 'wall_time_of_effective_time_round_trips_after_the_pauses', `${w}`);
  }
  if (n) { const [f, to] = ps[0]; if (to !== null) c.eq(PH.effOf(ps, f + 1), PH.effOf(ps, to), 'no_time_passes_inside_a_pause', ''); }
}

// ================================================================ money: credit and pricing
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql) => { let args = []; const s = {
    bind: (...a) => { args = a.map((v) => (v === undefined ? null : v)); return s; },
    first: async (col) => { const row = db.prepare(sql).get(...args); return row === undefined ? null : col ? row[col] : { ...row }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map((x) => ({ ...x })) }),
    run: async () => { const x = db.prepare(sql).run(...args); return { meta: { changes: Number(x.changes) } }; } }; return s; };
  return { prepare: stmt, raw: db };
}
const DAY = 86_400_000, IST = 19_800_000;
const istParts = (ms) => { const d = new Date(ms + IST); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
/** end of day 365 in India time, from the calendar: the payment's own India date is day 0 */
const expiryO = (paid) => { const [y, m, d] = istParts(paid); return Date.UTC(y, m, d + 366) - IST; };
async function creditCase(c, r, parts, tag) {
  const [, scen, cur, edge] = parts;
  const db = d1();
  db.raw.exec('CREATE TABLE engagement (id TEXT PRIMARY KEY, org TEXT, pack INTEGER, cancelled_ms INTEGER)');
  for (const s of CR.CREDIT_SCHEMA) db.raw.exec(s);
  const org = `org${tag}`, eid = `g${tag}`, now = Date.UTC(2027, r.int(0, 11), r.int(1, 28), r.int(0, 23), r.int(0, 59), r.int(0, 59));
  db.raw.prepare('INSERT INTO engagement (id, org, pack, cancelled_ms) VALUES (?,?,0,?)').run(eid, org, scen === 'cancelled_game' ? now - 1000 : null);
  const g = r.pick(GOLDEN), pricePaise = (cur === 'INR' ? g[1] : g[2]) * 100, price = pricePaise / 100;
  const paidAt = (daysAgo) => { if (edge === 'ist_midnight') { const [y, m, d] = istParts(now - daysAgo * DAY); return Date.UTC(y, m, d) - IST + r.pick([-1, 0, 1]); } return now - daysAgo * DAY - r.int(0, DAY - 1); };
  const mk = async (id, paise, paid, o = org, cu = cur) => {
    const row = await CR.creditFromPayment(db, { id, amount: paise / 100, currency: cu, paid_ms: paid }, o, null, now, 'cancel');
    c.ok(!!row, 'credit_made_from_paid_amount');
    if (row) { c.eq(row.expires_ms, expiryO(paid), 'credit_lapses_at_end_of_day_365_ist', `paid ${paid}`); c.eq(Math.round(row.total_inr * 100), paise, 'credit_keeps_exact_amount'); }
    return row;
  };
  const rows = async () => (await db.prepare('SELECT * FROM credit ORDER BY created_ms').all()).results;
  const uses = async () => (await db.prepare('SELECT * FROM credit_use').all()).results;
  const invariants = async () => {
    for (const x of await rows()) {
      for (const f of ['total_inr', 'remaining_inr', 'lapsed_inr']) c.ok(Math.abs(x[f] * 100 - Math.round(x[f] * 100)) < 1e-6, 'money_whole_paise_no_float_drift', `${f}=${x[f]}`);
      c.ok(x.remaining_inr >= 0 && x.lapsed_inr >= 0, 'money_never_negative', `${x.remaining_inr} ${x.lapsed_inr}`);
      const used = (await uses()).filter((u) => u.credit_id === x.id && u.status === 'applied').reduce((s, u) => s + Math.round(u.amount_inr * 100), 0);
      c.eq(Math.round(x.remaining_inr * 100) + used + Math.round(x.lapsed_inr * 100), Math.round(x.total_inr * 100), 'money_conserved_remaining_plus_used_plus_lapsed');
    }
    c.ok(Math.round((await CR.creditAppliedFor(db, eid)) * 100) <= pricePaise, 'no_double_payout_credit_applied_never_above_price');
    c.ok((await uses()).every((u) => u.amount_inr > 0), 'money_never_negative_use_rows');
  };
  const apply = (t = now) => CR.applyCreditToGame(db, org, eid, price, cur, t);
  if (['full', 'remainder', 'partial', 'idempotent', 'restore', 'restore_twice', 'restore_lapsed', 'reapply'].includes(scen)) {
    const amt = scen === 'full' ? pricePaise : scen === 'remainder' ? pricePaise + r.int(1, 500_000) : scen === 'partial' ? r.int(100, pricePaise - 1) : r.int(100, pricePaise * 2);
    const row = await mk(`pay_${tag}_1`, amt, paidAt(r.int(1, 300))), res = await apply(), want = Math.min(amt, pricePaise);
    c.eq(Math.round(res.appliedInr * 100), want, 'credit_applied_up_to_price', `${scen} amt=${amt} price=${pricePaise}`);
    const after = (await rows())[0];
    c.eq(Math.round(after.remaining_inr * 100), amt - want, 'remainder_stays_as_credit'); c.eq(after.status, amt - want > 0 ? 'active' : 'used', 'credit_status_after_use'); c.eq(after.expires_ms, row.expires_ms, 'remainder_keeps_same_expiry');
    if (scen === 'idempotent') { const again = await apply(); c.eq(again.usedNow.length, 0, 'no_double_payout_apply_twice_uses_nothing_more'); c.eq(Math.round(again.appliedInr * 100), want, 'apply_twice_same_total'); }
    if (scen === 'restore' || scen === 'restore_twice' || scen === 'reapply') {
      const back1 = await CR.restoreCreditUses(db, eid, now + 1000);
      const back = (await rows())[0];
      c.eq(Math.round(back.remaining_inr * 100), amt, 'cancel_puts_credit_back'); c.eq(back.expires_ms, row.expires_ms, 'restore_never_stretches_365_days'); c.eq(Math.round((await CR.creditAppliedFor(db, eid)) * 100), 0, 'nothing_applied_after_restore');
      c.eq(back1.reduce((s, x) => s + Math.round(x.amount * 100), 0), want, 'restore_reports_what_it_put_back');
      if (scen === 'restore_twice') { const again = await CR.restoreCreditUses(db, eid, now + 2000); c.eq(again.length, 0, 'no_double_payout_restore_twice_gives_nothing_more'); c.eq(Math.round((await rows())[0].remaining_inr * 100), amt, 'credit_not_inflated_by_second_restore'); }
      if (scen === 'reapply') { const re = await apply(now + 3000); c.eq(Math.round(re.appliedInr * 100), want, 'credit_can_pay_again_after_restore'); c.eq(Math.round((await rows())[0].remaining_inr * 100), amt - want, 'reapply_leaves_the_same_remainder'); }
    }
    if (scen === 'restore_lapsed') {
      await CR.restoreCreditUses(db, eid, row.expires_ms + r.int(0, 10 * DAY)); const back = (await rows())[0];
      c.eq(Math.round(back.remaining_inr * 100), amt - want, 'lapsed_credit_does_not_come_back_usable'); c.eq(Math.round(back.lapsed_inr * 100), want, 'restored_after_lapse_counts_as_lapsed');
    }
  } else if (scen === 'two_oldest') {
    const a1 = r.int(100, pricePaise - 100), a2 = r.int(pricePaise - a1 + 1, pricePaise * 2);
    const older = await mk(`pay_${tag}_old`, a1, paidAt(r.int(200, 360))), newer = await mk(`pay_${tag}_new`, a2, paidAt(r.int(1, 150)));
    const res = await apply(); c.eq(Math.round(res.appliedInr * 100), pricePaise, 'two_credits_cover_price');
    const rs2 = await rows(), o = rs2.find((x) => x.id === older.id), nw = rs2.find((x) => x.id === newer.id);
    c.eq(Math.round(o.remaining_inr * 100), 0, 'oldest_expiring_used_first'); c.eq(Math.round(nw.remaining_inr * 100), a2 - (pricePaise - a1), 'newer_credit_pays_only_the_rest');
  } else if (scen === 'expired_old' || scen === 'at_expiry' || scen === 'before_expiry') {
    const amt = r.int(100, pricePaise * 2), row = await mk(`pay_${tag}_e`, amt, paidAt(scen === 'expired_old' ? r.int(367, 700) : 200));
    const t = scen === 'expired_old' ? now : scen === 'at_expiry' ? row.expires_ms : row.expires_ms - 1, res = await apply(t);
    c.eq(Math.round(res.appliedInr * 100), scen === 'before_expiry' ? Math.min(amt, pricePaise) : 0, 'expired_credit_unusable_valid_until_last_ms', `${scen} t-exp=${t - row.expires_ms}`);
    if (scen === 'expired_old') c.eq(row.status, 'expired', 'credit_from_old_payment_is_born_lapsed');
  } else if (scen === 'cancelled_game') {
    await mk(`pay_${tag}_c`, r.int(100, pricePaise * 2), paidAt(10)); const res = await apply(); c.eq(Math.round(res.appliedInr * 100), 0, 'no_credit_on_a_cancelled_game');
  } else if (scen === 'dup_payment') {
    const amt = r.int(100, pricePaise * 2), paid = paidAt(10), a = await mk(`pay_${tag}_d`, amt, paid);
    const b = await CR.creditFromPayment(db, { id: `pay_${tag}_d`, amount: amt / 100, currency: cur, paid_ms: paid }, org, null, now + 5000, 'late');
    c.eq(b?.id, a?.id, 'no_double_payout_one_credit_per_payment'); c.eq((await rows()).length, 1, 'no_second_credit_row'); c.eq(Math.round((await rows())[0].total_inr * 100), amt, 'credit_total_not_doubled');
    c.eq(await CR.creditFromPayment(db, { id: 'zero', amount: 0, currency: cur }, org, null, now, 'cancel'), null, 'no_credit_for_a_zero_payment');
  } else if (scen === 'other_org' || scen === 'other_currency') {
    await mk(`pay_${tag}_x`, r.int(100, pricePaise * 2), paidAt(10), scen === 'other_org' ? `${org}b` : org, scen === 'other_currency' ? (cur === 'INR' ? 'USD' : 'INR') : cur);
    const res = await apply(); c.eq(Math.round(res.appliedInr * 100), 0, scen === 'other_org' ? 'credit_belongs_to_one_account' : 'credit_is_spent_only_in_its_own_currency');
  }
  await invariants();
}
function priceCase(c, r, parts) {
  const [, a, b] = parts;
  if (a === 'unknown') { for (const bad of [0, 99, 101, -5, 1e9, NaN]) { let m = ''; try { PR.price(bad, 'INR'); } catch (e) { m = e.message; } c.ok(/unknown pack/.test(m), 'unknown_pack_refused', String(bad)); } return; }
  if (a === 'monotone') { for (const cu of ['INR', 'USD']) { let prev = 0; for (const g of GOLDEN) { const p = PR.price(g[0], cu).total; c.ok(p > prev, 'a_bigger_pack_costs_more', `${cu} ${g[0]}`); prev = p; } } c.eq(PR.PACKS.length, GOLDEN.length, 'pack_list_has_the_owner_packs'); return; }
  const g = GOLDEN.find((x) => x[0] === +a), p = PR.price(+a, b);
  c.eq(p.total, b === 'INR' ? g[1] : g[2], 'price_is_the_owner_list', `${a} ${b}`); c.eq(p.tax, 0, 'no_gst_charged_while_the_seller_is_not_registered'); c.eq(p.base, p.total, 'base_equals_total_without_gst');
  c.ok(Number.isInteger(p.total) && p.total > 0, 'price_whole_and_above_zero'); c.eq(PR.GST_ON, false, 'gst_switch_off');
}

// ================================================================ wording and fixed texts
const indian = (n) => { const s = String(n), l = s.slice(-3), h = s.slice(0, -3); return h ? h.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + l : l; };
function wordCase(c, r, parts) {
  const k = parts[1];
  if (k === 'round_names') { const rounds = +parts[2], t = { rounds }, names = []; for (let i = 1; i <= rounds; i++) { const want = i === rounds ? 'Final' : i === rounds - 1 ? 'Semi-final' : i === rounds - 2 ? 'Quarter-final' : `Round ${i}`; c.eq(BR.roundName(t, i), want, 'round_name', `${rounds} ${i}`); names.push(BR.roundName(t, i)); } c.eq(new Set(names).size, rounds, 'round_names_are_distinct'); }
  else if (k === 'tie_lines') {
    const row = (d) => ({ rank: 2, id: 'x', name: 'Beta', roundReached: 1, points: 1, lastMatchPoints: 1, fate: '', decidedBy: d });
    c.eq(BR.tieLine(row(''), 'Alpha'), '', 'no_tie_line_for_the_champion'); c.eq(BR.tieLine(row('round reached'), 'Alpha'), '', 'no_tie_line_when_the_round_differs');
    c.eq(BR.tieLine(row('total points'), 'Alpha'), 'Alpha and Beta were level on round reached; separated by total points.', 'tie_line_total_points');
    c.eq(BR.tieLine(row('points in the last match'), 'Alpha'), 'Alpha and Beta were level on round reached and total points; separated by points in the last match.', 'tie_line_last_match');
    c.eq(BR.tieLine(row('fate'), 'Alpha'), 'Alpha and Beta were level on round reached, total points and points in the last match; separated by fate.', 'tie_line_fate');
  } else if (k === 'money_text') {
    for (let i = 0; i < 20; i++) {
      const whole = r.pick([0, 1, 34, 999, 2399, 17699, 29499, 100000, 1234567]), frac = r.pick([0, 0.5, 0.25, 0.07]);
      const v = whole + frac, fixed = Math.abs(v - Math.round(v)) < 0.005;
      const inr = CR.rs(v), usd = CR.rs(v, 'USD');
      c.eq(inr, 'Rs ' + (fixed ? indian(Math.round(v)) : indian(Math.floor(v)) + '.' + v.toFixed(2).split('.')[1]), 'rupee_text_indian_grouping', String(v));
      c.eq(usd, 'US$' + (fixed ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { minimumFractionDigits: 2 })), 'dollar_text', String(v));
    }
    const lastDay = (paid) => CR.creditLastDay(CR.creditExpiryMs(paid)); const p = Date.UTC(2027, r.int(0, 11), r.int(1, 28), r.int(0, 23), r.int(0, 59));
    const [y, m, d] = istParts(p), last = new Date(Date.UTC(y, m, d + 365)), mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][last.getUTCMonth()];
    const mm = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(lastDay(p)); c.ok(!!mm && +mm[1] === last.getUTCDate() && mm[2].slice(0, 3) === mon && +mm[3] === last.getUTCFullYear(), 'last_usable_day_told_is_day_365', lastDay(p));
  } else if (k === 'fixed_text') {
    c.eq(PH.ENDED_MESSAGE, 'The organizer ended the tournament. Thank you for playing.', 'ended_message');
    const L = CR.NO_REFUND_LINE; c.ok(/We do not give refunds/.test(L) && /365 days/.test(L) && /day 365/.test(L) && /credit/.test(L), 'refund_line_says_no_refunds_credit_for_365_days', L);
    c.eq(CR.CREDIT_DAYS, 365, 'credit_days_is_365');
  } else if (k === 'public_view') {
    const t = BR.startTournament; return t({ eid: 'E1', seed: 'SECRETSEED' + r.int(1, 99999), players: playersOf(r.int(2, 9)), startAt: T0 }).then((tt) => {
      const pv = JSON.stringify(BR.publicView(tt)); c.ok(!pv.includes(tt.seed) && !/seed|secret|device|email|phone/i.test(pv), 'spectator_view_has_no_seed_or_personal_data');
      c.ok(tt.entrants.every((e) => pv.includes(e.name)) || tt.entrants.length === 1, 'spectator_view_shows_display_names');
    });
  }
}

// ================================================================ what the game does not have
const LACK_RE = { booster: /booster/i, joker: /joker/i, prize: /prize|reward|gift|cash/i, vote: /vote|ballot/i, late_join: /late|addPlayer|joinAfter|joinLate|latecomer/i, payout: /payout|pay_?out|winnings|withdraw/i, stake: /stake|bet\b|wager|odds/i };
function lackCase(c, r, parts) {
  const f = parts[1], re = LACK_RE[f];
  const names = [...Object.keys(IX), ...Object.keys(BR), ...Object.keys(MA), ...Object.keys(CL), ...Object.keys(PH)].filter((n) => !['MISSED_LIMIT'].includes(n));
  c.eq(names.filter((n) => re.test(n)).join(','), '', 'the_game_has_no_such_feature_so_none_is_exported', f);
  const sample = JSON.stringify({ opts: { moveMs: 1, readyMs: 1 }, keys: ['v', 'eid', 'format', 'teamSize', 'moveMs', 'readyMs', 'seed', 'entrants', 'reserve', 'size', 'rounds', 'startAt', 'matches', 'done', 'champion', 'names'] });
  c.ok(!re.test(sample.replace(/startAt|readyMs/g, '')), 'tournament_state_has_no_field_for_it', f);
  return BR.startTournament({ eid: 'E1', seed: S(r), players: playersOf(4), startAt: T0 }).then((t) => { const keys = new Set(); const walk = (o) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (!/^(r\d+m\d+|p\d+|team\d+)$/.test(k)) keys.add(k); walk(v); } }; walk(t); c.eq([...keys].filter((k) => re.test(k) && !/^(startAt|readyMs|startedAt)$/.test(k)).join(','), '', 'played_state_has_no_key_for_it', f); });
}

// ================================================================ one case
export async function runCase(w, idx, seed) {
  const cell = CELLS[idx % CELLS.length], parts = cell.split('|');
  const r = rng(seed, idx), c = new Case(), tag = `${String(seed).replace(/\W/g, '')}n${idx}`;
  try {
    const h = { classic: classicCase, board: boardCase, bracket: bracketCase, tourney: tourneyCase, team: tourneyCase, replay: replayCase, seal: sealCase, pause: pauseCase, credit: creditCase, price: priceCase, word: wordCase, lack: lackCase }[parts[0]];
    await h(c, r, parts, tag);
  } catch (err) { c.ok(false, 'no_exception', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ')); }
  return { cell, c };
}
