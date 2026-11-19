// Tambola suite, part 3: the FORMAT dimension. Same harness contract as suites/tambola.js (CELLS, newWorld, runCase -> {cell, c}).
//
// What a "format" is (product definition: packages/beacon/test/modes.test.ts, src/control.ts, src/config.ts):
//   axis A  how the game STARTS     startMode "auto" (the scheduled beacon round) | "manual" (nothing is called until a signed Start, the "go" message)
//   axis B  who CALLS the numbers   callMode  "auto" (software, one number every `stride` rounds) | "host" (the Host presses Next, a signed "next" message per number)
//   4 formats = A x B:  m1 = auto start + software calls, m2 = auto start + Host calls, m3 = manual start + software calls, m4 = manual start + Host calls.
// Not an axis: engine CallMode "ai"|"manual"|"both" is the older server engine's own who-calls switch (same idea as axis B, other code, "both" is never read);
// PrizePlan.mode "auto"|"manual" is how prize AMOUNTS are planned from a budget, not how prizes are claimed. A prize is ALWAYS won by a player's own Claim.
//
// Steps (cells = format x step):
//   gate            before Start nothing is called; the settings -> game -> control plumbing gives the right flags
//   start_ok        a valid Start names the round number 1 comes in (software) / from which the Host's first press counts; auto formats need and accept no Start
//   start_refused   Start early / with too little lead / repeated / after the end / replayed / bad signature / tampered / wrong game, through the signed store
//   schedule        per-round call schedule with brand breaks and intermissions; host gaps; activeBreak
//   late            late joiners across the start: only numbers called at/after join + LATE_LAG_ROUNDS count
//   pause_stop      pause, resume, extend, stop: refusals and effects, in every format
//   pause_prestart  a pause that is over before the game began must not move number 1 (manual start: "number 1 comes in exactly the round Start named")
//   host_pacing     Next: too early / wrong lead / order / break gap / over the maximum / paused / before Start; software formats refuse every press
//   claims          claims and prizes settle identically in every format for the same called numbers
//   game_over       all 90 called, the 91st press, stop, nothing after the end, Unlucky decided at the end
//   resume_gap      a phone that was away: hold, blind, then catches up to exactly the same state as an online phone; stale and forged answers change nothing
//   fairness        the call order is the same sealed order in every format; a press or Start can only name a FUTURE round
// The oracle is written from the documents (control.ts comments, modes.test.ts, config.ts comments) and re-derives every schedule from scratch.
import '../lib/tsresolve.js';
import { createHash } from 'node:crypto';
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { imp } from '../lib/roots.js';
import { HOUSES, houseRule, ruleDoneAt, posOf, shuffle, sameSet, allN } from './tambola.js';

const R = (p) => imp(`corporate-tambola/${p}`);
const CT = await R('packages/beacon/src/control.ts');
const BX = await R('packages/beacon/src/index.ts');
const GM = await R('packages/beacon/src/game.ts');
const CF = await R('packages/beacon/src/config.ts');
const PE = await R('packages/beacon/src/prize-engine.ts');

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const SECRET = hex(Uint8Array.from({ length: 32 }, (_, i) => i + 7)), WRONG = hex(Uint8Array.from({ length: 32 }, (_, i) => i + 9));
const PUB = CT.publicKeyFromSecret(SECRET);
const ID = 'MODE123', FAKE = '0'.repeat(128);
const LEAD = CT.SAFETY_STANDARD.leadRounds, NEXT_LEAD = 2, MAX_TIMED = 28_800, LATE_LAG = 30, INTER = 30;
const J = JSON.stringify;

export const FM = { m1: { host: false, manual: false }, m2: { host: true, manual: false }, m3: { host: false, manual: true }, m4: { host: true, manual: true } };
const STEPS = ['gate', 'start_ok', 'start_refused', 'schedule', 'late', 'pause_stop', 'pause_prestart', 'host_pacing', 'claims', 'game_over', 'resume_gap', 'fairness'];
export const CELLS = cross(Object.keys(FM), STEPS).map((a) => a.join('|'));
export async function newWorld() { return {}; }

// ================================================================ scenario pieces
const gapsOf = (breaks, rounds) => [...breaks.map((b) => ({ at: b.after, rounds: b.seconds / 3 })), ...Array.from({ length: Math.max(0, rounds - 1) }, (_, i) => ({ at: (i + 1) * 90, rounds: INTER }))].sort((a, b) => a.at - b.at);
function mkO(r, f, x = {}) {
  const rounds = x.rounds ?? 1, breaks = x.breaks ?? [];
  const o = { sched: r.int(2_000_000, 9_000_000), stride: x.stride ?? r.pick([1, 2, 3, 4, 6]), maxPause: x.maxPause ?? r.pick([600, 200, 60]), rounds, breaks, fullGap: x.fullGap ?? r.chance(0.5), startOnly: false };
  o.start = o.sched; o.gaps = gapsOf(breaks, rounds); o.maxNexts = x.maxNexts ?? 90 * rounds;
  return o;
}
const cfgFor = (f, o) => ({ pubKey: PUB, maxPauseRounds: o.maxPause, leadRounds: LEAD, ...(o.fullGap ? { fullGap: true } : {}), ...(f.host ? { callMode: 'host', hostGaps: o.gaps, maxNexts: o.maxNexts } : {}), ...(f.manual ? { startMode: 'manual', startNotBefore: o.sched } : {}) });
class Log {
  constructor() { this.l = []; }
  add(action, at, signedAt, until) { const m = { engagementId: ID, seq: this.l.length + 1, action, atBeaconRound: at, signedAtRound: signedAt, ...(until === undefined ? {} : { untilRound: until }), sig: FAKE }; this.l.push(m); return m; }
  go(sg, lead = LEAD) { return this.add('go', sg + lead, sg); }
  press(at) { return this.add('next', at, at - NEXT_LEAD); }
}
const signed = (m, secret = SECRET) => { const { sig, ...u } = m; return CT.signControlWithSecret(secret, u); };

// ---------------------------------------------------------------- the oracle: the state machine from the documents
const MAPPED = { next_auto: CT.NEXT_REFUSALS.auto, next_lead: CT.NEXT_REFUSALS.lead, next_paused: CT.NEXT_REFUSALS.paused, next_order: CT.NEXT_REFUSALS.order, next_gap: CT.NEXT_REFUSALS.gap, next_done: CT.NEXT_REFUSALS.done, next_start: CT.NEXT_REFUSALS.start, next_early: CT.NEXT_REFUSALS.early, go_auto: CT.GO_REFUSALS.auto, go_early: CT.GO_REFUSALS.early, go_lead: CT.GO_REFUSALS.lead, go_again: CT.GO_REFUSALS.again, big: CT.BIG_GAME_REFUSAL };
function model(f, o, log) {
  const why = new Map(), ivs = [], nexts = [];
  let cur = null, stop = null, go = null;
  const endOf = (x) => Math.min(x.endedAt ?? Infinity, x.until ?? x.start + o.maxPause);
  for (const m of [...log].sort((a, b) => a.seq - b.seq)) {
    const at = m.atBeaconRound, sg = m.signedAtRound, lead = at - sg, bad = [];
    const paused = !!cur && cur.start <= at && at < endOf(cur);
    if (stop !== null) bad.push('stopped');
    else if (sg > at) bad.push('backwards');
    else if (o.startOnly && ['pause', 'resume', 'extend', 'stop'].includes(m.action)) bad.push('big');
    else if (m.action === 'next') {
      const last = nexts.length ? nexts[nexts.length - 1] : -1, gp = o.gaps.find((g) => g.at === nexts.length);
      if (!f.host) bad.push('next_auto');
      else {
        if (lead !== NEXT_LEAD || m.untilRound !== undefined) bad.push('next_lead');
        if (paused) bad.push('next_paused');
        if (f.manual && go === null) bad.push('next_start'); else if (f.manual && at < go) bad.push('next_early');
        if (nexts.length >= o.maxNexts) bad.push('next_done');
        if (at <= last) bad.push('next_order');
        if (gp && nexts.length > 0 && at < last + 1 + gp.rounds) bad.push('next_gap');
      }
    } else if (m.action === 'go') {
      if (!f.manual) bad.push('go_auto');
      else { if (go !== null) bad.push('go_again'); if (sg < o.sched) bad.push('go_early'); if (lead < LEAD || m.untilRound !== undefined) bad.push('go_lead'); }
    } else if (m.action === 'pause') {
      if (lead < LEAD) bad.push('pause_lead');
      if (cur && at < endOf(cur)) bad.push('pause_again');
      if (m.untilRound !== undefined && (m.untilRound <= at || m.untilRound - at > MAX_TIMED)) bad.push('pause_end');
    } else if (m.action === 'resume') {
      if (!paused) bad.push('resume_not_paused'); else { if (lead < 1) bad.push('resume_lead'); if (at <= cur.start) bad.push('resume_before'); }
    } else if (m.action === 'extend') {
      if (!paused) bad.push('extend_not_paused'); else {
        if (cur.endedAt !== null) bad.push('extend_ending');
        if (lead < LEAD) bad.push('extend_lead');
        if (m.untilRound === undefined || m.untilRound - at > MAX_TIMED) bad.push('extend_end'); else if (m.untilRound <= endOf(cur)) bad.push('extend_not_later');
      }
    } else if (m.action === 'stop') { if (lead < LEAD) bad.push('stop_lead'); }
    if (bad.length) { why.set(m.seq, bad); continue; }
    if (m.action === 'pause') { cur = { start: at, until: m.untilRound ?? null, endedAt: null }; ivs.push(cur); }
    else if (m.action === 'resume') cur.endedAt = at;
    else if (m.action === 'extend') cur.until = m.untilRound;
    else if (m.action === 'next') nexts.push(at);
    else if (m.action === 'go') go = at;
    else stop = at;
  }
  return { why, intervals: ivs.map((x) => ({ start: x.start, end: endOf(x) })), nexts, go, stop };
}
/** (round, k) -> the beacon round of that call, Infinity = a round that never arrives yet, null = the game was stopped before it. */
function calls(f, o, mdl) {
  const stopped = (a) => (mdl.stop !== null && a >= mdl.stop ? null : a);
  if (f.host) return (round, k) => { const x = mdl.nexts[(round - 1) * 90 + k]; return x !== undefined ? stopped(x) : mdl.stop !== null ? null : Infinity; };
  if (f.manual && mdl.go === null) return () => (mdl.stop !== null ? null : Infinity);
  const start = f.manual ? mdl.go : o.start, n = 90 * o.rounds, base = [];
  for (let g = 0; g < n; g++) {
    const round = Math.floor(g / 90) + 1, k = g % 90;
    base.push(round === 1 ? start + k * o.stride + o.breaks.reduce((s, b) => s + (b.after <= k ? b.seconds / 3 : 0), 0) : base[(round - 1) * 90 - 1] + o.stride + INTER + k * o.stride);
  }
  // the unpaused schedule of round 2 hangs on round 1's UNPAUSED last call; pauses are then laid over everything in order
  const arr = base.slice();
  for (const iv of mdl.intervals) {
    const s = iv.start, len = iv.end - s, first = arr.find((a) => a >= s);
    const d = first === undefined ? len : len + (o.fullGap ? Math.max(0, o.stride - (first - s)) : 0);
    for (let g = 0; g < n; g++) if (arr[g] >= s) arr[g] += d;
  }
  return (round, k) => stopped(arr[(round - 1) * 90 + k]);
}
function compareState(c, f, o, st, mdl, label) {
  c.eq(st.host, f.host, 'state_knows_who_calls', label); c.eq(st.manualStart, f.manual, 'state_knows_how_it_starts', label);
  c.eq(st.goRound, mdl.go, 'go_round_is_the_round_start_named', label); c.eq(st.stopRound, mdl.stop, 'stop_round_matches', label);
  c.eq(J(st.nextRounds), J(mdl.nexts), 'host_presses_released_are_exactly_the_valid_ones', label);
  c.eq(J(st.intervals), J(mdl.intervals), 'pause_intervals_match', label);
  c.eq(J(st.ignored.map((x) => x.seq)), J([...mdl.why.keys()].sort((a, b) => a - b)), 'refused_messages_are_exactly_the_invalid_ones', label);
  for (const x of st.ignored) {
    const cats = mdl.why.get(x.seq) ?? [], want = cats.map((k) => MAPPED[k]).filter(Boolean);
    c.ok(typeof x.why === 'string' && x.why.length > 0, 'refusal_has_words', label);
    if (want.length && want.length === cats.length) c.ok(want.includes(x.why), 'refusal_is_the_plain_text_of_the_rule', `${label} seq ${x.seq} ${cats} got ${x.why}`);
  }
}
function compareCalls(c, f, o, st, mdl, label, ks = null) {
  const at = calls(f, o, mdl), o1 = { ...o, breaks: [] }, at1 = calls(f, o1, mdl);
  const list = ks ?? Array.from({ length: 90 }, (_, k) => k);
  for (const k of list) {
    c.eq(CT.callRound(st, o.start, o.stride, k), at1(1, k), 'call_round_follows_the_format', `${label} k${k}`);
    for (let rd = 1; rd <= o.rounds; rd++) if (k % 7 === 0 || k === 89) c.eq(GM.callRoundR(st, o.start, o.stride, o.breaks, rd, k), at(rd, k), 'call_round_r_follows_the_format', `${label} round${rd} k${k}`);
  }
}
const noCallInside = (c, st, ks, label) => {
  for (const k of ks) { const a = CT.callRound(st, 0, 1, k); if (a !== null && Number.isFinite(a)) for (const iv of st.intervals) c.ok(!(a >= iv.start && a < iv.end), 'no_call_inside_a_pause', `${label} k${k} round ${a} in ${J(iv)}`); }
};

/** A run of `n` valid calls in a format with one round and no breaks. Returns {log, mdl, st, at(k)}. */
function build(r, f, o, n, extraGo = 0) {
  const L = new Log();
  let at0 = o.sched + r.int(2, 100);
  if (f.manual) { const sg = o.sched + r.int(0, 200); L.go(sg, LEAD + extraGo); at0 = sg + LEAD + extraGo + r.int(0, 5); }
  if (f.host) { let at = at0; for (let k = 0; k < n; k++) { L.press(at); at += r.int(1, 5); } }
  const mdl = model(f, o, L.l), st = CT.resolveControl(cfgFor(f, o), L.l), at = calls(f, o, mdl);
  return { log: L.l, mdl, st, at: (k) => at(1, k) };
}
const KEYS = HOUSES.filter((k) => k !== 'full2');
const kvOf = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) }; };

// ================================================================ gate
function gateCase(c, r, f, tag) {
  const o = mkO(r, f, { rounds: 2, breaks: r.chance(0.5) ? [{ after: r.int(10, 80), seconds: 3 * r.int(1, 20), kind: 'speech' }] : [] });
  const cfg = cfgFor(f, o), st = CT.resolveControl(cfg, []), mdl = model(f, o, []), at = calls(f, o, mdl);
  c.eq(st.manualStart, f.manual, 'state_knows_how_it_starts'); c.eq(st.host, f.host, 'state_knows_who_calls');
  c.eq(st.goRound, null, 'no_start_round_before_start'); c.eq(st.ignored.length, 0, 'nothing_refused_in_an_empty_log');
  for (const k of [0, 1, r.int(2, 88), 89]) {
    const a = CT.callRound(st, o.start, o.stride, k);
    if (f.manual || f.host) c.eq(a, Infinity, 'before_start_or_press_nothing_is_called', `k${k}`);
    else c.eq(a, o.start + k * o.stride, 'auto_start_software_calls_on_the_schedule', `k${k}`);
    for (let rd = 1; rd <= 2; rd++) {
      const b = GM.callRoundR(st, o.start, o.stride, o.breaks, rd, k);
      c.eq(b, at(rd, k), 'round_schedule_follows_the_format', `round${rd} k${k}`);
      if (f.manual || f.host) c.eq(b, Infinity, 'before_start_or_press_nothing_is_called_any_round', `round${rd} k${k}`);
    }
  }
  // a stop before Start ends the game: null (not "never yet"), in every format
  const sg = o.sched + r.int(0, 30), L = new Log(); L.add('stop', sg + LEAD + r.int(0, 9), sg);
  const st2 = CT.resolveControl(cfg, L.l), m2 = model(f, o, L.l);
  compareState(c, f, o, st2, m2, 'stop_first');
  if (f.manual || f.host) { c.eq(CT.callRound(st2, o.start, o.stride, 0), null, 'a_stop_before_start_ends_the_game'); c.eq(GM.callRoundR(st2, o.start, o.stride, o.breaks, 1, 3), null, 'a_stop_before_start_ends_the_game_r'); }
  // settings -> game -> control file: the four formats from the owner's two questions
  const v = CF.validateCfg({ callMode: f.host ? 'host' : 'auto', startMode: f.manual ? 'manual' : 'auto' });
  if (c.ok(v.ok, 'format_settings_are_valid')) {
    c.eq(v.cfg.callMode === 'host', f.host, 'saved_settings_keep_who_calls'); c.eq(v.cfg.startMode === 'manual', f.manual, 'saved_settings_keep_how_it_starts');
    const g = GM.hostGameOf(v.cfg, o.sched);
    c.eq(g.callMode, f.host ? 'host' : 'auto', 'hostGameOf_call_mode'); c.eq(g.startMode, f.manual ? 'manual' : 'auto', 'hostGameOf_start_mode');
    if (f.manual) c.eq(g.startNotBefore, o.sched, 'hostGameOf_carries_the_scheduled_round_for_manual_start');
    const file = { v: 1, engagementId: ID, pubKey: PUB, maxPauseRounds: o.maxPause, leadRounds: LEAD, messages: [], fullGap: true };
    const cfg2 = CT.cfgOf(file, g), st3 = CT.resolveControl(cfg2, []);
    c.eq(st3.host, f.host, 'control_file_from_settings_knows_who_calls'); c.eq(st3.manualStart, f.manual, 'control_file_from_settings_knows_how_it_starts');
    c.eq(cfg2.startNotBefore, f.manual ? o.sched : undefined, 'control_file_keeps_the_scheduled_round'); c.eq(cfg2.maxNexts ?? 0, f.host ? 90 : 0, 'control_file_host_max_presses_is_90_per_round');
  }
  c.ok(CF.validateCfg({ callMode: 'both' }).ok === false && CF.validateCfg({ startMode: 'tomorrow' }).ok === false, 'only_two_values_per_axis_exist');
  c.ok(CF.validateCfg({ prizePlan: { mode: 'auto', currency: 'INR', budget: 100, count: 1, prizes: [{ id: '0:top:1', amount: 100 }] } }).ok && CF.validateCfg({ prizePlan: { mode: 'manual', currency: 'INR', budget: 100, count: 1, prizes: [{ id: '0:top:1', amount: 100 }] } }).ok, 'prize_plan_mode_is_a_budget_planner_not_a_claim_mode');
}

// ================================================================ start_ok
function startOkCase(c, r, f, tag) {
  const o = mkO(r, f), L = new Log(), cfg = cfgFor(f, o);
  if (f.manual) {
    const sg = o.sched + r.pick([0, 0, r.int(1, 500)]), lead = LEAD + r.pick([0, 0, r.int(1, 30)]), G = sg + lead;
    L.go(sg, lead);
    if (!f.host) {
      const st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l);
      compareState(c, f, o, st, mdl, 'go'); c.eq(st.ignored.length, 0, 'a_valid_start_is_accepted');
      c.eq(CT.callRound(st, o.start, o.stride, 0), G, 'number_1_comes_in_exactly_the_round_start_named');
      c.eq(GM.callRoundR(st, o.start, o.stride, [], 1, 0), G, 'number_1_comes_in_exactly_the_round_start_named_r');
      for (const k of [1, r.int(2, 89)]) c.eq(CT.callRound(st, o.start, o.stride, k), G + k * o.stride, 'later_numbers_follow_at_the_chosen_speed', `k${k}`);
      compareCalls(c, f, o, st, mdl, 'm3 go', [0, 1, 2, 44, 89]);
    } else {
      L.add('next', G - 1, G - 1 - NEXT_LEAD);       // one round early: refused
      L.press(G); const a2 = G + r.int(1, 6); L.press(a2); L.press(a2 + 1 + r.int(0, 4));
      const st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l);
      compareState(c, f, o, st, mdl, 'm4 go');
      c.eq(st.ignored.length, 1, 'only_the_press_before_the_start_round_is_refused'); c.eq(st.ignored[0]?.why, CT.NEXT_REFUSALS.early, 'press_before_the_start_round_says_wait');
      c.eq(CT.callRound(st, o.start, o.stride, 0), G, 'first_press_may_come_in_the_start_round'); c.eq(CT.callRound(st, o.start, o.stride, 3), Infinity, 'a_number_nobody_pressed_yet_never_arrives');
      c.ok(st.nextRounds.every((x) => x >= G), 'no_number_before_the_start_round');
    }
  } else {
    const sg = o.sched + r.int(0, 300); L.go(sg);
    const st = CT.resolveControl(cfg, L.l);
    c.eq(st.ignored[0]?.why, CT.GO_REFUSALS.auto, 'a_game_that_starts_by_itself_has_no_start_button'); c.eq(st.goRound, null, 'refused_start_names_no_round');
    if (!f.host) {
      for (const k of [0, 5, 89]) c.eq(CT.callRound(st, o.start, o.stride, k), o.start + k * o.stride, 'auto_start_schedule_is_untouched_by_a_refused_start');
    } else {
      const L2 = new Log(), t = o.sched + r.int(0, 400); L2.press(t + NEXT_LEAD);
      const st2 = CT.resolveControl(cfg, L2.l); c.eq(st2.ignored.length, 0, 'auto_start_host_press_needs_no_start'); c.eq(J(st2.nextRounds), J([t + NEXT_LEAD]), 'auto_start_host_press_is_released');
      c.eq(CT.callRound(st2, o.start, o.stride, 0), t + NEXT_LEAD, 'auto_start_host_first_call_is_the_press'); c.eq(CT.callRound(st, o.start, o.stride, 0), Infinity, 'host_waits_for_the_first_press');
    }
  }
}

// ================================================================ start_refused (resolve rules + the signed store)
async function startRefusedCase(c, r, f, tag) {
  const o = mkO(r, f), cfg = cfgFor(f, o);
  const go1 = (sg, lead = LEAD, until) => { const L = new Log(); L.add('go', sg + lead, sg, until); return L.l; };
  const wantRefused = (log, cat, label, text) => {
    const st = CT.resolveControl(cfg, log), mdl = model(f, o, log); compareState(c, f, o, st, mdl, label);
    const k = f.manual ? cat : 'go_auto'; c.ok((mdl.why.get(log[log.length - 1].seq) ?? []).includes(k), 'harness_expected_refusal', label);
    c.eq(st.ignored.at(-1)?.why, f.manual ? text : CT.GO_REFUSALS.auto, 'start_refusal_in_plain_words', label); return st;
  };
  const e = 1 + r.int(0, 60);
  let st = wantRefused(go1(o.sched - e), 'go_early', 'early', CT.GO_REFUSALS.early);
  if (f.manual && !f.host) c.eq(CT.callRound(st, o.start, o.stride, 0), Infinity, 'refused_early_start_calls_nothing');
  if (f.manual) { c.eq(resolveGo(cfg, o.sched).ignored.length, 0, 'the_scheduled_round_itself_is_the_earliest_start'); c.eq(resolveGo(cfg, o.sched - 1).ignored.length, 1, 'one_round_before_the_schedule_is_refused'); }
  wantRefused(go1(o.sched + 5, r.int(0, LEAD - 1)), 'go_lead', 'short lead', CT.GO_REFUSALS.lead);
  wantRefused(go1(o.sched + 5, LEAD + 3, o.sched + 500), 'go_lead', 'start with an end round', CT.GO_REFUSALS.lead);
  { const L = new Log(); L.go(o.sched + 10); L.go(o.sched + 20); st = CT.resolveControl(cfg, L.l); compareState(c, f, o, st, model(f, o, L.l), 'again');
    if (f.manual) { c.eq(st.goRound, o.sched + 10 + LEAD, 'first_start_stands'); c.eq(st.ignored[0]?.why, CT.GO_REFUSALS.again, 'second_start_does_nothing'); } else c.eq(st.goRound, null, 'auto_games_never_get_a_start_round'); }
  { const L = new Log(); L.add('stop', o.sched + 40 + LEAD, o.sched + 40); L.go(o.sched + 60); st = CT.resolveControl(cfg, L.l); compareState(c, f, o, st, model(f, o, L.l), 'start after stop');
    c.ok(st.ignored.some((x) => x.seq === 2), 'start_after_the_end_is_refused'); c.eq(st.goRound, null, 'start_after_the_end_names_no_round'); }
  // the signed store: signature, replay, tamper, wrong game, sequence
  const kv = kvOf(); c.ok((await CT.registerKey(kv, ID, PUB, CT.SAFETY_STANDARD)).ok, 'key_registered');
  const game = { callMode: f.host ? 'host' : 'auto', startMode: f.manual ? 'manual' : 'auto', startNotBefore: o.sched };
  const pub = async (m) => CT.publishControl(kv, ID, m, game), file = async () => CT.readPublished(kv, ID);
  const mk = async (now, a, secret = SECRET) => signed(CT.nextMessage(await file(), now, a), secret);
  let res = await pub(await mk(o.sched - e, { action: 'go' }));
  c.ok(res.ok === false && res.status === 422, 'early_or_wrong_mode_start_is_422', J(res)); c.eq(res.error, f.manual ? CT.GO_REFUSALS.early : CT.GO_REFUSALS.auto, 'store_says_the_plain_words');
  res = await pub(await mk(o.sched + 5, { action: 'go' }, WRONG)); c.ok(res.ok === false && res.status === 403, 'bad_signature_is_403', J(res));
  { const m = await mk(o.sched + 5, { action: 'go' }); res = await pub({ ...m, atBeaconRound: m.atBeaconRound + 1 }); c.ok(res.ok === false && res.status === 403, 'tampered_round_is_403', J(res)); }
  { const m = signed({ ...(CT.nextMessage(await file(), o.sched + 5, { action: 'go' })), engagementId: 'OTHER99' }); res = await pub(m); c.ok(res.ok === false && res.status === 400, 'start_for_another_game_is_400', J(res)); }
  c.ok((await CT.publishControl(kv, 'NOSUCH1', await mk(o.sched + 5, { action: 'go' }), game)).status === 404, 'unknown_game_is_404');
  const good = await mk(o.sched + r.int(0, 100), { action: 'go' }); res = await pub(good);
  if (f.manual) {
    c.ok(res.ok === true && res.seq === 1, 'valid_start_is_accepted', J(res));
    const again = await pub(good); c.ok(again.ok === true && again.duplicate === true, 'replayed_start_is_harmless', J(again)); c.eq((await file()).messages.length, 1, 'replay_adds_nothing');
    const clash = await pub(signed({ ...good, signedAtRound: good.signedAtRound + 1, atBeaconRound: good.atBeaconRound + 1 })); c.ok(clash.ok === false && clash.status === 409, 'same_seq_other_message_is_409', J(clash));
    const second = await pub(await mk(o.sched + 200, { action: 'go' })); c.ok(second.ok === false && second.error === CT.GO_REFUSALS.again, 'second_start_refused_in_plain_words', J(second));
    c.ok((await pub({ ...(await mk(o.sched + 201, { action: 'pause', pauseForRounds: 9 })), seq: 9, sig: FAKE })).ok === false, 'a_gap_in_the_sequence_is_refused');
    c.eq(CT.describeControl(await file(), o.sched + 300, game).goRound, good.atBeaconRound, 'console_shows_the_start_round');
  } else {
    c.ok(res.ok === false && res.error === CT.GO_REFUSALS.auto, 'auto_start_game_refuses_start_in_the_store', J(res)); c.eq((await file()).messages.length, 0, 'refused_start_is_not_stored');
  }
  // presses through the store
  const kv2 = kvOf(); await CT.registerKey(kv2, ID, PUB, CT.SAFETY_STANDARD);
  const file2 = async () => CT.readPublished(kv2, ID), pub2 = async (m) => CT.publishControl(kv2, ID, m, game), mk2 = async (now, a) => signed(CT.nextMessage(await file2(), now, a));
  if (!f.host) { res = await pub2(await mk2(o.sched + 50, { action: 'next' })); c.eq(res.error, CT.NEXT_REFUSALS.auto, 'software_calls_so_no_next_button'); }
  else if (!f.manual) { res = await pub2(await mk2(o.sched + 50, { action: 'next' })); c.ok(res.ok === true, 'auto_start_host_press_needs_no_start', J(res)); }
  else {
    res = await pub2(await mk2(o.sched + 50, { action: 'next' })); c.eq(res.error, CT.NEXT_REFUSALS.start, 'press_before_start_says_press_start_first', J(res));
    const sg = o.sched + 60, G = sg + LEAD; res = await pub2(await mk2(sg, { action: 'go' })); c.ok(res.ok === true, 'start_accepted_in_the_store', J(res));
    res = await pub2(signed({ ...CT.nextMessage(await file2(), G - 4, { action: 'next' }) })); c.eq(res.error, CT.NEXT_REFUSALS.early, 'press_before_the_start_round_says_wait', J(res));
    res = await pub2(await mk2(G - NEXT_LEAD, { action: 'next' })); c.ok(res.ok === true, 'first_press_from_the_start_round_is_accepted', J(res));
  }
}
function resolveGo(cfg, signedAt) { const L = new Log(); L.go(signedAt); return CT.resolveControl(cfg, L.l); }

// ================================================================ schedule
function scheduleCase(c, r, f, tag) {
  const rounds = f.host ? r.pick([1, 2]) : r.pick([1, 2, 3]), afters = [...new Set(Array.from({ length: r.int(0, 2) }, () => r.int(10, 80)))].sort((a, b) => a - b);
  const breaks = afters.map((a) => ({ after: a, seconds: 3 * r.int(1, 20), kind: 'speech' }));
  const o = mkO(r, f, { rounds, breaks }), cfg = cfgFor(f, o);
  c.eq(J(CT.hostGapsFor(breaks, rounds, INTER)), J(o.gaps), 'host_gaps_are_the_breaks_and_the_intermissions');
  c.eq(CF.INTERMISSION_ROUNDS, INTER, 'intermission_is_30_rounds');
  const L = new Log();
  let G = o.sched;
  if (f.manual) { const sg = o.sched + r.int(0, 300); L.go(sg); G = sg + LEAD; }
  if (f.host) {
    let prev = G - 1 + r.int(0, 3), k = 0;
    const total = r.chance(0.5) ? 90 * rounds : r.int(5, 90 * rounds);
    for (; k < total; k++) { const gp = o.gaps.find((g) => g.at === k); let at = prev + 1 + r.int(0, 3); if (gp && k > 0) at = Math.max(at, prev + 1 + gp.rounds + r.int(0, 2)); if (k === 0) at = Math.max(at, G); L.press(at); prev = at; }
  }
  const st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l);
  compareState(c, f, o, st, mdl, `${rounds} rounds`);
  if (f.host) c.eq(mdl.nexts.length, L.l.length - (f.manual ? 1 : 0), 'host_with_gaps_respected_every_press_is_accepted');
  const at = calls(f, o, mdl), ks = [0, 1, 2, 89, r.int(3, 88), ...afters, ...afters.map((a) => a - 1)];
  for (let rd = 1; rd <= rounds; rd++) for (const k of ks) c.eq(GM.callRoundR(st, o.start, o.stride, breaks, rd, k), at(rd, k), 'every_round_call_follows_the_format', `round${rd} k${k}`);
  compareCalls(c, f, o, st, mdl, 'single round', [0, 1, 2, 44, 89]);
  // order and spacing
  if (!f.host && (!f.manual || mdl.go !== null)) {
    for (let rd = 1; rd <= rounds; rd++) {
      let prev = null;
      for (let k = 0; k < 90; k++) { const a = GM.callRoundR(st, o.start, o.stride, breaks, rd, k); if (prev !== null) c.ok(a - prev >= o.stride, 'calls_are_at_least_one_gap_apart', `round${rd} k${k}`); if (prev !== null && !breaks.some((b) => b.after === k)) c.eq(a - prev, o.stride, 'gap_is_the_chosen_speed_between_breaks', `round${rd} k${k}`); prev = a; }
      if (rd > 1) c.eq(GM.callRoundR(st, o.start, o.stride, breaks, rd, 0) - GM.callRoundR(st, o.start, o.stride, breaks, rd - 1, 89), o.stride + INTER, 'intermission_between_rounds');
    }
  }
  // the break shows right after the call it follows, for its length
  for (const b of breaks) {
    const prev = GM.callRoundR(st, o.start, o.stride, breaks, 1, b.after - 1);
    if (prev === null || !Number.isFinite(prev)) continue;
    const e = prev + 1 + b.seconds / 3;
    c.eq(GM.activeBreak(st, o.start, o.stride, breaks, prev + 1)?.endsAtRound, e, 'break_starts_right_after_its_call'); c.eq(GM.activeBreak(st, o.start, o.stride, breaks, e - 1)?.endsAtRound, e, 'break_lasts_its_length');
    c.eq(GM.activeBreak(st, o.start, o.stride, breaks, e), null, 'break_is_over_at_its_end'); c.eq(GM.activeBreak(st, o.start, o.stride, breaks, prev), null, 'no_break_during_its_own_call');
  }
}

// ================================================================ late joiners across the start
function lateCase(c, r, f, tag) {
  const o = mkO(r, f), n = r.int(40, 90), B = build(r, f, o, n), eid = `E${tag}`;
  c.eq(CF.LATE_LAG_ROUNDS, LATE_LAG, 'late_joiner_lag_is_30_rounds'); c.eq(PE.countFromOf(1000), 1000 + LATE_LAG, 'count_from_is_join_round_plus_lag'); c.eq(PE.countFromOf(0), 0, 'joined_in_time_counts_everything');
  if (f.host) c.eq(B.mdl.nexts.length, n, 'all_presses_accepted');
  const cr = Array.from({ length: n }, (_, k) => B.at(k));
  c.ok(cr.every((x) => Number.isFinite(x)), 'every_called_number_has_a_round'); c.ok(cr.every((x, k) => k === 0 || x > cr[k - 1]), 'call_rounds_increase');
  const first = cr[0], last = cr[n - 1], key = r.pick(KEYS), pids = Array.from({ length: 6 }, (_, i) => `s${tag}x${i}`);
  const log = shuffle(r, Array.from({ length: 90 }, (_, i) => i + 1)).slice(0, n), tickets = new Map(pids.map((p) => [p, GM.ticketsFor(eid, p, 1)]));
  const kind = r.pick(['before_start', 'across_start', 'at_start', 'mid', 'boundary', 'after_end']), countFrom = new Map(), late = pids.filter((_, i) => i % 2 === 1);
  for (const p of late) {
    const rule = houseRule(tickets.get(p)[0], key), mine = new Set(rule.kind === 'lines' ? rule.lines.flat() : rule.pool);
    const onHouse = log.map((x, k) => (k >= 1 && k <= n - 2 && mine.has(x) ? k : -1)).filter((k) => k >= 0);
    let jr;
    if (kind === 'before_start') jr = first - LATE_LAG - r.int(1, 200); else if (kind === 'across_start') jr = first - r.int(0, LATE_LAG - 1); else if (kind === 'at_start') jr = first;
    else if (kind === 'mid') jr = cr[r.int(1, n - 2)] - r.int(0, 2); else if (kind === 'boundary') jr = (onHouse.length ? cr[r.pick(onHouse)] : cr[1]) - LATE_LAG; else jr = last + r.int(1, 50);
    countFrom.set(p, PE.countFromOf(jr));
  }
  const mineOf = (p) => { const cf = countFrom.get(p) ?? 0; return log.map((x, k) => (cr[k] >= cf ? x : -1 - k)); };
  const doneOf = new Map(pids.map((p) => [p, ruleDoneAt(houseRule(tickets.get(p)[0], key), posOf(mineOf(p)))]));
  const deadline = (i) => (i + 1 < n ? BX.roundTimeMs(cr[i + 1]) : Infinity);
  const claims = pids.filter((p) => doneOf.get(p) >= 0).map((p) => ({ pid: p, pattern: key, round: 1, idx: doneOf.get(p), atMs: BX.roundTimeMs(cr[doneOf.get(p)]) + r.int(0, 2000) }));
  const m = r.int(1, 3), cfg = { ...CF.defaultCfg(), tickets: 1, ties: 'share', rewards: Array.from({ length: m }, (_, i) => ({ pattern: key, scope: 'ticket', ordinal: i + 1, text: '' })) };
  const lateArg = { countFrom, callRounds: cr }, rnd = { randomness: log.map((_, i) => sha(`${tag}|${i}`)) };
  const out = GM.settleAll(eid, pids, log, cfg, 1, lateArg, rnd, { claims, callRounds: cr }).filter((x) => x.pattern === key);
  const want = positionsOf(pids, (p) => doneOf.get(p), claims, deadline);
  c.eq(out.length, Math.min(m, want.length), 'one_result_per_position_awarded', `${key} ${kind}`);
  for (let q = 0; q < Math.min(m, want.length); q++) { const got = out.find((x) => x.ordinal === q + 1); if (c.ok(!!got, 'position_awarded', `${key} ${kind} ${q + 1}`)) { c.eq(got.idx, want[q].idx, 'position_goes_to_the_call_that_completes_it_on_counted_numbers', `${key} ${kind}`); c.ok(sameSet(got.pids, want[q].pids), 'everyone_on_the_same_call_shares', `${key} ${kind}`); } }
  for (const p of late) {
    const solo = GM.settleAll(eid, [p], log, cfg, 1, lateArg, rnd, { claims: claims.filter((x) => x.pid === p), callRounds: cr }).filter((x) => x.pattern === key && x.ordinal === 1);
    c.eq(solo.length ? solo[0].idx : -1, doneOf.get(p) >= 0 ? doneOf.get(p) : -1, 'late_joiner_wins_on_own_counted_numbers_only', `${key} ${kind}`);
    if (kind === 'before_start') { const all = ruleDoneAt(houseRule(tickets.get(p)[0], key), posOf(log)); c.eq(doneOf.get(p), all, 'joined_before_the_first_call_counts_every_number', key); }
    if (kind === 'after_end') c.eq(doneOf.get(p), -1, 'joined_after_the_last_call_counts_nothing', key);
  }
  const cheat = late.map((p) => ({ p, i: ruleDoneAt(houseRule(tickets.get(p)[0], key), posOf(log)) })).filter((x) => x.i >= 0 && x.i !== doneOf.get(x.p));
  const cc = GM.checkClaims(eid, [...cheat.map((x) => ({ pid: x.p, pattern: key, idx: x.i, round: 1 })), ...claims.map(({ pid, idx }) => ({ pid, pattern: key, idx, round: 1 }))], log, cfg, { countFrom, callRounds: { 1: cr } });
  c.eq(cc.bad.length, cheat.length, 'claim_on_numbers_before_the_count_from_round_is_refused', `${key} ${kind}`); c.eq(cc.good.length, claims.length, 'claim_on_own_counted_numbers_is_accepted');
}
/** The prize positions of one house under the documented rules (share): a claim counts at the real completion call, before the next number, with fewer than 2 Bogeys before it. */
function positionsOf(pids, doneOf, claims, deadline) {
  const groups = new Map();
  for (const p of pids) {
    const idx = doneOf(p); if (idx < 0) continue;
    const cl = claims.filter((x) => x.pid === p && !x.bogey).sort((a, b) => a.atMs - b.atMs)[0];
    if (!cl || cl.idx !== idx || !(cl.atMs < deadline(idx))) continue;
    if (claims.filter((x) => x.pid === p && x.bogey && x.atMs < cl.atMs).length >= 2) continue;
    groups.set(idx, [...(groups.get(idx) ?? []), p]);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((i) => ({ idx: i, pids: groups.get(i) }));
}

// ================================================================ pause / resume / extend / stop
function pauseStopCase(c, r, f, tag) {
  const o = mkO(r, f), L = new Log(), cfg = cfgFor(f, o);
  let G = o.sched;
  if (f.manual) { const sg = o.sched + r.int(0, 100); L.go(sg); G = sg + LEAD; }
  let now = G + r.int(0, 20);
  for (let e = r.int(2, 8); e > 0; e--) {
    now += r.int(1, 40);
    const t = r.pick(f.host ? ['press', 'press', 'press', 'press', 'pause', 'pause_t', 'resume', 'extend', 'bad_lead', 'stop'] : ['pause', 'pause_t', 'pause_t', 'resume', 'extend', 'bad_lead', 'press', 'stop']);
    const lead = LEAD + r.int(0, 10);
    if (t === 'press') L.add('next', now + NEXT_LEAD, now);
    else if (t === 'pause') L.add('pause', now + lead, now);
    else if (t === 'pause_t') L.add('pause', now + lead, now, now + lead + r.int(5, 80));
    else if (t === 'resume') L.add('resume', now + r.int(1, 6), now);
    else if (t === 'extend') L.add('extend', now + lead, now, now + lead + r.int(10, 200));
    else if (t === 'bad_lead') L.add('pause', now + r.int(0, LEAD - 1), now);
    else if (r.chance(0.5)) L.add('stop', now + lead, now);
  }
  const st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l);
  compareState(c, f, o, st, mdl, 'script');
  const ks = f.host ? Array.from({ length: mdl.nexts.length + 2 }, (_, k) => k) : null;
  compareCalls(c, f, o, st, mdl, 'script', ks);
  noCallInside(c, st, f.host ? ks : Array.from({ length: 90 }, (_, k) => k), 'script');
  if (f.host) { for (const a of st.nextRounds) for (const iv of st.intervals) c.ok(!(a >= iv.start && a < iv.end), 'a_press_inside_a_pause_is_never_released', `${a} in ${J(iv)}`); }
  // a stop only removes the tail: everything before it is as without it
  if (st.stopRound !== null) {
    const L2 = new Log(); L2.l = L.l.slice(0, L.l.findIndex((m) => m.action === 'stop' && !mdl.why.has(m.seq))); const st2 = CT.resolveControl(cfg, L2.l);
    for (let k = 0; k < (f.host ? mdl.nexts.length + 1 : 90); k++) { const a = CT.callRound(st, o.start, o.stride, k), b = CT.callRound(st2, o.start, o.stride, k); if (b !== null && Number.isFinite(b) && b < st.stopRound) c.eq(a, b, 'stop_only_removes_the_tail', `k${k}`); else if (b !== null && b >= st.stopRound) c.eq(a, null, 'nothing_is_called_from_the_stop_round_on', `k${k}`); }
  }
  // a plain timed pause: calls after it are pushed by its length (plus the full-gap rule), in the software formats
  if (!f.host) {
    const sg = G + r.int(10, 200), at = sg + LEAD, len = r.int(3, 60), L3 = new Log();
    if (f.manual) L3.go(o.sched + 1); L3.add('pause', at, sg, at + len);
    const st3 = CT.resolveControl(cfg, L3.l), m3 = model(f, o, L3.l); compareState(c, f, o, st3, m3, 'one pause'); compareCalls(c, f, o, st3, m3, 'one pause', [0, 3, 20, 50, 89]);
    const base = f.manual ? o.sched + 1 + LEAD : o.start;
    for (const k of [0, 10, 40, 80]) { const a = CT.callRound(st3, o.start, o.stride, k), b = base + k * o.stride; if (b < at) c.eq(a, b, 'calls_before_the_pause_are_not_moved', `k${k}`); else { c.ok(a >= at + len, 'calls_after_the_pause_come_after_it', `k${k}`); c.ok(a - b >= len, 'a_pause_pushes_later_calls_by_at_least_its_length', `k${k}`); } }
  }
}

// ================================================================ a pause that is over before the game began
function pausePrestartCase(c, r, f, tag) {
  const o = mkO(r, f, { fullGap: r.chance(0.5) }), cfg = cfgFor(f, o), L = new Log();
  const a = o.sched + r.int(0, 50), len = r.int(1, 60), pat = a + LEAD, until = pat + len;
  L.add('pause', pat, a, until);
  if (f.manual) {
    const G = until + r.int(0, 20); L.go(G - LEAD);
    if (f.host) { L.press(G + r.int(0, 3)); }
    const st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l); compareState(c, f, o, st, mdl, 'pause then start');
    if (!f.host) {
      c.eq(CT.callRound(st, o.start, o.stride, 0), G, 'a_pause_over_before_start_does_not_move_number_1');
      c.eq(CT.callRound(st, o.start, o.stride, 5), G + 5 * o.stride, 'a_pause_over_before_start_does_not_move_later_numbers');
      c.eq(GM.callRoundR(st, o.start, o.stride, [], 1, 0), G, 'a_pause_over_before_start_does_not_move_number_1_r');
    } else { c.eq(CT.callRound(st, o.start, o.stride, 0), mdl.nexts[0], 'host_first_call_is_the_first_press'); c.ok(mdl.nexts.length === 1, 'press_after_pause_and_start_accepted'); }
  } else {
    if (f.host) { L.press(pat + 3); L.press(until + 4); }
    const st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l); compareState(c, f, o, st, mdl, 'auto pause');
    noCallInside(c, st, Array.from({ length: f.host ? 2 : 90 }, (_, k) => k), 'auto pause');
    if (!f.host) { const a0 = CT.callRound(st, o.start, o.stride, 0); c.ok(a0 >= o.start, 'auto_start_never_earlier_than_scheduled'); c.note(`auto pause before schedule: number 1 at +${a0 - o.start} rounds (pause ${len})`); }
    else c.eq(st.ignored.some((x) => x.seq === 2), pat + 3 < until, 'host_press_inside_the_pause_is_refused_and_one_outside_is_not');
  }
}

// ================================================================ host pacing and refusals
function hostPacingCase(c, r, f, tag) {
  const maxN = r.int(4, 8), gapAt = r.int(2, maxN - 1), gapLen = r.int(2, 10);
  const o = mkO(r, f, { maxNexts: maxN }); o.gaps = [{ at: gapAt, rounds: gapLen }];
  const cfg = cfgFor(f, o), L = new Log(), want = []; // [seq, text]
  let prev = -1, k = 0;
  const say = (m, text) => want.push([m.seq, text]);
  if (!f.host) {
    for (let i = 0; i < 3; i++) { const m = L.press(o.sched + 40 + 4 * i); say(m, CT.NEXT_REFUSALS.auto); }
    const st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l); compareState(c, f, o, st, mdl, 'software presses');
    for (const [s, t] of want) c.eq(st.ignored.find((x) => x.seq === s)?.why, t, 'software_calls_so_every_press_is_refused');
    c.eq(st.nextRounds.length, 0, 'no_press_is_ever_released_in_a_software_game');
    return;
  }
  let G = o.sched + 10;
  if (f.manual) {
    say(L.press(G + 20), CT.NEXT_REFUSALS.start); // a press before Start
    const sg = o.sched + r.int(0, 30); L.go(sg); G = sg + LEAD;
    say(L.add('next', G - 1, G - 1 - NEXT_LEAD), CT.NEXT_REFUSALS.early); // in the round before Start
  }
  const valid = (gap = 0) => { const at = (prev < 0 ? G : prev) + (prev < 0 ? 0 : 1 + gap) + r.int(0, 2); L.press(at); prev = at; k++; return at; };
  valid();
  say(L.add('next', prev + 6, prev + 6 - 1), CT.NEXT_REFUSALS.lead);          // lead 1
  say(L.add('next', prev + 6, prev + 6 - 3), CT.NEXT_REFUSALS.lead);          // lead 3
  say(L.add('next', prev + 2, prev, prev + 9), CT.NEXT_REFUSALS.lead);        // with an end round
  say(L.press(prev), CT.NEXT_REFUSALS.order);                                 // same round as the last number
  { const at = prev - 1; say(L.press(at), f.manual && at < G ? CT.NEXT_REFUSALS.early : CT.NEXT_REFUSALS.order); } // an earlier round (before the Start round the Start rule is the first one)
  while (k < gapAt) valid();
  say(L.press(prev + 1 + r.int(0, gapLen - 1)), CT.NEXT_REFUSALS.gap);       // the break is still on
  const gapAt2 = valid(gapLen);                                               // exactly when it ends
  c.ok(gapAt2 >= 0, 'harness');
  if (k < maxN - 1) { // a pause: a press inside it is refused, one after it goes through
    const sg = prev + 1, pat = sg + LEAD, until = pat + 20; L.add('pause', pat, sg, until);
    say(L.press(pat + 5), CT.NEXT_REFUSALS.paused);
    prev = Math.max(prev, until); L.press(until + 2); prev = until + 2; k++;
  }
  while (k < maxN) valid();
  say(L.press(prev + 3), CT.NEXT_REFUSALS.done);                              // over the maximum
  const st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l); compareState(c, f, o, st, mdl, 'pacing');
  for (const [s, t] of want) c.eq(st.ignored.find((x) => x.seq === s)?.why, t, 'host_refusal_is_the_plain_words_for_that_fault', `seq ${s}`);
  c.eq(st.nextRounds.length, maxN, 'exactly_the_valid_presses_are_released'); c.eq(st.ignored.length, want.length, 'only_the_faulty_presses_are_refused');
  c.eq(CT.callRound(st, 0, o.stride, maxN), Infinity, 'after_the_last_press_nothing_more_is_due');
  for (let i = 1; i < st.nextRounds.length; i++) { c.ok(st.nextRounds[i] > st.nextRounds[i - 1], 'presses_released_strictly_in_order'); if (i === gapAt) c.ok(st.nextRounds[i] >= st.nextRounds[i - 1] + 1 + gapLen, 'break_length_is_respected_between_presses'); }
  if (f.manual) c.ok(st.nextRounds[0] >= st.goRound, 'no_press_counts_before_start');
}

// ================================================================ claims and prizes settle identically
function claimsCase(c, r, f, tag) {
  const o = mkO(r, f), n = r.int(30, 90), eid = `E${tag}`, B = build(r, f, o, n), ref = build(r, FM.m1, mkO(r, FM.m1), n);
  const cr = Array.from({ length: n }, (_, k) => B.at(k)), crRef = Array.from({ length: n }, (_, k) => ref.at(k));
  if (f.host) c.eq(B.mdl.nexts.length, n, 'all_presses_accepted');
  const pids = Array.from({ length: 6 }, (_, i) => `s${tag}x${i}`), key = r.pick(KEYS.filter((k) => k !== 'full'));
  const log = shuffle(r, Array.from({ length: 90 }, (_, i) => i + 1)).slice(0, n), tickets = new Map(pids.map((p) => [p, GM.ticketsFor(eid, p, 1)]));
  const doneOf = new Map(pids.map((p) => [p, ruleDoneAt(houseRule(tickets.get(p)[0], key), posOf(log))]));
  const m = r.int(1, 3), cfg = { ...CF.defaultCfg(), tickets: 1, ties: 'share', rewards: Array.from({ length: m }, (_, i) => ({ pattern: key, scope: 'ticket', ordinal: i + 1, text: '' })) };
  // each player's behaviour is fixed once (format-free): on time / late / none / wrong call / bogeys first; times are made relative to THAT format's own calls
  const beh = new Map(pids.map((p) => [p, { kind: r.pick(['ok', 'ok', 'ok', 'late', 'none', 'wrong', 'ok']), u: r.int(0, 2500), bog: r.int(0, 3) }]));
  const claimsFor = (cs) => {
    const out = [], dl = (i) => (i + 1 < n ? BX.roundTimeMs(cs[i + 1]) : Infinity);
    for (const p of pids) {
      const i = doneOf.get(p), b = beh.get(p); if (i < 0 || b.kind === 'none') continue;
      let idx = i, at = BX.roundTimeMs(cs[i]) + b.u;
      if (b.kind === 'late' && i + 1 < n) at = dl(i) + b.u;
      if (b.kind === 'wrong') idx = i > 0 ? i - 1 : i + 1;
      for (let q = 0; q < b.bog; q++) out.push({ pid: p, pattern: key, round: 1, idx: Math.max(0, i - 1 - q), atMs: BX.roundTimeMs(cs[Math.min(i, n - 1)]) - 1000 * (q + 1), bogey: true });
      out.push({ pid: p, pattern: key, round: 1, idx, atMs: at });
    }
    return out;
  };
  const cl = claimsFor(cr), clRef = claimsFor(crRef), rnd = { randomness: log.map((_, i) => sha(`${tag}|${i}`)) };
  const run = (cs, cc) => GM.settleAll(eid, pids, log, cfg, 1, undefined, rnd, { claims: cc, callRounds: cs }).filter((x) => x.pattern === key).map((x) => ({ o: x.ordinal, i: x.idx, p: [...x.pids].sort() }));
  const got = run(cr, cl), ref0 = run(crRef, clRef);
  c.eq(J(got), J(ref0), 'claims_and_prizes_settle_identically_in_every_format', key);
  const deadline = (i) => (i + 1 < n ? BX.roundTimeMs(cr[i + 1]) : Infinity);
  const want = positionsOf(pids, (p) => doneOf.get(p), cl, deadline).slice(0, m);
  c.eq(J(got), J(want.map((w, q) => ({ o: q + 1, i: w.idx, p: [...w.pids].sort() }))), 'winners_are_the_valid_claims_at_the_real_completion_call', key);
  for (const p of pids) if (beh.get(p).kind === 'none') c.ok(!got.some((x) => x.p.includes(p)), 'no_claim_no_prize', key);
  for (const p of pids) if (beh.get(p).kind === 'wrong') c.ok(!got.some((x) => x.p.includes(p)), 'a_claim_on_the_wrong_call_does_not_win', key);
  // the checker (what the phone runs) agrees: only claims on the real completion call pass
  const chk = GM.checkClaims(eid, cl.filter((x) => !x.bogey).map(({ pid, pattern, idx, round }) => ({ pid, pattern, idx, round })), log, cfg);
  for (const x of chk.good) c.eq(x.idx, doneOf.get(x.pid), 'checked_claim_is_on_the_real_completion_call'); for (const x of chk.bad) c.ok(x.idx !== doneOf.get(x.pid), 'refused_claim_is_not_on_the_real_completion_call');
}

// ================================================================ game over
function gameOverCase(c, r, f, tag) {
  const o = mkO(r, f), cfg = cfgFor(f, o), eid = `E${tag}`;
  const B = build(r, f, o, 90);
  if (f.host) {
    c.eq(B.mdl.nexts.length, 90, 'all_90_presses_accepted'); c.eq(B.st.ignored.length, 0, 'no_refusal_in_a_clean_game');
    const L = new Log(); L.l = [...B.log]; const last = B.mdl.nexts[89];
    L.press(last + 1 + r.int(0, 4));
    let st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l); compareState(c, f, o, st, mdl, '91st press');
    c.eq(st.ignored.at(-1)?.why, CT.NEXT_REFUSALS.done, 'press_after_every_number_is_called_says_so'); c.eq(st.nextRounds.length, 90, 'no_91st_number'); c.eq(CT.callRound(st, 0, o.stride, 90), Infinity, 'nothing_is_due_after_the_last_number');
    const sg = last + 5; L.add('stop', sg + LEAD, sg);
    st = CT.resolveControl(cfg, L.l); mdl = model(f, o, L.l); compareState(c, f, o, st, mdl, 'stop after the end');
    c.eq(CT.callRound(st, 0, o.stride, 89), last, 'a_stop_after_the_last_call_keeps_every_number'); c.eq(CT.callRound(st, 0, o.stride, 90), null, 'after_the_end_a_call_is_null_not_never_yet');
    L.press(sg + 30); st = CT.resolveControl(cfg, L.l); c.eq(st.ignored.at(-1)?.why, 'engagement already stopped', 'a_press_after_the_end_is_refused');
  } else {
    const G = B.at(0);
    for (let k = 1; k < 90; k++) c.ok(B.at(k) > B.at(k - 1), 'calls_in_order');
    const T = G + o.stride * r.int(5, 85) + r.int(0, 2), L = new Log(); L.l = [...B.log]; const sg = T - LEAD - r.int(0, 3); L.add('stop', T, sg);
    const st = CT.resolveControl(cfg, L.l), mdl = model(f, o, L.l); compareState(c, f, o, st, mdl, 'stop mid game');
    let seenNull = false;
    for (let k = 0; k < 90; k++) { const a = CT.callRound(st, o.start, o.stride, k), b = B.at(k); if (b < T) c.eq(a, b, 'calls_before_the_stop_are_kept', `k${k}`); else { c.eq(a, null, 'calls_from_the_stop_round_on_never_come', `k${k}`); seenNull = true; } if (seenNull) c.eq(a, null, 'once_the_game_has_ended_it_stays_ended', `k${k}`); }
    L.go(T + 50); const st2 = CT.resolveControl(cfg, L.l); c.eq(st2.ignored.at(-1)?.why, 'engagement already stopped', 'nothing_is_accepted_after_the_end');
  }
  // Unlucky is decided at the end: the same winner for the same numbers in every format
  const pids = Array.from({ length: r.int(3, 9) }, (_, i) => `s${tag}x${i}`), n = r.int(20, 90), log = shuffle(r, Array.from({ length: 90 }, (_, i) => i + 1)).slice(0, n);
  const tk = new Map(pids.map((p) => [p, GM.ticketsFor(eid, p, 1)[0]])), pos = posOf(log), rnd = { randomness: log.map((_, i) => sha(`${tag}|${i}`)) };
  const rew = [{ pattern: 'unlucky', scope: 'ticket', ordinal: 1, text: '' }, { pattern: 'early5', scope: 'ticket', ordinal: 1, text: '' }];
  const ucfg = { ...CF.defaultCfg(), tickets: 1, ties: 'share', rewards: rew }, cr = Array.from({ length: n }, (_, k) => B.at(k));
  const out = GM.settleAll(eid, pids, log, ucfg, 1, undefined, { ...rnd, over: true }, { claims: [], callRounds: cr }).filter((x) => x.pattern === 'unlucky');
  const doneE = pids.map((p) => ruleDoneAt(houseRule(tk.get(p), 'early5'), pos)).filter((i) => i >= 0), doneF = pids.map((p) => ruleDoneAt(houseRule(tk.get(p), 'full'), pos)).filter((i) => i >= 0);
  // with no claims at all, nobody wins Early Five, so Unlucky is decided at the first Full House or, failing that, at the last call
  const at = doneF.length ? Math.min(...doneF) : n - 1;
  c.eq(out.length, 1, 'unlucky_is_decided_when_the_game_is_over');
  if (out.length) {
    const marked = (p) => allN(tk.get(p)).filter((x) => log.slice(0, at + 1).includes(x)).length, best = Math.min(...pids.map(marked));
    c.eq(out[0].idx, at, 'unlucky_is_decided_at_the_first_full_house_or_the_last_call'); c.eq(marked(out[0].pids[0]), best, 'unlucky_goes_to_whoever_marked_fewest');
    const ref = GM.settleAll(eid, pids, log, ucfg, 1, undefined, { ...rnd, over: true }, { claims: [], callRounds: Array.from({ length: n }, (_, k) => o.sched + 3 * k) }).filter((x) => x.pattern === 'unlucky');
    c.eq(J(out), J(ref), 'game_over_settles_identically_in_every_format');
  }
}

// ================================================================ a phone that was away
async function resumeGapCase(c, r, f, tag) {
  const o = mkO(r, f), cfg = cfgFor(f, o), L = new Log(), sf = CT.SAFETY_STANDARD;
  let G = o.sched;
  if (f.manual) { const sg = o.sched + r.int(0, 50); L.go(sg); G = sg + LEAD; }
  if (f.host) { let at = G + r.int(0, 3); for (let i = 0; i < r.int(2, 4); i++) { L.press(at); at += r.int(1, 5); } }
  else { const sg = G + r.int(5, 40), at = sg + LEAD; L.add('pause', at, sg, at + r.int(3, 40)); }
  const msgs = L.l.map((m) => signed(m)), body = (xs) => ({ engagementId: ID, messages: xs });
  const A = new CT.ControlTracker({ ...cfg }, ID, sf, o.sched - 5), B = new CT.ControlTracker({ ...cfg }, ID, sf, o.sched - 5);
  const t0 = o.sched + r.int(0, 20);
  c.eq(A.mode(o.sched - 5), 'hold', 'a_fresh_phone_holds_until_its_first_good_answer'); c.eq(CT.callRound(A.state, o.start, o.stride, 0), f.manual || f.host ? Infinity : o.start, 'fresh_phone_knows_only_the_schedule');
  c.ok(await A.ingest(t0, body(msgs)), 'good_answer_is_taken'); c.eq(A.mode(t0), 'live', 'live_after_a_good_answer'); c.eq(A.mode(t0 + sf.holdAfterRounds), 'live', 'live_until_hold_after'); c.eq(A.mode(t0 + sf.holdAfterRounds + 1), 'hold', 'hold_when_the_answer_is_too_old');
  // B was away: only failed attempts for a long time, then comes back
  const away = t0 + r.int(sf.holdAfterRounds + 2, 3 * sf.giveUpRounds);
  c.eq(B.mode(t0), 'hold', 'a_phone_with_no_answer_holds');
  B.failed(t0); c.eq(B.mode(t0 + sf.giveUpRounds), 'blind', 'blind_only_after_a_long_run_of_failed_attempts'); c.eq(B.mode(t0 + 1), 'hold', 'not_blind_early');
  // stale answer (a prefix), forged answer, wrong game: nothing is applied
  const cut = r.int(0, msgs.length - 1);
  c.ok(await B.ingest(away, body(msgs.slice(0, cut))), 'a_stale_prefix_is_a_good_answer'); const stOld = J({ g: B.state.goRound, n: B.state.nextRounds, i: B.state.intervals });
  const forged = msgs.map((m, i) => (i === msgs.length - 1 ? { ...m, atBeaconRound: m.atBeaconRound + 1 } : m));
  c.eq(await B.ingest(away + 1, body(forged)), false, 'a_forged_answer_is_a_lie'); c.eq(await B.ingest(away + 1, { engagementId: 'OTHER99', messages: msgs }), false, 'an_answer_for_another_game_is_a_lie');
  c.eq(J({ g: B.state.goRound, n: B.state.nextRounds, i: B.state.intervals }), stOld, 'forged_or_foreign_answers_change_nothing');
  c.ok(await B.ingest(away + 2, body(msgs)), 'back_online_full_answer'); c.eq(B.mode(away + 2), 'live', 'live_again_after_the_answer');
  c.ok(await B.ingest(away + 3, body(msgs.slice(0, 1))), 'a_stale_answer_after_the_full_one'); c.eq(B.log.length, msgs.length, 'stale_answer_never_undoes_anything');
  const sig = (T) => J({ g: T.state.goRound, n: T.state.nextRounds, i: T.state.intervals, s: T.state.stopRound, x: T.state.ignored });
  c.eq(sig(B), sig(A), 'a_phone_that_was_away_ends_with_exactly_the_same_state');
  for (const k of [0, 1, 2, 3, 10]) c.eq(B.callRound(o.start, o.stride, k), A.callRound(o.start, o.stride, k), 'a_phone_that_was_away_computes_the_same_call_rounds', `k${k}`);
  const mdl = model(f, o, L.l); compareState(c, f, o, B.state, mdl, 'tracker state');
  if (f.manual) { const c0 = CT.resolveControl(cfg, []); c.eq(CT.callRound(c0, o.start, o.stride, 0), Infinity, 'without_the_start_message_number_1_does_not_exist_for_a_phone'); }
}

// ================================================================ fairness: one sealed order in every format
function fairnessCase(c, r, f, tag) {
  const o = mkO(r, f), eid = `E${tag}`, B = build(r, f, o, 90), cfg = cfgFor(f, o);
  const sched = Array.from({ length: 90 }, (_, k) => CT.callRound(B.st, o.start, o.stride, k));
  c.ok(sched.every((x) => Number.isFinite(x)), 'every_call_has_a_future_round'); c.ok(sched.every((x, k) => k === 0 || x > sched[k - 1]), 'call_rounds_increase');
  const Rn = Array.from({ length: 90 }, (_, k) => sha(`${tag}|rand|${k}`));
  const store = (rs) => ({ rounds: new Map(sched.map((a, k) => [a, { round: a, randomness: rs[k], signature: '' }])) });
  const ref = BX.deriveCalls(eid, Rn), got = GM.logFrom(eid, sched, store(Rn), 90);
  c.eq(J(got), J(ref), 'the_call_order_is_the_same_sealed_order_in_every_format');
  c.eq([...new Set(got)].length, 90, 'all_90_numbers_called_once'); c.ok(got.every((x) => x >= 1 && x <= 90), 'numbers_are_1_to_90');
  const k0 = r.int(0, 80), R2 = Rn.map((x, k) => (k > k0 ? sha(`other|${tag}|${k}`) : x));
  c.eq(J(GM.logFrom(eid, sched, store(R2), 90).slice(0, k0 + 1)), J(ref.slice(0, k0 + 1)), 'a_number_depends_only_on_its_own_and_earlier_rounds');
  let moved = 0; for (let t = 0; t < 6; t++) { const R3 = Rn.slice(); R3[k0] = sha(`flip|${tag}|${t}`); if (GM.logFrom(eid, sched, store(R3), 90)[k0] !== ref[k0]) moved++; } c.ok(moved >= 1, 'a_number_changes_with_its_own_round_randomness');
  const s2 = store(Rn); s2.rounds.delete(sched[k0 + 1]); c.eq(GM.logFrom(eid, sched, s2, 90).length, k0 + 1, 'log_stops_at_the_first_missing_round');
  c.eq(J(GM.logFrom(eid, sched.map(() => Infinity), store(Rn), 90)), J([]), 'a_round_that_never_arrives_gives_no_number');
  // before Start (manual) / before any press (host) there is no round at all, so no number can exist for a phone
  if (f.manual || f.host) { const st0 = CT.resolveControl(cfg, []); c.eq(J(GM.logFrom(eid, [0, 1, 2].map((k) => CT.callRound(st0, o.start, o.stride, k)), store(Rn), 3)), J([]), 'nothing_is_known_before_start_or_the_first_press'); }
  // a Start or press can only name a round that is still in the future when it is signed, so nobody knows its randomness
  for (const m of B.log) { c.ok(m.atBeaconRound > m.signedAtRound, 'named_round_is_after_signing', m.action); if (m.action === 'next') c.eq(m.atBeaconRound - m.signedAtRound, NEXT_LEAD, 'a_press_is_signed_exactly_2_rounds_ahead'); if (m.action === 'go') c.ok(m.atBeaconRound - m.signedAtRound >= LEAD, 'a_start_is_signed_at_least_the_safety_lead_ahead'); }
  c.ok(LEAD * 3 > 12 + 3 + 3, 'start_lead_beats_the_slowest_phone_poll_plus_cache_plus_latency'); c.ok(NEXT_LEAD >= 1, 'press_lead_is_positive');
}

// ================================================================ one case
const RUN = { gate: gateCase, start_ok: startOkCase, start_refused: startRefusedCase, schedule: scheduleCase, late: lateCase, pause_stop: pauseStopCase, pause_prestart: pausePrestartCase, host_pacing: hostPacingCase, claims: claimsCase, game_over: gameOverCase, resume_gap: resumeGapCase, fairness: fairnessCase };
export async function runCase(w, idx, seed) {
  const cell = CELLS[idx % CELLS.length], [fm, step] = cell.split('|');
  const r = rng(seed, idx), c = new Case(), tag = `${String(seed).replace(/\W/g, '')}n${idx}`;
  try { await RUN[step](c, r, FM[fm], tag); } catch (err) { c.ok(false, 'no_exception', String(err?.stack ?? err).split('\n').slice(0, 3).join(' | ')); }
  return { cell, c };
}
