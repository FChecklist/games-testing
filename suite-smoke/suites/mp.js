// Model-based property suite for the REAL Moneypenny code (in-process, real signing, real SQLite, injectable clock).
// One case = one account walking one cell of: currency x payment state x bucket mix x injected fault.
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { imp } from '../lib/roots.js';

const H = await imp('moneypenny/test/helpers.js');
const L = await imp('moneypenny/src/ledger.js');
const FX = await imp('moneypenny/src/fx.js');
const { DAY, MIN, HOUR } = H;

export const CUR = ['INR', 'USD'];
export const STATE = ['paid', 'shortfall', 'zero_balance', 'bonus_only', 'pending_hold', 'failed', 'refund', 'cancel'];
export const MIX = ['bought', 'bought+bonus', 'bought+commission', 'all3'];
export const FAULT = ['none', 'dup_replay', 'dup_webhook', 'out_of_order', 'expiry', 'fx_rotate', 'scope', 'tenant', 'rail_down', 'ai_ask'];
export const CELLS = cross(CUR, STATE, MIX, FAULT).map((c) => c.join('|'));

import { fastClient, cachePrepare } from '../lib/mpfast.js';

export async function newWorld({ fast = true } = {}) {
  const s = await H.setup({ other: true });
  cachePrepare(s.db);
  if (fast) {
    const mkF = (t) => { const f = (k, sc) => fastClient(s.app, s.clock, { ...k, tenant_id: t.tenant_id }, sc); const c = f(t.api, 'api'); c.pay = f(t.purchase, 'purchase'); c.read = f(t.read, 'read'); c.admin = f(t.admin, 'admin'); c.ai = f(t.ai_read, 'ai_read'); return c; };
    s.mkT = mkF; const a = mkF(s.demo); s.api = a; s.pay = a.pay; s.read = a.read; s.admin = a.admin; s.ai = a.ai;
  }
  await s.admin.put('/v1/admin/catalogue', { product: 'game', item: 'p100', credits: 3400 });
  await s.admin.put('/v1/admin/catalogue', { product: 'game', item: 'small', credits: 500 });
  return { s, n: 0, fast };
}

const OK = (st) => st >= 200 && st < 300;

export async function runCase(w, idx, seed) {
  const { s } = w;
  const r = rng(seed, idx);
  const cell = CELLS[idx % CELLS.length];
  const [cur, state, mix, fault] = cell.split('|');
  const c = new Case();
  const tag = `${seed}-${idx}`;
  const email = `u${idx}x${w.n++}@corp.example`;
  const idem2 = `${idx}x${w.n}`;
  const payer = `p${idx}x${w.n}@buyer.example`;
  s.clock.t += 25 * HOUR; // fresh velocity window per case
  { const v = Math.min(115, Math.max(60, (w.rate ?? 70) * (1 + (r.next() - 0.5) * 0.06))); w.rate = v; await FX.refreshRates(s.db, { name: 'sim', async fetch() { return { rates: { INR: v } }; } }, Math.floor(s.clock.t / DAY) * DAY + 5000); } // the 00:00 UTC refresh
  const api = s.api, pay = s.pay;
  const T = async (cl, m, p, b, o) => { const x = await cl.raw(m, p, b, o); c.note([m, p, b === undefined ? null : b, x.status, x.body?.error?.code ?? (x.body?.ok === false ? 'err' : 'ok')]); return x; };
  const GET = (cl, p) => T(cl, 'GET', p);
  const POST = (cl, p, b, o) => T(cl, 'POST', p, b, o);
  const bal = async (e = email, cl = api) => { const x = await GET(cl, `/v1/balance?email=${encodeURIComponent(e)}&details=1`); c.eq(x.status, 200, 'balance_readable'); return x.body; };

  // independent oracle (does not read the code under test): expected totals per bucket
  const exp = { bought: 0, bonus: 0, commission: 0 };
  const resync = async () => { const b = await bal(); exp.bought = b.buckets.bought; exp.bonus = b.buckets.bonus; exp.commission = b.buckets.commission; };
  const invariants = async (when) => {
    const b = await bal();
    const sum = b.buckets.bought + b.buckets.bonus + b.buckets.commission;
    c.eq(sum, b.balance, 'buckets_sum_equals_balance', when);
    c.ok(b.buckets.bought >= 0 && b.buckets.bonus >= 0 && b.buckets.commission >= 0 && b.balance >= 0, 'balance_never_negative', when);
    c.eq(b.buckets.bought, exp.bought, 'oracle_bought', when);
    c.eq(b.buckets.bonus, exp.bonus, 'oracle_bonus', when);
    c.eq(b.buckets.commission, exp.commission, 'oracle_commission', when);
    const t = b.display?.text ?? '';
    c.ok(/^[\d,]+ Moneypenny = US\$\d+\.\d\d$/.test(t), 'display_exact_text', t);
    c.ok(!/\bMP\b|\bMC\b/.test(JSON.stringify(b.display)) && !/(^|[^S])\$\d/.test(t), 'display_no_mp_or_bare_dollar', t);
    c.eq(b.display?.unit, 'moneypenny', 'display_unit', when);
    return b;
  };

  const acquire = async (credits, label) => {
    const q = (await GET(api, `/v1/quote?credits=${credits}`)).body;
    const paid = cur === 'INR' ? q.inr_minor : q.usd_minor;
    if (cur === 'USD') c.eq(paid, credits, 'usd_price_exact', label);
    else c.ok(paid >= Math.ceil((credits * q.inr_paise_per_usd) / 100) && paid % 100 === 0, 'inr_price_covers_rounded_up', { paid, q });
    const ref = `pay_${tag}_${label}`;
    const viaOrder = r.chance(0.5) || fault === 'dup_webhook' || fault === 'rail_down';
    if (viaOrder) {
      const o = await POST(api, '/v1/buy_credits', { email, credits, order_ref: `ord_${tag}_${label}`, currency: cur });
      if (!c.eq(o.status, 200, 'buy_credits_ok', o.body)) return null;
      c.eq(o.body.amount_minor, paid, 'order_amount_equals_quote');
      const cf = await POST(pay, '/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: ref, paid_minor: paid, currency: cur });
      if (!c.eq(cf.status, 200, 'rail_confirm_ok', cf.body)) return null;
      c.eq(cf.body.credited, credits, 'rail_confirm_credits');
      exp.bought += credits;
      if (fault === 'dup_webhook' || fault === 'dup_replay') {
        const again = await POST(pay, '/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: ref, paid_minor: paid, currency: cur });
        c.ok(OK(again.status) && again.body.already === true, 'duplicate_confirm_is_noop', again.body);
        const other = await POST(pay, '/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: ref + '_b', paid_minor: paid, currency: cur });
        c.eq(other.status, 409, 'second_payment_for_paid_order_refused', other.body);
        const again2 = await POST(api, '/v1/buy_credits', { email, credits, order_ref: `ord_${tag}_${label}`, currency: cur });
        c.eq(again2.body?.order_id, o.body.order_id, 'same_order_ref_same_order');
      }
    } else {
      await POST(pay, '/v1/payment_notice', { payment_ref: ref, paid_minor: paid, currency: cur, payer_email: email });
      const cp = await POST(pay, '/v1/credit_purchase', { email, amount: credits, paid_minor: paid, currency: cur, payment_ref: ref });
      if (!c.eq(cp.status, 200, 'credit_purchase_ok', cp.body)) return null;
      exp.bought += credits;
      if (fault === 'dup_replay' || fault === 'dup_webhook') {
        const again = await POST(pay, '/v1/credit_purchase', { email, amount: credits, paid_minor: paid, currency: cur, payment_ref: ref });
        c.ok(OK(again.status) || again.status === 409, 'duplicate_purchase_answer', again.body);
        const other = await POST(pay, '/v1/credit_purchase', { email, amount: credits, paid_minor: paid, currency: cur, payment_ref: ref }, { idem: `other-${tag}-${label}` });
        c.eq(other.status, 409, 'same_payment_new_key_refused', other.body);
      }
      const over = await POST(pay, '/v1/credit_purchase', { email, amount: credits + 5000, paid_minor: paid, currency: cur, payment_ref: ref + '_over' });
      c.ok(over.status >= 400, 'credit_exceeding_payment_refused', over.body);
    }
    return { ref, paid };
  };

  const bonusEvent = async () => {
    const e = await POST(api, '/v1/event', { email, event_type: 'account_created', event_key: `ev_${tag}_acct` });
    c.eq(e.status, 200, 'event_ok', e.body);
    if (e.body.granted > 0) { c.ok(e.body.granted <= 100, 'bonus_not_above_rule', e.body); exp.bonus += e.body.granted; }
    const dup = await POST(api, '/v1/event', { email, event_type: 'account_created', event_key: `ev_${tag}_acct` });
    c.ok(dup.body.duplicate === true && dup.body.granted === e.body.granted, 'event_key_replay_pays_once', dup.body);
    const again = await POST(api, '/v1/event', { email, event_type: 'account_created', event_key: `ev_${tag}_acct2` });
    c.eq(again.body.granted, 0, 'once_rule_pays_once', again.body);
    const visit = await POST(api, '/v1/event', { email, event_type: 'page_view', event_key: `ev_${tag}_pv` });
    c.eq(visit.body.granted, 0, 'visits_earn_nothing', visit.body);
  };
  const commissionEvent = async (cash) => {
    const sref = `sale_${tag}`;
    const body = { email, event_type: 'referral_sale_paid', event_key: `ev_${tag}_sale`, payer_email: payer, cash_minor: cash, currency: 'USD', sale_ref: sref };
    if (fault === 'out_of_order') {
      const early = await POST(api, '/v1/event', body);
      c.ok(early.body.granted === 0 && early.body.reason === 'payment_not_verified', 'commission_needs_verified_payment', early.body);
    }
    await POST(pay, '/v1/payment_notice', { payment_ref: sref, paid_minor: cash, currency: 'USD', payer_email: payer });
    const e = await POST(api, '/v1/event', body);
    c.eq(e.status, 200, 'event_ok', e.body);
    if (e.body.granted > 0) {
      c.eq(e.body.granted, Math.floor((cash * 1000) / 10000), 'commission_is_10pct_of_cash', e.body);
      exp.commission += e.body.granted;
    } else c.ok(['amount_zero', 'over_event_limit', 'daily_cap_reached'].includes(e.body.reason), 'commission_refusal_known_reason', e.body);
    const same = await POST(api, '/v1/event', { ...body, event_key: `ev_${tag}_sale2` });
    c.eq(same.body.granted, 0, 'one_sale_pays_commission_once', same.body);
    const me = await POST(api, '/v1/event', { ...body, email: payer, event_key: `ev_${tag}_self`, sale_ref: sref + 'x' });
    c.eq(me.body.granted, 0, 'self_referral_pays_nothing', me.body);
  };

  const reserveItem = (item, ord, extra = {}) => POST(api, '/v1/spend/reserve_item', { email, product: 'game', item, order_ref: ord, ...extra });
  const buyN = r.pick([100, 500, 1000, 3400, 3400, 5000, 12000]);
  try {
    if (mix === 'bought+bonus' || mix === 'all3') await bonusEvent();
    if (state !== 'zero_balance' && state !== 'bonus_only' && state !== 'failed') await acquire(buyN, 'a');
    if (mix === 'bought+commission' || mix === 'all3') await commissionEvent(r.pick([5000, 20000, 90000]));
    await invariants('after_prelude');
    if (exp.commission > 0) { const b0 = await bal(); c.eq(b0.settling, exp.commission, 'commission_settling_until_hold_ends', b0); }

    switch (state) {
      case 'paid': {
        const b = await bal();
        if (b.buckets.bought >= 500) {
          const h = await reserveItem('small', `o_${tag}`);
          if (c.eq(h.status, 200, 'reserve_paid_ok', h.body)) {
            c.eq(h.body.credits, 500, 'reserve_price_from_catalogue');
            if (fault === 'dup_replay') {
              const dup = await reserveItem('small', `o_${tag}`);
              c.eq(dup.status, 409, 'second_hold_same_order_refused', dup.body);
            }
            const cap = await POST(api, '/v1/spend/capture', { hold_id: h.body.hold_id });
            c.eq(cap.status, 200, 'capture_ok', cap.body);
            const cap2 = await POST(api, '/v1/spend/capture', { hold_id: h.body.hold_id });
            c.eq(cap2.status, 409, 'double_capture_refused', cap2.body);
            const nb = await bal();
            c.eq(b.balance - nb.balance, 500, 'capture_takes_exactly_price', { b: b.balance, n: nb.balance });
            c.ok(nb.buckets.commission === b.buckets.commission, 'settling_commission_untouched');
            await resync();
          }
        }
        break;
      }
      case 'shortfall': {
        const big = await reserveItem('p100', `o_${tag}_big`);
        if (big.status === 402) {
          c.eq(big.body.error.code, 'insufficient_credits', 'shortfall_code');
          c.eq(big.body.error.short_by, 3400 - big.body.error.usable_credits, 'short_by_consistent', big.body.error);
          c.ok(big.body.error.usable_credits <= (await bal()).balance, 'usable_never_above_balance', big.body.error);
          await invariants('after_402_unchanged');
        } else if (big.status === 200) { await POST(api, '/v1/spend/release', { hold_id: big.body.hold_id }); await resync(); }
        else c.ok(false, 'shortfall_unexpected_status', big.body);
        const q = (await GET(api, '/v1/quote?credits=2500')).body;
        const orderMinor = cur === 'INR' ? q.inr_minor : q.usd_minor;
        const hr = await POST(api, '/v1/spend/reserve', { email, order_ref: `c_${tag}`, amount_minor: orderMinor, currency: cur });
        if (c.eq(hr.status, 200, 'reserve_cash_ok', hr.body)) {
          c.eq(hr.body.credit_value_minor + hr.body.cash_due_minor, orderMinor, 'credit_plus_cash_equals_order', hr.body);
          if (hr.body.hold_id && hr.body.cash_due_minor > 0) {
            const under = await POST(api, '/v1/spend/capture', { hold_id: hr.body.hold_id, payment_ref: `cash_${tag}`, cash_paid_minor: hr.body.cash_due_minor - 1 });
            c.eq(under.status, 422, 'underpaid_capture_refused', under.body);
            const unv = await POST(api, '/v1/spend/capture', { hold_id: hr.body.hold_id, payment_ref: `cash_${tag}`, cash_paid_minor: hr.body.cash_due_minor });
            c.eq(unv.status, 402, 'unverified_cash_refused', unv.body);
            await POST(pay, '/v1/payment_notice', { payment_ref: `cash_${tag}`, paid_minor: hr.body.cash_due_minor, currency: cur, payer_email: email });
            const ok = await POST(api, '/v1/spend/capture', { hold_id: hr.body.hold_id, payment_ref: `cash_${tag}`, cash_paid_minor: hr.body.cash_due_minor });
            c.eq(ok.status, 200, 'verified_cash_capture_ok', ok.body);
            const reuse = await POST(api, '/v1/spend/reserve', { email, order_ref: `c2_${tag}`, amount_minor: 5000, currency: cur });
            if (reuse.body.hold_id && reuse.body.cash_due_minor > 0) {
              const dp = await POST(api, '/v1/spend/capture', { hold_id: reuse.body.hold_id, payment_ref: `cash_${tag}`, cash_paid_minor: reuse.body.cash_due_minor });
              c.ok(dp.status >= 400, 'payment_cannot_pay_two_orders', dp.body);
              await POST(api, '/v1/spend/release', { hold_id: reuse.body.hold_id });
            }
          } else if (hr.body.hold_id) await POST(api, '/v1/spend/release', { hold_id: hr.body.hold_id });
          await resync();
        }
        break;
      }
      case 'zero_balance': {
        const h = await reserveItem('small', `o_${tag}`);
        c.eq(h.status, 402, 'zero_balance_402', h.body);
        c.eq(h.body.error?.usable_credits, 0, 'zero_usable', h.body);
        const cash = await POST(api, '/v1/spend/reserve', { email, order_ref: `c_${tag}`, amount_minor: 10000, currency: cur });
        c.ok(cash.body.hold_id === null && cash.body.cash_due_minor === 10000, 'zero_balance_all_cash', cash.body);
        break;
      }
      case 'bonus_only': {
        if (mix === 'bought' || mix === 'bought+commission') await bonusEvent();
        const b = await bal();
        c.eq(b.buckets.bought, 0, 'no_bought_in_bonus_only');
        const h = await reserveItem('small', `o_${tag}`);
        c.eq(h.status, 402, 'bonus_alone_cannot_pay', h.body);
        c.eq(h.body.error?.usable_credits, 0, 'bonus_unusable_without_paid_value', h.body);
        const cashB = await POST(api, '/v1/spend/reserve', { email, order_ref: `cb_${tag}`, amount_minor: 10000, currency: cur });
        c.ok(cashB.status === 200 && cashB.body.hold_id === null && cashB.body.credit_applied === 0, 'bonus_alone_cannot_pay_cash_order', cashB.body);
        await invariants('bonus_only_after');
        await acquire(1000, 'unlock');
        const h2 = await reserveItem('small', `o2_${tag}`);
        if (h2.status === 200) {
          const nb = await bal();
          c.ok(exp.bonus - nb.buckets.bonus <= 250, 'bonus_capped_at_half_order', { used: exp.bonus - nb.buckets.bonus });
          await POST(api, '/v1/spend/release', { hold_id: h2.body.hold_id });
        }
        await resync();
        break;
      }
      case 'pending_hold': {
        const b = await bal();
        if (b.buckets.bought >= 500) {
          const h = await reserveItem('small', `o_${tag}`);
          if (c.eq(h.status, 200, 'pending_reserve_ok', h.body)) {
            const mid = await bal();
            c.eq(b.balance - mid.balance, 500, 'held_credits_leave_balance', { before: b.balance, mid: mid.balance });
            s.clock.t += 22 * MIN;
            const cap = await POST(api, '/v1/spend/capture', { hold_id: h.body.hold_id });
            c.eq(cap.status, 410, 'expired_hold_cannot_capture', cap.body);
            await POST(s.admin, '/v1/admin/sweep', {});
            const after = await bal();
            c.eq(after.balance, b.balance, 'sweep_restores_unpaid_hold', { b: b.balance, a: after.balance });
          }
        }
        break;
      }
      case 'failed': {
        const o = await POST(api, '/v1/buy_credits', { email, credits: 1000, order_ref: `ord_${tag}_f`, currency: cur });
        c.eq(o.status, 200, 'order_created', o.body);
        const need = o.body.amount_minor;
        const wrongCur = await POST(pay, '/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: `bad_${tag}`, paid_minor: need, currency: cur === 'INR' ? 'USD' : 'INR' });
        c.eq(wrongCur.status, 422, 'wrong_currency_refused', wrongCur.body);
        const less = await POST(pay, '/v1/rail/confirm', { order_id: o.body.order_id, payment_ref: `bad2_${tag}`, paid_minor: need - 1, currency: cur });
        c.eq(less.status, 422, 'short_payment_refused', less.body);
        await invariants('failed_nothing_credited');
        s.clock.t += 3 * HOUR; await POST(s.admin, '/v1/admin/sweep', {});
        await invariants('failed_after_sweep');
        break;
      }
      case 'refund': {
        const b = await bal();
        if (b.buckets.bought >= 500) {
          const h = await reserveItem('small', `o_${tag}`);
          if (h.status === 200) {
            await POST(api, '/v1/spend/capture', { hold_id: h.body.hold_id });
            const rf = await POST(api, '/v1/refund', { type: 'order', hold_id: h.body.hold_id, credits: 200 });
            c.eq(rf.status, 200, 'partial_order_refund_ok', rf.body);
            const rf2 = await POST(api, '/v1/refund', { type: 'order', hold_id: h.body.hold_id, credits: 301 });
            c.eq(rf2.status, 409, 'cannot_refund_more_than_spent', rf2.body);
            const rf3 = await POST(api, '/v1/refund', { type: 'order', hold_id: h.body.hold_id });
            c.eq(rf3.body.returned_credits, 300, 'refund_rest', rf3.body);
            const rf4 = await POST(api, '/v1/refund', { type: 'order', hold_id: h.body.hold_id });
            c.eq(rf4.status, 409, 'no_double_refund', rf4.body);
            const wrongKey = await POST(api, '/v1/refund', { type: 'purchase', payment_ref: `pay_${tag}_a` });
            c.eq(wrongKey.status, 403, 'product_key_cannot_refund_money', wrongKey.body);
            const nb = await bal();
            c.eq(nb.balance, b.balance, 'refunded_order_restores_balance', { b: b.balance, n: nb.balance });
            await resync();
          }
        }
        const pr = await POST(pay, '/v1/refund', { type: 'purchase', payment_ref: `pay_${tag}_a`, credits: 100 });
        if (pr.status === 200) { c.ok(pr.body.money_due_minor > 0, 'money_refund_positive', pr.body); await resync(); }
        if (r.chance(0.5)) {
          const cb = await POST(pay, '/v1/refund', { type: 'chargeback', payment_ref: `pay_${tag}_a` });
          if (cb.status === 200) {
            const cb2 = await POST(pay, '/v1/refund', { type: 'chargeback', payment_ref: `pay_${tag}_a` });
            c.ok(cb2.body.already === true, 'chargeback_idempotent', cb2.body);
            const re = await POST(pay, '/v1/credit_purchase', { email, amount: 100, paid_minor: cur === 'USD' ? 100 : 100000, currency: cur, payment_ref: `pay_${tag}_a` });
            c.ok(re.status >= 400, 'reversed_payment_cannot_be_reused', re.body);
            await resync();
          }
        }
        break;
      }
      case 'cancel': {
        const b = await bal();
        if (b.buckets.bought >= 500) {
          const h = await reserveItem('small', `o_${tag}`);
          if (h.status === 200) {
            const rel = await POST(api, '/v1/spend/release', { hold_id: h.body.hold_id });
            c.eq(rel.body.status, 'released', 'release_ok');
            const rel2 = await POST(api, '/v1/spend/release', { hold_id: h.body.hold_id }, { idem: 'again-' + tag });
            c.eq(rel2.body.status, 'released', 'release_twice_safe');
            const cap = await POST(api, '/v1/spend/capture', { hold_id: h.body.hold_id });
            c.eq(cap.status, 409, 'capture_after_release_refused', cap.body);
            c.eq((await bal()).balance, b.balance, 'cancel_restores_everything');
          }
        }
        break;
      }
    }

    if (fault === 'scope') {
      if (w.fast) { /* signing, nonce, idempotency conflict are checked in the signed tier */ }
      const b0 = (await bal()).balance;
      c.eq((await POST(s.read, '/v1/spend/reserve_item', { email, product: 'game', item: 'small', order_ref: `rk_${tag}` })).status, 403, 'read_key_cannot_spend');
      c.eq((await POST(api, '/v1/credit_purchase', { email, amount: 100, paid_minor: 100, currency: 'USD', payment_ref: `sc_${tag}` })).status, 403, 'product_key_cannot_credit_purchase');
      c.eq((await POST(pay, '/v1/event', { email, event_type: 'account_created', event_key: `sce_${tag}` })).status, 403, 'payment_key_cannot_grant_events');
      c.eq((await T(api, 'PUT', '/v1/admin/settings', { buy_max_credits: 1 })).status, 403, 'product_key_cannot_change_settings');
      if (!w.fast) {
        c.eq((await T(api, 'GET', `/v1/balance?email=${email}`, undefined, { sign: false })).status, 401, 'bad_signature_refused');
        c.eq((await T(api, 'GET', `/v1/balance?email=${email}`, undefined, { ts: s.clock.t - 10 * MIN })).status, 401, 'stale_timestamp_refused');
        const nonce = 'nn-' + tag; await T(api, 'GET', `/v1/balance?email=${email}`, undefined, { nonce });
        c.eq((await T(api, 'GET', `/v1/balance?email=${email}`, undefined, { nonce })).status, 401, 'nonce_replay_refused');
        const badIdem = await T(api, 'POST', '/v1/event', { email, event_type: 'account_created', event_key: `x${tag}` }, { idem: 'x'.repeat(121) });
        c.ok(badIdem.status >= 400, 'oversize_idempotency_key_refused', badIdem.body);
        await T(api, 'POST', '/v1/event', { email, event_type: 'nothing', event_key: `ik${tag}` }, { idem: 'ik-' + tag });
        const diff = await T(api, 'POST', '/v1/event', { email, event_type: 'other', event_key: `ik2${tag}` }, { idem: 'ik-' + tag });
        c.eq(diff.status, 409, 'same_idem_key_different_request_conflict', diff.body);
        const rp = await T(api, 'POST', '/v1/event', { email, event_type: 'nothing', event_key: `ik${tag}` }, { idem: 'ik-' + tag });
        c.eq(rp.headers.get('idempotent-replay'), 'true', 'idempotent_replay_header');
      }
      c.eq((await bal()).balance, b0, 'scope_attacks_change_nothing');
    }
    if (fault === 'tenant') {
      const ob = s.mkT(s.other);
      const own = await bal();
      const ov = await GET(ob, `/v1/balance?email=${encodeURIComponent(email)}`);
      c.eq(ov.body.balance, 0, 'tenant_isolation_balance', ov.body);
      const h = await POST(ob, '/v1/spend/reserve_item', { email, product: 'game', item: 'small', order_ref: `x_${tag}` });
      c.ok(h.status >= 400, 'other_tenant_cannot_spend_my_credits', h.body);
      const hist = await GET(ob, `/v1/history?email=${encodeURIComponent(email)}`);
      c.eq((hist.body.entries ?? []).length, 0, 'tenant_isolation_history');
      c.ok((await POST(ob, '/v1/spend/capture', { hold_id: 'hold_x' })).status >= 400, 'other_tenant_cannot_use_hold');
      c.eq((await bal()).balance, own.balance, 'tenant_probe_changes_nothing');
    }
    if (fault === 'expiry') {
      s.clock.t += 8 * DAY;
      c.eq((await bal()).settling, 0, 'commission_released_after_hold');
      s.clock.t += 400 * DAY;
      await POST(s.admin, '/v1/admin/sweep', {});
      const b3 = await bal();
      c.eq(b3.buckets.bought, 0, 'bought_credits_end_after_365_days', b3.buckets);
      c.eq(b3.buckets.bonus, 0, 'bonus_ends_after_365_days', b3.buckets);
      c.eq(b3.buckets.commission, exp.commission, 'commission_never_expires', b3.buckets);
      exp.bought = 0; exp.bonus = 0;
    }
    if (fault === 'fx_rotate') {
      const email = `fx${idem2}@corp.example`;
      const rate = Math.min(115, Math.max(60, (w.rate ?? 70) * r.pick([0.92, 1, 1.08])));
      const src = (v) => ({ name: 'sim', async fetch() { return { rates: { INR: v } }; } });
      const dayEnd = Math.floor(s.clock.t / DAY) * DAY + DAY;
      s.clock.t = dayEnd - 20 * MIN;
      await FX.refreshRates(s.db, src(rate), dayEnd - 3 * HOUR);
      const q1 = (await GET(api, '/v1/quote?credits=3400')).body;
      const ord = await POST(api, '/v1/buy_credits', { email, credits: 3400, currency: 'INR', order_ref: `fx_${tag}` });
      if (c.eq(ord.status, 200, 'fx_order_ok', ord.body)) {
        c.eq(ord.body.amount_minor, q1.inr_minor, 'order_price_equals_quote');
        s.clock.t = dayEnd + 10 * MIN;
        const newRate = Math.min(125, rate * (1 + r.pick([-0.2, 0.08, 0.3])));
        w.rate = newRate;
        await FX.refreshRates(s.db, src(newRate), dayEnd + 1000);
        const done = await POST(pay, '/v1/rail/confirm', { order_id: ord.body.order_id, payment_ref: `fxp_${tag}`, paid_minor: ord.body.amount_minor, currency: 'INR' });
        c.eq(done.status, 200, 'fx_confirm_ok', done.body);
        c.eq(done.body.credited, 3400, 'rate_lock_respected_credits', done.body);
        c.ok(!done.body.repriced, 'not_repriced_inside_120min', done.body);
        const e2b = (await bal(email)).balance; c.eq(e2b, 3400, 'fx_locked_balance_exact', e2b);
        const ord2 = await POST(api, '/v1/buy_credits', { email, credits: 3400, currency: 'INR', order_ref: `fx2_${tag}` });
        s.clock.t += 121 * MIN;
        const late = await POST(pay, '/v1/rail/confirm', { order_id: ord2.body.order_id, payment_ref: `fxq_${tag}`, paid_minor: ord2.body.amount_minor, currency: 'INR' });
        if (c.eq(late.status, 200, 'late_confirm_ok', late.body)) {
          c.eq(late.body.repriced, true, 'lock_expired_reprices', late.body);
          const nowPaise = (await GET(api, '/v1/quote?credits=100')).body.inr_paise_per_usd;
          c.ok(late.body.credited <= Math.floor((ord2.body.amount_minor * 100) / nowPaise), 'repriced_never_over_value', { late: late.body, nowPaise });
          c.eq((await bal(email)).balance, 3400 + late.body.credited, 'fx_total_balance_exact');
        }
        const before = (await GET(api, '/v1/quote?credits=100')).body.inr_paise_per_usd;
        await FX.refreshRates(s.db, src(r.pick([0, -5, 'abc', 5, 9000])), dayEnd + DAY + 1000);
        s.clock.t = dayEnd + DAY + 2000;
        c.eq((await GET(api, '/v1/quote?credits=100')).body.inr_paise_per_usd, before, 'bad_fx_feed_keeps_last_good_rate');
      }
    }
    if (fault === 'rail_down') {
      const email = `rd${idem2}@corp.example`;
      let down = true; const rail0 = s.app.rail;
      s.app.rail = { name: 'flaky', async createOrder(o) { if (down) throw new Error('rail unavailable'); return { rail_order_id: 'R-' + o.order_id, pay_url: 'https://pay.invalid/' + o.order_id }; }, async health() { return { ok: !down }; } };
      const o = await POST(api, '/v1/buy_credits', { email, credits: 1000, currency: cur, order_ref: `rd_${tag}` });
      c.ok(o.status === 200 && o.body.status === 'pending_rail', 'order_waits_when_rail_down', o.body);
      for (let i = 0; i < 9; i++) { s.clock.t += 2 * HOUR; await POST(s.admin, '/v1/admin/rail/process', {}); }
      const dl = await GET(s.admin, '/v1/admin/dead_letters');
      c.ok((dl.body.dead_letters ?? []).length >= 1, 'dead_letter_after_retries', dl.body);
      down = false;
      for (const d of dl.body.dead_letters ?? []) await POST(s.admin, '/v1/admin/dead_letters/requeue', { id: d.id });
      await POST(s.admin, '/v1/admin/rail/process', {});
      const again = await POST(api, '/v1/buy_credits', { email, credits: 1000, currency: cur, order_ref: `rd_${tag}` });
      c.eq(again.body.order_id, o.body.order_id, 'same_order_after_recovery');
      c.ok(again.body.status !== 'paid', 'rail_recovery_never_credits_without_payment', again.body);
      s.app.rail = rail0;
      await invariants('rail_down_no_credit_without_payment');
    }
    if (fault === 'ai_ask') {
      const before = await bal();
      const ai = s.ai;
      const ask = await POST(ai, '/v1/ai/ask', { action: 'refund', params: { type: 'purchase', payment_ref: `pay_${tag}_a` } });
      c.ok(OK(ask.status), 'ai_ask_accepted', ask.body);
      c.ok(/pending/.test(JSON.stringify(ask.body)), 'ai_ask_is_pending_not_done', ask.body);
      c.eq((await POST(ai, '/v1/refund', { type: 'order', hold_id: 'x' })).status, 403, 'ai_key_cannot_refund_directly');
      c.eq((await POST(ai, '/v1/spend/reserve_item', { email, product: 'game', item: 'small', order_ref: `ai_${tag}` })).status, 403, 'ai_key_cannot_spend');
      c.eq((await POST(ai, '/v1/convert_request', { email, credits: 5000 })).status, 403, 'ai_key_cannot_convert');
      c.eq((await POST(ai, '/v1/refund', { type: 'chargeback', payment_ref: 'x' })).status, 403, 'ai_key_cannot_chargeback');
      c.eq((await POST(ai, '/v1/credit_purchase', { email, amount: 100, paid_minor: 100, currency: 'USD', payment_ref: 'z' + tag })).status, 403, 'ai_key_cannot_credit');
      c.eq((await bal()).balance, before.balance, 'ai_ask_changes_no_balance');
      c.ok((await POST(ai, '/v1/ai/approvals/none/approve', {})).status >= 400, 'ai_key_cannot_approve_itself');
    }

    const mismatch = await L.verifyBalances(s.ctx());
    c.eq(mismatch.length, 0, 'ledger_balances_match_lots', mismatch.slice(0, 2));
    const hist = await GET(api, `/v1/history?email=${encodeURIComponent(email)}&limit=100`);
    const seen = new Set();
    for (const e of (hist.body.entries ?? []).filter((e) => e.kind === 'purchase')) { c.ok(!seen.has(e.ext_ref), 'one_purchase_entry_per_payment', e.ext_ref); seen.add(e.ext_ref); }
    c.ok((await bal()).balance >= 0, 'final_balance_nonneg');
  } catch (e) {
    c.ok(false, 'harness_or_code_exception', `${e?.message ?? e}`.slice(0, 200));
  }
  return { cell, c };
}
