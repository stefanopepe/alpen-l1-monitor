import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { createReadCache } from '../src/read/cache.js';
import { LivePoller } from '../src/replay/report/poll.js';

function backend() {
  const data = new Map<string, unknown>();
  return { data, get: vi.fn(async (key: string) => data.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }) };
}

it('shares compressed values across instances and isolates networks, deployments and revisions', async () => {
  const storage = backend(), a = createReadCache(storage, 'mainnet:v1'), b = createReadCache(storage, 'mainnet:v1');
  const client = { query: vi.fn() } as unknown as PoolClient;
  const load = vi.fn(async () => ({ snapshot: 'a'.repeat(50000) }));
  const value = await a(client, 'wallets', 1, load);
  expect(await b(client, 'wallets', 1, load)).toEqual(value);
  expect(load).toHaveBeenCalledTimes(1);
  expect(String([...storage.data.values()][0]).length).toBeLessThan(1000);
  await b(client, 'wallets', 2, load);
  await createReadCache(storage, 'signet:v1')(client, 'wallets', 1, load);
  await createReadCache(storage, 'mainnet:v2')(client, 'wallets', 1, load);
  expect(load).toHaveBeenCalledTimes(4);
});

it('rechecks the shared cache after another transaction fills a concurrent miss', async () => {
  const storage = backend(), a = createReadCache(storage, 'same'), b = createReadCache(storage, 'same');
  let unlock!: () => void;
  const committed = new Promise<void>(resolve => { unlock = resolve; });
  const first = { query: vi.fn() } as unknown as PoolClient;
  const second = { query: vi.fn(async () => committed) } as unknown as PoolClient;
  const load = vi.fn(async () => ({ value: 7 }));
  const concurrent = b(second, 'wallets', 1, load);
  expect(await a(first, 'wallets', 1, load)).toEqual({ value: 7 });
  unlock();
  expect(await concurrent).toEqual({ value: 7 });
  expect(load).toHaveBeenCalledTimes(1);
});

it('fails closed on cache failure instead of silently repeating large database reads', async () => {
  const load = vi.fn(async () => 1);
  const cache = createReadCache({ get: async () => { throw new Error('offline'); }, set: async () => {} }, 'scope');
  await expect(cache({} as PoolClient, 'wallets', 1, load)).rejects.toThrow('offline');
  expect(load).not.toHaveBeenCalled();
});

it('does not cache failed loads and retries after recovery', async () => {
  const cache = createReadCache(backend(), 'scope'), client = { query: vi.fn() } as unknown as PoolClient;
  await expect(cache(client, 'wallets', 1, async () => { throw new Error('database'); })).rejects.toThrow('database');
  expect(await cache(client, 'wallets', 1, async () => 7)).toBe(7);
});

it('pauses hidden tabs, deduplicates in-flight/resume requests and backs off failures', async () => {
  let now = 0, visible = false, release!: () => void;
  const refresh = vi.fn(async () => new Promise<void>(resolve => { release = resolve; }));
  const poller = new LivePoller(refresh, () => visible, () => now);
  await poller.tick(); expect(refresh).not.toHaveBeenCalled();
  visible = true;
  const first = poller.tick(); await poller.tick(); expect(refresh).toHaveBeenCalledTimes(1);
  release(); await first;
  await poller.tick(); now = 299999; await poller.tick(); expect(refresh).toHaveBeenCalledTimes(1);
  now = 300000; refresh.mockRejectedValue(new Error('offline')); await poller.tick();
  now = 899999; await poller.tick(); expect(refresh).toHaveBeenCalledTimes(2);
  now = 900000; await poller.tick(); expect(refresh).toHaveBeenCalledTimes(3);
  visible = false; now = 10000000; await poller.tick(); expect(refresh).toHaveBeenCalledTimes(3);
  visible = true; refresh.mockResolvedValue(); await poller.tick(); expect(refresh).toHaveBeenCalledTimes(4);
  now += 300000; await poller.tick(); expect(refresh).toHaveBeenCalledTimes(5);
});
