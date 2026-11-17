// Bulk money arithmetic, checked against an independent BigInt oracle (pure functions of the REAL Moneypenny code).
// Covers: credits<->money both ways, 5% margin only on buyer INR price, payout at the raw rate, TDS split, quote rounding.
import { rng, cross } from '../lib/rng.js';
import { Case } from '../lib/run.js';
import { imp } from '../lib/roots.js';
const SET = await imp('moneypenny/src/settings.js');
const GATE = await imp('moneypenny/src/gate.js');
const CONV = await imp('moneypenny/src/convert.js');

export const CELLS = cross(['INR', 'USD'], ['tds0', 'tds1000', 'tds500', 'tds2000'], ['cpu100', 'cpu50', 'cpu200'], ['small', 'mid', 'large', 'boundary'], ['margin0', 'margin500', 'margin1000']).map((c) => c.join('|'));
export function newWorld() { return {}; }

export async function runCase(w, idx, seed) {
  const cell = CELLS[idx % CELLS.length];
  const [cur, tds, cpuS, size, marg] = cell.split('|');
  const r = rng(seed, idx);
  const c = new Case();
  const cpu = +cpuS.slice(3), tdsBps = +tds.slice(3), margBps = +marg.slice(6);
  const rawRate = Math.round(r.int(6000, 11500) + r.next() * 100) / 100 * 100; // paise per US$ before margin (whole paise)
  const raw = Math.round(rawRate);
  const buyerPaise = Math.round((raw * (10000 + margBps)) / 10000);
  const s = { ...SET.DEFAULTS, credits_per_usd: cpu, inr_paise_per_usd: buyerPaise, inr_paise_raw: raw, fx_margin_bps: margBps, conversion_currency: cur, tds_rate_bps: tdsBps || null, currency_name: 'Moneypenny' };
  const hi = { small: 200, mid: 20_000, large: 2_000_000, boundary: 1 }[size];
  for (let i = 0; i < 8; i++) {
    const credits = size === 'boundary' ? [1, 99, 100, 101, 1499, 1500, 1501, 499999, 500000][r.int(0, 8)] : r.int(1, hi);
    const mpu = cur === 'INR' ? buyerPaise : 100;
    // oracle with BigInt
    const minorOr = (BigInt(credits) * BigInt(mpu) + BigInt(cpu) - 1n) / BigInt(cpu); // ceil
    c.eq(BigInt(SET.minorFromCredits(s, cur, credits)), minorOr, 'minor_from_credits_matches_oracle', { credits, mpu, cpu });
    const back = (BigInt(SET.minorFromCredits(s, cur, credits)) * BigInt(cpu)) / BigInt(mpu);
    c.ok(back >= BigInt(credits), 'buyer_money_always_covers_credits', { credits });
    const money = r.int(1, 90_000_000);
    c.eq(BigInt(SET.creditsFromMinor(s, cur, money)), (BigInt(money) * BigInt(cpu)) / BigInt(mpu), 'credits_from_minor_matches_oracle', { money, mpu, cpu });
    // price in whole rupees for INR, exact for USD
    const pm = GATE.priceMinor(s, cur, credits);
    c.ok(pm >= SET.minorFromCredits(s, cur, credits) && (cur === 'USD' ? pm === SET.minorFromCredits(s, cur, credits) : pm % 100 === 0 && pm - SET.minorFromCredits(s, cur, credits) < 100), 'price_rounding_up_to_rupee_only', { pm });
    // margin only ever raises the buyer's INR price
    if (cur === 'INR') c.ok(buyerPaise >= raw, 'margin_never_lowers_buyer_price', { raw, buyerPaise });
    // conversion
    const k = CONV.calculate(s, credits);
    const rawPaise = cur === 'INR' ? raw : 100;
    const gross = (BigInt(credits) * BigInt(rawPaise)) / BigInt(cpu);
    c.eq(BigInt(k.gross_minor), gross, 'conversion_gross_oracle', { credits });
    c.eq(k.gross_minor, k.net_minor + k.tds_minor + k.gst_minor, 'gross_equals_net_plus_tax');
    c.ok(k.net_minor >= 0 && k.tds_minor >= 0 && k.tds_minor <= k.gross_minor, 'tax_split_in_bounds', k);
    c.eq(BigInt(k.tds_minor), (gross * BigInt(tdsBps) + 9999n) / 10000n, 'tds_is_ceiling_of_rate', { credits });
    const k2 = CONV.calculate(s, credits + 1);
    c.ok(k2.gross_minor >= k.gross_minor, 'conversion_monotonic');
    // payouts use the raw rate, never the margin rate: payout can never exceed what the buyer-rate would give
    if (cur === 'INR') c.ok(k.gross_minor <= Math.floor((credits * buyerPaise) / cpu), 'payout_never_above_buyer_rate', { credits });
    // display
    const t = SET.creditsText(s, credits);
    c.ok(/^[\d,]+ Moneypenny = US\$\d+\.\d\d$/.test(t) && !/\bMP\b/.test(t), 'display_exact', t);
  }
  return { cell, c };
}
