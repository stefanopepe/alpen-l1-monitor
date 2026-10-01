import { afterEach, expect, it, vi } from 'vitest';
import { Budget, Esplora } from '../src/chain/esplora.js';
import { safeError } from '../src/chain/errors.js';
import { providerSchema, type ProviderConfig } from '../src/config/schema.js';
import { config, hash } from './helpers.js';

afterEach(() => vi.unstubAllEnvs());
const provider = (auth: ProviderConfig['auth']): ProviderConfig => ({
  ...config().config.providers[0]!, name: 'private', tier: 'internal',
  base_url: 'https://private.example/api', min_interval_ms: 0, auth,
});
const client = (p: ProviderConfig, fetcher: typeof fetch) => new Esplora(p, new Budget(Date.now() + 10000, 10, p.name), fetcher);

it('encodes a query token on each API request without putting it in headers or saved config', async () => {
  const secret = 'test token+with&reserved=characters?#%';
  vi.stubEnv('TEST_ESPLORA_TOKEN', secret);
  const p = provider({ scheme: 'query', secret_env: 'TEST_ESPLORA_TOKEN', parameter_name: 'token' });
  expect(providerSchema.safeParse(p).success).toBe(true);
  const before = JSON.stringify(p);
  const paths: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe('https://private.example');
    expect([...url.searchParams]).toEqual([['token', secret]]);
    expect(url.hash).toBe('');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    expect(init?.redirect).toBe('error');
    expect(init?.cache).toBe('no-store');
    paths.push(url.pathname);
    return url.pathname.endsWith('/hash') ? new Response(hash(200)) : Response.json([]);
  });
  const view = client(p, fetcher);
  await expect(view.tipHash()).resolves.toBe(hash(200));
  await expect(view.addressTxsChain('address', hash(1))).resolves.toEqual([]);
  expect(paths).toEqual(['/api/blocks/tip/hash', `/api/address/address/txs/chain/${hash(1)}`]);
  expect(JSON.stringify(p)).toBe(before);
});

it.each<ProviderConfig['auth']>([
  { scheme: 'none' },
  { scheme: 'bearer', secret_env: 'TEST_ESPLORA_TOKEN' },
  { scheme: 'header', secret_env: 'TEST_ESPLORA_TOKEN', header_name: 'X-API-Key' },
])('preserves $scheme authentication without adding query credentials', async auth => {
  vi.stubEnv('TEST_ESPLORA_TOKEN', 'test-secret');
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(new URL(String(input)).search).toBe('');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(auth.scheme === 'bearer' ? 'Bearer test-secret' : null);
    expect(headers.get('x-api-key')).toBe(auth.scheme === 'header' ? 'test-secret' : null);
    return new Response(hash(200));
  });
  await expect(client(provider(auth), fetcher).tipHash()).resolves.toBe(hash(200));
});

it.each(['', 'bad\r\ntoken'])('refuses a missing or malformed query credential before making a request', async secret => {
  vi.stubEnv('TEST_ESPLORA_TOKEN', secret);
  const fetcher = vi.fn<typeof fetch>();
  const p = provider({ scheme: 'query', secret_env: 'TEST_ESPLORA_TOKEN', parameter_name: 'token' });
  await expect(client(p, fetcher).tipHash()).rejects.toThrow('E_PROVIDER_SECRET_MISSING');
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['transport', 'http', 'redirect'])('redacts query credentials from %s failures', async kind => {
  vi.stubEnv('TEST_ESPLORA_TOKEN', 'test-secret');
  const p = provider({ scheme: 'query', secret_env: 'TEST_ESPLORA_TOKEN', parameter_name: 'token' });
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (kind === 'transport') throw new Error(`Cannot fetch ${String(input)}`);
    return new Response(String(input), { status: kind === 'http' ? 401 : 302 });
  });
  const error = await client(p, fetcher).tipHash().catch((e: unknown) => e);
  expect(safeError(error)).toBe(kind === 'transport' ? 'E_PROVIDER_TIMEOUT' : 'E_PROVIDER_BAD_REQUEST');
  expect(JSON.stringify(error)).not.toContain('test-secret');
});

it('keeps query credentials out of base URLs in configuration', () => {
  const p = provider({ scheme: 'query', secret_env: 'TEST_ESPLORA_TOKEN', parameter_name: 'token' });
  expect(providerSchema.safeParse({ ...p, base_url: `${p.base_url}?token=test-secret` }).success).toBe(false);
});
