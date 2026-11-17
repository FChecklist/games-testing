// Model-based smoke suite for the REAL Corporate Monopoly code (C:\ct\monopoly, in-process, in-memory SQLite, injectable clock).
// One case = one little company episode walking one cell of:
//   target x period x event/stage x role x budget x provider kind x provider fault
// Other dimensions are drawn from rng(seed, idx): date boundary, cap_month, rate-card active_from, penalty effect, backdating, AI switch state.
// Every case runs the SAME scenario twice: once as a pure in-memory MODEL (independent oracle, written from the written rules,
// infinite budget, no faults) to learn the clean total, then for real against the product, with the model checked step by step.
//
// Provider kinds: 'fake-*' = an in-memory credit provider that follows CONTRACT/provider-v1.md (full / no hold / no debit / no reverse);
//                 'mnp-adapter-contract-only' = the REAL MoneypennyProvider adapter (real signing) against an in-memory fake Moneypenny.
//                 The adapter cells prove the border contract only, never Moneypenny's own behaviour.
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { imp } from '../lib/roots.js';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../lib/roots.js';

// ---------------------------------------------------------------- harness-side speed-up: WebCrypto on this laptop costs ~0.8 ms per call; the product makes dozens per operation.
// Same algorithms (SHA-256, HMAC-SHA-256, AES-256-GCM) through node:crypto, self-tested against the native implementation before use. Product code is untouched.
import { createHash, createHmac, createCipheriv, createDecipheriv, createSecretKey } from 'node:crypto';
async function installFastCrypto() {
  const sub = globalThis.crypto.subtle; if (sub.__fast || process.env.NO_FAST_CRYPTO) return;
  const o = { digest: sub.digest.bind(sub), importKey: sub.importKey.bind(sub), sign: sub.sign.bind(sub), encrypt: sub.encrypt.bind(sub), decrypt: sub.decrypt.bind(sub) };
  const nm = (a) => String(typeof a === 'string' ? a : a?.name).toUpperCase();
  const buf = (d) => (d instanceof ArrayBuffer ? Buffer.from(d) : Buffer.from(d.buffer, d.byteOffset, d.byteLength));
  const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const f = {
    digest: async (a, d) => (nm(a) === 'SHA-256' ? ab(createHash('sha256').update(buf(d)).digest()) : o.digest(a, d)),
    importKey: async (fmt, d, a, ext, uses) => { const n = nm(a); if (fmt === 'raw' && n === 'HMAC' && nm(a.hash) === 'SHA-256') { const kb = Buffer.from(buf(d)); return { __fast: 'hmac', k: createSecretKey(kb) }; } if (fmt === 'raw' && n === 'AES-GCM') { const kb = Buffer.from(buf(d)); return { __fast: 'aes', k: createSecretKey(kb), bits: kb.length * 8 }; } return o.importKey(fmt, d, a, ext, uses); },
    sign: async (a, key, d) => (key?.__fast === 'hmac' ? ab(createHmac('sha256', key.k).update(buf(d)).digest()) : o.sign(a, key, d)),
    encrypt: async (a, key, d) => { if (key?.__fast !== 'aes') return o.encrypt(a, key, d); const c = createCipheriv('aes-' + key.bits + '-gcm', key.k, Buffer.from(a.iv)); if (a.additionalData) c.setAAD(buf(a.additionalData)); return ab(Buffer.concat([c.update(buf(d)), c.final(), c.getAuthTag()])); },
    decrypt: async (a, key, d) => { if (key?.__fast !== 'aes') return o.decrypt(a, key, d); const b = buf(d), dc = createDecipheriv('aes-' + key.bits + '-gcm', key.k, Buffer.from(a.iv)); if (a.additionalData) dc.setAAD(buf(a.additionalData)); dc.setAuthTag(b.subarray(b.length - 16)); try { return ab(Buffer.concat([dc.update(b.subarray(0, b.length - 16)), dc.final()])); } catch { throw new Error('OperationError'); } },
  };
  // self-test against the native implementation: any difference and the shim stays off
  const te = new TextEncoder(), hex = (x) => Buffer.from(x).toString('hex');
  const k32 = await o.digest('SHA-256', te.encode('selftest')), iv = new Uint8Array(12).fill(7), aad = te.encode('label:1'), msg = te.encode('hello moneypenny');
  const nk = await o.importKey('raw', k32, 'AES-GCM', false, ['encrypt', 'decrypt']), fk = await f.importKey('raw', k32, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const hk = await o.importKey('raw', te.encode('sec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), hf = await f.importKey('raw', te.encode('sec'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const same = hex(await o.digest('SHA-256', msg)) === hex(await f.digest('SHA-256', msg))
    && hex(await o.sign('HMAC', hk, msg)) === hex(await f.sign('HMAC', hf, msg))
    && hex(await o.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, nk, msg)) === hex(await f.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, fk, msg))
    && hex(await f.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, fk, await o.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, nk, msg))) === hex(msg);
  if (!same) { console.error('fast crypto self-test failed: using native WebCrypto'); return; }
  for (const k of Object.keys(f)) sub[k] = f[k];
  sub.__fast = true;
}
await installFastCrypto();

const H = await imp('monopoly/test/helpers.js');
const WH = await imp('monopoly/test/webhelp.js');
const API = await imp('monopoly/src/api.js');
const EV = await imp('monopoly/src/events.js');
const RW = await imp('monopoly/src/rewards.js');
const SU = await imp('monopoly/src/setup.js');
const PEN = await imp('monopoly/src/penalty.js');
const AIM = await imp('monopoly/src/aiapi.js');
const PE = await imp('monopoly/src/people.js');
const PER = await imp('monopoly/src/periods.js');
const UT = await imp('monopoly/src/util.js');
const PRV = await imp('monopoly/src/provider/errors.js');
const MNP = await imp('monopoly/src/provider/moneypenny.js');
const AUD = await imp('monopoly/src/audit.js');
const { ProviderError } = PRV;

// ---------------------------------------------------------------- dimensions
export const TGT = ['individual', 'team'];
export const PERIOD = ['weekly', 'monthly', 'quarterly', 'half-yearly', 'yearly'];
export const EVS = ['lead.entered', 'lead.verified', 'lead.converted', 'game.created', 'game.completed', 'attendance.on_time'];
export const ROLE = ['employee', 'manager', 'hr', 'admin', 'system', 'ai'];
export const BUDGET = ['ample', 'exact', 'exhausted'];
export const PROV = ['fake-full', 'fake-no_hold', 'fake-no_debit', 'fake-no_reverse', 'mnp-adapter-contract-only'];
export const FAULT = ['none', 'timeout', 'error', 'dup_delivery', 'out_of_order', 'replay'];
export const SECONDARY = {
  date: ['normal', 'month_end', 'midnight_utc', 'ist_boundary', 'leap_day'],
  cap: ['none', 'below', 'equal', 'above'],
  rate: ['past', 'past', 'past', 'future'],
  pen: ['none', 'none', 'steps_back', 'points', 'lane', 'credits_off', 'credits_on'],
  occ: ['now', 'now', 'backdated'],
  ai: ['on', 'on', 'company_off', 'kill'],
};
// A full cross product, stored in a stride-permuted order so that idx % CELLS.length walks ALL dimensions (not just the last one).
const _cross = cross(TGT, PERIOD, EVS, ROLE, BUDGET, PROV, FAULT).map((c) => c.join('|'));
const _STRIDE = 7919; // prime, coprime with the cell count
export const CELLS = (() => { const n = _cross.length, out = new Array(n); for (let j = 0; j < n; j++) out[j] = _cross[(j * _STRIDE) % n]; return out; })();

// ---------------------------------------------------------------- calendar (own implementation; India time = UTC+5:30)
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000, IST = 330 * MIN;
const istMs = (y, m, d = 1, hh = 0, mm = 0) => Date.UTC(y, m, d, hh, mm) - IST;
const monthOf = (ms) => { const c = new Date(ms + IST); return c.getUTCFullYear() * 12 + c.getUTCMonth(); };
const PERIOD_KIND = { weekly: 'week', monthly: 'month', quarterly: 'quarter', 'half-yearly': 'half', yearly: 'year' };
function periodMine(kind, ms) { // company financial year starts in April (default fy_start_month = 4)
  const c = new Date(ms + IST), y = c.getUTCFullYear(), m = c.getUTCMonth(), d = c.getUTCDate();
  if (kind === 'week') { const dow = (c.getUTCDay() + 6) % 7; const s = istMs(y, m, d - dow); return { id: s, start: s, end: s + 7 * DAY }; }
  if (kind === 'month') { const s = istMs(y, m, 1); return { id: s, start: s, end: istMs(y, m + 1, 1) }; }
  const fy = m >= 3 ? y : y - 1, m0 = (m - 3 + 12) % 12, len = kind === 'quarter' ? 3 : kind === 'half' ? 6 : 12, idx = Math.floor(m0 / len);
  const s = istMs(fy, 3 + idx * len, 1); return { id: s, start: s, end: istMs(fy, 3 + (idx + 1) * len, 1) };
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const slotYear = (n) => { let y = 2104, k = 0; for (;;) { if (isLeap(y) && !(y % 100 === 0 && y % 400 !== 0)) { if (k === n) return y; k++; } y += 4; if (y % 100 === 0 && y % 400 !== 0) y += 4; } };

// ---------------------------------------------------------------- the in-memory credit server (shared by the fake provider and the fake Moneypenny)
class CreditServer {
  constructor() { this.reset(); }
  reset() { this.bal = new Map(); this.idem = new Map(); this.holds = new Map(); this.credited = []; this.debited = []; this.reversed = []; this.calls = []; this.fault = { mode: 'ok', left: 0 }; this.holdSeq = 0; this.creditCalls = 0; }
  setFault(mode, left = Infinity) { this.fault = { mode, left }; }
  clearFault() { this.fault = { mode: 'ok', left: 0 }; }
  /** returns 'ok' | 'down' | 'lost' | 'reject:<code>' for THIS credit call (consuming one use of a counted fault) */
  nextFault() { if (this.fault.mode !== 'ok' && this.fault.left > 0) { this.fault.left--; return this.fault.mode; } return 'ok'; }
  credit({ acct, amount, idem, ref, holdId }) {
    this.creditCalls++;
    const f = this.nextFault();
    if (f === 'down') throw new ProviderError('provider_down', 'down', { retriable: true });
    if (f.startsWith('reject:')) throw new ProviderError(f.slice(7), f);
    if (!Number.isInteger(amount) || amount <= 0) throw new ProviderError('bad_request', 'amount');
    const prev = this.idem.get(idem);
    if (prev) { this.credited.push({ acct, amount, idem, ref, effective: false }); if (f === 'lost') throw new ProviderError('provider_down', 'lost', { retriable: true }); return { ...prev, duplicate: true }; }
    if (holdId) {
      const h = this.holds.get(holdId);
      if (!h) throw new ProviderError('hold_expired', 'no hold');
      if (h.remaining < amount) throw new ProviderError('insufficient_budget', 'hold used up');
      h.remaining -= amount;
    }
    this.bal.set(acct, (this.bal.get(acct) ?? 0) + amount);
    const out = { entry_id: 'e' + this.idem.size, balance: this.bal.get(acct) };
    this.idem.set(idem, out);
    this.credited.push({ acct, amount, idem, ref, effective: true });
    if (f === 'lost') throw new ProviderError('provider_down', 'lost', { retriable: true });
    return out;
  }
}

class FakeProv { // contract-v1 provider, in memory
  constructor(srv, caps) { this.srv = srv; this.caps = { hold: !!caps.hold, debit: !!caps.debit, reverse: !!caps.reverse, expiry: false, batch: false, cash_out: false, spend: true, max_batch: 1 }; this.name = 'fake'; }
  async capabilities() { this.srv.calls.push({ m: 'capabilities' }); return { ...this.caps }; }
  async link() { return { tenant_ref: 'fake', capabilities: await this.capabilities() }; }
  async ensureAccount({ externalRef }) { this.srv.calls.push({ m: 'ensureAccount' }); return { account_ref: 'acct_' + externalRef }; }
  async getBalance({ accountRef }) { this.srv.calls.push({ m: 'getBalance' }); const b = this.srv.bal.get(accountRef) ?? 0; return { balance: b, spendable: b, holds: 0, next_expiry_at: null, unit_name: 'Moneypenny Credits' }; }
  async reserveBudget({ amount, idem }) {
    this.srv.calls.push({ m: 'reserveBudget', amount });
    if (!this.caps.hold) throw new ProviderError('unsupported', 'no hold');
    if (!Number.isInteger(amount) || amount < 0) throw new ProviderError('bad_request', 'amount');
    const ex = [...this.srv.holds].find(([, h]) => h.idem === idem);
    if (ex) return { hold_id: ex[0], remaining: ex[1].remaining, duplicate: true };
    const id = 'hold_' + (++this.srv.holdSeq); this.srv.holds.set(id, { idem, remaining: amount, amount });
    return { hold_id: id, remaining: amount };
  }
  async releaseHold({ holdId, amount }) {
    this.srv.calls.push({ m: 'releaseHold' });
    if (!this.caps.hold) throw new ProviderError('unsupported', 'no hold');
    const h = this.srv.holds.get(holdId); if (!h) throw new ProviderError('hold_expired', 'none');
    const rel = Math.min(h.remaining, amount ?? h.remaining); h.remaining -= rel; return { remaining: h.remaining, released: rel };
  }
  async credit({ accountRef, amount, fromHoldId, reasonCode, ref, idem }) {
    this.srv.calls.push({ m: 'credit', reasonCode, ref, idem, amount });
    return this.srv.credit({ acct: accountRef, amount, idem, ref, holdId: fromHoldId });
  }
  async debit({ accountRef, amount, reasonCode, ref, idem }) {
    this.srv.calls.push({ m: 'debit', reasonCode, ref, idem, amount });
    if (!this.caps.debit) throw new ProviderError('unsupported', 'no debit');
    const prev = this.srv.idem.get('d:' + idem); if (prev) return { ...prev, duplicate: true };
    const bal = this.srv.bal.get(accountRef) ?? 0, take = Math.max(0, Math.min(amount, bal));
    this.srv.bal.set(accountRef, bal - take); const out = { entry_id: 'd' + this.srv.debited.length, debited: take, balance: bal - take };
    this.srv.idem.set('d:' + idem, out); this.srv.debited.push({ acct: accountRef, amount: take, asked: amount, reasonCode, ref });
    return out;
  }
  async reverse({ entryId, reasonCode, idem }) {
    this.srv.calls.push({ m: 'reverse', reasonCode, idem });
    if (!this.caps.reverse) throw new ProviderError('unsupported', 'no reverse');
    const prev = this.srv.idem.get('r:' + idem); if (prev) return { ...prev, duplicate: true };
    const hit = this.srv.credited.find((x) => x.effective && this.srv.idem.get(x.idem)?.entry_id === entryId);
    if (!hit) throw new ProviderError('bad_request', 'no such credit');
    const bal = this.srv.bal.get(hit.acct) ?? 0, back = Math.min(hit.amount, bal);
    this.srv.bal.set(hit.acct, bal - back); const out = { entry_id: 'r' + this.srv.reversed.length, reversed: back, owed: hit.amount - back };
    this.srv.idem.set('r:' + idem, out); this.srv.reversed.push({ acct: hit.acct, back, owed: out.owed });
    return out;
  }
  async history() { return { lines: [] }; }
}

const MNP_SECRET = 'mnp-harness-secret-0123456789';
async function hmacHex(secret, msg) { return UT.hmacHex(secret, msg); }
function fakeMoneypenny(srv, clock) { // a fake Moneypenny HTTP server: verifies the real signing scheme; credit is idempotent by key
  const seen = new Set();
  return async (url, init) => {
    const u = new URL(url), h = init.headers, body = init.body ?? '';
    const reply = (status, j, extra = {}) => ({ ok: status < 300, status, headers: { get: (k) => extra[k] ?? null }, json: async () => j });
    srv.calls.push({ m: 'http:' + init.method + ' ' + u.pathname });
    const expect = await hmacHex(MNP_SECRET, [h['x-mnp-timestamp'], h['x-mnp-nonce'], init.method, u.pathname + u.search, await UT.sha256Hex(body)].join('\n'));
    if (h['x-mnp-key'] !== 'mk_h' || h['x-mnp-signature'] !== expect) return reply(401, { ok: false, error: { code: 'bad_signature' } });
    if (Math.abs(clock.t - Number(h['x-mnp-timestamp'])) > 5 * MIN) return reply(401, { ok: false, error: { code: 'stale_timestamp' } });
    if (seen.has(h['x-mnp-nonce'])) return reply(401, { ok: false, error: { code: 'replayed' } });
    seen.add(h['x-mnp-nonce']); if (seen.size > 5000) seen.clear();
    if (u.pathname === '/v1/balance') return reply(200, { ok: true, balance: srv.bal.get(u.searchParams.get('email')) ?? 0, display: { label: 'Moneypenny Credits' } });
    if (u.pathname === '/v1/credit') {
      const j = JSON.parse(body); const key = h['idempotency-key'];
      if (!key) return reply(400, { ok: false, error: { code: 'idempotency_key_required' } });
      srv.calls.push({ m: 'credit', idem: key, ref: j.ref, amount: j.amount });
      try { const out = srv.credit({ acct: j.email, amount: j.amount, idem: key, ref: j.ref }); return reply(200, { ok: true, granted: j.amount, balance: out.balance }, out.duplicate ? { 'idempotent-replay': 'true' } : {}); }
      catch (e) {
        if (e.code === 'provider_down') { if (e.message === 'lost') throw new Error('network'); throw new Error('network'); }
        return reply(400, { ok: false, error: { code: e.code === 'account_closed' ? 'account_frozen' : 'bad_request' } });
      }
    }
    if (u.pathname === '/v1/history') return reply(200, { ok: true, entries: [] });
    return reply(404, { ok: false, error: { code: 'not_found' } });
  };
}
const spy = (inner, srv) => new Proxy(inner, { get(t, p) { const v = Reflect.get(t, p, t); if (typeof v !== 'function' || typeof p === 'symbol' || p === 'constructor') return v; return (...a) => { if (!(t instanceof FakeProv)) srv.calls.push({ m: String(p), via: 'adapter' }); return v.apply(t, a); }; } });

function makeProvider(kind, srv, clock) {
  if (kind === 'mnp-adapter-contract-only') {
    const inner = new MNP.MoneypennyProvider({ baseUrl: 'https://mnp.test', keyId: 'mk_h', secret: MNP_SECRET }, { fetchImpl: fakeMoneypenny(srv, clock), now: () => clock.t });
    return { prov: spy(inner, srv), caps: { hold: false, debit: false, reverse: false }, adapter: true };
  }
  const caps = { hold: kind !== 'fake-no_hold', debit: kind !== 'fake-no_debit', reverse: kind !== 'fake-no_reverse' };
  return { prov: new FakeProv(srv, caps), caps, adapter: false };
}

// ---------------------------------------------------------------- the cheap statement cache (harness-side speed-up, product code untouched)
function cachePrepare(db) {
  const raw = db.raw, orig = raw.prepare.bind(raw), m = new Map();
  raw.prepare = (sql) => { let st = m.get(sql); if (!st) { st = orig(sql); if (m.size < 3000) m.set(sql, st); } return st; };
}

// ---------------------------------------------------------------- static UI strings, checked once
const PUB = resolve(ROOT, 'monopoly/public');
let UI_BAD = null;
function uiStrings() {
  if (UI_BAD) return UI_BAD;
  const bad = [];
  try {
    for (const f of readdirSync(PUB)) {
      if (!/\.(js|html)$/.test(f)) continue;
      const t = readFileSync(resolve(PUB, f), 'utf8');
      // string literals only (quotes/backticks), so code like regex or template placeholders are not read as display text
      for (const m of t.matchAll(/(["'`])((?:\\.|(?!\1).){2,200})\1/g)) {
        const s = m[2];
        if (/\bMP\b/.test(s)) bad.push(`${f}: MP in "${s.slice(0, 60)}"`);
        if (/(^|[^A-Za-z])\$\s?\d/.test(s) && !/\$\{/.test(s)) bad.push(`${f}: bare $ in "${s.slice(0, 60)}"`);
      }
    }
  } catch (e) { bad.push('ui files unreadable: ' + e.message); }
  UI_BAD = bad; return bad;
}

// ---------------------------------------------------------------- the oracle model (written from CONTRACT/*.md, the design comments and the written rules, not by reading outputs)
const COUNTED = new Set(['queued', 'sent', 'waiting', 'recorded']);
const DEF = { capEvent: 1000, capPersonMonth: 5000, capPersonSeason: 15000, capPeriodBonus: 5000, secondApproverOver: 1000, backdateDays: 7, splitContribPct: 60, splitHeadCap: 5000, lateCloseDays: 7, dedupeDays: 365 };
const ROLE_OF = { P: 'employee', Q: 'employee', R: 'employee', M: 'manager', OM: 'manager', H: 'hr', A: 'admin', S: 'system' };

class Model {
  constructor({ budget, season, caps, adapter }) {
    this.budget = budget; this.season = season; this.caps = caps; this.adapter = adapter;
    this.events = new Map(); // dupKey -> event
    this.dedupe = new Map(); // `${type}|${hash}` -> {at, status}
    this.rows = []; this.cards = new Map(); this.targets = []; this.now = 0;
    this.fault = { mode: 'ok', left: 0 }; this.credited = new Map(); this.bal = new Map();
    this.team = { M: ['P', 'Q', 'R'] }; this.pen = null; this.settled = new Map();
  }
  rk(k) { return this.ids?.[k] ?? k; } // real ids are random: when known, ties and grant order follow them like the product's ORDER BY person_id
  funded() { let s = 0; for (const r of this.rows) if (r.amount > 0 && (r.state === 'queued' || r.state === 'sent')) s += r.amount; return s; }
  sumCounted(f) { let s = 0; for (const r of this.rows) if (COUNTED.has(r.state) && f(r)) s += r.amount; return s; }
  setFault(mode, left = Infinity) { this.fault = { mode, left }; }
  nextFault() { if (this.fault.mode !== 'ok' && this.fault.left > 0) { this.fault.left--; return this.fault.mode; } return 'ok'; }
  /** the reward decision, from the written rules: caps are checked first (room), then the season budget (queued vs waiting) */
  grant({ person, kind, amount, idem, group, at, rowCap = 0, periodBonus = false, periodId = null }) {
    const f = this.rows.find((x) => x.idem === idem);
    if (f) return { paid: ['failed', 'void'].includes(f.state) ? 0 : f.amount, replay: true };
    if (!Number.isInteger(amount) || amount <= 0) return { paid: 0 };
    const mk = monthOf(at);
    let room = amount;
    if (kind === 'event') room = Math.min(room, DEF.capEvent);
    if (group && rowCap > 0) room = Math.min(room, rowCap - this.sumCounted((x) => x.person === person && x.group === group && x.mk === mk));
    if (!periodBonus) room = Math.min(room, DEF.capPersonMonth - this.sumCounted((x) => x.person === person && x.mk === mk));
    room = Math.min(room, DEF.capPersonSeason - this.sumCounted((x) => x.person === person));
    if (periodBonus) room = Math.min(room, DEF.capPeriodBonus - this.sumCounted((x) => x.person === person && x.periodId === periodId && ['tier', 'streak', 'team'].includes(x.kind)));
    if (room <= 0) return { paid: 0, capped: true };
    const row = { idem, person, kind, amount: room, group, mk, periodId, state: 'queued', attempts: 0, at };
    if (this.funded() + room > this.budget) row.state = 'waiting';
    this.rows.push(row);
    if (row.state === 'queued') this.send(row);
    return { paid: room, row };
  }
  send(row) { // mirrors the provider call and the way the game treats each answer
    row.attempts++;
    const f = this.nextFault();
    const credit = () => { if (!this.credited.has(row.idem)) { this.credited.set(row.idem, { person: row.person, amount: row.amount }); this.bal.set(row.person, (this.bal.get(row.person) ?? 0) + row.amount); } };
    if (f === 'down') return;
    if (f === 'lost') { credit(); return; }
    if (f.startsWith('reject:')) {
      const code = f.slice(7);
      const asWait = !this.adapter && (code === 'insufficient_budget' || code === 'hold_expired');
      row.state = asWait ? 'waiting' : 'failed'; return;
    }
    credit(); row.state = 'sent';
  }
  retry() { for (const r of this.rows.filter((x) => x.state === 'queued')) this.send(r); }
  release() { for (const r of this.rows.filter((x) => x.state === 'waiting')) { if (this.funded() + r.amount > this.budget) continue; r.state = 'queued'; this.send(r); } }

  // ---- intake (events.js rules, as documented)
  predictSubmit(it, actor, now) {
    const role = ROLE_OF[actor], sys = role === 'system';
    const at = it.at;
    if (at > now + DAY) return { ok: false, reason: 'bad_date' };
    if (it.person === 'X') return { ok: false, reason: 'unknown_person' };
    if (role === 'employee' && actor !== it.person) return { ok: false, reason: 'not_allowed' };
    if (role === 'manager' && !(this.team[actor]?.includes(it.person) || actor === it.person)) return { ok: false, reason: 'not_your_team' };
    if (at < this.season.start || at >= this.season.end) return { ok: false, reason: 'outside_season' };
    const card = this.cardFor(it.type, it.stage, at);
    if (!card) return { ok: false, reason: 'no_rate_card' };
    if (card.state === 'system' && !sys) return { ok: false, reason: 'needs_system_source' };
    const ext = role === 'employee' ? `${actor}:${it.ext}` : it.ext;
    const dupKey = `${it.type}|${ext}|${it.stage}`;
    if (this.events.has(dupKey)) return { ok: false, reason: 'duplicate' };
    if (it.dedupe && card.stageNo === 1) { const d = this.dedupe.get(`${it.type}|${it.dedupe.toLowerCase()}`); if (d && d.status !== 'rejected' && d.status !== 'reversed' && d.at > now - DEF.dedupeDays * DAY) return { ok: false, reason: 'duplicate_lead' }; }
    const backdated = at < now - DEF.backdateDays * DAY, big = card.credits > DEF.secondApproverOver, self = actor === it.person;
    let approvals;
    if (sys && card.state !== 'manager') approvals = 0;
    else if (card.state === 'auto' && !self && !backdated && !big && role !== 'employee') approvals = 0;
    else approvals = 1;
    if (!sys && (backdated || big)) approvals = 2;
    return { ok: true, status: approvals === 0 ? 'applied' : 'pending', approvals, dupKey, card };
  }
  commitSubmit(it, actor, exp, now) {
    const ev = { key: it.key, person: it.person, type: it.type, stage: it.stage, at: it.at, status: exp.status, req: exp.approvals, done: 0, by: new Set(), submitter: actor, card: exp.card };
    this.events.set(exp.dupKey, ev);
    if (it.dedupe) this.dedupe.set(`${it.type}|${it.dedupe.toLowerCase()}`, { at: now, status: 'pending' });
    if (exp.status === 'applied') this.applyEvent(ev);
    return ev;
  }
  evOf(it) { return [...this.events.values()].find((e) => e.key === it.key); }
  applyEvent(ev) {
    ev.status = 'applied';
    this.grant({ person: ev.person, kind: 'event', amount: ev.card.credits, idem: `event:${ev.key}:${ev.stage}`, group: `card:${ev.type}:${ev.stage}`, at: ev.at, rowCap: ev.card.capMonth });
    if (this.pen) ev.penalty = true;
  }
  predictApprove(ev, actor) {
    if (!ev) return { ok: false, reason: 'no_event' };
    if (!['pending', 'held'].includes(ev.status)) return { ok: false, reason: 'not_pending' };
    const role = ROLE_OF[actor];
    const can = role === 'admin' || role === 'hr' || (role === 'manager' && this.team[actor]?.includes(ev.person));
    if (!['manager', 'hr', 'admin'].includes(role) || !can) return { ok: false, reason: 'not_allowed' };
    if (actor === ev.person || actor === ev.submitter) return { ok: false, reason: 'self_approval' };
    if (ev.req >= 2 && ev.done >= 1 && !['hr', 'admin'].includes(role)) return { ok: false, reason: 'second_approver' };
    if (ev.by.has(actor)) return { ok: false, reason: 'already_approved' };
    return { ok: true };
  }
  commitApprove(ev, actor) { ev.by.add(actor); ev.done++; if (ev.done >= Math.max(1, ev.req)) this.applyEvent(ev); }
  cardFor(type, stage, at) { const c = this.cards.get(`${type}|${stage}`); return c && c.activeFrom <= at ? c : null; }

  // ---- period targets: a person (or team) is paid the tier bonus once per closed period; top-ups only; never twice
  settle(asOf) {
    for (const t of this.targets) {
      const evs = [...this.events.values()].filter((e) => e.type === t.type && e.stage === t.stage && e.status === 'applied' && e.at >= t.activeFrom);
      const periods = new Map();
      for (const e of evs) { const p = periodMine(t.kind, e.at); periods.set(p.id, p); }
      for (const p of [...periods.values()].sort((a, b) => a.start - b.start)) {
        if (p.end + DEF.lateCloseDays * DAY > asOf) continue;
        const inP = evs.filter((e) => e.at >= p.start && e.at < p.end);
        const tierOf = (n) => { let best = null; for (const x of t.tiers) if (n >= x.count) best = x; return best; };
        if (t.scope === 'person') {
          for (const person of [...new Set(inP.map((e) => e.person))].sort((a, b) => this.rk(a) < this.rk(b) ? -1 : 1)) {
            const n = inP.filter((e) => e.person === person).length, ent = tierOf(n)?.bonus ?? 0;
            this.topUp({ person, kind: 'tier', group: `tier:${t.id}:${p.id}`, periodId: p.id, ent, at: p.end - 1 });
          }
        } else {
          const members = ['P', 'Q', 'R'].map((m) => ({ id: m, events: inP.filter((e) => e.person === m).length })).sort((a, b) => this.rk(a.id) < this.rk(b.id) ? -1 : 1);
          const total = members.reduce((a, m) => a + m.events, 0), tier = tierOf(total);
          const elig = members.filter((m) => m.events > 0);
          const share = new Map(members.map((m) => [m.id, 0]));
          if (elig.length && tier) {
            const pool = Math.min(tier.bonus, DEF.splitHeadCap * elig.length), contrib = Math.floor((pool * DEF.splitContribPct) / 100), equal = pool - contrib;
            const evSum = elig.reduce((a, m) => a + m.events, 0); let given = 0;
            for (const m of elig) { const a = Math.floor((contrib * m.events) / evSum) + Math.floor(equal / elig.length); share.set(m.id, a); given += a; }
            const top = [...elig].sort((a, b) => b.events - a.events || (this.rk(a.id) < this.rk(b.id) ? -1 : 1))[0]; // ties: the member whose id sorts first
            share.set(top.id, share.get(top.id) + (pool - given));
          }
          for (const m of members) this.topUp({ person: m.id, kind: 'team', group: `team:${t.id}:${p.id}:T`, periodId: p.id, ent: share.get(m.id), at: p.end - 1 });
        }
      }
    }
  }
  topUp({ person, kind, group, periodId, ent, at }) {
    const paid = this.sumCounted((x) => x.person === person && x.group === group);
    if (ent > paid) this.grant({ person, kind, amount: ent - paid, idem: `${kind}:${person}:${group}:e${ent}:p${paid}`, group, at, periodBonus: true, periodId });
  }
}

// ---------------------------------------------------------------- the world (company A on a shared in-memory database, plus tenant B for isolation probes)
const BOARD = await imp('monopoly/src/board.js');
export async function newWorld() {
  const holder = { provs: new Map(), clock: null };
  const w = await H.world({
    providerOverride: (company) => { let p = holder.provs.get(company.id); if (!p) { p = makeProvider('fake-full', new CreditServer(), holder.clock).prov; holder.provs.set(company.id, p); } return p; },
    settings: { daily_event_limit: 100000 },
  });
  cachePrepare(w.db);
  holder.clock = w.clock; w.holder = holder;
  w.ctx.env = { ...w.ctx.env };
  w.n = 0; w.sessions = new Set(); w.creditLoss = false; w.aiState = 'on'; w.ui = uiStrings();
  w.keys = {};
  for (const s of ['event_write', 'ai_read']) w.keys[s] = await SU.createKey(w.ctx, w.company, w.admin, { scope: s, label: s });
  await setAi(w, 'on');
  const { company: bco, admin: badmin } = await PE.createCompany(w.ctx, { name: 'Beta Co', slug: 'beta', adminEmail: 'boss@beta.test', settings: { daily_event_limit: 100000 } });
  w.B = { company: bco, admin: badmin, srv: new CreditServer() };
  w.B.prov = makeProvider('fake-full', w.B.srv, w.clock).prov; holder.provs.set(bco.id, w.B.prov);
  w.B.person = await mkPerson(w, bco, 'bperson', 'employee', null);
  w.B.key = await SU.createKey(w.ctx, bco, badmin, { scope: 'event_write', label: 'b' });
  const bs = await SU.createSeason(w.ctx, bco, badmin, { name: 'S', starts_at: H.T0 - 10 * DAY, ends_at: H.T0 + 300 * DAY, budget: 100000 });
  await SU.publishSeason(w.ctx, bco, badmin, bs.id, { allowStarted: true });
  await SU.addRateCard(w.ctx, bco, badmin, { event_type: 'bt', stage: 's', stage_no: 1, credits: 7, state_needed: 'auto', active_from: H.T0 - 5 * DAY });
  w.clock.t = H.T0;
  const be = await EV.submitEvent(w.ctx, bco, w.B.person, { person_id: w.B.person.id, event_type: 'bt', stage: 's', ext_id: 'b-ev-1', source: 'request', dedupe_key: 'b-d-1', occurred_at: H.T0 });
  w.B.pendingEvent = be.id;
  w.B.counts = () => bcounts(w);
  return w;
}
async function bcounts(w) {
  const q = (t, col = 'company_id') => w.db.first(`SELECT COUNT(*) n FROM ${t} WHERE ${col} = ?`, w.B.company.id).then((x) => x.n);
  return { reward: await q('reward'), event: await q('event'), audit: await q('audit'), user: await q('app_user'), penalty: await q('penalty_case'), ai: await q('ai_request'), credits: [...w.B.srv.bal].join(), calls: w.B.srv.calls.length };
}
async function setAi(w, st) {
  const want = st !== 'company_off';
  if (w.aiCompany !== want) { await AIM.setAiEnabled(w.ctx, w.company, w.admin, want); await w.reload(); w.aiCompany = want; }
  w.ctx.env.AI_KILL = st === 'kill' ? '1' : ''; w.aiState = st;
}

async function mkPerson(w, company, key, role, teamId, joinedAt = H.T0 - 60 * DAY) {
  const { ctx, db } = w;
  const id = UT.newId('u'), email = `${key}@${company.slug}.test`;
  await db.run('INSERT INTO app_user (id, company_id, team_id, role, name_sealed, email_hash, email_sealed, avatar, joined_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, company.id, teamId, role, await ctx.seal('Player', 'app_user.name:' + id), await ctx.hash('email', email), await ctx.seal(email, 'app_user.email:' + id), 'badge', joinedAt, joinedAt);
  await BOARD.ensureBoard(ctx, company, id);
  const u = await db.first('SELECT * FROM app_user WHERE id = ?', id); u.email = email; return u;
}
async function mkConsent(w, user, company) {
  for (const kind of ['employee_notice', 'penalty_rules']) await w.db.run('INSERT INTO consent (id, user_id, company_id, kind, version, at) VALUES (?,?,?,?,?,?)', `cn_${user.id}_${kind}`, user.id, company.id, kind, 'v', w.clock.t);
}

// ---------------------------------------------------------------- HTTP helpers
async function sessionFor(w, user) {
  const tok = `tk_${user.id}_${w.n}_${Math.floor(w.clock.t / (6 * HOUR))}`;
  if (!w.sessions.has(tok)) { await w.db.run('INSERT INTO session (token_hash, user_id, company_id, expires_at) VALUES (?,?,?,?)', await UT.sha256Hex(tok), user.id, user.company_id, w.clock.t + 12 * HOUR); w.sessions.add(tok); if (w.sessions.size > 5000) w.sessions.clear(); }
  return tok;
}
async function http(w, user, method, path, body) {
  const headers = { 'content-type': 'application/json', cookie: 'floor_session=' + await sessionFor(w, user) };
  if (method !== 'GET') headers['x-floor'] = '1';
  const res = await API.handle(w.ctx, new Request('https://floor.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
let idemN = 0;
const idemKey = (tag) => `h-${tag}-${(idemN++).toString(36)}`.replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 90).padEnd(8, 'x');
const kcall = (w, key, method, path, body, idem) => WH.keyCall(w, key, method, path, body, idem === null ? {} : { 'idempotency-key': idem ?? idemKey('k') });
const codeOf = (x) => x.json?.error?.code ?? (x.json?.ok === false ? x.json?.reason : null);

// ---------------------------------------------------------------- the scenario
const CARDSETS = {
  lead: [['entered', 1, 5, 'auto', 'individual'], ['verified', 2, 15, 'manager', 'individual'], ['converted', 3, 80, 'system', 'both']],
  game: [['created', 1, 10, 'auto', 'individual'], ['completed', 2, 40, 'system', 'both']],
  attendance: [['on_time', 1, 2, 'system', 'individual']],
};
const OFFS = [-1, 0, 1, -HOUR, HOUR, -DAY, DAY, -2 * DAY, -3 * DAY];
const LATE = 7 * DAY;

class Run {
  constructor({ w, idx, seed, Y, real, budget, c }) {
    this.w = w; this.idx = idx; this.seed = seed; this.Y = Y; this.real = real; this.c = c; this.budgetReal = budget;
    this.r = rng(seed, idx);
    const [tgt, perName, ev, role, budgetK, provK, fault] = CELLS[idx % CELLS.length].split('|');
    Object.assign(this, { tgt, perName, ev, role, budgetK, provK, fault });
    const r = this.r;
    this.date = r.pick(SECONDARY.date); this.capK = r.pick(SECONDARY.cap); this.rateK = r.pick(SECONDARY.rate); this.penK = r.pick(SECONDARY.pen); this.occ = r.pick(SECONDARY.occ); this.aiK = r.pick(SECONDARY.ai);
    this.aiProbe = role === 'ai' ? r.chance(0.5) : r.chance(0.1); this.tenantProbe = r.chance(0.22); this.uiProbe = r.chance(0.12); r.next();
    [this.base, this.stage] = ev.split('.');
    this.kind = PERIOD_KIND[perName];
    this.tag = `c${idx}`; this.type = `${this.base}_${this.tag}`;
    this.B0 = { normal: istMs(Y, 2, 12, 10, 0), month_end: istMs(Y, 3, 1, 0, 0), midnight_utc: Date.UTC(Y, 5, 1, 0, 0), ist_boundary: istMs(Y, 5, 1, 0, 0), leap_day: istMs(Y, 1, 29, 0, 0) }[this.date];
    this.now0 = this.B0 + 2 * HOUR; this.now = this.now0;
    this.season = { start: istMs(Y - 1, 0, 1), end: istMs(Y + 3, 0, 1) };
    this.adapter = provK === 'mnp-adapter-contract-only';
    this.caps = this.adapter ? { hold: false, debit: false, reverse: false } : { hold: provK !== 'fake-no_hold', debit: provK !== 'fake-no_debit', reverse: provK !== 'fake-no_reverse' };
    this.model = new Model({ budget: real ? budget : Infinity, season: this.season, caps: this.caps, adapter: this.adapter });
    this.model.now = this.now;
    this.U = {}; this.byId = new Map(); this.evs = [];
  }
  note(...a) { if (this.real) this.c.note(a); }
  ok(cond, code, detail) { if (this.real) return this.c.ok(cond, code, detail); return true; }
  eq(a, b, code, detail) { if (this.real) return this.c.eq(a, b, code, detail); return true; }
  acct(k) { return this.adapter ? this.U[k].email : 'acct_' + this.U[k].id; }
  setClock(t) { this.now = t; this.model.now = t; if (this.real) this.w.clock.t = t; }

  // ---- the real world setup for this case
  async setup() {
    const { w, r } = this, A = w.company, adm = w.admin;
    this.srv = new CreditServer(); const mk = makeProvider(this.provK, this.srv, w.clock); w.holder.provs.set(A.id, mk.prov);
    w.clock.t = this.B0 - 12 * DAY;
    if (this.penK.startsWith('credits')) { const want = this.penK === 'credits_on'; if (w.creditLoss !== want) { await PE.updateSettings(w.ctx, w.company, adm, { penalty_credit_loss: want }); await w.reload(); w.creditLoss = want; } }
    await setAi(w, this.aiK);
    const co = w.company;
    const teamId = UT.newId('t'); this.teamId = teamId;
    await w.db.run('INSERT INTO team (id, company_id, name, manager_id, created_at) VALUES (?,?,?,?,?)', teamId, co.id, 'Case ' + this.tag, null, w.clock.t);
    const U = this.U; const joined = this.season.start;
    U.M = await mkPerson(w, co, `m.${this.tag}`, 'manager', null, joined);
    await w.db.run('UPDATE team SET manager_id = ? WHERE id = ?', U.M.id, teamId);
    U.P = await mkPerson(w, co, `p.${this.tag}`, 'employee', teamId, joined);
    U.Q = await mkPerson(w, co, `q.${this.tag}`, 'employee', teamId, joined);
    if (this.tgt === 'team') U.R = await mkPerson(w, co, `r.${this.tag}`, 'employee', teamId, joined);
    U.H = w.people.hr; U.A = adm; U.OM = w.people.mgr;
    for (const k of Object.keys(U)) this.byId.set(U[k].id, k);
    this.model.ids = Object.fromEntries(Object.keys(U).map((k) => [k, U[k].id]));
    const cards = this.cards;
    for (const [st, no, , need, mode] of cards) {
      const m = this.model.cards.get(`${this.type}|${st}`);
      await SU.addRateCard(w.ctx, co, adm, { event_type: this.type, stage: st, stage_no: no, credits: m.credits, cap_month: m.capMonth, state_needed: need, mode, active_from: m.activeFrom });
    }
    const s = await SU.createSeason(w.ctx, co, adm, { name: 'Case ' + this.tag, starts_at: this.season.start, ends_at: this.season.end, budget: this.budgetReal, mode: 'steady' });
    this.seasonId = s.id;
    const pub = await SU.publishSeason(w.ctx, co, adm, s.id, { allowStarted: true });
    this.holdId = pub.hold_id;
    const t = this.model.targets[0];
    const tg = await SU.addTarget(w.ctx, co, adm, { name: 'T ' + this.tag, scope: t.scope, period: this.kind, event_type: this.type, stage: this.stage, tiers: t.tiers, active_from: t.activeFrom });
    this.targetId = tg.id;
    if (this.penK !== 'none') {
      const effect = this.penK.startsWith('credits') ? 'credits' : this.penK;
      const pr = await SU.addPenaltyRule(w.ctx, co, adm, { event_type: this.type, effect, amount: this.model.pen.amount });
      await SU.publishPenaltyRule(w.ctx, co, adm, pr.id); this.ruleId = pr.id;
      for (const k of ['P', 'Q', 'R', 'M']) if (U[k]) await mkConsent(w, U[k], co);
    }
    w.clock.t = this.now0;
    this.before = { b: await w.B.counts() };
    this.baseEvents = (await w.db.first('SELECT COUNT(*) n FROM event WHERE company_id = ?', co.id)).n;
  }

  // ---- submit one event as `actor` (P Q R employee, M OM manager, H hr, A admin, S signed system key)
  async submit(it, actor, expectRefusal = null) {
    const { model } = this;
    const exp = model.predictSubmit(it, actor, this.now);
    if (expectRefusal && exp.reason !== expectRefusal && !(this.rateK === 'future' && exp.reason === 'no_rate_card')) this.ok(false, 'harness_expected_refusal_mismatch', `${it.key} model said ${exp.reason ?? 'ok'} wanted ${expectRefusal}`);
    let got = null;
    if (this.real) {
      const w = this.w, body = { event_type: it.type, stage: it.stage, ext_id: it.ext, person_id: it.person === 'X' ? 'u_nobody' : this.U[it.person].id, occurred_at: it.at };
      if (it.dedupe) body.dedupe_key = it.dedupe;
      if (actor === 'S') {
        const x = await kcall(w, w.keys.event_write, 'POST', '/api/v1/events', { events: [body] }, idemKey(this.tag));
        got = x.status === 200 ? { ...x.json.results[0], http: 200 } : { ok: false, reason: codeOf(x) ?? 'http_' + x.status, http: x.status };
      } else {
        const x = await http(w, this.U[actor], 'POST', '/api/events', body);
        got = x.status === 200 ? { ...x.json, http: 200 } : { ok: false, reason: codeOf(x) ?? 'http_' + x.status, http: x.status };
      }
      this.note('submit', actor, it.key, got.ok, got.reason ?? got.status);
      if (exp.ok) { this.eq(got.ok, true, 'submit_accepted', `${it.key} by ${actor} want ok got ${got.reason}`); if (got.ok) { this.eq(got.status, exp.status, 'submit_status', `${it.key} by ${actor}`); this.eq(got.approvals_required, exp.approvals, 'submit_approvals_required', `${it.key} by ${actor}`); } }
      else { this.eq(got.ok, false, 'submit_refused', `${it.key} by ${actor} want ${exp.reason}`); this.eq(got.reason, exp.reason, 'submit_refusal_reason', `${it.key} by ${actor}`); }
    }
    if (exp.ok && (!this.real || got?.ok)) { const e = model.commitSubmit(it, actor, exp, this.now); if (this.real) { e.id = got.id; this.evs.push(e); } else this.evs.push(e); }
    return exp;
  }

  async humanSubmitViaAi(it) { // role = ai: the AI key may only ASK. A human accepts; the normal intake then decides.
    const { w } = this;
    if (!this.real) { if (this.aiK === 'on') await this.submitAccepted(it); return; }
    const body = { op: 'event.submit', payload: { event_type: it.type, stage: it.stage, ext_id: it.ext, person_id: this.U[it.person].id, occurred_at: it.at, ...(it.dedupe ? { dedupe_key: it.dedupe } : {}) }, reason: 'harness proposal' };
    const evBefore = (await w.db.first('SELECT COUNT(*) n FROM event WHERE company_id = ?', w.company.id)).n;
    const rwBefore = (await w.db.first('SELECT COUNT(*) n FROM reward WHERE company_id = ?', w.company.id)).n;
    const x = await kcall(w, w.keys.ai_read, 'POST', '/api/v1/proposals', body);
    this.note('ai_propose', x.status, x.json?.error?.code ?? x.json?.status);
    const evAfter = (await w.db.first('SELECT COUNT(*) n FROM event WHERE company_id = ?', w.company.id)).n;
    const rwAfter = (await w.db.first('SELECT COUNT(*) n FROM reward WHERE company_id = ?', w.company.id)).n;
    this.eq(evAfter, evBefore, 'ai_proposal_creates_no_event', it.key); this.eq(rwAfter, rwBefore, 'ai_proposal_pays_nothing', it.key);
    if (this.aiK === 'on') { this.eq(x.status, 202, 'ai_proposal_pending', JSON.stringify(x.json?.error ?? x.json?.status)); this.eq(x.json?.status, 'pending_human', 'ai_proposal_waits_for_human'); }
    else { this.eq(x.status, this.aiK === 'kill' ? 503 : 403, 'ai_off_refuses_proposal', this.aiK); this.eq(x.json?.error?.code, 'ai_off', 'ai_off_code'); return; }
    await this.submitAccepted(it, x.json.id);
  }
  /** a signed-in admin accepts the AI proposal: it must run through the normal intake exactly like an admin entry */
  async submitAccepted(it, proposalId = null) {
    const exp = this.model.predictSubmit(it, 'A', this.now);
    let got = null;
    if (this.real) {
      const w = this.w;
      const x = await http(w, this.U.A, 'POST', `/api/admin/ai-requests/${proposalId}/decide`, { accept: true });
      got = x.json; this.note('ai_accept', x.status, got?.result?.executed, got?.result?.refused);
      this.eq(x.status, 200, 'ai_accept_http', JSON.stringify(x.json?.error));
      const row = await w.db.first('SELECT status, decided_by FROM ai_request WHERE id = ?', proposalId);
      this.eq(row?.status, 'approved', 'ai_request_approved'); this.eq(row?.decided_by, this.U.A.id, 'ai_request_decided_by_human_admin');
      if (exp.ok) { this.eq(got?.result?.executed, true, 'ai_accept_runs_intake', JSON.stringify(got?.result)); this.eq(got?.result?.event_status, exp.status, 'ai_accept_event_status'); }
      else { this.eq(got?.result?.executed, false, 'ai_accept_refused_by_intake', JSON.stringify(got?.result)); this.eq(got?.result?.refused, exp.reason, 'ai_accept_refusal_reason'); }
      const again = await http(w, this.U.A, 'POST', `/api/admin/ai-requests/${proposalId}/decide`, { accept: true });
      this.eq(again.status, 409, 'ai_second_accept_refused', JSON.stringify(again.json?.error));
    }
    if (exp.ok) { const e = this.model.commitSubmit(it, 'A', exp, this.now); if (this.real) e.id = got?.result?.event_id; this.evs.push(e); }
  }

  async approve(ev, actor) {
    const exp = this.model.predictApprove(ev, actor);
    let got = null;
    if (this.real) {
      const x = await http(this.w, this.U[actor], 'POST', `/api/events/${ev.id}/approve`, {});
      got = x.status === 200 ? { ok: true, status: x.json.status, done: x.json.approvals_done } : { ok: false, reason: codeOf(x) ?? 'http_' + x.status };
      this.note('approve', actor, ev.key, got.ok, got.reason ?? got.status);
      if (exp.ok) { this.eq(got.ok, true, 'approve_accepted', `${ev.key} by ${actor} got ${got.reason}`); }
      else { this.eq(got.ok, false, 'approve_refused', `${ev.key} by ${actor} want ${exp.reason}`); this.eq(got.reason, exp.reason, 'approve_refusal_reason', `${ev.key} by ${actor}`); }
    }
    if (exp.ok && (!this.real || got?.ok)) { this.model.commitApprove(ev, actor); if (this.real) this.eq(got.status, ev.status, 'approve_result_status', `${ev.key}`); }
    return exp;
  }

  // ---- phases
  async approvals() {
    const { r } = this;
    const pend = this.evs.filter((e) => e.status === 'pending');
    let first = true;
    for (const ev of pend) {
      if (first) { // authority probes on the first pending event
        first = false;
        await this.approve(ev, 'P'); await this.approve(ev, 'OM'); if (ev.submitter === 'M') await this.approve(ev, 'M');
        if (ev.person !== 'P') await this.approve(ev, ev.person); // nobody approves their own
      }
      const need = Math.max(1, ev.req);
      for (let k = 0; k < need; k++) {
        const ban = new Set([ev.person, ev.submitter, ...ev.by]);
        let cands = (k === 0 ? ['M', 'H', 'A'] : ['H', 'A']).filter((x) => !ban.has(x));
        if (k === 0 && need === 2) cands = cands.filter((c0) => ['H', 'A'].some((s2) => ![ev.person, ev.submitter, c0].includes(s2)));
        if (!cands.length) { this.ok(false, 'harness_no_approver', ev.key); break; }
        if (k === 1) { await this.approve(ev, 'M'); await this.approve(ev, [...ev.by][0]); } // second approver must be HR/admin; the same person twice is refused
        await this.approve(ev, r.pick(cands));
      }
    }
  }
  async probes() {
    const { r } = this, base = { type: this.type, stage: this.stages[0], at: this.now - 1000, no: 1 };
    const p = [
      { it: { ...base, key: this.tag + '-pOM', ext: this.tag + '-pOM', person: 'P' }, actor: 'OM', want: 'not_your_team' },
      { it: { ...base, key: this.tag + '-pQ', ext: this.tag + '-pQ', person: 'P' }, actor: 'Q', want: 'not_allowed' },
      { it: { ...base, key: this.tag + '-pD', ext: this.tag + '-pD', person: 'P', at: this.now + 2 * DAY }, actor: 'H', want: 'bad_date' },
    ];
    for (const { it, actor, want } of p) await this.submit(it, actor, want);
  }
  async replays(heavy) {
    const e0 = this.evs.find((e) => e.status !== 'rejected');
    if (!e0) return;
    const it = { key: e0.key, person: e0.person, type: e0.type, stage: e0.stage, ext: this.itemsByKey.get(e0.key).ext, at: e0.at, dedupe: this.itemsByKey.get(e0.key).dedupe };
    const first = e0.submitter;
    await this.submit({ ...it, key: it.key + '-rep' }, first, 'duplicate'); // same door, same key
    if (ROLE_OF[first] !== 'employee' && first !== 'S') { const other = first === 'H' ? 'A' : 'H'; await this.submit({ ...it, key: it.key + '-rep2' }, other, 'duplicate'); }
    if (this.real && first === 'S') { // same Idempotency-Key replays the stored answer
      const w = this.w, body = { event_type: it.type, stage: it.stage, ext_id: it.ext, person_id: this.U[it.person].id, occurred_at: it.at, ...(it.dedupe ? { dedupe_key: it.dedupe } : {}) };
      const k = idemKey(this.tag + 'r'); const a = await kcall(w, w.keys.event_write, 'POST', '/api/v1/events', { events: [body] }, k); const b = await kcall(w, w.keys.event_write, 'POST', '/api/v1/events', { events: [body] }, k);
      this.eq(b.headers.get('idempotent-replayed'), 'true', 'idempotency_key_replays_answer'); this.eq(JSON.stringify(b.json?.results ?? null), JSON.stringify(a.json?.results ?? null), 'idempotent_replay_same_body');
    }
    if (heavy && this.real) { // apply an applied event again and run the tick twice: nothing is paid again
      for (const e of this.evs) if (e.status === 'applied' && e.id) { await EV.applyEvent(this.w.ctx, this.w.company, e.id); await EV.applyEvent(this.w.ctx, this.w.company, e.id); }
    }
  }
  async retryNow() { if (this.real) await RW.retryQueued(this.w.ctx, this.w.company); this.model.retry(); }
  async releaseNow() { if (this.real) await RW.releaseWaiting(this.w.ctx, this.w.company); this.model.release(); }
  async recover(light = false) {
    if (this.fault === 'timeout' && !light) { await this.retryNow(); await this.reconcile('retry_while_down'); } // still down: still queued, never lost
    if (this.real) this.srv.clearFault(); this.model.setFault('ok', 0);
    await this.retryNow(); await this.releaseNow(); await this.retryNow(); await this.releaseNow();
    await this.reconcile('after_recover');
  }
  async raise() {
    const total = this.dryTotal;
    if (!(total > this.model.budget)) return;
    if (this.real) { await SU.raiseBudget(this.w.ctx, this.w.company, this.w.admin, this.seasonId, total); this.model.budget = total; } else this.model.budget = total;
    await this.releaseNow(); await this.retryNow();
    await this.reconcile('after_budget_raise');
  }
  async settle() {
    if (this.real) await PER.settleCompany(this.w.ctx, this.w.company, this.w.ctx.now());
    this.model.settle(this.now);
    await this.reconcile('after_settle');
  }
  async penalties() {
    if (this.penK === 'none' || !this.real) { if (this.penK !== 'none') this.model.pen.skip = true; return; }
    const { w } = this, co = w.company, srv = this.srv, U = this.U;
    const money = async () => ({ rw: (await w.db.first('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM reward WHERE season_id = ?', this.seasonId)), bal: [...srv.bal].sort().join(), cred: srv.credited.length });
    const m0 = await money();
    const applied = this.evs.filter((e) => e.status === 'applied').length;
    const cases = await w.db.all("SELECT * FROM penalty_case WHERE company_id = ? AND event_id IN (SELECT id FROM event WHERE event_type = ?)", co.id, this.type);
    const creditsEff = this.penK.startsWith('credits');
    const expectCases = creditsEff ? (this.penK === 'credits_on' && this.caps.debit ? applied : 0) : applied;
    this.eq(cases.length, expectCases, 'penalty_rule_cases_per_applied_event', `${this.penK} applied=${applied} debit=${this.caps.debit}`);
    if (this.penK === 'credits_off' || (creditsEff && !this.caps.debit)) {
      const x = await http(w, U.H, 'POST', '/api/penalties', { person_id: U.P.id, effect: 'credits', amount: 5, reason: 'harness' });
      this.eq(x.status, 409, 'credit_penalty_refused_when_off_or_unsupported', JSON.stringify(x.json?.error));
      this.ok(['credit_loss_off', 'unsupported'].includes(x.json?.error?.code), 'credit_penalty_refusal_code', x.json?.error?.code);
    }
    const mp = await http(w, U.M, 'POST', '/api/penalties', { person_id: U.P.id, effect: 'points', amount: 1, reason: 'harness manager' });
    this.eq(mp.status, 200, 'manager_may_propose_for_own_team', JSON.stringify(mp.json?.error));
    const op = await http(w, U.OM, 'POST', '/api/penalties', { person_id: U.P.id, effect: 'points', amount: 1, reason: 'x' });
    this.eq(op.status, 403, 'other_manager_may_not_propose', JSON.stringify(op.json));
    const ep = await http(w, U.P, 'POST', '/api/penalties', { person_id: U.Q.id, effect: 'points', amount: 1, reason: 'x' });
    this.eq(ep.status, 403, 'employee_may_not_propose', JSON.stringify(ep.json));
    const all = await w.db.all("SELECT * FROM penalty_case WHERE company_id = ? AND person_id IN (?,?,?)", co.id, U.P.id, U.Q.id, U.R?.id ?? U.P.id);
    for (const pc of all) if (pc.state === 'proposed') {
      const a = await http(w, U.M, 'POST', `/api/penalties/${pc.id}/approve`, {}); this.eq(a.status, 403, 'manager_cannot_approve_penalty', JSON.stringify(a.json?.error));
      const b = await http(w, U.P, 'POST', `/api/penalties/${pc.id}/approve`, {}); this.eq(b.status, 403, 'person_cannot_approve_own_penalty', JSON.stringify(b.json?.error));
      const h = await http(w, U.H, 'POST', `/api/penalties/${pc.id}/approve`, {}); this.eq(h.status, 200, 'hr_approves_penalty', JSON.stringify(h.json?.error));
    }
    this.setClock(this.now + 3 * DAY + 1);
    const tk = await PEN.tickPenalties(w.ctx, co);
    const after = await w.db.all("SELECT * FROM penalty_case WHERE company_id = ? AND person_id IN (?,?,?)", co.id, U.P.id, U.Q.id, U.R?.id ?? U.P.id);
    for (const pc of after) {
      this.ok(['applied', 'rejected', 'reversed', 'proposed', 'pending'].includes(pc.state), 'penalty_state_known', pc.state);
      this.ok(pc.applied_steps <= pc.amount && pc.applied_points <= pc.amount, 'penalty_board_effect_within_amount', JSON.stringify([pc.amount, pc.applied_steps, pc.applied_points]));
      if (!creditsEff || pc.effect !== 'credits') this.eq(pc.applied_credits ?? 0, 0, 'non_credit_penalty_takes_no_credits', pc.effect);
    }
    const m1 = await money();
    const debitCalls = srv.calls.filter((x) => x.m === 'debit');
    if (this.penK === 'credits_on' && this.caps.debit) {
      // opt-in credit loss: only earned, unspent credits, only reason 'penalty', never above the cap share of this month's earnings, never below zero
      const mk = UT.monthKey(w.ctx.now());
      const earned = (await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE company_id = ? AND person_id IN (?,?,?) AND month_key = ? AND state IN ('queued','sent','waiting','recorded')", co.id, U.P.id, U.Q.id, U.R?.id ?? U.P.id, mk)).s;
      this.ok(debitCalls.every((d) => d.reasonCode === 'penalty'), 'debit_only_for_penalty_reason', JSON.stringify(debitCalls.map((d) => d.reasonCode)));
      for (const d of srv.debited) {
        const pk = this.byId.get(d.acct.replace(/^acct_/, ''));
        const ep = (await w.db.first("SELECT COALESCE(SUM(amount),0) s FROM reward WHERE season_id = ? AND person_id = ? AND month_key = ? AND state IN ('queued','sent','waiting','recorded')", this.seasonId, U[pk]?.id ?? '', mk)).s;
        this.ok(d.amount <= d.asked && d.asked <= Math.floor((ep * 20) / 100), 'credit_penalty_within_cap_share', JSON.stringify({ d, ep }));
      }
      void earned;
      this.ok([...srv.bal.values()].every((v) => v >= 0), 'provider_balance_never_below_zero_after_penalty');
    } else {
      this.eq(debitCalls.length, 0, 'penalty_never_calls_provider_debit', `${this.penK}`);
      this.eq(m1.bal, m0.bal, 'penalty_leaves_provider_balances_alone'); this.eq(m1.cred, m0.cred, 'penalty_creates_no_provider_credit');
    }
    this.eq(m1.rw.n, m0.rw.n, 'penalty_creates_no_reward_row'); this.eq(m1.rw.s, m0.rw.s, 'penalty_leaves_reward_sum_alone');
    this.note('penalties', this.penK, cases.length, tk);
  }

  // ---- model vs product, row by row
  async reconcile(label) {
    if (!this.real) return;
    const { w, model } = this;
    const rows = await w.db.all('SELECT person_id, kind, amount, state, group_key, idem_key, sent_amount, attempts, event_id, month_key FROM reward WHERE season_id = ?', this.seasonId);
    const key = (p, k, a, s) => `${p}|${k}|${a}|${s}`;
    const got = new Map(), want = new Map();
    for (const x of rows) { const k = key(this.byId.get(x.person_id), x.kind, x.amount, x.state); got.set(k, (got.get(k) ?? 0) + 1); }
    const tie = model.tieTop;
    for (const x of model.rows) { const p = tie && x.kind === 'team' ? '*' : x.person; const k = key(p, x.kind, x.amount, x.state); want.set(k, (want.get(k) ?? 0) + 1); }
    if (tie) { const g2 = new Map(); for (const [k, n] of got) { const [p, kind, a, s] = k.split('|'); if (kind === 'team') { const kk = key('*', kind, a, s); g2.set(kk, (g2.get(kk) ?? 0) + n); } else g2.set(k, n); } got.clear(); for (const [k, n] of g2) got.set(k, n); }
    const diff = [];
    for (const [k, n] of want) if ((got.get(k) ?? 0) !== n) diff.push(`want ${n}x ${k} got ${got.get(k) ?? 0}`);
    for (const [k, n] of got) if (!want.has(k)) diff.push(`unexpected ${n}x ${k}`);
    this.ok(diff.length === 0, 'model_rewards_match_product', `${label}: ${diff.slice(0, 4).join(' ; ')}`);
    // provider side: what the provider holds equals what the game sent, per person
    for (const k of Object.keys(this.U)) {
      if (!['P', 'Q', 'R'].includes(k)) continue;
      const have = this.srv.bal.get(this.acct(k)) ?? 0, exp = model.bal.get(k) ?? 0;
      if (!(tie && model.rows.some((x) => x.kind === 'team'))) this.eq(have, exp, 'provider_balance_matches_model', `${label} ${k}`);
    }
    // events
    for (const e of this.evs) { if (!e.id) continue; const row = await w.db.first('SELECT status, approvals_done FROM event WHERE id = ?', e.id); this.eq(row?.status, e.status, 'event_status_matches_model', `${label} ${e.key}`); }
  }

  // ---- facts that must hold whatever the model says
  async invariants() {
    const { w, srv } = this, co = w.company, sid = this.seasonId;
    const sum = async (sql, ...p) => (await w.db.first(sql, ...p)).s ?? 0;
    // 1. paid exactly once per event key: one reward per (event, stage); provider got at most one EFFECTIVE credit per idempotency key and per reward id
    const dupRw = await w.db.all("SELECT event_id, group_key, COUNT(*) n FROM reward WHERE season_id = ? AND kind = 'event' GROUP BY event_id, group_key HAVING n > 1", sid);
    this.eq(dupRw.length, 0, 'reward_paid_once_per_event_key', JSON.stringify(dupRw.slice(0, 2)));
    const eff = new Map(), refKeys = new Map();
    for (const x of srv.credited) { if (x.effective) eff.set(x.idem, (eff.get(x.idem) ?? 0) + 1); if (!refKeys.has(x.ref)) refKeys.set(x.ref, new Set()); refKeys.get(x.ref).add(x.idem); }
    this.ok([...eff.values()].every((n) => n === 1), 'provider_one_effective_credit_per_key', JSON.stringify([...eff].filter(([, n]) => n > 1)));
    this.ok([...refKeys.values()].every((s) => s.size === 1), 'one_idempotency_key_per_reward_id', JSON.stringify([...refKeys].filter(([, s]) => s.size > 1).map(([k, s]) => [k, [...s]])));
    const effCount = new Map(); for (const x of srv.credited) if (x.effective) effCount.set(x.ref, (effCount.get(x.ref) ?? 0) + 1);
    this.ok([...effCount.values()].every((n) => n <= 1), 'provider_at_most_one_credit_per_reward_id', JSON.stringify([...effCount].filter(([, n]) => n > 1)));
    // every effective credit corresponds to a reward row that the game recorded as counted (queued/sent/waiting never credited twice, failed rows may exist only if the provider answered "no")
    const sentRows = await w.db.all("SELECT id, idem_key, state, amount, sent_amount FROM reward WHERE season_id = ? AND state = 'sent' AND amount > 0", sid);
    const credByIdem = new Map(srv.credited.filter((x) => x.effective).map((x) => [x.idem, x]));
    for (const rrow of sentRows) { const cr = credByIdem.get(rrow.idem_key); if (!cr || cr.amount !== rrow.sent_amount) { this.ok(false, 'sent_reward_has_exactly_one_provider_credit', JSON.stringify({ id: rrow.id, idem: rrow.idem_key, has: !!cr })); break; } }
    // 2. budget: promised (queued+sent) <= season budget; credits at the provider <= budget
    const seasonRow = await w.db.first('SELECT budget FROM season WHERE id = ?', sid);
    const funded = await sum("SELECT SUM(amount) s FROM reward WHERE season_id = ? AND amount > 0 AND state IN ('queued','sent')", sid);
    this.ok(funded <= seasonRow.budget, 'total_rewards_within_season_budget', `${funded} > ${seasonRow.budget}`);
    const credTotal = [...credByIdem.values()].reduce((a, x) => a + x.amount, 0);
    this.ok(credTotal <= seasonRow.budget, 'provider_credits_within_season_budget', `${credTotal} > ${seasonRow.budget}`);
    for (const hh of srv.holds.values()) this.ok(hh.remaining >= 0, 'provider_hold_never_negative');
    // 3. no negative amounts anywhere; only a reversal row is negative; no pay is ever reduced
    const neg = await w.db.all("SELECT kind, amount FROM reward WHERE season_id = ? AND amount < 0 AND kind != 'reversal'", sid);
    this.eq(neg.length, 0, 'no_negative_reward_except_reversal', JSON.stringify(neg.slice(0, 2)));
    this.ok([...srv.bal.values()].every((v) => v >= 0), 'provider_balance_never_negative');
    this.ok(srv.credited.every((x) => x.amount > 0), 'provider_credit_amounts_positive');
    // 4. caps: person per month, person per season, row month cap
    const pm = await w.db.all("SELECT person_id, month_key, SUM(amount) s FROM reward WHERE season_id = ? AND kind != 'tier' AND kind != 'streak' AND kind != 'team' AND state IN ('queued','sent','waiting','recorded') GROUP BY person_id, month_key", sid);
    this.ok(pm.every((x) => x.s <= DEF.capPersonMonth), 'person_month_cap_never_exceeded', JSON.stringify(pm.filter((x) => x.s > DEF.capPersonMonth)));
    const ps = await w.db.all("SELECT person_id, SUM(amount) s FROM reward WHERE season_id = ? AND state IN ('queued','sent','waiting','recorded') GROUP BY person_id", sid);
    this.ok(ps.every((x) => x.s <= DEF.capPersonSeason), 'person_season_cap_never_exceeded');
    for (const [st, , , ,] of this.cards) {
      const cap = this.model.cards.get(`${this.type}|${st}`).capMonth; if (!cap) continue;
      const rowm = await w.db.all("SELECT person_id, month_key, SUM(amount) s FROM reward WHERE season_id = ? AND group_key = ? AND state IN ('queued','sent','waiting','recorded') GROUP BY person_id, month_key", sid, `card:${this.type}:${st}`);
      this.ok(rowm.every((x) => x.s <= cap), 'cap_month_never_exceeded', JSON.stringify([st, cap, rowm]));
    }
    // 5. provider only ever sees the allowed calls; nothing about wages
    const allowed = new Set(['capabilities', 'link', 'ensureAccount', 'getBalance', 'credit', 'reserveBudget', 'releaseHold', 'reverse', 'debit', 'history', 'http:GET /v1/balance', 'http:POST /v1/credit', 'http:GET /v1/history']);
    this.ok(srv.calls.every((x) => allowed.has(x.m)), 'provider_calls_are_the_allowed_ones', JSON.stringify([...new Set(srv.calls.map((x) => x.m))].filter((m) => !allowed.has(m))));
    if (!this.caps.hold) this.eq(srv.calls.filter((x) => x.m === 'reserveBudget' || x.m === 'releaseHold').length, 0, 'no_hold_call_when_provider_has_no_hold');
    if (this.penK === 'none' || this.penK === 'steps_back' || this.penK === 'points' || this.penK === 'lane' || this.penK === 'credits_off') this.eq(srv.calls.filter((x) => x.m === 'debit').length, 0, 'no_provider_debit_without_credit_loss_opt_in');
    if (this.adapter) { this.eq(srv.calls.filter((x) => x.m === 'debit' || x.m === 'reverse' || x.m === 'reserveBudget').length, 0, 'adapter_never_calls_unsupported_features'); }
    // 6. AI never executed anything by itself
    const aiEvents = await w.db.first("SELECT COUNT(*) n FROM event WHERE company_id = ? AND submitted_by IN (SELECT 'key:' || key_id FROM company_key WHERE scope = 'ai_read')", co.id);
    this.eq(aiEvents.n, 0, 'ai_key_never_submits_events');
    const aiBad = await w.db.all("SELECT id, status, decided_by FROM ai_request WHERE company_id = ? AND status = 'approved' AND (decided_by IS NULL OR decided_by NOT IN (SELECT id FROM app_user WHERE company_id = ? AND role = 'admin'))", co.id, co.id);
    this.eq(aiBad.length, 0, 'ai_request_approved_only_by_human_admin', JSON.stringify(aiBad));
    const aiMoney = await w.db.all("SELECT id FROM ai_request WHERE company_id = ? AND status = 'pending' AND result IS NOT NULL", co.id);
    this.eq(aiMoney.length, 0, 'pending_ai_request_has_no_result');
    // 7. tenant B is untouched
    const b1 = await w.B.counts(); const b0 = this.before.b;
    this.eq(JSON.stringify(b1), JSON.stringify(b0), 'tenant_b_untouched_by_company_a_case');
  }

  // ---- probes that do not depend on the model
  async tenantProbes() {
    const { w, U } = this, B = w.B, pB = B.person;
    const leak = (x) => x.text.includes(pB.id) || x.text.includes(B.pendingEvent);
    const e1 = await http(w, U.A, 'POST', '/api/events', { event_type: this.type, stage: this.stages[0], ext_id: this.tag + '-xt1', person_id: pB.id, occurred_at: this.now - 1000, dedupe_key: this.tag + '-xtd' });
    this.eq(e1.json?.reason, 'unknown_person', 'admin_cannot_enter_event_for_other_company_person', JSON.stringify(e1.json));
    const e2 = await kcall(w, w.keys.event_write, 'POST', '/api/v1/events', { events: [{ event_type: this.type, stage: this.stages[0], ext_id: this.tag + '-xt2', person_id: pB.id, occurred_at: this.now - 1000 }] });
    this.eq(e2.json?.results?.[0]?.reason, 'unknown_person', 'key_cannot_enter_event_for_other_company_person', e2.text.slice(0, 200));
    const e3 = await http(w, U.H, 'POST', `/api/events/${B.pendingEvent}/approve`, {});
    this.eq(e3.status, 404, 'hr_cannot_approve_other_company_event', e3.text.slice(0, 200));
    const e4 = await http(w, U.A, 'GET', `/api/people/${pB.id}/summary`);
    this.ok(e4.status >= 400 && !leak(e4), 'admin_cannot_read_other_company_person', e4.text.slice(0, 200));
    const e5 = await http(w, U.A, 'GET', '/api/events'); this.ok(!leak(e5), 'event_list_has_no_other_company_rows');
    const e6 = await http(w, U.A, 'GET', '/api/people'); this.ok(!leak(e6), 'people_list_has_no_other_company_rows');
    const e7 = await http(w, U.H, 'POST', '/api/penalties', { person_id: pB.id, effect: 'points', amount: 1, reason: 'x' });
    this.eq(e7.status, 404, 'cannot_propose_penalty_for_other_company_person', e7.text.slice(0, 200));
    this.eq(JSON.stringify(await B.counts()), JSON.stringify(this.before.b), 'tenant_b_untouched_by_company_a_probes');
    const e8 = await http(w, B.admin, 'GET', '/api/events'); this.ok(!e8.text.includes(this.type), 'other_company_admin_sees_none_of_our_events');
    const e9 = await http(w, B.admin, 'POST', `/api/events/${this.evs.find((e) => e.id)?.id ?? 'ev_none'}/approve`, {}); this.ok(e9.status >= 400, 'other_company_admin_cannot_approve_our_event', e9.text.slice(0, 120));
    const bk = await WH.keyCall(w, B.key, 'POST', '/api/v1/events', { events: [{ event_type: this.type, stage: this.stages[0], ext_id: this.tag + '-xt3', person_id: U.P.id, occurred_at: this.now - 1000 }] }, { 'idempotency-key': idemKey('bk') });
    this.eq(bk.json?.results?.[0]?.reason, 'unknown_person', 'other_company_key_cannot_enter_event_for_our_person', bk.text.slice(0, 200));
    this.before.b = await B.counts();
  }
  async aiProbes() {
    const { w, U } = this, on = this.aiK === 'on';
    const st = await kcall(w, w.keys.ai_read, 'GET', '/api/v1/status', undefined, null);
    this.eq(st.status, 200, 'ai_status_always_readable');
    this.eq(st.json?.switches?.platform_ai_kill, this.aiK === 'kill', 'ai_kill_switch_reported'); this.eq(st.json?.switches?.company_ai_enabled, this.aiK !== 'company_off', 'company_ai_switch_reported');
    this.eq(st.json?.effective?.writes_allowed, on, 'ai_writes_allowed_only_when_all_switches_on');
    const d1 = await kcall(w, w.keys.ai_read, 'POST', '/api/v1/events', { events: [{ event_type: this.type, stage: this.stages[0], ext_id: this.tag + '-ai1', person_id: U.P.id, occurred_at: this.now - 1000 }] });
    this.eq(d1.status, 403, 'ai_key_cannot_write_events'); this.eq(d1.json?.error?.code, 'scope_denied', 'ai_key_scope_denied');
    const d2 = await kcall(w, w.keys.ai_read, 'POST', '/api/ingest/events', { events: [] }, null); this.eq(d2.status, 403, 'ai_key_cannot_use_ingest_route');
    const d3 = await http(w, U.P, 'POST', '/api/admin/ai/toggle', { enabled: true }); this.eq(d3.status, 403, 'employee_cannot_switch_ai_on');
    const snap = async () => ({ ev: (await w.db.first('SELECT COUNT(*) n FROM event WHERE company_id = ?', w.company.id)).n, rw: (await w.db.first('SELECT COUNT(*) n FROM reward WHERE company_id = ?', w.company.id)).n, pc: (await w.db.first('SELECT COUNT(*) n FROM penalty_case WHERE company_id = ?', w.company.id)).n, rc: (await w.db.first('SELECT COUNT(*) n FROM rate_card WHERE company_id = ?', w.company.id)).n, calls: this.srv.calls.length });
    const s0 = await snap();
    const money = [
      { op: 'reward.award', payload: { person_id: U.P.id, amount: 500 } },
      { op: 'ratecard.change', payload: { event_type: this.type, stage: this.stages[0], credits: 900 } },
      { op: 'event.approve', payload: { event_id: this.evs.find((e) => e.id)?.id ?? 'ev_none' } },
      { op: 'reward.reverse', payload: { reward_id: (await w.db.first('SELECT id FROM reward WHERE season_id = ? LIMIT 1', this.seasonId))?.id ?? 'rw_none' } },
    ];
    for (const m of money) {
      const x = await kcall(w, w.keys.ai_read, 'POST', '/api/v1/proposals', { ...m, reason: 'harness ' + this.tag });
      if (on) {
        if (m.payload.event_id === 'ev_none' || m.payload.reward_id === 'rw_none') { this.ok(x.status === 404, 'ai_proposal_for_missing_id_refused', x.status); continue; }
        this.eq(x.status, 202, 'ai_money_proposal_is_only_a_request', `${m.op} ${x.text.slice(0, 120)}`); this.eq(x.json?.status, 'pending_human', 'ai_money_proposal_pending_human');
        const s1 = await snap(); this.eq(JSON.stringify(s1), JSON.stringify(s0), 'ai_proposal_changes_nothing', m.op);
        const dec = await http(w, U.A, 'POST', `/api/admin/ai-requests/${x.json.id}/decide`, { accept: true });
        this.eq(dec.status, 200, 'admin_decides_ai_proposal'); this.eq(dec.json?.result?.executed, false, 'accepted_money_proposal_is_not_executed_by_system', `${m.op} ${JSON.stringify(dec.json?.result)}`);
        const s2 = await snap(); this.eq(JSON.stringify(s2), JSON.stringify(s0), 'accepting_ai_money_proposal_changes_no_money', m.op);
      } else this.eq(x.json?.error?.code, 'ai_off', 'ai_off_refuses_proposals', `${this.aiK} ${m.op}`);
    }
    const pen = await kcall(w, w.keys.ai_read, 'POST', '/api/v1/proposals', { op: 'penalty.propose', payload: { person_id: U.P.id, effect: 'points', amount: 5, salary_cut: 10 }, reason: 'harness' });
    this.eq(pen.status, on ? 422 : (this.aiK === 'kill' ? 503 : 403), 'ai_penalty_with_pay_field_refused', pen.text.slice(0, 160));
    const pen2 = await kcall(w, w.keys.ai_read, 'POST', '/api/v1/proposals', { op: 'penalty.propose', payload: { person_id: U.P.id, effect: 'points', amount: 5 }, reason: 'please cut his salary' });
    this.eq(pen2.status, on ? 422 : (this.aiK === 'kill' ? 503 : 403), 'ai_penalty_that_mentions_pay_refused', pen2.text.slice(0, 160));
    const xt = await kcall(w, w.keys.ai_read, 'POST', '/api/v1/proposals', { op: 'reward.award', payload: { person_id: w.B.person.id, amount: 5 }, reason: 'cross' });
    this.eq(xt.status, on ? 404 : (this.aiK === 'kill' ? 503 : 403), 'ai_proposal_cannot_name_other_company_person', xt.text.slice(0, 160));
    const s3 = await snap(); this.eq(JSON.stringify(s3), JSON.stringify(s0), 'ai_probes_changed_no_money_or_rules');
  }
  async displayProbes() {
    const { w, U } = this;
    const bad = [];
    const scan = (what, x) => { for (const m of x.text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) { const s = m[1]; if (/\bMP\b/.test(s)) bad.push(`${what}: MP in "${s.slice(0, 40)}"`); if (/(^|[^S])\$\d?/.test(s)) bad.push(`${what}: bare $ in "${s.slice(0, 40)}"`); } };
    const bal = await http(w, U.P, 'GET', '/api/me/balance'); scan('balance', bal);
    this.eq(bal.status, 200, 'balance_readable', bal.text.slice(0, 120));
    this.eq(bal.json?.unit, 'Moneypenny', 'currency_is_shown_as_Moneypenny'); this.eq(bal.json?.symbol, 'moneypenny', 'currency_symbol_word');
    const lost = this.srv.debited.filter((d) => d.acct === this.acct('P')).reduce((t, d) => t + d.amount, 0); // opt-in earned-credit loss (debit reason penalty) is checked in penalties()
    this.eq(bal.json?.credits, (this.model.bal.get('P') ?? 0) - lost, 'balance_asked_from_provider_matches_model');
    const cfg = await http(w, U.P, 'GET', '/api/config'); scan('config', cfg); this.eq(cfg.json?.unit_name, 'Moneypenny', 'config_unit_name');
    const me = await http(w, U.P, 'GET', '/api/me'); scan('me', me); this.eq(me.json?.company?.unit_name, 'Moneypenny', 'me_unit_name');
    const rw = await http(w, U.P, 'GET', '/api/me/rewards'); scan('rewards', rw);
    this.ok(rw.json?.rewards?.every((x) => x.unit === 'Moneypenny'), 'every_reward_shows_Moneypenny');
    this.ok(bad.length === 0, 'display_never_MP_never_bare_dollar', bad.slice(0, 3).join(' ; '));
    this.ok(w.ui.length === 0, 'ui_files_never_MP_never_bare_dollar', w.ui.slice(0, 3).join(' ; '));
  }
  async cleanup() {
    const { w } = this;
    await w.db.run('DELETE FROM tier WHERE target_id = ?', this.targetId); await w.db.run('DELETE FROM streak WHERE target_id = ?', this.targetId);
    await w.db.run('DELETE FROM period_target WHERE id = ?', this.targetId); await w.db.run('DELETE FROM team WHERE id = ?', this.teamId);
    await w.db.run('DELETE FROM reward WHERE season_id = ?', this.seasonId); await w.db.run('DELETE FROM ai_request WHERE company_id = ?', w.company.id);
    if (this.ruleId) await w.db.run('UPDATE penalty_rule SET active = 0 WHERE id = ?', this.ruleId);
    w.holder.provs.delete(w.company.id);
  }

  async play() {
    const { r, model } = this, type = this.type, tag = this.tag;
    const cards = CARDSETS[this.base].filter((c) => c[1] <= CARDSETS[this.base].find((x) => x[0] === this.stage)[1]);
    this.cards = cards; this.stages = cards.map((c) => c[0]);
    const mult = r.pick([1, 2]), nPros = r.int(1, 3);
    const members = this.tgt === 'team' ? ['P', 'Q', 'R'] : ['P'];
    const prosPerson = Array.from({ length: nPros }, () => (this.tgt === 'team' ? r.pick(members) : 'P'));
    const rateFrom = this.rateK === 'future' ? this.now0 + 3 * DAY : this.B0 - 30 * DAY;
    for (const [st, no, credits, need, mode] of cards) {
      const cr = credits * mult;
      const capMonth = this.capK === 'none' ? 0 : this.capK === 'below' ? cr + Math.floor(cr / 2) : this.capK === 'equal' ? cr * nPros : cr * (nPros + 3);
      model.cards.set(`${type}|${st}`, { stageNo: no, credits: cr, capMonth, state: need, mode, activeFrom: rateFrom });
    }
    const t1 = r.int(1, 2), b1 = r.pick([50, 100, 200]);
    model.targets.push({ id: 'T1', scope: this.tgt === 'team' ? 'team' : 'person', kind: this.kind, type, stage: this.stage, activeFrom: this.B0 - 500 * DAY, tiers: [{ count: t1, bonus: b1 }, { count: t1 + r.int(1, 2), bonus: b1 * 2 }] });
    if (this.penK !== 'none') model.pen = { effect: this.penK, amount: r.int(1, 3) };
    const errCode0 = r.pick(this.adapter ? ['account_closed'] : ['account_closed', 'insufficient_budget']);
    const heavyReplay = this.fault === 'replay' || r.chance(0.35);
    const mkAt = () => (this.occ === 'backdated' ? this.now0 - 10 * DAY - r.int(0, 5) * HOUR : this.B0 + r.pick(OFFS));
    this.items = [];
    for (let j = 0; j < nPros; j++) { const at = mkAt(); for (const st of this.stages) this.items.push({ key: `${tag}-${j}-${st}`, person: prosPerson[j], type, stage: st, ext: `${tag}-p${j}`, at, dedupe: st === this.stages[0] ? `${tag}-d${j}` : undefined, no: cards.find((c) => c[0] === st)[1] }); }
    if (this.fault === 'out_of_order') { this.items.reverse(); for (let i = this.items.length - 1; i > 0; i--) { const k = r.int(0, i); [this.items[i], this.items[k]] = [this.items[k], this.items[i]]; } }
    this.itemsByKey = new Map(this.items.map((i) => [i.key, i]));

    if (this.real) await this.setup();
    const role = this.role;
    const submitterOf = (it) => (role === 'employee' ? it.person : role === 'manager' ? 'M' : role === 'hr' ? 'H' : role === 'admin' ? 'A' : 'S');

    if (this.rateK === 'future') { // a card that starts later pays nothing before its start
      const it = { key: `${tag}-pre`, person: 'P', type, stage: this.stages[0], ext: `${tag}-pre`, at: this.now0 - 1000, dedupe: `${tag}-pre-d`, no: 1 };
      await this.submit(it, role === 'ai' ? 'A' : submitterOf(it), 'no_rate_card');
      this.setClock(this.now0 + 4 * DAY);
      for (const it2 of this.items) it2.at += 4 * DAY;
    }
    const fp = this.fault === 'timeout' ? ['down', Infinity] : this.fault === 'error' ? ['reject:' + errCode0, 2] : this.fault === 'dup_delivery' ? ['lost', 2] : null;
    if (fp && this.real) { model.setFault(...fp); this.srv.setFault(...fp); }

    for (const it of this.items) {
      const needSys = model.cards.get(`${type}|${it.stage}`).state === 'system';
      if (role === 'ai') { if (!needSys) await this.humanSubmitViaAi(it); else { await this.humanSubmitViaAi(it); await this.submit({ ...it }, 'S'); } continue; }
      if (needSys && role !== 'system') await this.submit({ ...it, key: it.key + '-x', ext: it.ext + '-x', dedupe: undefined }, submitterOf(it), 'needs_system_source');
      await this.submit(it, needSys ? 'S' : submitterOf(it));
    }
    if (this.fault !== 'none') await this.reconcile('after_submit');
    await this.probes();
    await this.approvals();
    await this.reconcile('after_approvals');
    await this.replays(heavyReplay);
    await this.recover();
    if (this.budgetK === 'exhausted' && r.chance(0.6)) await this.raise();
    let last = 0;
    for (const e of this.model.events.values()) if (e.status === 'applied') last = Math.max(last, periodMine(this.kind, e.at).end);
    if (last > 0) this.setClock(Math.max(this.now, last + LATE + HOUR));
    await this.settle(); await this.settle();
    await this.penalties();
    if (this.real) {
      if (this.aiProbe) await this.aiProbes();
      if (this.tenantProbe) await this.tenantProbes();
      if (this.uiProbe) await this.displayProbes();
      await this.invariants();
      await this.cleanup();
    }
    return { total: this.model.funded() };
  }
}
void MIN;

// ---------------------------------------------------------------- entry point
export async function runCase(w, idx, seed) {
  const cell = CELLS[idx % CELLS.length];
  const c = new Case();
  w.n++; const Y = slotYear(w.n);
  try {
    const dry = new Run({ w, idx, seed, Y, real: false, budget: Infinity, c });
    const { total } = await dry.play();
    const budgetK = cell.split('|')[4];
    const budget = budgetK === 'ample' ? Math.max(1_000_000, total * 3) : budgetK === 'exact' ? total : Math.floor(total / 2);
    const run = new Run({ w, idx, seed, Y, real: true, budget, c });
    run.dryTotal = total;
    c.note(['cell', cell, run.date, run.capK, run.rateK, run.penK, run.occ, run.aiK, 'budget', budget, 'total', total]);
    await run.play();
  } catch (e) {
    c.ok(false, 'exception', `${e?.message ?? e} @ ${String(e?.stack ?? '').split('\n').slice(1, 3).join(' | ').slice(0, 300)}`);
    try { await w.db.run('DELETE FROM ai_request WHERE company_id = ?', w.company.id); w.holder.provs.delete(w.company.id); } catch { /* best effort */ }
  }
  return { cell, c };
}
