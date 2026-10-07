import { afterEach, expect, it, vi } from 'vitest';
import handler from '../api/time-machine.js';
import { readTimeMachine } from '../src/read/timeMachine.js';
vi.mock('../src/db/pool.js', () => ({ database: () => ({}) }));
vi.mock('../src/read/timeMachine.js', () => ({ readTimeMachine: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });

it('returns unchanged data as 304 and permits conditional reads from the Signet page', async () => {
  vi.stubEnv('NETWORK', 'mainnet'); vi.stubEnv('STAGING_PREVIEW', '');
  const data = { network: 'mainnet', readAt: new Date().toISOString(), staleAfterSeconds: 3300,
    records: [], transactions: [], study: null, researchUpdatedAt: null, researchError: null };
  vi.mocked(readTimeMachine).mockResolvedValue(data);
  const first = await handler.fetch(new Request('https://test/api/time-machine'));
  expect(first.status).toBe(200);
  const etag = first.headers.get('etag')!;
  expect(etag).toBeTruthy(); expect(first.headers.get('access-control-expose-headers')).toContain('ETag');
  vi.mocked(readTimeMachine).mockResolvedValue({ ...data, readAt: new Date(Date.now() + 300000).toISOString() });
  const unchanged = await handler.fetch(new Request('https://test/api/time-machine', { headers: { 'If-None-Match': etag } }));
  expect(unchanged.status).toBe(304); expect(await unchanged.text()).toBe('');
  vi.mocked(readTimeMachine).mockResolvedValue({ ...data, researchError: 'refresh_failed' });
  const changed = await handler.fetch(new Request('https://test/api/time-machine', { headers: { 'If-None-Match': etag } }));
  expect(changed.status).toBe(200); expect(changed.headers.get('etag')).not.toBe(etag);
  const options = await handler.fetch(new Request('https://test/api/time-machine', { method: 'OPTIONS' }));
  expect(options.status).toBe(204); expect(options.headers.get('access-control-allow-headers')).toBe('If-None-Match');
});

it('does not turn a failed source check into a cached success or 304', async () => {
  vi.stubEnv('NETWORK', 'mainnet'); vi.stubEnv('STAGING_PREVIEW', '');
  vi.mocked(readTimeMachine).mockRejectedValue(new Error('unavailable'));
  const response = await handler.fetch(new Request('https://test/api/time-machine', { headers: { 'If-None-Match': '"old"' } }));
  expect(response.status).toBe(503); expect(response.headers.get('etag')).toBeNull();
  expect(response.headers.get('cache-control')).toContain('no-store');
});
