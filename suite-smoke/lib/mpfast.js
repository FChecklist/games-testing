// FAST tier: calls the REAL Moneypenny route handlers (ROUTES from api.js) inside the real db.tx, with the same
// scope check, response shape and error mapping as the HTTP wrapper. It skips ONLY: HMAC signing, nonce, rate counters
// and the Idempotency-Key replay table. Those four are covered by the SIGNED tier (suite mp, mode 'signed').
import { imp } from './roots.js';
const A = await imp('moneypenny/src/api.js');
const U = await imp('moneypenny/src/util.js');
const S = await imp('moneypenny/src/settings.js');

// statement cache so the same SQL is not re-parsed 40 million times (harness-side only, product code untouched)
export function cachePrepare(db) {
  const raw = db.raw; const orig = raw.prepare.bind(raw); const m = new Map();
  raw.prepare = (sql) => { let st = m.get(sql); if (!st) { st = orig(sql); if (m.size < 2000) m.set(sql, st); } return st; };
}

export function fastClient(app, clock, keys, scope) {
  const db = app.db;
  async function raw(method, path, body, o = {}) {
    const url = new URL(`http://t.local${path}`);
    const route = A.ROUTES.find((r) => r[0] === method && r[1] === url.pathname);
    const mk = (status, obj) => ({ status, body: obj, headers: new Headers() });
    if (!route) return mk(404, { ok: false, error: { code: 'not_found' } });
    if (o.sign === false) return mk(401, { ok: false, error: { code: 'bad_signature' } });
    if (!route[2].includes(scope)) return mk(403, { ok: false, error: { code: 'wrong_key_type' } });
    try {
      const out = await db.tx(async (t) => {
        const ctx = { db: t, tenantId: keys.tenant_id ?? keys.tenantId, now: app.now, master: app.master, rail: app.rail, cache: app.cache, scope, actor: keys.key_id, keyId: keys.key_id, callerType: scope === 'ai_read' ? 'ai' : scope === 'purchase' ? 'payment' : scope === 'admin' ? 'human' : 'product', idem: null, _settings: null };
        const set = await S.getSettings(ctx);
        if (set.kill_switch && scope !== 'admin') throw new U.ApiError(503, 'paused', 'off');
        if (scope === 'ai_read' && !set.ai_enabled) throw new U.ApiError(403, 'ai_off', 'off');
        const result = await route[4](ctx, method === 'GET' ? {} : (body ?? {}), url.searchParams);
        if (scope === 'ai_read') result.untrusted = { fields: [] };
        return result;
      });
      return mk(200, { ok: true, ...out });
    } catch (e) {
      if (e instanceof U.ApiError) return mk(e.status, { ok: false, error: { code: e.code, message: e.message, ...e.extra } });
      return mk(500, { ok: false, error: { code: 'internal', message: String(e?.message ?? e) } });
    }
  }
  return { raw, get: (p, o) => raw('GET', p, undefined, o), post: (p, b, o) => raw('POST', p, b, o), put: (p, b, o) => raw('PUT', p, b, o) };
}
