import { afterEach, expect, it, vi } from 'vitest';
import { authorized } from '../src/http/auth.js';
import { renderMetrics, renderText } from '../src/read/render.js';
import statusHandler from '../api/status.js';
import metricsHandler from '../api/metrics.js';
import collectHandler from '../api/collect.js';
import refreshHandler from '../api/refresh.js';
import type { ReadModel } from '../src/read/model.js';
const cron = 'c'.repeat(32), wrong = 'r'.repeat(32);
const req = (token?: string, method = 'GET', path = 'status') => new Request(`https://monitor.test/api/${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('collection auth fails closed and rejects wrong, malformed or query credentials', () => {
  const env = { CRON_SECRET: cron };
  expect(authorized(req(cron), env)).toBe(true);
  expect(authorized(req(wrong), env)).toBe(false);
  expect(authorized(req(), env)).toBe(false);
  expect(authorized(req(cron), {})).toBe(false);
  expect(authorized(req('short'), { CRON_SECRET: 'short' })).toBe(false);
  expect(authorized(req('bad token'), { CRON_SECRET: 'bad token' })).toBe(false);
  expect(authorized(new Request(`https://monitor.test/api/collect?token=${cron}`), env)).toBe(false);
});
it('collection routes still deny unauthorized access before database/config access', async () => {
  vi.stubEnv('CRON_SECRET', cron);
  for (const [handler, method] of [[collectHandler, 'GET'], [refreshHandler, 'POST']] as const) {
    for (const token of [undefined, wrong]) {
      const response = await handler.fetch(req(token, method));
      expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toContain('no-store');
    }
  }
  expect((await refreshHandler.fetch(req(cron))).status).toBe(405);
});
it('public reads return 503 on storage failure and never call an upstream provider', async () => {
  vi.stubEnv('DATABASE_URL_METRICS', '');
  const fetcher = vi.fn(() => { throw new Error('No upstream fetch permitted on reads'); }); vi.stubGlobal('fetch', fetcher);
  expect((await statusHandler.fetch(req())).status).toBe(503);
  expect((await metricsHandler.fetch(req())).status).toBe(503);
  expect(fetcher).not.toHaveBeenCalled();
});
it('emits both wallet liveness series even before the first successful scan', () => {
  const model: ReadModel = { network: 'mainnet', readAt: '2026-09-30T00:00:00.000Z', primaryIsPublic: true, providerErrors: [],
    wallets: ['ee', 'ol'].map(wallet => ({ wallet, name: wallet.toUpperCase(), stale: true, ageSeconds: null, snapshot: null })) };
  const text = renderMetrics(model);
  for (const wallet of ['ee', 'ol']) expect(text).toContain(`bridge_wallet_last_update_timestamp{network="mainnet",wallet="${wallet}"} 0`);
  expect(text).not.toContain('NaN'); expect(text).not.toContain('bridge_wallet_naive_runway_days{');
  expect(renderText(model)).toContain('STALE / UNAVAILABLE');
});
it('rejects invalid client timezones before reading storage', async () => {
  const response = await statusHandler.fetch(new Request('https://monitor.test/api/status?format=text&timezone=Mars/Test'));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'invalid_timezone' });
});
