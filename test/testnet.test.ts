import { afterEach, expect, it, vi } from 'vitest';
import { Transaction, TEST_NETWORK } from '@scure/btc-signer';
import { feeApiBaseUrl, observeFees } from '../src/chain/fees.js';
import * as configs from '../src/config/load.js';
import * as inventory from '../src/consolidation/inventory.js';
import { demoData } from '../src/consolidation/demo.js';
import { consolidationQuote } from '../src/consolidation/service.js';
import handler from '../api/consolidation.js';
import { hash, status } from './helpers.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('loads the operator-supplied Sparrow Signet descriptors against independently observed address vectors', () => {
  const v = configs.loadConfig('signet', false);
  expect(v.config.providers[0]?.base_url).toBe('https://esplora.testnet-prod.alpenlabs.io');
  expect(v.config.chain.checkpoint.height).toBeGreaterThan(0);
  expect(v.wallets.get('ee')?.account.depth).toBe(6);
  expect(v.wallets.get('ol')?.account.depth).toBe(6);
  expect(v.config.wallets.every(wallet => [0, 1].every(chain => wallet.vectors.some(vector => vector.chain === chain)))).toBe(true);
});

it('uses only the configured testnet fee source for recommendations, pressure and completed blocks', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }));
  const base = 'https://mempool.space/signet/api';
  await observeFees(fetcher, undefined, feeApiBaseUrl({ network: 'signet', fee_api_base_url: base }));
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    `${base}/v1/fees/recommended`, `${base}/v1/fees/mempool-blocks`, `${base}/v1/blocks`,
  ]);
  expect(feeApiBaseUrl({ network: 'mainnet' })).toBe('https://mempool.space/api');
});

it('never substitutes mainnet fee observations for an absent testnet source', async () => {
  const fetcher = vi.fn();
  for (const network of ['signet', 'testnet4', 'custom-signet']) {
    expect(await observeFees(fetcher, undefined, feeApiBaseUrl({ network }))).toMatchObject({
      status: 'unavailable', rates: null, error: 'E_FEE_SOURCE_UNAVAILABLE',
      pressure: { status: 'unavailable' }, completed: { status: 'unavailable' },
    });
  }
  expect(feeApiBaseUrl({ network: 'mainnet', fee_api_base_url: null })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});

it('rejects crossed network parameters and a genesis-only Signet checkpoint', () => {
  const { config: v } = demoData();
  for (const network of ['signet', 'testnet', 'testnet4']) {
    const c = { ...v.config, network };
    expect(() => configs.validateConfig(c, network, false)).not.toThrow();
    for (const chain of [
      { ...c.chain, bech32_hrp: 'bc' }, { ...c.chain, bip44_coin_type: 0 },
      { ...c.chain, bip32_versions: { public: '0488b21e', private: '0488ade4' } },
    ]) expect(() => configs.validateConfig({ ...c, chain }, network, false)).toThrow('E_CONFIG_SCHEMA');
  }
  expect(() => configs.validateConfig({ ...v.config, chain: { ...v.config.chain, checkpoint: { height: 0, hash: hash(0) } } }, 'signet', false)).toThrow('E_CONFIG_SCHEMA');
});

function liveSignet(wrongCheckpoint = false) {
  const d = demoData(), wallet = d.wallets[0]!;
  d.config.config.fee_api_base_url = 'https://fees.signet.example/api';
  d.config.config.providers = [{ ...d.config.config.providers[0]!, base_url: 'https://esplora.signet.example/api', auth: { scheme: 'none' }, min_interval_ms: 0 }];
  vi.stubEnv('NETWORK', 'signet'); vi.stubEnv('STAGING_PREVIEW', '');
  vi.spyOn(configs, 'loadConfig').mockReturnValue(d.config);
  vi.spyOn(inventory, 'readInventory').mockResolvedValue(wallet);
  const fetcher = vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.href === 'https://fees.signet.example/api/v1/fees/recommended')
      return Response.json({ fastestFee: 0, halfHourFee: 0, hourFee: 0, economyFee: 0, minimumFee: 0 });
    if (u.hostname !== 'esplora.signet.example') throw new Error('Unexpected network');
    if (u.pathname === '/api/block-height/1') return new Response(wrongCheckpoint ? hash(99) : d.config.config.chain.checkpoint.hash);
    if (u.pathname === '/api/blocks/tip/hash') return new Response(hash(2));
    if (u.pathname === `/api/block/${hash(2)}`) return Response.json({ id: hash(2), height: 2, timestamp: Math.floor(Date.now() / 1000) });
    if (u.pathname === `/api/address/${wallet.utxos[0]!.address}/utxo`)
      return Response.json(wallet.utxos.map(utxo => ({ txid: utxo.txid, vout: utxo.vout, value: utxo.valueSats, status: status(1) })));
    throw new Error('Unexpected request');
  });
  vi.stubGlobal('fetch', fetcher);
  return { fetcher, wallet };
}

it('checks live Signet inputs and exports a network-labelled PSBT with coin-type-1 paths', async () => {
  const { fetcher, wallet } = liveSignet();
  const quote = await consolidationQuote('signet', 'ee');
  expect(quote).toMatchObject({ network: 'signet', sample: false, feeRate: 0.1 });
  expect(quote.destination).toMatch(/^tb1q/);
  const response = await handler.fetch(new Request(`https://testnet.example/api/consolidation?wallet=ee&format=psbt&quote=${quote.quoteId}`));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toContain('ee-signet-consolidation.psbt');
  const tx = Transaction.fromPSBT(new Uint8Array(await response.arrayBuffer()));
  expect(tx.inputsLength).toBe(wallet.utxos.length);
  expect(tx.getOutputAddress(0, TEST_NETWORK)).toBe(quote.destination);
  expect(tx.getInput(0).bip32Derivation?.[0]?.[1].path.slice(0, 3)).toEqual([0x80000054, 0x80000001, 0x80000000]);
  expect(tx.fee).toBe(BigInt(quote.feeSats));
  expect(fetcher.mock.calls.every(([url]) => String(url).includes('.signet.example/'))).toBe(true);
});

it('refuses a Signet consolidation when the provider checkpoint is on another chain', async () => {
  const { fetcher } = liveSignet(true);
  await expect(consolidationQuote('signet', 'ee')).rejects.toThrow('E_VERIFICATION');
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/utxo'))).toBe(false);
});

it('does not fetch mainnet fees or create a PSBT when a Signet fee source is missing', async () => {
  const { fetcher } = liveSignet();
  const v = configs.loadConfig();
  delete v.config.fee_api_base_url;
  await expect(consolidationQuote('signet', 'ee')).rejects.toThrow('E_FEES');
  expect(fetcher).not.toHaveBeenCalled();
});
