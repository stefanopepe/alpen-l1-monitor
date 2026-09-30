import { afterEach, expect, it, vi } from 'vitest';
import { Budget, Esplora } from '../src/chain/esplora.js';
import { ProviderError } from '../src/chain/errors.js';
import { discover, inventory } from '../src/discovery/scan.js';
import { deriveAddress } from '../src/derive/address.js';
import { sampleHistory, emptyHistory } from '../src/extract/history.js';
import { address, config, fakeView, hash, pair, status } from './helpers.js';
import { scanWallet } from '../src/pipeline/walletRun.js';
afterEach(() => vi.unstubAllGlobals());
it('gap-scans both chains, detects rotation and keeps watched addresses', async () => {
  const v = config(), wallet = { ...v.config.wallets[0]!, gap_scan: { min_indices: 2, gap_limit: 2, ceiling: 8 } }, parsed = v.wallets.get(wallet.id)!;
  const active = deriveAddress(parsed, 0, 1, 'bc').address;
  let rotated = false;
  const view = fakeView({ addressStats: async a => ({ chain_stats: { tx_count: Number(a === active || (rotated && a === deriveAddress(parsed, 0, 3, 'bc').address)) }, mempool_stats: { tx_count: 0 } }) });
  const first = await discover(view, v.config, wallet, parsed, []);
  expect(first.addresses.filter(a => a.chain === 0).length).toBe(4);
  rotated = true;
  const second = await discover(view, v.config, wallet, parsed, first.addresses);
  expect(second.addresses.find(a => a.chain === 0 && a.index === 3)?.used).toBe(true);
  expect(second.addresses.filter(a => a.chain === 0).length).toBe(6);
});
it('flags ceiling exhaustion, including the exact boundary', async () => {
  const v = config(), wallet = { ...v.config.wallets[0]!, gap_scan: { min_indices: 2, gap_limit: 2, ceiling: 3 } };
  const result = await discover(fakeView({ addressStats: async () => ({ chain_stats: { tx_count: 1 }, mempool_stats: { tx_count: 0 } }) }), v.config, wallet, v.wallets.get(wallet.id)!, []);
  expect(result.ceilingHit).toEqual({ receive: true, change: true });
});
it('retries UTXOs once on a moving tip, then refuses inconsistent inventory', async () => {
  let calls = 0;
  const view = fakeView({ addressUtxos: async () => { calls++; return []; }, tipHash: async () => calls === 1 ? hash(201) : hash(200) });
  await inventory(view, [address]); expect(calls).toBe(2);
  await expect(inventory(fakeView({ tipHash: async () => hash(300) }), [address])).rejects.toMatchObject({ kind: 'inconsistent' });
});
it.each([[429, '', 'rate_limited'], [500, '', 'server_error'], [400, 'Too many unspent outputs', 'utxo_limit'], [400, 'Too many history entries', 'history_limit'], [404, '', 'not_found'], [400, 'Address on invalid network', 'wrong_network'], [400, 'oops', 'bad_request']])('classifies provider HTTP %s safely', async (statusCode, message, kind) => {
  const p = { ...config().config.providers[0]!, min_interval_ms: 0 };
  const client = new Esplora(p, new Budget(Date.now() + 10000, 10, p.name), vi.fn(async () => new Response(message as string, { status: statusCode as number })));
  await expect(client.addressUtxos('address')).rejects.toMatchObject({ kind });
});
it('refuses unsafe amounts and malformed confirmed status', async () => {
  const p = { ...config().config.providers[0]!, min_interval_ms: 0 };
  const client = new Esplora(p, new Budget(Date.now() + 10000, 10, p.name), vi.fn(async () => Response.json([{ txid: hash(1), vout: 0, value: Number.MAX_SAFE_INTEGER + 1, status: { confirmed: true } }])));
  await expect(client.addressUtxos('address')).rejects.toMatchObject({ kind: 'malformed' });
});
it('refuses a consumed request budget', () => {
  const budget = new Budget(Date.now() + 1000, 1, 'fake'); budget.take();
  expect(() => budget.take()).toThrow('E_PROVIDER_BUDGET_EXHAUSTED');
});
it('rejects duplicate outpoints across addresses', async () => {
  const view = fakeView({ addressUtxos: async () => [{ txid: hash(1), vout: 0, value: 1000, status: status() }] });
  await expect(inventory(view, [address, { ...address, address: 'other' }])).rejects.toMatchObject({ kind: 'inconsistent' });
});
it('collects complete settlement history, excludes a false unspent proof, and does not hide truncation', async () => {
  const { commit, reveal } = pair();
  const view = fakeView({ addressTxsChain: async () => [reveal, commit], tx: async () => reveal,
    outspend: async () => ({ spent: true, txid: reveal.txid, vin: 0 }) });
  const result = await sampleHistory(view, [address], emptyHistory(), config().config, await view.tip(), 120000);
  expect(result.complete).toBe(true); expect(result.settlements[0]?.drainSats).toBe(1436);
  const pending = await sampleHistory(fakeView({ addressTxsChain: async () => [reveal, commit] }), [address], emptyHistory(), config().config, await view.tip(), 120000);
  expect(pending.settlements[0]?.complete).toBe(false);
  await expect(sampleHistory(fakeView(), [address], emptyHistory(), config().config, await view.tip(), 120000)).rejects.toMatchObject({ kind: 'inconsistent' });
});
it('bounded history is incomplete and preserves progress for the next collection', async () => {
  const { commit } = pair(); const txs = Array.from({ length: 26 }, (_, i) => ({ ...commit, txid: hash(i + 10), vout: [{ scriptpubkey: address.script, scriptpubkey_type: 'v0_p2wpkh', value: 9513 }] }));
  const cfg = config().config; cfg.collection.history_page_cap = 1;
  const view = fakeView({ addressTxsChain: async (_a, cursor) => cursor ? txs.slice(25) : txs.slice(0, 25) });
  const a = { ...address, confirmedTxCount: 26 };
  const first = await sampleHistory(view, [a], emptyHistory(), cfg, await view.tip(), 120000);
  expect(first.complete).toBe(false); expect(first.state.addresses.wallet?.cursor).toBe(hash(34));
  cfg.collection.history_page_cap = 2;
  const second = await sampleHistory(view, [a], first.state, cfg, await view.tip(), 120000);
  expect(second.complete).toBe(true); expect(second.state.addresses.wallet?.txids).toHaveLength(26);
});
it('provider failover restarts inventory without mixing provider UTXOs', async () => {
  const v = config(); v.config.providers.forEach(p => { p.min_interval_ms = 0; });
  v.config.wallets[0]!.gap_scan = { min_indices: 1, gap_limit: 1, ceiling: 3 };
  const wallet = v.config.wallets[0]!, errors: string[] = [];
  const active = deriveAddress(v.wallets.get(wallet.id)!, 0, 0, 'bc').address;
  const checkpoint = v.config.chain.checkpoint.hash;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = new URL(url), primary = u.host === 'blockstream.info', path = u.pathname.replace('/api', '');
    if (path.startsWith('/block-height/')) return new Response(checkpoint);
    if (path === '/blocks/tip/hash') return new Response(hash(200));
    if (path === `/block/${hash(200)}`) return Response.json({ id: hash(200), height: 200, timestamp: Math.floor(Date.now()/1000) });
    if (path.endsWith('/utxo')) return primary ? new Response('Too many unspent outputs', { status: 400 }) : Response.json([{ txid: hash(5), vout: 0, value: 700, status: status() }]);
    if (path.includes('/txs/chain')) return Response.json([]);
    if (path === `/address/${active}`) return Response.json({ chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 1 } });
    return Response.json({ chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 0 } });
  }));
  const result = await scanWallet(v, wallet, { addresses: [], history: emptyHistory() }, Date.now() + 20000, 0, async (p, kind) => { errors.push(`${p}:${kind}`); });
  expect(result.snapshot.provider).toBe('mempool'); expect(result.snapshot.composition.spendableSats).toBe(700);
  expect(errors).toEqual(['blockstream:utxo_limit']);
});
it('keeps balance collection viable when history budget is exhausted', async () => {
  const view = fakeView({ addressTxsChain: async () => { throw new ProviderError('fake', 'budget_exhausted'); } });
  const result = await sampleHistory(view, [address], emptyHistory(), config().config, await view.tip(), 120000);
  expect(result.complete).toBe(false);
});
