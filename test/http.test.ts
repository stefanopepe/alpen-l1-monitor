import { afterEach, expect, it, vi } from 'vitest';
import { authorized } from '../src/http/auth.js';
import { renderMetrics, renderText } from '../src/read/render.js';
import statusHandler from '../api/status.js';
import metricsHandler from '../api/metrics.js';
import collectHandler from '../api/collect.js';
import refreshHandler from '../api/refresh.js';
import type { ReadModel } from '../src/read/model.js';
const cron = 'c'.repeat(32), read = 'r'.repeat(32), next = 'n'.repeat(32);
const req = (token?: string, method = 'GET', path = 'status') => new Request(`https://monitor.test/api/${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
it('auth fails closed, separates roles, supports read token rotation and rejects query credentials', () => {
  const env = { CRON_SECRET: cron, METRICS_BEARER_TOKENS: `${read},${next}` };
  expect(authorized(req(cron), 'collect', env)).toBe(true);
  expect(authorized(req(cron), 'read', env)).toBe(false);
  expect(authorized(req(read), 'collect', env)).toBe(false);
  expect(authorized(req(next), 'read', env)).toBe(true);
  expect(authorized(req(), 'read', env)).toBe(false);
  expect(authorized(req(cron), 'collect', {})).toBe(false);
  expect(authorized(req(cron), 'read', { ...env, METRICS_BEARER_TOKENS: cron })).toBe(false);
  expect(authorized(new Request(`https://monitor.test/?token=${read}`), 'read', env)).toBe(false);
});
it('every route denies unauthorized access before database/config access', async () => {
  vi.stubEnv('CRON_SECRET', cron); vi.stubEnv('METRICS_BEARER_TOKENS', read);
  for (const [handler, method] of [[statusHandler, 'GET'], [metricsHandler, 'GET'], [collectHandler, 'GET'], [refreshHandler, 'POST']] as const) {
    const response = await handler.fetch(req(undefined, method));
    expect(response.status).toBe(401); expect(response.headers.get('cache-control')).toContain('no-store');
  }
  expect((await refreshHandler.fetch(req(cron))).status).toBe(405);
});
it('authenticated reads return 503 on storage failure and never call an upstream provider', async () => {
  vi.stubEnv('METRICS_BEARER_TOKENS', read); vi.stubEnv('DATABASE_URL_METRICS', '');
  const fetcher = vi.fn(() => { throw new Error('No upstream fetch permitted on reads'); }); vi.stubGlobal('fetch', fetcher);
  expect((await statusHandler.fetch(req(read))).status).toBe(503);
  expect((await metricsHandler.fetch(req(read))).status).toBe(503);
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
