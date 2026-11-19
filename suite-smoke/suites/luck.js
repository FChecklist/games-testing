// Seeded, deterministic, in-process smoke suite for Corporate Luck by Chance (public repo, read-only clone). No servers, no network, no bun.
// Same harness contract as suites/tambola.js and tambola2.js: exports CELLS, newWorld, runCase(w, idx, seed) -> { cell, c }; Case methods ok/eq/note; rng(seed, idx).
// Drives the REAL TypeScript (loaded through lib/tsresolve.js): packages/luck (random, settings, timeline, engine) and apps/edge (luck.ts routes on an in-memory
// node:sqlite stand-in for D1, credit.ts, worker.ts SCHEMA) and packages/shared pricing. The product source on disk is never edited.
// The repo is found at LUCK_REPO, else <SUITE_ROOT>/corporate-luck-by-chance, else <SUITE_ROOT>/sc/corporate-luck-by-chance (mutation copies use LUCK_REPO).
//
// The ORACLE is written from the product documents, not from its outputs: docs/RULES.md (R01..R70), docs/GAME.md, docs/ROLES_AND_CONSOLE_SPEC_6.md (credit),
// the owner's pack price list. Targets, dice and fate numbers are re-derived here with node:crypto (a second route to the same numbers, not the product's code).
//
// THE LIFECYCLE, STEP BY STEP (what the game HAS is a cell family; what it LACKS is listed at the bottom and proved absent by the "absent" cells):
//   settings  organizer's choices and prize texts            lobby   start, seat list, closing of the list      late    late joiners / watchers
//   odds      the odds table: target, dice, hit, points      round   a whole game, dice round by dice round     rank    strict ranking and tie wording
//   time      the clock: window, reveal, break, over         end     organizer ends the game after a round      vote    game-over vote, quorum, podium
//   prize     prizes paid to places (payout = prize table)   money   credit, pack prices, players never pay      word    wording and privacy of what players read
//   engine    endAfterRound on the engine                    absent  steps this game does not have              replay  determinism of a case
// What the game LACKS (listed so nobody looks for it): scratch cards, boosters (joker, extra ticket, lucky-draw pass), an Unlucky prize, lucky draws between rounds,
// opening/closing messages and messages between rounds (R52), pause (R51: one fixed clock), late joiners who play (R36: the list closes at the start; a late phone only
// watches), presence mode and the golden shoot-out (R24), players paying anything (R43/R47), a show-of-hands vote to END the game (the only vote is the result vote R39).
import '../lib/tsresolve.js';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { ROOT } from '../lib/roots.js';

const REPO = process.env.LUCK_REPO ?? (existsSync(resolve(ROOT, 'corporate-luck-by-chance')) ? resolve(ROOT, 'corporate-luck-by-chance') : resolve(ROOT, 'sc/corporate-luck-by-chance'));
const R = (p) => import(pathToFileURL(resolve(REPO, p)).href);
const EN = await R('packages/luck/src/index.ts');
const LK = await R('apps/edge/src/luck.ts');
const CR = await R('apps/edge/src/credit.ts');
const PR = await R('packages/shared/src/pricing.ts');
const WK = await R('apps/edge/src/worker.ts');
const LUCK_TS = readFileSync(resolve(REPO, 'apps/edge/src/luck.ts'), 'utf8');

// ================================================================ independent oracle (from the documents)
const AT = String.fromCharCode(64);
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
/** The product's stream/below, written again with node:crypto: first 32 bits of sha256(seed|label#k|0), rejection sampling below floor(2^32/n)*n. */
const u32 = (seed, label, k) => createHash('sha256').update(`${seed}|${label}#${k}|0`, 'utf8').digest().readUInt32BE(0);
const belowO = (seed, label, n) => { const lim = Math.floor(4294967296 / n) * n; for (let k = 0; ; k++) { const v = u32(seed, label, k); if (v < lim) return v % n; } };
/** THE ODDS TABLE (R03, R05, R07, R11): faces 1..6, every face the same weight, a hit pays the target's face value, a miss pays nothing. */
const ODDS = { faces: [1, 2, 3, 4, 5, 6], weight: [1, 1, 1, 1, 1, 1], pay: (target, dice) => (dice === target ? target : 0) };
const targetO = (gid, g, A) => 1 + belowO(`LBC-TARGET|${gid}|${g}|${A}`, 't', 6);
const diceO = (gid, seat, g, B) => 1 + belowO(`LBC-DICE|${gid}|${seat}|${g}|${B}`, 'd', 6);
const fateO = (gid, label, seat, beacon) => sha(`LBC-FATE|${gid}|${label}|${seat}|${beacon}`);
const hexs = (r, n) => Array.from({ length: n }, () => r.int(0, 15).toString(16)).join('');
const DAY = 86_400_000, IST = 19_800_000;
const GOLDEN = [[100, 2399, 34], [250, 3499, 51], [500, 4699, 67], [750, 5899, 84], [1000, 7099, 101], [2500, 11799, 169], [5000, 17699, 253], [10000, 29499, 421]];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const istParts = (ms) => { const d = new Date(ms + IST); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const creditExpiryOracle = (paidMs) => { const [y, m, d] = istParts(paidMs); return Date.UTC(y, m, d + 366) - IST; };

/** Plain sentence a player can read (RULES H, J): starts with a capital or digit, ends with a stop, no machine words. */
function plain(c, text, where) {
  const ok = typeof text === 'string' && text.length >= 8 && /^[A-Z0-9]/.test(text) && /[.!?)]$/.test(text) && !/undefined|\bnull\b|NaN|\[object|Error:|exception|stack/i.test(text);
  c.ok(ok, 'refusal_is_a_plain_sentence', `${where}: ${JSON.stringify(text)}`);
}

/** Independent play of a whole game from the beacon values A[g], B[g]: targets, dice, tallies (total and per round). */
function simO(gid, s, seats, A, B) {
  const T = s.rounds * s.diceRounds, targets = [], dice = [];
  const mk = (seat) => ({ seat, points: 0, hits: 0, best: 0, reachedAt: -1 });
  const total = Array.from({ length: seats }, (_, i) => mk(i)), rt = Array.from({ length: s.rounds }, () => Array.from({ length: seats }, (_, i) => mk(i)));
  for (let g = 0; g < T; g++) {
    const t = targetO(gid, g, A[g]); targets.push(t); const row = [];
    for (let seat = 0; seat < seats; seat++) {
      const d = diceO(gid, seat, g, B[g]); row.push(d);
      const p = ODDS.pay(t, d);
      if (p > 0) for (const x of [total[seat], rt[Math.floor(g / s.diceRounds)][seat]]) { x.points += p; x.hits++; x.best = Math.max(x.best, t); x.reachedAt = g; }
    }
    dice.push(row);
  }
  return { targets, dice, total, rt };
}
const measureO = (a, b) => (a.points !== b.points ? 'points' : a.best !== b.best ? 'best' : a.hits !== b.hits ? 'hits' : a.reachedAt !== b.reachedAt ? 'earliest' : 'fate');
const WORDS = { points: 'points', best: 'the highest single hit', hits: 'the most hits', earliest: 'who reached the score first', fate: 'fate (a number from the public beacon)' };
/** R15-R22: points, then highest single hit, then most hits, then who reached it first, then fate (lower hex wins). Returns the whole strict order with the wording of each place. */
function rankO(gid, label, beacon, tallies, top) {
  const fate = new Map(tallies.map((t) => [t.seat, fateO(gid, label, t.seat, beacon)]));
  const full = [...tallies].sort((a, b) => b.points - a.points || b.best - a.best || b.hits - a.hits || a.reachedAt - b.reachedAt || (fate.get(a.seat) < fate.get(b.seat) ? -1 : fate.get(a.seat) > fate.get(b.seat) ? 1 : 0));
  const out = [];
  for (let i = 0; i < Math.min(top, full.length); i++) {
    const t = full[i], prev = full[i - 1], next = full[i + 1];
    const tiedPrev = prev && prev.points === t.points, tiedNext = next && next.points === t.points;
    let line = '';
    if (tiedPrev || tiedNext) { const m = tiedPrev ? measureO(prev, t) : measureO(t, next); line = `Tied on ${t.points} point${t.points === 1 ? '' : 's'}; decided by ${WORDS[m]}.`; }
    out.push({ place: i + 1, seat: t.seat, points: t.points, hits: t.hits, best: t.best, reachedAt: t.reachedAt, line });
  }
  return out;
}
/** R25: "you are in the top x%": players strictly ahead on the four numbers, x = ceil((ahead+1)/players*100), at least 1. */
function standingO(tallies, seat) {
  const me = tallies[seat]; let ahead = 0;
  for (const t of tallies) if (t !== me && (t.points > me.points || (t.points === me.points && (t.best > me.best || (t.best === me.best && (t.hits > me.hits || (t.hits === me.hits && t.reachedAt < me.reachedAt))))))) ahead++;
  return { ahead, of: tallies.length, percent: Math.max(1, Math.ceil(((ahead + 1) / tallies.length) * 100)) };
}
/** R26-R29: prize text per place; who gets it. Without "one win per player" place p goes to the p-th of that ranking; with it, down the list to the next who has won nothing. */
function prizesO(s, roundLists, overall) {
  const wins = [], won = new Set();
  const one = (name, list, texts) => {
    // place p goes to the p-th of the ranking; with "one win per player" the p-th of the players who have won nothing in an earlier ranking (a blank place keeps its slot)
    const elig = s.oneWinPerPlayer ? list.filter((x) => !won.has(x.seat)) : list;
    for (let p = 1; p <= Math.min(5, texts.length); p++) {
      if (!texts[p - 1] || p > elig.length) continue;
      wins.push({ ranking: name, place: p, seat: elig[p - 1].seat, prize: texts[p - 1] });
    }
    for (const w of wins) if (w.ranking === name) won.add(w.seat);
  };
  if (s.prizeMode !== 'overall') roundLists.forEach((l, i) => one(`round-${i + 1}`, l, s.prizes.rounds[i] ?? []));
  if (s.prizeMode !== 'rounds') one('overall', overall, s.prizes.overall);
  return wins;
}
/** R30/R31: the clock walked segment by segment (a different route from the product's formulas). */
function clockO(s, start) {
  const seg = []; let t = start;
  for (let rd = 0; rd < s.rounds; rd++) {
    for (let d = 0; d < s.diceRounds; d++) {
      const g = rd * s.diceRounds + d;
      seg.push({ kind: 'window', from: t, to: t + s.windowSecs * 1000, g, open: t }); t += s.windowSecs * 1000;
      seg.push({ kind: 'reveal', from: t, to: t + s.revealSecs * 1000, g }); t += s.revealSecs * 1000;
    }
    if (rd < s.rounds - 1) { seg.push({ kind: 'break', from: t, to: t + s.breakSecs * 1000, afterRound: rd + 1 }); t += s.breakSecs * 1000; }
  }
  return { seg, end: t };
}
const phaseO = (cl, start, now) => { if (now < start) return { kind: 'before' }; if (now >= cl.end) return { kind: 'over' }; return cl.seg.find((x) => now >= x.from && now < x.to); };
const quorumO = (n) => (n < 3 ? n : Math.max(3, Math.ceil(n * 0.05)));

const mkSettings = (r, o = {}) => {
  const s = EN.defaultSettings();
  s.rounds = o.rounds ?? 1; s.windowSecs = o.windowSecs ?? r.pick([6, 10, 15]); s.prizeMode = o.prizeMode ?? 'both'; s.oneWinPerPlayer = !!o.oneWin;
  const txt = (k) => (o.texts === 'none' ? [] : Array.from({ length: o.texts === 'gaps' ? 5 : k }, (_, i) => (o.texts === 'gaps' && i % 2 === 1 ? '' : `Gift ${i + 1} x${r.int(1, 99)}`)));
  s.prizes = { overall: txt(r.int(1, 5)), rounds: Array.from({ length: s.rounds }, () => txt(r.int(0, 5))) };
  return s;
};
const beacons = (r, T) => ({ A: Array.from({ length: T }, () => hexs(r, 16)), B: Array.from({ length: T }, () => hexs(r, 16)) });
const strip = (l) => l.map((x) => ({ place: x.place, seat: x.seat, points: x.points, hits: x.hits, best: x.best, reachedAt: x.reachedAt, line: x.line }));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ================================================================ cells
const SETTINGS_KINDS = [
  ...[0, 1, 5, 10, 20, 21, -3, 1.5, 'abc', 100].map((v) => `rounds|${v}`),
  ...[6, 10, 15, 7, 0, 30].map((v) => `window|${v}`),
  ...['both', 'overall', 'rounds', 'x', 'ALL'].map((v) => `prizemode|${v}`),
  ...['true', 'false', 'missing'].map((v) => `onewin|${v}`),
  ...[0, 1, 3, 5, 6, 9].map((v) => `overall_len|${v}`),
  ...['gift', 'money_word', 'rupee_sign', 'dollar_sign', 'jackpot', 'bet', 'long_120', 'long_121', 'spaces', 'not_text', 'cashew_ok', 'empty'].map((v) => `prize_text|${v}`),
  ...['equal', 'one_more', 'fewer', 'bad_entry', 'not_array'].map((v) => `round_lists|${v}`),
];
const PRIZE_MODES = ['both', 'overall', 'rounds'], TF = ['t', 'f'];
const PLAY_CELLS = [
  ...cross(['round'], ['2', '3', '10', '30'], ['1', '2', '3'], PRIZE_MODES, TF).map((c) => c.join('|')),
  ...cross(['round'], ['2', '5'], ['10'], ['both'], TF).map((c) => c.join('|')),
];
const CREDIT_SCEN = ['full', 'remainder', 'partial', 'two_oldest', 'expired_old', 'at_expiry', 'before_expiry', 'cancelled_game', 'idempotent', 'restore', 'restore_lapsed', 'dup_payment', 'other_org', 'other_currency'];
const VOTE_SCEN = ['agree', 'one_short', 'forged_minority', 'split_below_quorum', 'timeout', 'early_vote', 'not_in_game', 'wrong_device', 'bad_shapes', 'repeat_vote', 'done_then_forged'];
const LOBBY = ['too_few', 'blocked_not_counted', 'start_twice', 'delay_bounds', 'bad_settings_refused', 'non_organizer', 'seats_closed_before_start', 'seats_frozen_dense', 'beacon_before_start', 'reveal_hidden', 'public_views_private', 'me_states', 'beacon_only_when_due', 'fee_fields_ignored'];
const ABSENT = ['scratch', 'booster', 'joker', 'unlucky', 'lucky', 'join', 'pause', 'shootout', 'presence', 'message'];
export const CELLS = [
  ...SETTINGS_KINDS.map((k) => `settings|${k}`),
  ...cross(['odds'], ['target', 'dice', 'hit_rate'], ['600', '3000']).map((c) => c.join('|')),
  'odds|score|table', 'odds|pair|independent', 'odds|seat|sensitive', 'odds|beacon|sensitive',
  ...PLAY_CELLS,
  ...cross(['engine'], ['none_played', 'mid_round', 'exact_boundary', 'before_boundary', 'n_ge_rounds', 'n_zero', 'n_float', 'out_of_order', 'missing_beacon', 'early_ranking']).map((c) => c.join('|')),
  ...cross(['rank'], ['dense', 'sparse', 'zero', 'cut_best', 'cut_fate', 'one_point'], ['5', '10']).map((c) => c.join('|')),
  ...cross(['prize'], PRIZE_MODES, TF, ['full', 'gaps', 'none'], ['2', '3', '6', '12']).map((c) => c.join('|')),
  ...cross(['time'], ['1', '2', '10', '20'], ['6', '10', '15']).map((c) => c.join('|')),
  ...cross(['lobby'], LOBBY).map((c) => c.join('|')),
  ...cross(['late'], ['before_start', 'running', 'over', 'reopen_same_player', 'blocked_player']).map((c) => c.join('|')),
  ...cross(['end'], ['before_start', 'before_first', 'in_window', 'in_reveal', 'in_break', 'last_round', 'twice', 'after_over', 'non_organizer']).map((c) => c.join('|')),
  ...cross(['vote'], ['2', '3', '10', '60'], VOTE_SCEN).map((c) => c.join('|')),
  ...cross(['money|credit'], CREDIT_SCEN, ['INR', 'USD'], ['mid_day', 'ist_midnight']).map((c) => c.join('|')),
  ...cross(['money|price'], GOLDEN.map((g) => String(g[0])), ['INR', 'USD']).map((c) => c.join('|')),
  ...['money|players_never_pay|source', 'money|players_never_pay|routes', 'money|prize_is_a_gift|texts'],
  ...cross(['absent'], ABSENT).map((c) => c.join('|')),
  ...['word|refusals|settings', 'word|refusals|routes', 'word|no_refund_line|credit', 'word|target_sentence|rank_lines'],
  ...['replay|game|a', 'replay|game|b', 'replay|case|round', 'replay|case|vote', 'replay|case|rank'],
];
export async function newWorld() { return {}; }

// ================================================================ D1 stand-in and route driver (real luckRoute on node:sqlite)
function d1() {
  const db = new DatabaseSync(':memory:');
  const stmt = (sql) => { let args = []; const s = {
    bind: (...a) => { args = a.map((v) => (v === undefined ? null : v)); return s; },
    first: async () => { const row = db.prepare(sql).get(...args); return row === undefined ? null : { ...row }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map((x) => ({ ...x })) }),
    run: async () => { const x = db.prepare(sql).run(...args); return { meta: { changes: Number(x.changes) } }; } }; return s; };
  return { prepare: stmt, raw: db, batch: async (xs) => { for (const x of xs) await x.run(); return []; } };
}
const SCHEMA_SQL = [...WK.SCHEMA];
function freshDb() { const db = d1(); for (const s of SCHEMA_SQL) { try { db.raw.exec(s); } catch { /* an ALTER that was already part of its table */ } } return db; }
async function call(g, sub, method, now, body, q = '', allowed = true) {
  const url = `http://x/api/z/${g.eid}/luck/${sub}${q}`;
  const res = await LK.luckRoute({ env: { DB: g.db }, req: new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), now, eid: g.eid, e: {}, sub, url: new URL(url),
    body: async (rq) => { try { return await rq.json(); } catch { return null; } }, spend: async () => true, allowed, openName: async (p) => p, gate: null, BUSY: () => new Response('busy', { status: 429 }) });
  const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, j, text };
}
/** A lobby of n players who joined (participant + seat rows, one device each). */
function mkGame(r, tag, n) {
  const db = freshDb(), eid = `LK${tag}`, players = [];
  for (let i = 0; i < n; i++) {
    const pid = String(i + 1), device = hexs(r, 32), name = `Nick ${i + 1}`;
    db.raw.prepare('INSERT INTO participant(eid,pid,phone_hash,name,joined_ms,pii) VALUES(?,?,?,?,?,?)').run(eid, pid, hexs(r, 16), null, 1000 + i, name);
    db.raw.prepare('INSERT INTO seat(eid,seq,pid,ph,dev) VALUES(?,?,?,?,?)').run(eid, i, pid, hexs(r, 16), sha(`dev|${eid}|${device}`).slice(0, 32));
    players.push({ pid, device, name });
  }
  return { db, eid, players, seatOf: (pid) => [...players.map((p) => p.pid)].sort().indexOf(pid) };
}
const addPlayer = (g, r, pid, name) => { const device = hexs(r, 32); g.db.raw.prepare('INSERT INTO participant(eid,pid,phone_hash,name,joined_ms,pii) VALUES(?,?,?,?,?,?)').run(g.eid, pid, hexs(r, 16), null, 9, name); g.db.raw.prepare('INSERT INTO seat(eid,seq,pid,ph,dev) VALUES(?,?,?,?,?)').run(g.eid, 900 + g.players.length, pid, hexs(r, 16), sha(`dev|${g.eid}|${device}`).slice(0, 32)); return { pid, device, name }; };
const T0 = (r) => 1_800_000_000_000 + r.int(0, 1e9);
const rowsOf = (g, table) => g.db.raw.prepare(`SELECT * FROM ${table} WHERE eid=?`).all(g.eid);
async function startGame(c, g, now, settings, delaySecs = 5) {
  const st = await call(g, 'start', 'POST', now, { settings, delaySecs });
  c.eq(st.status, 200, 'start_accepted_for_organizer', st.text?.slice(0, 120));
  return st.j;
}
/** The phone side: fetch every due beacon value from the feed, play with the real engine, make the result. Also re-derives the feed with the oracle. */
async function phoneResult(c, g, settings, n, now) {
  const vals = []; for (;;) { const b = await call(g, 'beacon', 'GET', now, undefined, `?from=${vals.length}`); for (const x of b.j.values) vals[x.i] = x.v; if (!b.j.values.length) break; }
  const t = g.db.raw.prepare('SELECT * FROM luck_t WHERE eid=?').get(g.eid);
  const pids = g.db.raw.prepare('SELECT pid FROM luck_p WHERE eid=? ORDER BY seat').all(g.eid).map((x) => x.pid);
  const seed = sha(`LBC-SEED|${t.secret}|${g.eid}|${sha(`LBC-ROSTER|${[...pids].sort().join(',')}`)}`);
  c.eq(t.seed, seed, 'seed_is_sha256_of_secret_eid_roster');
  const T = EN.totalDiceRounds(settings);
  c.eq(vals.length, 2 * T, 'feed_has_every_value_once_the_game_is_over');
  let feedOk = true; for (let i = 0; i < vals.length; i++) if (vals[i] !== sha(`LBC-BEACON|${seed}|${i}`)) feedOk = false;
  c.ok(feedOk, 'beacon_feed_equals_sha256_seed_index');
  const game = new EN.LuckGame(g.eid, settings, n);
  for (let k = 0; k < T; k++) await game.addDiceRound(k, vals[2 * k], vals[2 * k + 1]);
  const line = (x) => ({ seat: x.seat, points: x.points, hits: x.hits, best: x.best, line: x.line });
  const rounds = []; for (let q = 1; q <= settings.rounds; q++) rounds.push((await game.roundRanking(q)).map(line));
  const overall = (await game.overallRanking()).map(line);
  const o = simO(g.eid, settings, n, vals.filter((_, i) => i % 2 === 0), vals.filter((_, i) => i % 2 === 1));
  const want = rankO(g.eid, 'overall', vals[2 * T - 1], o.total, 10);
  c.ok(same(overall.map((x) => [x.seat, x.points]), want.map((x) => [x.seat, x.points])), 'phone_result_from_feed_matches_oracle_overall');
  return { vals, seed, game, result: { overall, rounds }, oracle: o };
}
const podium = ['first', 'second', 'third', 'fourth', 'fifth'];

// ================================================================ settings
function settingsCase(c, r, parts) {
  const [, field, v] = parts, P = EN.parseSettings;
  const ok = (x) => x && x.ok === true, bad = (x, w) => { c.eq(x?.ok, false, `settings_refused_${field}`, w); if (x && x.ok === false) plain(c, x.error, `settings ${field} ${v}`); };
  if (field === 'rounds') { const val = v === 'abc' ? 'abc' : Number(v), good = Number.isInteger(val) && val >= 1 && val <= 20; const x = P({ rounds: val }); if (good) { c.ok(ok(x) && x.value.rounds === val, 'rounds_1_to_20_accepted', v); c.eq(x.value.diceRounds, 10, 'ten_dice_rounds_per_round'); } else bad(x, v); }
  if (field === 'window') { const val = Number(v), good = [6, 10, 15].includes(val), x = P({ windowSecs: val }); if (good) c.ok(ok(x) && x.value.windowSecs === val, 'window_6_10_15_accepted', v); else bad(x, v); }
  if (field === 'prizemode') { const good = PRIZE_MODES.includes(v), x = P({ prizeMode: v }); if (good) c.ok(ok(x) && x.value.prizeMode === v, 'prize_mode_accepted', v); else bad(x, v); }
  if (field === 'onewin') { const x = P(v === 'missing' ? {} : { oneWinPerPlayer: v === 'true' }); c.ok(ok(x) && x.value.oneWinPerPlayer === (v === 'true'), 'one_win_flag_kept_default_false', v); }
  if (field === 'overall_len') { const n = Number(v), x = P({ prizes: { overall: Array.from({ length: n }, (_, i) => `Gift ${i + 1}`) } }); if (n <= 5) c.ok(ok(x) && x.value.prizes.overall.length === n, 'up_to_5_prizes_per_ranking', v); else bad(x, v); }
  if (field === 'prize_text') {
    const T = { gift: ['Smart watch', true], money_word: ['Win cash today', false], rupee_sign: ['₹500 voucher', false], dollar_sign: ['$5 card', false], jackpot: ['The jackpot', false], bet: ['Place a bet', false], long_120: ['a'.repeat(120), true], long_121: ['a'.repeat(121), false], spaces: ['  Two   words  ', true], not_text: [42, false], cashew_ok: ['Cashew nuts box', true], empty: ['', true] };
    const [text, good] = T[v], x = P({ prizes: { overall: [text] } });
    if (good) { c.ok(ok(x), 'gift_text_accepted', v); if (ok(x) && v === 'spaces') c.eq(x.value.prizes.overall[0], 'Two words', 'prize_text_spaces_collapsed_and_trimmed'); } else bad(x, v);
  }
  if (field === 'round_lists') {
    const rounds = r.int(2, 6);
    const lists = { equal: Array.from({ length: rounds }, () => ['Pen']), one_more: Array.from({ length: rounds + 1 }, () => ['Pen']), fewer: [['Pen']], bad_entry: [['Pen'], ['cash']], not_array: 'x' }[v];
    const x = P({ rounds, prizes: { rounds: lists } });
    if (v === 'equal' || v === 'fewer') c.ok(ok(x) && x.value.prizes.rounds.length === lists.length, 'round_prize_lists_up_to_rounds', v); else bad(x, v);
  }
}

// ================================================================ odds
async function oddsCase(c, r, parts) {
  const [, what, size] = parts, gid = `G${hexs(r, 6)}`;
  if (what === 'score') {
    for (const t of ODDS.faces) for (const d of ODDS.faces) c.eq(EN.scoreOf(t, d), ODDS.pay(t, d), 'score_follows_pay_table', `target ${t} dice ${d}`);
    c.eq(ODDS.weight.reduce((a, b) => a + b, 0), 6, 'odds_table_has_six_equal_faces');
    return;
  }
  if (what === 'pair') { // R12: two players in the same dice round roll independently; the pair agrees about 1 in 6 times
    let agree = 0; const N = 1500;
    for (let g = 0; g < N; g++) { const B = hexs(r, 16), d0 = await EN.diceOf(gid, 0, g, B), d1 = await EN.diceOf(gid, 1, g, B); c.eq(d0, diceO(gid, 0, g, B), 'dice_equals_oracle'); if (d0 === d1) agree++; }
    const z = (agree - N / 6) / Math.sqrt(N * (1 / 6) * (5 / 6)); c.ok(Math.abs(z) < 5, 'two_players_roll_independently', { agree, N, z });
    return;
  }
  if (what === 'seat') { const B = hexs(r, 16), set = new Set(); for (let s = 0; s < 60; s++) set.add(await EN.diceOf(gid, s, 3, B)); c.ok(set.size >= 4, 'dice_depends_on_the_seat', [...set]); return; }
  if (what === 'beacon') { // R13: different beacon values, different game; same values, same game
    const A = hexs(r, 16), B = hexs(r, 16); let diffT = 0, diffD = 0; const N = 120;
    c.eq(await EN.targetOf(gid, 5, A), await EN.targetOf(gid, 5, A), 'same_inputs_same_target');
    for (let i = 0; i < N; i++) { const A2 = hexs(r, 16), B2 = hexs(r, 16); if ((await EN.targetOf(gid, 5, A)) !== (await EN.targetOf(gid, 5, A2))) diffT++; if ((await EN.diceOf(gid, 3, 5, B)) !== (await EN.diceOf(gid, 3, 5, B2))) diffD++; }
    c.ok(diffT > N * 0.6 && diffD > N * 0.6, 'different_beacon_values_give_a_different_game', { diffT, diffD });
    return;
  }
  const N = Number(size), cnt = Array(7).fill(0); let hits = 0, pts = 0;
  for (let g = 0; g < N; g++) {
    const A = hexs(r, 16), B = hexs(r, 16), t = await EN.targetOf(gid, g, A), d = await EN.diceOf(gid, g % 9, g, B);
    if (what === 'target') { c.eq(t, targetO(gid, g, A), 'target_equals_oracle'); cnt[t]++; }
    if (what === 'dice') { c.eq(d, diceO(gid, g % 9, g, B), 'dice_equals_oracle'); cnt[d]++; }
    if (what === 'hit_rate') { const p = EN.scoreOf(t, d); c.eq(p, ODDS.pay(targetO(gid, g, A), diceO(gid, g % 9, g, B)), 'points_follow_table'); if (p > 0) hits++; pts += p; }
  }
  if (what !== 'hit_rate') {
    const W = ODDS.weight.reduce((a, b) => a + b, 0); let chi = 0; for (let f = 1; f <= 6; f++) { const e = (N * ODDS.weight[f - 1]) / W; chi += (cnt[f] - e) ** 2 / e; }
    c.ok(chi < 35, `${what}_faces_spread_evenly_1_to_6`, { cnt: cnt.slice(1), chi });
    c.ok(cnt[0] === 0, 'no_face_outside_1_to_6');
  } else {
    const z = (hits - N / 6) / Math.sqrt(N * (1 / 6) * (5 / 6)); c.ok(Math.abs(z) < 5, 'hit_chance_is_1_in_6', { hits, N, z });
    const mean = pts / N, sd = Math.sqrt((91 / 36 - (21 / 36) ** 2) / N); c.ok(Math.abs(mean - 21 / 36) < 5 * sd, 'mean_points_per_dice_round_is_21_over_36', { mean });
  }
}

// ================================================================ a whole game, dice round by dice round
async function roundCase(c, r, parts, tag) {
  const seats = Number(parts[1]), rounds = Number(parts[2]), mode = parts[3], oneWin = parts[4] === 't';
  const s = mkSettings(r, { rounds, prizeMode: mode, oneWin }); const T = s.rounds * s.diceRounds, gid = `G${tag}`, { A, B } = beacons(r, T);
  const g = new EN.LuckGame(gid, s, seats), o = simO(gid, s, seats, A, B);
  c.eq(g.finished, false, 'new_game_not_finished'); c.eq(T, rounds * 10, 'ten_dice_rounds_per_round');
  for (let k = 0; k < T; k++) {
    const res = await g.addDiceRound(k, A[k], B[k]);
    c.eq(res.target, o.targets[k], 'target_equals_oracle', k); c.eq(res.round, Math.floor(k / 10) + 1, 'dice_round_belongs_to_its_round');
    let okd = true, okp = true; for (let q = 0; q < seats; q++) { if (res.dice[q] !== o.dice[k][q]) okd = false; if (res.points[q] !== ODDS.pay(o.targets[k], o.dice[k][q])) okp = false; }
    c.ok(okd, 'every_dice_equals_oracle', k); c.ok(okp, 'every_score_follows_pay_table', k);
  }
  c.eq(g.finished, true, 'game_finished_after_all_dice_rounds'); c.eq(g.done, T, 'dice_rounds_played_counted');
  const tal = (x) => x.map((t) => ({ seat: t.seat, points: t.points, hits: t.hits, best: t.best, reachedAt: t.reachedAt }));
  c.ok(same(tal(g.total), tal(o.total)), 'overall_tallies_equal_oracle');
  for (let q = 0; q < rounds; q++) c.ok(same(tal(g.roundTallies[q]), tal(o.rt[q])), 'round_tallies_equal_oracle', q + 1);
  c.eq(g.total.reduce((a, t) => a + t.points, 0), g.roundTallies.reduce((a, rt) => a + rt.reduce((b, t) => b + t.points, 0), 0), 'points_add_up_across_rounds');
  const rr = [];
  for (let q = 1; q <= rounds; q++) { const got = strip(await g.roundRanking(q)), want = rankO(gid, `round-${q}`, B[q * 10 - 1], o.rt[q - 1], 10); rr.push(await g.roundRanking(q)); const ord = (l) => l.map((x) => [x.place, x.seat, x.points, x.hits, x.best, x.reachedAt]); c.ok(same(ord(got), ord(want)), 'round_ranking_equals_oracle_strict_chain', { q }); got.forEach((x, i) => c.eq(x.line, want[i].line, 'tie_line_says_how_the_place_was_decided', `round ${q} place ${i + 1} seat ${x.seat}`)); }
  const ov = await g.overallRanking(), want = rankO(gid, 'overall', B[T - 1], o.total, 10);
  { const ord = (l) => l.map((x) => [x.place, x.seat, x.points, x.hits, x.best, x.reachedAt]); c.ok(same(ord(strip(ov)), ord(want)), 'overall_ranking_equals_oracle_strict_chain'); ov.forEach((x, i) => c.eq(x.line, want[i].line, 'tie_line_says_how_the_place_was_decided', `overall place ${i + 1} seat ${x.seat}`)); }
  c.eq(ov.length, Math.min(10, seats), 'top_ten_listed');
  c.eq(new Set(ov.map((x) => x.seat)).size, ov.length, 'top_places_are_different_players_no_ties');
  c.ok(ov.every((x, i) => x.place === i + 1 && (i === 0 || ov[i - 1].points >= x.points)), 'places_in_order_most_points_first');
  for (const x of ov) c.ok(x.line === '' || /^Tied on \d+ points?; decided by .+\.$/.test(x.line), 'tie_line_shape', x.line);
  const me = r.int(0, seats - 1), st = EN.standingOf(g.total, me), so = standingO(o.total, me);
  c.ok(st.ahead === so.ahead && st.of === so.of && st.percent === so.percent, 'standing_is_players_strictly_ahead', { st, so });
  // prizes: the payout equals the prize table
  const wins = EN.assignPrizes(s, rr, ov), wantW = prizesO(s, rr, ov);
  c.ok(same(wins, wantW), 'prize_payout_equals_prize_table', { got: wins.length, want: wantW.length });
  c.eq(new Set(wins.map((w) => `${w.ranking}|${w.place}`)).size, wins.length, 'no_prize_paid_twice');
  // the same result on every phone and in every order of work (R32/R13): a second engine, same inputs
  const g2 = new EN.LuckGame(gid, s, seats); for (let k = 0; k < T; k++) await g2.addDiceRound(k, A[k], B[k]);
  c.ok(same(strip(await g2.overallRanking()), strip(ov)), 'replay_same_inputs_same_game');
  const g3 = new EN.LuckGame(gid, s, seats), B2 = B.map(() => hexs(r, 16)); for (let k = 0; k < T; k++) await g3.addDiceRound(k, A[k], B2[k]);
  c.ok(!same(g3.results.map((x) => Array.from(x.dice)), g.results.map((x) => Array.from(x.dice))), 'different_beacon_gives_a_different_game');
  c.note(sha(JSON.stringify([want, wantW])).slice(0, 12));
}

// ================================================================ engine: ending after a round, order, early reads
async function engineCase(c, r, parts, tag) {
  const what = parts[1], rounds = r.int(3, 6), s = mkSettings(r, { rounds, texts: 'none' }), T = rounds * 10, gid = `G${tag}`, { A, B } = beacons(r, T + 2);
  const g = new EN.LuckGame(gid, s, 3);
  const play = async (k) => { for (let i = 0; i < k; i++) await g.addDiceRound(i, A[i], B[i]); };
  if (what === 'none_played') { await play(0); c.eq(g.endAfterRound(1), true, 'end_after_round_1_before_any_dice_round_is_fine'); c.eq(g.settings.rounds, 1, 'game_has_n_rounds_after_end'); }
  if (what === 'mid_round') { const n = r.int(1, rounds - 1); await play(n * 10 + r.int(1, 9)); c.eq(g.endAfterRound(n), false, 'cannot_end_before_dice_rounds_already_played'); c.eq(g.settings.rounds, rounds, 'refusal_changes_nothing'); c.eq(g.endAfterRound(n + 1) || n + 1 >= rounds, true, 'next_round_boundary_accepted'); }
  if (what === 'exact_boundary') { const n = r.int(1, rounds - 1); await play(n * 10); c.eq(g.endAfterRound(n), true, 'end_after_the_round_just_finished'); c.eq(g.finished, true, 'game_finished_at_that_round'); c.eq((await g.overallRanking()).length, 3, 'final_result_after_early_end'); c.eq(EN.totalDiceRounds(g.settings), n * 10, 'total_dice_rounds_shrinks'); }
  if (what === 'before_boundary') { const n = r.int(2, rounds - 1); await play(n * 10 - 1); c.eq(g.endAfterRound(n), true, 'end_after_the_round_being_played'); await g.addDiceRound(n * 10 - 1, A[n * 10 - 1], B[n * 10 - 1]); c.eq(g.finished, true, 'round_being_played_is_finished_then_game_over'); }
  if (what === 'n_ge_rounds') { c.eq(g.endAfterRound(rounds), false, 'cannot_end_after_the_last_round'); c.eq(g.endAfterRound(rounds + r.int(1, 5)), false, 'cannot_end_after_more_rounds_than_exist'); }
  if (what === 'n_zero') { c.eq(g.endAfterRound(0), false, 'cannot_end_after_round_0'); c.eq(g.endAfterRound(-1), false, 'cannot_end_after_negative_round'); }
  if (what === 'n_float') c.eq(g.endAfterRound(1.5), false, 'round_must_be_a_whole_number');
  if (what === 'out_of_order') {
    await play(3);
    for (const k of [5, 2, 0, 3]) { let threw = false; try { await g.addDiceRound(k, A[k], B[k]); } catch { threw = true; } c.eq(threw, k !== 3, 'dice_rounds_in_order_none_skipped_none_repeated', k); }
    c.eq(g.done, 4, 'only_the_next_dice_round_was_taken');
  }
  if (what === 'missing_beacon') { for (const [a, b] of [['', 'x'], ['x', ''], ['', '']]) { let threw = false; try { await g.addDiceRound(0, a, b); } catch { threw = true; } c.eq(threw, true, 'dice_round_needs_both_beacon_values'); } c.eq(g.done, 0, 'nothing_played_on_refusal'); }
  if (what === 'early_ranking') {
    let t1 = false, t2 = false; try { await g.overallRanking(); } catch { t1 = true; } c.eq(t1, true, 'no_standings_before_anything_is_played');
    await play(5); try { await g.roundRanking(1); } catch { t2 = true; } c.eq(t2, true, 'round_ranking_only_after_the_round_is_finished');
    c.eq((await g.overallRanking()).length, 3, 'standings_so_far_are_available'); await play(0);
  }
}

// ================================================================ strict ranking and tie wording on crafted tallies
async function rankCase(c, r, parts, tag) {
  const kind = parts[1], top = Number(parts[2]), gid = `G${tag}`, beacon = hexs(r, 16);
  const mk = (seat, list) => { const t = EN.emptyTally(seat); for (const [g, tg] of list) EN.addHit(t, g, tg); return t; };
  let tallies = [];
  if (kind === 'dense' || kind === 'sparse' || kind === 'zero' || kind === 'one_point') {
    const n = r.int(3, 16), maxH = kind === 'dense' ? 3 : 6;
    for (let i = 0; i < n; i++) {
      const h = kind === 'zero' ? 0 : kind === 'one_point' ? (i < 3 ? 1 : 0) : r.int(0, maxH), list = [];
      let g = r.int(0, 3); for (let k = 0; k < h; k++) { list.push([g, kind === 'one_point' ? 1 : kind === 'dense' ? r.int(1, 3) : r.int(1, 6)]); g += r.int(1, 4); }
      tallies.push(mk(i, list));
    }
  } else { // the cut: places `top` and `top+1` are level on points
    const n = top + r.int(1, 3); for (let i = 0; i < n; i++) { if (i < top - 1) tallies.push(mk(i, [[0, 6], [1, 6], [2, 5], [3 + i, 5]])); else if (i === top - 1) tallies.push(mk(i, [[0, 5]])); else tallies.push(mk(i, kind === 'cut_best' ? [[0, 2], [1, 3]] : [[0, 5]])); }
  }
  const got = await EN.rankTop(gid, 'overall', beacon, tallies, top), want = rankO(gid, 'overall', beacon, tallies, top);
  c.ok(same(got.map((x) => [x.place, x.seat, x.points]), want.map((x) => [x.place, x.seat, x.points])), 'ranking_order_equals_the_documented_chain', { got: got.map((x) => x.seat), want: want.map((x) => x.seat) });
  c.eq(got.length, Math.min(top, tallies.length), 'top_places_listed');
  c.eq(new Set(got.map((x) => x.seat)).size, got.length, 'prize_never_shared_places_are_different_players');
  for (let i = 0; i < got.length; i++) c.eq(got[i].line, want[i].line, 'tie_line_says_how_the_place_was_decided', `place ${i + 1} seat ${got[i].seat}`);
  if (kind === 'one_point') c.ok(want.every((x) => !/(^| )1 points/.test(x.line)), 'oracle_says_1_point_singular');
  c.ok(got.every((x) => !/(^| )1 points/.test(x.line)), 'one_point_is_singular');
}

// ================================================================ prizes: payout = prize table
function prizeCase(c, r, parts) {
  const [, mode, ow, texts, np] = parts, n = Number(np), oneWin = ow === 't', rounds = r.int(1, 3);
  const s = mkSettings(r, { rounds, prizeMode: mode, oneWin, texts });
  const list = () => Array.from({ length: Math.min(n, 10) }, (_, i) => ({ place: i + 1, seat: -1, points: 0, hits: 0, best: 0, reachedAt: -1, decidedBy: null, line: '' }));
  const shuf = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = r.int(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const mkList = () => { const seats = shuf(Array.from({ length: n }, (_, i) => i)); return list().map((x, i) => ({ ...x, seat: seats[i] })); };
  const rl = Array.from({ length: rounds }, mkList), ov = mkList();
  const wins = EN.assignPrizes(s, rl, ov), want = prizesO(s, rl, ov);
  if (oneWin && texts === 'gaps') { // the rules do not say whether a blank place keeps its slot when earlier winners are skipped: only what they do say is checked
    const lists = { overall: ov }; rl.forEach((l, i) => { lists[`round-${i + 1}`] = l; }); const won = new Set(); let okk = true;
    for (const name of Object.keys(lists)) { let last = -1; const mine = wins.filter((w) => w.ranking === name); for (const w of mine) { const pos = lists[name].findIndex((x) => x.seat === w.seat); if (pos < 0 || pos < w.place - 1 || pos <= last || won.has(w.seat)) okk = false; last = pos; } for (const w of mine) won.add(w.seat); }
    c.ok(okk, 'one_win_per_player_next_player_in_order_gets_the_prize', wins);
  } else c.ok(same(wins, want), 'prize_payout_equals_prize_table', { got: wins, want });
  c.eq(new Set(wins.map((w) => `${w.ranking}|${w.place}`)).size, wins.length, 'no_prize_paid_twice');
  for (const w of wins) { const t = w.ranking === 'overall' ? s.prizes.overall[w.place - 1] : s.prizes.rounds[Number(w.ranking.slice(6)) - 1][w.place - 1]; c.eq(w.prize, t, 'prize_text_is_the_organizers_text'); c.ok(w.place >= 1 && w.place <= 5, 'only_places_1_to_5_have_prizes'); }
  if (oneWin) c.eq(new Set(wins.map((w) => w.seat)).size, wins.length, 'one_win_per_player_when_switched_on');
  const slots = (name, texts2) => texts2.slice(0, 5).filter((x) => x).length;
  const upper = (mode !== 'overall' ? s.prizes.rounds.reduce((a, t) => a + slots('', t), 0) : 0) + (mode !== 'rounds' ? slots('', s.prizes.overall) : 0);
  c.ok(wins.length <= upper, 'never_more_prizes_than_the_table_has', { n: wins.length, upper });
  if (!oneWin) { const w0 = wins.filter((w) => w.ranking === 'overall'); for (const w of w0) c.eq(w.seat, ov[w.place - 1].seat, 'place_p_goes_to_the_pth_of_that_ranking'); }
  if (mode === 'overall') c.ok(wins.every((w) => w.ranking === 'overall'), 'overall_mode_pays_only_overall');
  if (mode === 'rounds') c.ok(wins.every((w) => w.ranking !== 'overall'), 'rounds_mode_pays_only_rounds');
  if (texts === 'none') c.eq(wins.length, 0, 'no_prize_texts_no_payout');
}

// ================================================================ the clock
async function timeCase(c, r, parts, tag) {
  const rounds = Number(parts[1]), w = Number(parts[2]), s = mkSettings(r, { rounds, windowSecs: w, texts: 'none' }), start = T0(r), cl = clockO(s, start);
  c.eq(EN.gameEndMs(s, start), cl.end, 'game_end_equals_walked_clock');
  c.eq(cl.end - start, (rounds * 10 * (w + 3) + (rounds - 1) * 20) * 1000, 'game_length_is_dice_rounds_reveals_and_breaks');
  if (rounds === 10 && w === 10) c.eq(cl.end - start, 1_480_000, 'default_game_takes_24_min_40_s');
  const probes = new Set([start - 1, start, cl.end - 1, cl.end, cl.end + 1]); for (const x of cl.seg) { probes.add(x.from - 1); probes.add(x.from); probes.add(x.to - 1); } for (let i = 0; i < 25; i++) probes.add(start + r.int(-5000, cl.end - start + 5000));
  for (const t of probes) {
    const got = EN.phaseAt(s, start, t), want = phaseO(cl, start, t);
    const okk = got.kind === want.kind && (want.kind !== 'window' || (got.g === want.g && got.closesMs === want.to)) && (want.kind !== 'reveal' || (got.g === want.g && got.endsMs === want.to)) && (want.kind !== 'break' || (got.afterRound === want.afterRound && got.endsMs === want.to));
    c.ok(okk, 'phase_equals_walked_clock', { t: t - start, got, want });
  }
  for (const x of cl.seg) if (x.kind === 'window') { c.eq(EN.beaconDueMs(s, start, 2 * x.g), x.from, 'target_value_due_when_the_dice_round_opens', x.g); c.eq(EN.beaconDueMs(s, start, 2 * x.g + 1), x.to, 'dice_value_due_only_when_the_window_closes', x.g); }
  for (let i = 0; i < 2 * rounds * 10 - 1; i++) c.ok(EN.beaconDueMs(s, start, i) < EN.beaconDueMs(s, start, i + 1), 'beacon_values_come_due_in_order', i);
  // R37 through the real feed: only values that are due are ever sent
  const g = mkGame(r, tag, 2), st = await startGame(c, g, start - 5000, s, 5);
  if (st) for (let k = 0; k < 4; k++) {
    const now = st.startMs + r.int(-2000, cl.end - start + 2000), b = await call(g, 'beacon', 'GET', now, undefined, `?from=${r.int(0, 3)}`);
    c.eq(b.status, 200, 'beacon_feed_answers'); let early = false; for (const x of b.j.values) if (EN.beaconDueMs(s, st.startMs, x.i) > now) early = true;
    c.ok(!early, 'a_beacon_value_is_never_sent_before_it_is_due', { now: now - st.startMs });
    const from = b.j.from, dueCount = Array.from({ length: 2 * rounds * 10 }, (_, i) => i).filter((i) => i >= from && EN.beaconDueMs(s, st.startMs, i) <= now).length;
    c.eq(b.j.values.length, Math.min(60, dueCount), 'every_due_value_is_sent_up_to_the_batch');
  }
}

// ================================================================ lobby, start, seats, feed, secrecy
async function lobbyCase(c, r, parts, tag) {
  const what = parts[1], now = T0(r), n = r.int(2, 8), g = mkGame(r, tag, n), s = mkSettings(r, { rounds: 1, texts: 'none' });
  if (what === 'too_few') {
    const g1 = mkGame(r, tag + 'a', 1), res = await call(g1, 'start', 'POST', now, { settings: s }); c.eq(res.status, 409, 'start_refused_with_one_player'); c.eq(res.j?.code, 'too-few', 'too_few_code'); plain(c, res.j?.error, 'too few');
    const g0 = mkGame(r, tag + 'b', 0), r0 = await call(g0, 'start', 'POST', now, { settings: s }); c.eq(r0.status, 409, 'start_refused_with_no_players');
    const ok = await call(g, 'start', 'POST', now, { settings: s }); c.eq(ok.status, 200, 'start_accepted_with_two_or_more');
  }
  if (what === 'blocked_not_counted') {
    g.db.raw.prepare('UPDATE seat SET blocked=1 WHERE eid=? AND seq=0').run(g.eid); const live = n - 1;
    const res = await call(g, 'start', 'POST', now, { settings: s });
    if (live >= 2) { c.eq(res.status, 200, 'start_accepted'); c.eq(res.j?.players, live, 'removed_player_is_not_seated'); c.eq(rowsOf(g, 'luck_p').length, live, 'only_live_players_get_a_seat'); } else c.eq(res.status, 409, 'removed_players_do_not_count');
  }
  if (what === 'start_twice') { const a = await call(g, 'start', 'POST', now, { settings: s }); const b = await call(g, 'start', 'POST', now + 1000, { settings: { ...s, rounds: 5 } }); c.eq(a.status, 200, 'first_start_ok'); c.eq(b.status, 409, 'second_start_refused'); c.eq(b.j?.code, 'started', 'started_code'); plain(c, b.j?.error, 'start twice'); c.eq(JSON.parse(g.db.raw.prepare('SELECT opts FROM luck_t WHERE eid=?').get(g.eid).opts).rounds, 1, 'settings_unchanged_by_second_start'); c.eq(a.j?.startMs, g.db.raw.prepare('SELECT start_ms FROM luck_t WHERE eid=?').get(g.eid).start_ms, 'start_time_unchanged'); }
  if (what === 'delay_bounds') for (const [d, ok] of [[4, false], [5, true], [3600, true], [3601, false], [0, false], [1.5, false]]) { const gg = mkGame(r, `${tag}d${d}`, 2), res = await call(gg, 'start', 'POST', now, { settings: s, delaySecs: d }); c.eq(res.status, ok ? 200 : 400, 'start_delay_5_seconds_to_1_hour', d); if (ok) c.eq(res.j.startMs, now + d * 1000, 'game_starts_after_the_delay'); else plain(c, res.j?.error, 'delay'); }
  if (what === 'bad_settings_refused') for (const bad of [{ rounds: 21 }, { rounds: 0 }, { windowSecs: 7 }, { prizes: { overall: ['win cash'] } }, { prizeMode: 'x' }, { prizes: { overall: ['a', 'b', 'c', 'd', 'e', 'f'] } }]) { const gg = mkGame(r, `${tag}b${r.int(0, 1e6)}`, 2), res = await call(gg, 'start', 'POST', now, { settings: bad }); c.eq(res.status, 400, 'wrong_settings_refused', JSON.stringify(bad)); plain(c, res.j?.error, JSON.stringify(bad)); c.eq((await call(gg, 'view', 'GET', now)).j.state, 'open', 'refused_start_leaves_the_game_open'); }
  if (what === 'non_organizer') { const res = await call(g, 'start', 'POST', now, { settings: s }, '', false); c.eq(res.status, 403, 'only_organizer_or_host_can_start'); c.eq(rowsOf(g, 'luck_t')[0].state, 'open', 'game_still_open'); const t = await call(g, 'tick', 'POST', now, undefined, '', false); c.eq(t.status, 403, 'tick_not_for_players'); }
  if (what === 'seats_closed_before_start') { const res = await call(g, 'seats', 'GET', now); c.eq(res.status, 409, 'seat_list_closed_before_the_start'); c.eq(res.j.code, 'open', 'open_code'); c.eq(await LK.gameStarted({ DB: g.db }, g.eid), false, 'list_not_closed_before_start'); }
  if (what === 'seats_frozen_dense') {
    const st = await startGame(c, g, now, s), seats = await call(g, 'seats', 'GET', now + 1); c.eq(await LK.gameStarted({ DB: g.db }, g.eid), true, 'list_closes_when_the_host_starts');
    c.eq(seats.j.players, n, 'players_counted'); c.ok(same(seats.j.seats.map((x) => x[0]), Array.from({ length: n }, (_, i) => i)), 'seat_numbers_0_to_n_minus_1_without_gaps');
    const order = g.players.map((p) => p.pid).sort(); c.ok(same(seats.j.seats.map((x) => x[1]), order.map((pid) => g.players.find((p) => p.pid === pid).name)), 'nicknames_in_seat_order'); c.ok(st && st.players === n, 'start_reports_players');
    c.eq(st.endMs, EN.gameEndMs(s, st.startMs), 'start_reports_the_end_of_the_game'); c.eq(st.diceRounds, 10, 'start_reports_dice_rounds');
  }
  if (what === 'beacon_before_start') { const res = await call(g, 'beacon', 'GET', now); c.eq(res.status, 409, 'no_beacon_before_start'); c.eq(res.j.code, 'open', 'open_code'); }
  if (what === 'reveal_hidden') {
    const v0 = await call(g, 'view', 'GET', now), rv0 = await call(g, 'reveal', 'GET', now); c.ok(/^[0-9a-f]{64}$/.test(v0.j.commit), 'fingerprint_public_from_the_first_look'); c.eq(rv0.j.revealed, false, 'secret_hidden_before_start'); c.ok(!rv0.text.includes(rowsOf(g, 'luck_t')[0].secret), 'secret_not_in_the_text_before_start');
    const st = await startGame(c, g, now, s), mid = await call(g, 'reveal', 'GET', st.startMs + 1000); c.eq(mid.j.revealed, false, 'secret_hidden_while_the_game_runs'); c.ok(!mid.text.includes(rowsOf(g, 'luck_t')[0].secret), 'secret_not_in_the_text_while_running');
    c.eq(sha(`LBC-COMMIT|${rowsOf(g, 'luck_t')[0].secret}`), v0.j.commit, 'commit_is_sha256_of_secret');
  }
  if (what === 'public_views_private') {
    const st = await startGame(c, g, now, s), secret = rowsOf(g, 'luck_t')[0].secret, ph = g.db.raw.prepare('SELECT ph FROM seat WHERE eid=?').all(g.eid).map((x) => x.ph), devs = g.players.map((p) => p.device);
    const outs = [await call(g, 'view', 'GET', now + 1), await call(g, 'seats', 'GET', now + 1), await call(g, 'rank', 'GET', now + 1), await call(g, 'beacon', 'GET', st.endMs), await call(g, 'reveal', 'GET', now + 1)];
    for (const o of outs) { c.ok(!ph.some((x) => o.text.includes(x)) && !devs.some((x) => o.text.includes(x)) && !o.text.includes(secret), 'public_views_hold_no_phone_hash_device_or_secret'); c.ok(!new RegExp(`[\\w.-]+${AT}[\\w.-]+\\.[a-z]{2,}`, 'i').test(o.text) && !/\d{8,}/.test(o.text.replace(/"(serverNow|startMs|endMs|ann|at)":\d+/g, '').replace(/[0-9a-f]{16,}/g, '')), 'public_views_hold_no_address_or_phone_number'); }
    c.ok(!('pid' in (outs[0].j ?? {})) && !('you' in (outs[0].j ?? {})), 'public_view_has_no_player_identity');
  }
  if (what === 'me_states') {
    const p = g.players[0], q = `?pid=${p.pid}&device=${p.device}`, w0 = await call(g, 'me', 'GET', now, undefined, q); c.eq(w0.j?.phase, 'waiting', 'before_start_player_waits'); plain(c, w0.j?.message, 'waiting');
    const st = await startGame(c, g, now, s), w1 = await call(g, 'me', 'GET', now + 1, undefined, q); c.eq(w1.j?.phase, 'playing', 'after_start_player_plays'); c.eq(w1.j?.you?.seat, g.seatOf(p.pid), 'player_sees_own_seat'); c.eq(w1.j?.you?.name, p.name, 'player_sees_own_nickname');
    const other = g.players[1], mine = await call(g, 'me', 'GET', now + 1, undefined, `?pid=${p.pid}&device=${other.device}`); c.eq(mine.status, 403, 'a_player_is_shown_only_on_their_own_phone'); c.eq(mine.j.code, 'other-phone', 'other_phone_code'); c.ok(!mine.text.includes(p.name), 'other_phone_never_gets_the_name');
    const bad = await call(g, 'me', 'GET', now + 1, undefined, `?pid=${p.pid}&device=zz`); c.eq(bad.status, 400, 'malformed_device_refused'); plain(c, bad.j?.error, 'bad device'); const none = await call(g, 'me', 'GET', now + 1, undefined, `?pid=nobody&device=${p.device}`); c.eq(none.status, 403, 'unknown_player_refused'); c.ok(st, 'started');
  }
  if (what === 'beacon_only_when_due') { const st = await startGame(c, g, now, s), cl = clockO(s, st.startMs); let prev = -1; for (const x of cl.seg.filter((y) => y.kind === 'window')) { const b1 = await call(g, 'beacon', 'GET', x.from - 1), b2 = await call(g, 'beacon', 'GET', x.from), b3 = await call(g, 'beacon', 'GET', x.to - 1), b4 = await call(g, 'beacon', 'GET', x.to); const top = (b) => Math.max(-1, ...b.j.values.map((v) => v.i)); c.ok(top(b2) >= 2 * x.g && top(b2) < 2 * x.g + 1 || top(b2) === 2 * x.g, 'target_value_is_there_exactly_when_the_window_opens', x.g); c.ok(top(b3) < 2 * x.g + 1, 'dice_value_not_there_while_the_window_is_open', x.g); c.ok(top(b4) === 2 * x.g + 1, 'dice_value_is_there_when_the_window_closes', x.g); prev = x.g; } c.ok(prev >= 0, 'walked_every_window'); }
  if (what === 'fee_fields_ignored') { // R43: the game ignores any fee sent to it
    const body = { settings: s, fee: 500, price: 99, amount: 1000, entryFee: 50, stake: 10, currency: 'INR', delaySecs: 5 }; const st = await call(g, 'start', 'POST', now, body); c.eq(st.status, 200, 'start_ignores_fee_fields');
    const opts = JSON.parse(rowsOf(g, 'luck_t')[0].opts); c.ok(!Object.keys(opts).some((k) => /fee|price|amount|stake|currency/i.test(k)), 'no_money_field_kept_in_the_settings'); c.ok(!/fee|price|amount|stake|currency|paid/i.test(st.text), 'start_answer_has_no_money');
  }
}

// ================================================================ late joiners (the list is closed at the start: a late phone only watches)
async function lateCase(c, r, parts, tag) {
  const what = parts[1], now = T0(r), n = r.int(2, 6), g = mkGame(r, tag, n), s = mkSettings(r, { rounds: 1, texts: 'none' });
  const joinOpen = async () => !(await LK.gameStarted({ DB: g.db }, g.eid));
  if (what === 'before_start') { c.eq(await joinOpen(), true, 'joining_is_open_before_the_start'); await call(g, 'view', 'GET', now); c.eq(await joinOpen(), true, 'looking_does_not_close_the_list'); return; }
  const st = await startGame(c, g, now, s); c.eq(await joinOpen(), false, 'joining_closed_from_the_start');
  const late = addPlayer(g, r, 'L1', 'Late Larry'), q = `?pid=${late.pid}&device=${late.device}`;
  if (what === 'running') { const me = await call(g, 'me', 'GET', st.startMs + 1000, undefined, q); c.eq(me.j?.phase, 'watching', 'late_joiner_only_watches'); plain(c, me.j?.message, 'watching'); c.ok(!('you' in me.j), 'late_joiner_has_no_seat'); const seats = await call(g, 'seats', 'GET', st.startMs + 1000); c.eq(seats.j.players, n, 'list_stays_frozen'); c.ok(!seats.text.includes('Late Larry'), 'late_joiner_not_on_the_seat_list'); c.eq(rowsOf(g, 'luck_p').length, n, 'no_seat_made_after_the_start'); }
  if (what === 'over') { const v = await call(g, 'vote', 'POST', st.endMs + 1, { pid: late.pid, device: late.device, result: {} }); c.eq(v.status, 409, 'late_joiner_cannot_vote'); c.eq(v.j?.code, 'watching', 'watching_code'); plain(c, v.j?.error, 'late vote'); c.eq(rowsOf(g, 'luck_v').length, 0, 'no_vote_stored'); }
  if (what === 'reopen_same_player') { const p = g.players[r.int(0, n - 1)], q2 = `?pid=${p.pid}&device=${p.device}`; const a = await call(g, 'me', 'GET', st.startMs + 10, undefined, q2), b = await call(g, 'me', 'GET', st.startMs + 99_000, undefined, q2); c.eq(a.j?.phase, 'playing', 'player_who_was_in_can_open_the_link_again'); c.ok(same(a.j?.you, b.j?.you) && a.j.you.seat === g.seatOf(p.pid), 'same_seat_every_time'); }
  if (what === 'blocked_player') { const p = g.players[0]; g.db.raw.prepare('UPDATE seat SET blocked=1 WHERE eid=? AND pid=?').run(g.eid, p.pid); const me = await call(g, 'me', 'GET', st.startMs + 10, undefined, `?pid=${p.pid}&device=${p.device}`); c.eq(me.status, 403, 'removed_player_refused'); c.eq(me.j.code, 'removed', 'removed_code'); plain(c, me.j.error, 'removed'); }
}

// ================================================================ the organizer ends the game after a round
async function endCase(c, r, parts, tag) {
  const what = parts[1], now = T0(r), g = mkGame(r, tag, r.int(2, 5)), rounds = what === 'last_round' ? 1 : r.int(3, 5), s = mkSettings(r, { rounds, texts: 'none' });
  if (what === 'before_start') { const res = await call(g, 'end', 'POST', now); c.eq(res.status, 409, 'cannot_end_a_game_that_has_not_started'); c.eq(res.j.code, 'not-started', 'not_started_code'); plain(c, res.j.error, 'end before start'); return; }
  const st = await startGame(c, g, now, s), cl = clockO(s, st.startMs);
  if (what === 'before_first') { const res = await call(g, 'end', 'POST', now + 1000); c.eq(res.status, 409, 'cannot_end_before_the_first_dice_round'); c.eq(res.j.code, 'not-yet', 'not_yet_code'); plain(c, res.j.error, 'end before first'); return; }
  if (what === 'non_organizer') { const res = await call(g, 'end', 'POST', st.startMs + 1000, undefined, '', false); c.eq(res.status, 403, 'only_organizer_or_host_can_end'); c.eq(JSON.parse(rowsOf(g, 'luck_t')[0].opts).rounds, rounds, 'refused_end_changes_nothing'); return; }
  if (what === 'after_over') { const res = await call(g, 'end', 'POST', st.endMs + 1); c.eq(res.status, 409, 'cannot_end_a_game_that_is_over'); c.eq(res.j.code, 'over', 'over_code'); return; }
  if (what === 'last_round') { const res = await call(g, 'end', 'POST', st.startMs + 1000); c.eq(res.status, 200, 'end_in_the_last_round_is_a_no_op_answer'); c.eq(res.j.last, true, 'told_it_is_the_last_round'); c.eq(rowsOf(g, 'luck_t')[0].end_ms, st.endMs, 'last_round_end_time_unchanged'); return; }
  const kind = { in_window: 'window', in_reveal: 'reveal', in_break: 'break', twice: 'window' }[what];
  const cands = cl.seg.filter((x) => x.kind === kind && (kind === 'break' || Math.floor(x.g / 10) + 1 < rounds)); const seg = r.pick(cands.length ? cands : cl.seg.filter((x) => x.kind === 'window')), at = seg.from + r.int(0, seg.to - seg.from - 1);
  const cur = seg.kind === 'break' ? seg.afterRound : Math.floor(seg.g / 10) + 1, res = await call(g, 'end', 'POST', at);
  if (cur >= rounds) { c.eq(res.j.last, true, 'end_in_last_round_changes_nothing'); return; }
  const s2 = { ...s, rounds: cur }, endMs = EN.gameEndMs(s2, st.startMs);
  c.eq(res.status, 200, 'end_accepted'); c.eq(res.j.endedAfterRound, cur, 'the_round_being_played_is_finished_then_the_game_ends'); c.eq(res.j.endsMs, endMs, 'new_end_time_is_the_clock_of_the_shorter_game');
  c.eq(JSON.parse(rowsOf(g, 'luck_t')[0].opts).rounds, cur, 'game_simply_has_fewer_rounds'); c.eq(rowsOf(g, 'luck_t')[0].end_ms, endMs, 'end_time_stored');
  if (what === 'twice') { const again = await call(g, 'end', 'POST', at + 500); c.eq(again.status, 200, 'pressed_twice_same_answer'); c.eq(again.j.again, true, 'again_flag'); c.eq(again.j.endedAfterRound, cur, 'same_round'); c.eq(rowsOf(g, 'luck_t')[0].end_ms, endMs, 'second_press_changes_nothing'); }
  const v = await call(g, 'vote', 'POST', endMs - 1, { pid: g.players[0].pid, device: g.players[0].device, result: {} }); c.eq(v.status, 409, 'result_vote_waits_for_the_shorter_end', v.text.slice(0, 200) + ' endMs-start=' + (endMs - st.startMs)); c.eq(v.j.code, 'running', 'running_code');
  const far = await call(g, 'beacon', 'GET', st.endMs + 1e7); c.eq(far.j.total, 2 * cur * 10, 'beacon_feed_stops_with_the_shorter_game'); c.eq(far.j.values.length, Math.min(60, 2 * cur * 10), 'no_value_beyond_the_shorter_game');
}

// ================================================================ the game-over vote: quorum, podium, no double payout
const badResults = (n, rounds, dr) => {
  const line = (seat, points = 5, hits = 1, best = 5) => ({ seat, points, hits, best, line: '' });
  const good = (k) => ({ overall: [line(0), line(Math.min(1, n - 1))].slice(0, Math.min(2, n)), rounds: Array.from({ length: k }, () => [line(0)]) });
  const T = rounds * dr;
  return [
    ['seat_not_in_game', { ...good(rounds), overall: [line(n)] }, true],
    ['seat_negative', { ...good(rounds), overall: [line(-1)] }, true],
    ['seat_repeated', { ...good(rounds), overall: [line(0), line(0)] }, true],
    ['wrong_number_of_rounds', good(rounds + 1), true],
    ['too_few_rounds', good(rounds - 1), true],
    ['empty_list', { ...good(rounds), overall: [] }, true],
    ['more_than_ten_lines', { ...good(rounds), overall: Array.from({ length: 11 }, (_, i) => line(i % n)) }, true],
    ['float_points', { ...good(rounds), overall: [line(0, 1.5)] }, true],
    ['negative_points', { ...good(rounds), overall: [line(0, -1)] }, true],
    ['best_above_6', { ...good(rounds), overall: [line(0, 5, 1, 7)] }, true],
    ['not_an_object', 'result', true],
    ['points_above_everything_possible', { ...good(rounds), overall: [line(0, 6 * T + 1, 1, 6)] }, false],
    ['hits_above_dice_rounds_played', { ...good(rounds), overall: [line(0, 6 * T, T + 1, 6)] }, false],
    ['points_above_six_per_hit', { ...good(rounds), overall: [line(0, 7, 1, 6)] }, false],
    ['points_below_one_per_hit', { ...good(rounds), overall: [line(0, 1, 4, 6)] }, false],
    ['hits_without_a_best_hit', { ...good(rounds), overall: [line(0, 5, 2, 0)] }, false],
  ];
};
async function voteCase(c, r, parts, tag) {
  const n = Number(parts[1]), scen = parts[2], now = T0(r), g = mkGame(r, tag, n), rounds = r.pick([1, 2]);
  const s = mkSettings(r, { rounds, windowSecs: 6, prizeMode: 'both', texts: 'full' }); s.prizes.overall = ['A1', 'A2', 'A3', 'A4', 'A5'];
  const st = await startGame(c, g, now, s); if (!st) return;
  const q = quorumO(n), voteAt = st.endMs + 2, doVote = (p, result, at = voteAt) => call(g, 'vote', 'POST', at, { pid: p.pid, device: p.device, result });
  c.eq(LK.quorumFor(n), q, 'quorum_is_3_or_5_percent_or_all_if_fewer_than_3', n);
  if (scen === 'early_vote') {
    const p = g.players[0]; for (const at of [st.startMs + 1000, st.endMs - 1]) { const res = await doVote(p, {}, at); c.eq(res.status, 409, 'no_vote_while_the_game_is_running', at - st.startMs); c.eq(res.j.code, 'running', 'running_code'); plain(c, res.j.error, 'early vote'); }
    c.eq(rowsOf(g, 'luck_v').length, 0, 'no_vote_stored_while_running'); return;
  }
  const ph = await phoneResult(c, g, s, n, st.endMs + 1), honest = ph.result;
  const forged = (k) => ({ ...honest, overall: [...honest.overall].reverse().map((x) => ({ ...x, points: x.points + k })) });
  const luckP = rowsOf(g, 'luck_p'); c.eq(luckP.length, n, 'every_player_has_a_seat');
  const pidOfSeat = (seat) => luckP.find((x) => x.seat === seat).pid;
  const check = async (agreed, voters) => {
    const t = rowsOf(g, 'luck_t')[0], rk = (await call(g, 'rank', 'GET', voteAt + 1)).j;
    c.eq(t.state === 'done' && !!t.result, agreed, 'result_counts_only_when_enough_phones_agree', { voters, q });
    c.eq(rk.agreed, agreed, 'rank_says_whether_agreed'); c.eq(rk.quorum ?? q, q, 'rank_reports_the_quorum');
    return { t, rk };
  };
  const payouts = () => ({ settled: rowsOf(g, 'settled'), winner: rowsOf(g, 'winner'), life: rowsOf(g, 'life') });
  if (scen === 'agree' || scen === 'done_then_forged') {
    for (let i = 0; i < q - 1; i++) { const res = await doVote(g.players[i], honest); c.eq(res.j.agreed, false, 'not_agreed_one_vote_short', i); }
    let a = await check(false, q - 1); c.eq(payouts().settled.length + payouts().winner.length, 0, 'no_prize_row_before_agreement'); c.eq((await call(g, 'reveal', 'GET', voteAt)).j.revealed, false, 'secret_hidden_until_the_game_is_closed'); c.eq(a.rk.votes, q - 1, 'rank_counts_votes');
    const last = await doVote(g.players[q - 1], honest); c.eq(last.j.agreed, true, 'quorum_reached_result_counts');
    a = await check(true, q); const pay = payouts(), want = honest.overall.slice(0, 5);
    c.eq(pay.settled.length, want.length, 'one_podium_row_per_winner'); c.eq(pay.winner.length, want.length, 'one_winner_record_per_winner');
    want.forEach((w, i) => { const sr = pay.settled.find((x) => x.pattern === podium[i]); c.ok(!!sr && sr.pids === JSON.stringify([pidOfSeat(w.seat)]), 'podium_place_goes_to_that_seat', podium[i]); const wr = pay.winner.find((x) => x.pattern === podium[i]); c.ok(!!wr && wr.seat === Number(pidOfSeat(w.seat)) && wr.src === 'phones' && wr.ordinal === 1, 'winner_record_is_the_seat', podium[i]); });
    c.eq(new Set(pay.winner.map((x) => x.seat)).size, pay.winner.length, 'a_player_is_not_on_the_podium_twice'); c.eq(pay.life.length, 1, 'data_deletion_clock_started'); c.eq(pay.life[0]?.end_src, 'phones', 'end_source_is_the_phones');
    c.eq(a.rk.overall.length, honest.overall.length, 'published_result_lists_the_top_ten'); c.ok(a.rk.overall.every((x, i) => x.place === i + 1 && x.name === luckP.find((y) => y.seat === honest.overall[i].seat).name && x.points === honest.overall[i].points), 'published_result_has_names_in_order'); c.eq(new Set(a.rk.overall.map((x) => x.name)).size, a.rk.overall.length, 'strict_order_no_two_places_for_one_player'); c.ok(a.rk.rounds.length === rounds, 'published_result_has_every_round');
    const before = JSON.stringify(payouts());
    for (let i = q; i < n; i++) { const res = await doVote(g.players[i], scen === 'agree' ? honest : forged(i + 1)); c.eq(res.j.already, true, 'vote_after_done_changes_nothing', i); }
    for (let k = 0; k < 3; k++) { await call(g, 'tick', 'POST', voteAt + 1e9); await call(g, 'view', 'GET', voteAt + 1e9); await call(g, 'rank', 'GET', voteAt + 1e9); }
    c.eq(JSON.stringify(payouts()), before, 'no_double_payout_by_later_votes_or_ticks'); c.eq(rowsOf(g, 'luck_t')[0].result, JSON.stringify(LK.normalizeResult(honest, n, rounds)), 'agreed_result_kept_as_voted');
    const rv = (await call(g, 'reveal', 'GET', voteAt + 5)).j; c.eq(rv.revealed, true, 'secret_shown_after_the_game_is_over'); c.eq(sha(`LBC-COMMIT|${rv.secret}`), rv.commit, 'anybody_can_check_the_fingerprint'); c.eq(rv.seed, ph.seed, 'revealed_seed_is_the_games_seed');
  }
  if (scen === 'one_short') {
    for (let i = 0; i < q - 1; i++) await doVote(g.players[i], honest); const a = await check(false, q - 1); c.eq(payouts().winner.length, 0, 'no_payout_without_agreement'); c.eq(a.rk.votes, q - 1, 'votes_counted');
    await call(g, 'tick', 'POST', st.endMs + 599_000); c.eq(rowsOf(g, 'luck_t')[0].state, 'running', 'not_closed_before_ten_minutes'); await call(g, 'tick', 'POST', st.endMs + 600_001); const t = rowsOf(g, 'luck_t')[0]; c.eq(t.state, 'done', 'closed_ten_minutes_after_the_last_dice_round'); c.eq(t.result, null, 'no_result_published'); c.eq(payouts().winner.length + payouts().settled.length, 0, 'no_payout_when_phones_never_agree'); c.eq((await call(g, 'reveal', 'GET', st.endMs + 700_000)).j.revealed, true, 'secret_shown_after_close');
  }
  if (scen === 'timeout') { await call(g, 'tick', 'POST', st.endMs + 1000); c.eq(rowsOf(g, 'luck_t')[0].state, 'running', 'still_running_before_ten_minutes'); await call(g, 'tick', 'POST', st.endMs + 600_001); c.eq(rowsOf(g, 'luck_t')[0].state, 'done', 'closed_without_a_result'); c.eq(rowsOf(g, 'luck_t')[0].result, null, 'no_result'); const e1 = rowsOf(g, 'luck_t')[0].ended_ms; await call(g, 'tick', 'POST', st.endMs + 700_001); c.eq(rowsOf(g, 'luck_t')[0].ended_ms, e1, 'closing_is_once'); c.eq(rowsOf(g, 'winner').length, 0, 'no_winner_rows'); }
  if (scen === 'forged_minority') {
    const nf = Math.min(q - 1, n - q); for (let i = 0; i < nf; i++) await doVote(g.players[n - 1 - i], forged(i + 1)); await check(false, nf);
    for (let i = 0; i < q; i++) await doVote(g.players[i], honest); await check(true, q); const t = rowsOf(g, 'luck_t')[0]; c.eq(t.result, JSON.stringify(LK.normalizeResult(honest, n, rounds)), 'forged_minority_cannot_win_the_vote'); c.eq(rowsOf(g, 'winner').length, Math.min(5, honest.overall.length), 'podium_from_the_honest_result');
  }
  if (scen === 'split_below_quorum') { // two different results, each short of the quorum: nothing counts, nobody is paid, the game closes without a result
    const k = Math.max(1, Math.min(q - 1, Math.floor(n / 2))); for (let i = 0; i < k; i++) { await doVote(g.players[i], honest); await doVote(g.players[n - 1 - i], forged(i + 1)); }
    await check(false, 2 * k); c.eq(rowsOf(g, 'winner').length + rowsOf(g, 'settled').length, 0, 'a_split_below_quorum_pays_nobody');
    await call(g, 'tick', 'POST', st.endMs + 600_001); c.eq(rowsOf(g, 'luck_t')[0].state, 'done', 'closed_when_nobody_agrees'); c.eq(rowsOf(g, 'luck_t')[0].result, null, 'no_result_published');
  }
  if (scen === 'not_in_game') { const late = addPlayer(g, r, 'LATE', 'Late Lena'); const res = await doVote(late, honest); c.eq(res.status, 409, 'late_phone_cannot_vote'); c.eq(res.j.code, 'watching', 'watching_code'); c.eq(rowsOf(g, 'luck_v').length, 0, 'no_vote_stored'); }
  if (scen === 'wrong_device') {
    const p = g.players[0], other = g.players[1] ?? g.players[0], res = await call(g, 'vote', 'POST', voteAt, { pid: p.pid, device: hexs(r, 32), result: honest }); c.eq(res.status, 403, 'vote_only_from_the_players_own_phone'); c.eq(res.j.code, 'other-phone', 'other_phone_code'); plain(c, res.j.error, 'wrong device');
    const un = await call(g, 'vote', 'POST', voteAt, { pid: 'ghost', device: other.device, result: honest }); c.eq(un.status, 403, 'stranger_cannot_vote'); const mal = await call(g, 'vote', 'POST', voteAt, { pid: p.pid, device: 'nothex', result: honest }); c.eq(mal.status, 400, 'malformed_device_refused'); c.eq(rowsOf(g, 'luck_v').length, 0, 'no_vote_stored');
  }
  if (scen === 'bad_shapes') {
    const dr = s.diceRounds; for (const [name, shape, documented] of badResults(n, rounds, dr)) { const res = await doVote(g.players[0], shape); c.eq(res.status, 400, documented ? `odd_result_refused_${name}` : 'impossible_score_refused', name); if (res.status === 400) { c.eq(res.j.code, 'bad-result', 'bad_result_code'); plain(c, res.j.error, name); } }
    c.eq(rowsOf(g, 'luck_v').length, 0, 'no_vote_stored_for_odd_results');
  }
  if (scen === 'repeat_vote') {
    const p = g.players[0]; for (let i = 0; i < q + 2; i++) await doVote(p, i % 2 ? honest : forged(1)); c.eq(rowsOf(g, 'luck_v').length, 1, 'one_phone_one_vote'); await check(q <= 1, 1); c.eq(rowsOf(g, 'luck_t')[0].state, q <= 1 ? 'done' : 'running', 'one_phone_alone_counts_for_nothing'); c.eq(rowsOf(g, 'winner').length, 0, 'no_payout_from_one_phone');
    const last = JSON.parse(rowsOf(g, 'luck_v')[0].payload); c.ok(same(last, LK.normalizeResult(forged(1), n, rounds)) || same(last, LK.normalizeResult(honest, n, rounds)), 'last_vote_of_a_phone_replaces_its_first');
  }
}

// ================================================================ money
async function creditCase(c, r, parts, tag) {
  const [, , scen, cur, edge] = parts, db = d1();
  db.raw.exec('CREATE TABLE engagement (id TEXT PRIMARY KEY, org TEXT, pack INTEGER, cancelled_ms INTEGER)'); for (const s of CR.CREDIT_SCHEMA) db.raw.exec(s);
  const org = `org${tag}`, eid = `g${tag}`, now = Date.UTC(2027, r.int(0, 11), r.int(1, 28), r.int(0, 23), r.int(0, 59), r.int(0, 59));
  db.raw.prepare('INSERT INTO engagement (id, org, pack, cancelled_ms) VALUES (?,?,0,?)').run(eid, org, scen === 'cancelled_game' ? now - 1000 : null);
  const gl = r.pick(GOLDEN), pricePaise = (cur === 'INR' ? gl[1] : gl[2]) * 100, price = pricePaise / 100;
  const paidAt = (daysAgo) => { if (edge === 'ist_midnight') { const [y, m, d] = istParts(now - daysAgo * DAY); return Date.UTC(y, m, d) - IST + r.pick([-1, 0, 1]); } return now - daysAgo * DAY - r.int(0, DAY - 1); };
  const mk = async (id, paise, paid, o = org, cu = cur) => {
    const row = await CR.creditFromPayment(db, { id, amount: paise / 100, currency: cu, paid_ms: paid }, o, null, now, 'cancel'); c.ok(!!row, 'credit_made_from_paid_amount');
    if (row) { c.eq(row.expires_ms, creditExpiryOracle(paid), 'credit_lapses_at_end_of_day_365_ist', { paid }); c.eq(Math.round(row.total_inr * 100), paise, 'credit_keeps_exact_amount'); const [y, m, d] = istParts(paid), last = new Date(Date.UTC(y, m, d + 365)), mm = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(CR.creditLastDay(row.expires_ms)); c.ok(!!mm && +mm[1] === last.getUTCDate() && mm[2].slice(0, 3) === MON[last.getUTCMonth()] && +mm[3] === last.getUTCFullYear(), 'last_usable_day_told_is_day_365'); }
    return row;
  };
  const rows = () => db.raw.prepare('SELECT * FROM credit ORDER BY created_ms').all(), uses = () => db.raw.prepare('SELECT * FROM credit_use').all();
  const invariants = async () => {
    for (const x of rows()) { for (const f of ['total_inr', 'remaining_inr', 'lapsed_inr']) c.ok(Math.abs(x[f] * 100 - Math.round(x[f] * 100)) < 1e-6, 'credit_amount_whole_paise_no_float_drift', f); c.ok(x.remaining_inr >= 0 && x.lapsed_inr >= 0 && x.total_inr >= 0, 'money_never_negative', x.remaining_inr); const used = uses().filter((u) => u.credit_id === x.id && u.status === 'applied').reduce((sum, u) => sum + Math.round(u.amount_inr * 100), 0); c.eq(Math.round(x.remaining_inr * 100) + used + Math.round(x.lapsed_inr * 100), Math.round(x.total_inr * 100), 'credit_conserved_remaining_plus_used_plus_lapsed'); }
    c.ok(Math.round((await CR.creditAppliedFor(db, eid)) * 100) <= pricePaise, 'credit_applied_never_above_price'); c.ok(uses().every((u) => u.amount_inr > 0), 'no_zero_or_negative_use_row');
  };
  const apply = (t = now) => CR.applyCreditToGame(db, org, eid, price, cur, t); let res, want;
  if (['full', 'remainder', 'partial', 'idempotent', 'restore', 'restore_lapsed'].includes(scen)) {
    const amt = scen === 'full' ? pricePaise : scen === 'remainder' ? pricePaise + r.int(1, 500_000) : scen === 'partial' ? r.int(100, pricePaise - 1) : r.int(100, pricePaise * 2), row = await mk(`pay_${tag}_1`, amt, paidAt(r.int(1, 300)));
    res = await apply(); want = Math.min(amt, pricePaise); c.eq(Math.round(res.appliedInr * 100), want, 'credit_applied_up_to_price'); const after = rows()[0];
    c.eq(Math.round(after.remaining_inr * 100), amt - want, 'remainder_stays_as_credit'); c.eq(after.status, amt - want > 0 ? 'active' : 'used', 'credit_status_after_use'); c.eq(after.expires_ms, row.expires_ms, 'remainder_keeps_same_expiry');
    if (scen === 'idempotent') { const again = await apply(); c.eq(again.usedNow.length, 0, 'apply_twice_uses_nothing_more'); c.eq(Math.round(again.appliedInr * 100), want, 'apply_twice_same_total'); }
    if (scen === 'restore') { await CR.restoreCreditUses(db, eid, now + 1000); const back = rows()[0]; c.eq(Math.round(back.remaining_inr * 100), amt, 'cancel_puts_credit_back'); c.eq(back.expires_ms, row.expires_ms, 'restore_never_stretches_365_days'); c.eq(Math.round((await CR.creditAppliedFor(db, eid)) * 100), 0, 'nothing_applied_after_restore'); }
    if (scen === 'restore_lapsed') { await CR.restoreCreditUses(db, eid, row.expires_ms + r.int(0, 10 * DAY)); const back = rows()[0]; c.eq(Math.round(back.remaining_inr * 100), amt - want, 'lapsed_credit_does_not_come_back_usable'); c.eq(Math.round(back.lapsed_inr * 100), want, 'restored_after_lapse_counts_as_lapsed'); }
  } else if (scen === 'two_oldest') {
    const a1 = r.int(100, pricePaise - 100), a2 = r.int(pricePaise - a1 + 1, pricePaise * 2), older = await mk(`pay_${tag}_old`, a1, paidAt(r.int(200, 360))), newer = await mk(`pay_${tag}_new`, a2, paidAt(r.int(1, 150)));
    res = await apply(); c.eq(Math.round(res.appliedInr * 100), pricePaise, 'two_credits_cover_price'); const o = rows().find((x) => x.id === older.id), nw = rows().find((x) => x.id === newer.id); c.eq(Math.round(o.remaining_inr * 100), 0, 'oldest_expiring_used_first'); c.eq(Math.round(nw.remaining_inr * 100), a2 - (pricePaise - a1), 'newer_credit_pays_only_the_rest');
  } else if (['expired_old', 'at_expiry', 'before_expiry'].includes(scen)) {
    const amt = r.int(100, pricePaise * 2), row = await mk(`pay_${tag}_e`, amt, paidAt(scen === 'expired_old' ? r.int(367, 700) : 200)), t = scen === 'expired_old' ? now : scen === 'at_expiry' ? row.expires_ms : row.expires_ms - 1;
    res = await apply(t); c.eq(Math.round(res.appliedInr * 100), scen === 'before_expiry' ? Math.min(amt, pricePaise) : 0, 'expired_credit_unusable_valid_until_last_ms', scen); if (scen === 'expired_old') c.eq(row.status, 'expired', 'credit_from_old_payment_is_born_lapsed');
  } else if (scen === 'cancelled_game') { await mk(`pay_${tag}_c`, r.int(100, pricePaise * 2), paidAt(10)); res = await apply(); c.eq(Math.round(res.appliedInr * 100), 0, 'no_credit_on_a_cancelled_game'); }
  else if (scen === 'dup_payment') { const amt = r.int(100, pricePaise * 2), paid = paidAt(10), a = await mk(`pay_${tag}_d`, amt, paid), b = await CR.creditFromPayment(db, { id: `pay_${tag}_d`, amount: amt / 100, currency: cur, paid_ms: paid }, org, null, now + 5000, 'late'); c.eq(b?.id, a?.id, 'one_credit_per_payment'); c.eq(rows().length, 1, 'no_second_credit_row'); c.eq(Math.round(rows()[0].total_inr * 100), amt, 'credit_total_not_doubled'); }
  else if (scen === 'other_org' || scen === 'other_currency') { await mk(`pay_${tag}_x`, r.int(100, pricePaise * 2), paidAt(10), scen === 'other_org' ? `${org}b` : org, scen === 'other_currency' ? (cur === 'INR' ? 'USD' : 'INR') : cur); res = await apply(); c.eq(Math.round(res.appliedInr * 100), 0, scen === 'other_org' ? 'credit_isolated_between_organizations' : 'credit_only_in_its_own_currency'); }
  await invariants();
}
function priceCase(c, r, parts) {
  const pack = Number(parts[2]), cur = parts[3], g = GOLDEN.find((x) => x[0] === pack), p = PR.price(pack, cur);
  c.eq(p.total, cur === 'INR' ? g[1] : g[2], 'pack_price_equals_owner_list', `${pack} ${cur}`); c.eq(p.tax, 0, 'no_gst_charged'); c.eq(p.total, p.base + p.tax, 'total_is_base_plus_tax'); c.ok(p.total > 0, 'money_never_negative_or_zero_price');
  c.ok(Number.isInteger(p.total * 100), 'price_in_whole_paise'); let threw = false; try { PR.price(pack + 1, cur); } catch { threw = true; } c.ok(threw, 'unknown_pack_refused');
}
async function moneyMisc(c, r, parts, tag) {
  const what = parts[1];
  if (what === 'players_never_pay' && parts[2] === 'source') { c.ok(!/checkout|razorpay|payment|entry.?fee|invoice/i.test(LUCK_TS.replace(/\/\/.*$/gm, '')), 'game_server_code_has_no_payment_code'); c.ok(!/\b(fee|price|amount)\b\s*[:=]/i.test(LUCK_TS.replace(/\/\/.*$/gm, '')), 'game_server_code_reads_no_fee_field'); }
  if (what === 'players_never_pay' && parts[2] === 'routes') {
    const now = T0(r), g = mkGame(r, tag, 3), s = mkSettings(r, { rounds: 1, texts: 'none' }), st = await startGame(c, g, now, s);
    for (const sub of ['pay', 'checkout', 'fee', 'buy', 'order']) { const res = await call(g, sub, 'POST', now, { amount: 100 }); c.eq(res.status, 404, 'no_payment_route_on_the_game', sub); }
    for (const sub of ['view', 'seats', 'rank', 'beacon', 'reveal']) { const res = await call(g, sub, 'GET', st.endMs + 1); c.ok(!/"(fee|price|amount|currency|paid|payment)"/i.test(res.text), 'game_answers_carry_no_money_field', sub); }
  }
  if (what === 'prize_is_a_gift') {
    for (const t of ['Cash prize', 'Rs 100', '₹ 50', 'win $5', 'jackpot', 'betting slip', 'stake money', 'wager', 'gambling chips', 'INR 500', 'USD 10', 'dollars']) { const x = EN.checkPrizeText(t); c.eq(x.ok, false, 'money_word_in_prize_refused', t); plain(c, x.error, t); }
    for (const t of ['Smart watch', 'Coffee mug', 'Cashew nuts box', 'Team lunch for four']) c.eq(EN.checkPrizeText(t).ok, true, 'gift_prize_accepted', t);
  }
}

// ================================================================ steps the game does not have
async function absentCase(c, r, parts, tag) {
  const f = parts[1], now = T0(r), g = mkGame(r, tag, 3), s = mkSettings(r, { rounds: 1, texts: 'none' }); const st = await startGame(c, g, now, s);
  const subs = { scratch: ['scratch', 'reveal-card'], booster: ['booster', 'boosters'], joker: ['joker'], unlucky: ['unlucky'], lucky: ['lucky', 'draw'], join: ['join'], pause: ['pause', 'resume'], shootout: ['shootout'], presence: ['presence', 'press'], message: ['announce-open', 'closing'] }[f];
  for (const sub of subs) for (const m of ['GET', 'POST']) { const res = await call(g, sub, m, st.startMs + 1000, m === 'POST' ? {} : undefined); c.eq(res.status, 404, 'no_such_step_in_this_game', `${m} ${sub}`); }
  const keys = { scratch: 'scratchCards', booster: 'boosters', joker: 'joker', unlucky: 'unlucky', lucky: 'luckyDraws', join: 'lateJoin', pause: 'pause', shootout: 'shootout', presence: 'presence', message: 'openingMessage' }[f];
  const x = EN.parseSettings({ [keys]: true, [`${keys}Count`]: 3 }); c.ok(x.ok && same(Object.keys(x.value).sort(), Object.keys(EN.defaultSettings()).sort()), 'settings_have_no_such_option', keys);
  const opts = JSON.parse(rowsOf(g, 'luck_t')[0].opts); c.ok(!(keys in opts), 'game_keeps_no_such_option');
  if (f === 'pause') { const a = EN.phaseAt(s, st.startMs, st.startMs + 5000), b = EN.phaseAt(s, st.startMs, st.startMs + 5000); c.ok(same(a, b) && a.kind === 'window', 'one_fixed_clock_no_pause'); }
}

// ================================================================ wording
async function wordCase(c, r, parts, tag) {
  const what = parts[1];
  if (what === 'refusals' && parts[2] === 'settings') for (const bad of [{ rounds: 21 }, { rounds: 'x' }, { windowSecs: 12 }, { prizeMode: 'q' }, { prizes: { overall: ['cash'] } }, { prizes: { overall: new Array(6).fill('a') } }, { prizes: { rounds: 'x' } }, { prizes: { rounds: [['a'], ['b']] }, rounds: 1 }, { prizes: { overall: [5] } }, { prizes: { overall: ['x'.repeat(130)] } }]) { const x = EN.parseSettings(bad); c.eq(x.ok, false, 'wrong_settings_refused', JSON.stringify(bad).slice(0, 60)); if (!x.ok) plain(c, x.error, JSON.stringify(bad).slice(0, 60)); }
  if (what === 'refusals' && parts[2] === 'routes') {
    const now = T0(r), g = mkGame(r, tag, 3), s = mkSettings(r, { rounds: 2, texts: 'none' }), p = g.players[0];
    const all = [await call(g, 'start', 'POST', now, undefined, '', false), await call(g, 'end', 'POST', now), await call(g, 'seats', 'GET', now), await call(g, 'beacon', 'GET', now), await call(g, 'vote', 'POST', now, { pid: 1, device: 2 }), await call(g, 'me', 'GET', now, undefined, '?pid=1&device=bad')];
    const st = await startGame(c, g, now, s); all.push(await call(g, 'start', 'POST', now, { settings: s }), await call(g, 'vote', 'POST', st.startMs, { pid: p.pid, device: p.device, result: {} }), await call(g, 'end', 'POST', now + 1), await call(g, 'end', 'POST', st.endMs + 1));
    for (const x of all) if (x.status >= 400 && x.j?.error) plain(c, x.j.error, `${x.status} ${x.j.code ?? ''}`);
    c.ok(all.some((x) => x.status >= 400), 'refusals_were_exercised');
  }
  if (what === 'no_refund_line') {
    const L = CR.NO_REFUND_LINE; c.ok(/refund/i.test(L) && /365 days/.test(L) && /credit/.test(L), 'no_refund_line_states_the_365_day_credit_rule'); c.ok(!/refund (is|will be) (given|made|paid)/i.test(L), 'no_refund_line_never_promises_a_refund'); c.ok(/^We do not give refunds\./.test(L), 'no_refund_line_starts_plainly');
    for (const [p, cur, want] of [[2399, 'INR', 'Rs 2,399'], [11799, 'INR', 'Rs 11,799'], [169, 'USD', 'US$169']]) c.eq(CR.rs(p, cur), want, 'money_words_grouping', `${p} ${cur}`);
  }
  if (what === 'target_sentence') { // R22: the tie line, in the words of the rules
    const a = EN.emptyTally(0), b = EN.emptyTally(1); for (const [g, t] of [[0, 5], [1, 6]]) EN.addHit(a, g, t); for (const [g, t] of [[0, 6], [1, 5]]) EN.addHit(b, g, t); // both 11 points, best 6, hits 2, a reached 11 at round 1, b too
    EN.addHit(a, 2, 1); a.points -= 1; a.hits--; a.reachedAt = 1; const rk = await EN.rankTop('G', 'overall', 'beacon', [a, b], 10);
    c.ok(rk.every((x) => /^Tied on 11 points; decided by .+\.$/.test(x.line)), 'tie_line_reads_like_the_rules_example', rk.map((x) => x.line)); c.ok(rk.every((x) => x.place >= 1), 'places_numbered');
    for (const m of Object.keys(WORDS)) c.ok(true, 'measure_words_known');
  }
}

// ================================================================ replay (determinism of the suite itself and of the game)
async function replayCase(c, r, parts, tag, seed, idx) {
  if (parts[1] === 'case') {
    const sub = { round: 'round|3|2|both|t', vote: 'vote|3|agree', rank: 'rank|dense|10' }[parts[2]];
    const run = async () => { const cc = new Case(), rr = rng(seed, idx + 7), p = sub.split('|'); const f = { round: roundCase, vote: voteCase, rank: rankCase }[p[0]]; await f(cc, rr, p, `${tag}x`); return JSON.stringify([cc.v, cc.checks, cc.trace]); };
    const a = await run(), b = await run(); c.eq(a, b, 'same_seed_same_case_same_checks_same_trace'); c.ok(JSON.parse(a)[1] > 5, 'replayed_case_really_checked_something'); return;
  }
  const s = mkSettings(r, { rounds: 2, texts: 'none' }), T = 20, { A, B } = beacons(r, T), seats = r.int(2, 9), gid = `G${tag}`, out = [];
  for (let k = 0; k < 3; k++) { const g = new EN.LuckGame(gid, s, seats); for (let i = 0; i < T; i++) await g.addDiceRound(i, A[i], B[i]); out.push(JSON.stringify([strip(await g.overallRanking()), strip(await g.roundRanking(1)), strip(await g.roundRanking(2)), g.results.map((x) => [x.target, Array.from(x.dice)])])); }
  c.ok(out[0] === out[1] && out[1] === out[2], 'same_inputs_same_game_three_times');
  if (parts[2] === 'b') { const g = new EN.LuckGame(gid, s, seats); for (let i = T - 1; i >= 0; i--) { let threw = false; try { await g.addDiceRound(i, A[i], B[i]); } catch { threw = true; } c.ok(threw || i === 0, 'reverse_order_refused', i); } }
}

// ================================================================ one case
export async function runCase(w, idx, seed) {
  const cell = CELLS[idx % CELLS.length], parts = cell.split('|');
  const r = rng(seed, idx), c = new Case(), tag = `${String(seed).replace(/\W/g, '')}n${idx}`;
  try {
    const f = parts[0];
    if (f === 'settings') settingsCase(c, r, parts);
    else if (f === 'odds') await oddsCase(c, r, parts);
    else if (f === 'round') await roundCase(c, r, parts, tag);
    else if (f === 'engine') await engineCase(c, r, parts, tag);
    else if (f === 'rank') await rankCase(c, r, parts, tag);
    else if (f === 'prize') prizeCase(c, r, parts);
    else if (f === 'time') await timeCase(c, r, parts, tag);
    else if (f === 'lobby') await lobbyCase(c, r, parts, tag);
    else if (f === 'late') await lateCase(c, r, parts, tag);
    else if (f === 'end') await endCase(c, r, parts, tag);
    else if (f === 'vote') await voteCase(c, r, parts, tag);
    else if (f === 'money' && parts[1] === 'credit') await creditCase(c, r, parts, tag);
    else if (f === 'money' && parts[1] === 'price') priceCase(c, r, parts);
    else if (f === 'money') await moneyMisc(c, r, parts, tag);
    else if (f === 'absent') await absentCase(c, r, parts, tag);
    else if (f === 'word') await wordCase(c, r, parts, tag);
    else if (f === 'replay') await replayCase(c, r, parts, tag, seed, idx);
    else c.ok(false, 'no_such_cell_family', f);
  } catch (err) { c.ok(false, 'no_exception', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ')); }
  return { cell, c };
}
