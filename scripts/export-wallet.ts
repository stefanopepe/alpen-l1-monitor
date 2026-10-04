import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../src/config/load.js';
import { deriveAddress } from '../src/derive/address.js';
import { ArchiveClient, canonical, digest, writeJson } from '../src/replay/archive.js';
import { blockSchema, hashSchema, safeInt, txSchema, type ChainTx } from '../src/chain/schemas.js';
import { historyInventory, type ExportAddress } from '../src/consolidation/historyInventory.js';

const args = process.argv.slice(2);
function option(key: string, fallback: string) {
  const i = args.indexOf('--' + key); return i < 0 ? fallback : args[i + 1] ?? '';
}
const statsPart = z.object({ tx_count: safeInt, funded_txo_count: safeInt, funded_txo_sum: safeInt, spent_txo_count: safeInt, spent_txo_sum: safeInt });
const statsSchema = z.object({ chain_stats: statsPart, mempool_stats: statsPart });
type Stats = z.infer<typeof statsSchema>;
type Address = ExportAddress & { stats: Stats; txids: string[] };

async function main() {
  for (let i = 0; i < args.length; i += 2) {
    if (!['--network', '--wallet', '--out', '--provider'].includes(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('E_EXPORT_ARGUMENT');
  }
  const network = option('network', 'signet'), walletId = option('wallet', 'ee');
  const v = loadConfig(network, false), wallet = v.config.wallets.find(w => w.id === walletId), parsed = v.wallets.get(walletId);
  if (!wallet || !parsed) throw new Error('E_WALLET');
  const provider = v.config.providers.find(p => p.name === option('provider', v.config.providers[0]!.name));
  if (!provider) throw new Error('E_EXPORT_PROVIDER');
  const dir = resolve(option('out', `.local/exports/${network}-${walletId}`));
  mkdirSync(dir, { recursive: true });
  // Half-second pacing, cached successful pages and bounded retry/backoff. No database imports.
  const client = new ArchiveClient({ ...provider, min_interval_ms: Math.max(500, provider.min_interval_ms), timeout_ms: 30000 }, join(dir, 'evidence'));
  const captureFile = join(dir, 'capture.json');
  const identity = { network, wallet: walletId, provider: provider.name, configSha256: v.sha256 };
  if (existsSync(captureFile)) {
    const old = JSON.parse(readFileSync(captureFile, 'utf8'));
    if (canonical(old) !== canonical(identity)) throw new Error('E_EXPORT_CAPTURE_CHANGED');
  } else writeJson(captureFile, identity);
  const checkpoint = () => client.get('/block-height/' + v.config.chain.checkpoint.height, hashSchema, true, false);
  if (await checkpoint() !== v.config.chain.checkpoint.hash) throw new Error('E_EXPORT_NETWORK');
  const startTip = await client.get('/blocks/tip/hash', hashSchema, true, false);
  const tip = await client.get('/block/' + startTip, blockSchema);
  const addresses: Address[] = [], transactions = new Map<string, ChainTx>();
  for (const chain of [0, 1] as const) for (let index = 0; index < wallet.gap_scan.ceiling; index++) {
    const a = { ...deriveAddress(parsed, chain, index, v.config.chain.bech32_hrp), chain, index };
    const path = '/address/' + a.address;
    let stats = await client.get(path, statsSchema, false, false), complete = false;
    let txs = new Map<string, ChainTx>();
    for (let pass = 0; pass < 3 && !complete; pass++) {
      txs = new Map(); let cursor: string | undefined;
      if (stats.chain_stats.tx_count) for (;;) {
        const page: ChainTx[] = await client.get(path + '/txs/chain' + (cursor ? '/' + cursor : ''), z.array(txSchema).max(25), false, Boolean(cursor) && pass === 0);
        for (const tx of page) {
          if (!tx.status.confirmed || txs.has(tx.txid) || ![...tx.vout, ...tx.vin.flatMap(i => i.prevout ? [i.prevout] : [])].some(o => o.scriptpubkey === a.script)) throw new Error('E_EXPORT_PAGINATION');
          txs.set(tx.txid, tx);
        }
        if (page.length < 25) break;
        cursor = page.at(-1)!.txid;
        if (txs.size % 250 === 0) console.log(JSON.stringify({ phase: 'history', chain, index, fetched: txs.size, expected: stats.chain_stats.tx_count, requests: client.requests }));
      }
      const after = await client.get(path, statsSchema, false, false);
      complete = txs.size === after.chain_stats.tx_count && canonical(stats.chain_stats) === canonical(after.chain_stats);
      stats = after;
    }
    if (!complete) throw new Error('E_EXPORT_HISTORY_INCOMPLETE');
    const local = historyInventory([a], [...txs.values()], Number.MAX_SAFE_INTEGER);
    const funded = local.outputs.reduce((n, o) => n + o.valueSats, 0), spent = local.outputs.filter(o => o.spentBy);
    if (local.outputs.length !== stats.chain_stats.funded_txo_count || funded !== stats.chain_stats.funded_txo_sum ||
      spent.length !== stats.chain_stats.spent_txo_count || spent.reduce((n, o) => n + o.valueSats, 0) !== stats.chain_stats.spent_txo_sum) throw new Error('E_EXPORT_STATS_MISMATCH');
    for (const tx of txs.values()) {
      const known = transactions.get(tx.txid);
      if (known && canonical(known) !== canonical(tx)) throw new Error('E_EXPORT_TX_CHANGED');
      transactions.set(tx.txid, tx);
    }
    addresses.push({ ...a, stats, txids: [...txs.keys()] });
    writeJson(join(dir, 'progress.json'), { ...identity, addresses: addresses.length, transactions: transactions.size, requests: client.requests, updatedAt: new Date().toISOString() });
    if (txs.size || index % 10 === 0) console.log(JSON.stringify({ phase: 'address-complete', chain, index, transactions: txs.size, outputs: local.outputs.length, unspent: local.utxos.length }));
  }
  // Fail closed if the configured range ends with activity instead of a full unused gap.
  for (const chain of [0, 1] as const) if (addresses.filter(a => a.chain === chain).slice(-wallet.gap_scan.gap_limit).some(a => a.stats.chain_stats.tx_count + a.stats.mempool_stats.tx_count > 0)) throw new Error('E_EXPORT_SCAN_CEILING');
  // Re-read counts after paging to catch activity during the capture; cached history resumes cheaply.
  for (const a of addresses) {
    const fresh = await client.get('/address/' + a.address, statsSchema, false, false);
    if (canonical(fresh.chain_stats) !== canonical(a.stats.chain_stats)) throw new Error('E_EXPORT_HISTORY_MOVED_RESUME');
    a.stats = fresh;
  }
  if (await checkpoint() !== v.config.chain.checkpoint.hash || await client.get('/block-height/' + tip.height, hashSchema, true, false) !== tip.id) throw new Error('E_EXPORT_CHAIN_CHANGED');
  const all = [...transactions.values()], current = historyInventory(addresses, all, Number.MAX_SAFE_INTEGER);
  const pinned = historyInventory(addresses, all, tip.height);
  const metadata = { ...identity, startedAtHeight: tip.height, startedAtHash: tip.id, capturedAt: new Date().toISOString(),
    addressRange: { receive: [0, wallet.gap_scan.ceiling - 1], change: [0, wallet.gap_scan.ceiling - 1], unusedGap: wallet.gap_scan.gap_limit },
    requests: client.requests, addresses: addresses.length, transactions: all.length, historicalOutputs: current.outputs.length,
    confirmedUtxos: current.utxos.length, confirmedBalanceSats: current.utxos.reduce((n, o) => n + o.valueSats, 0),
    confirmedDustCount: current.utxos.filter(o => o.valueSats > 0 && o.valueSats <= 546).length,
    mempoolTransactionEntries: addresses.reduce((n, a) => n + a.stats.mempool_stats.tx_count, 0),
    limitations: ['Provider-confirmed history; mempool outputs/spends are excluded. Unsigned files require a fresh outspend check.', 'Coverage is limited to the recorded descriptor range; each chain ends with the configured unused gap.'],
    dataDigest: digest({ addresses, transactions: all, outputs: current.outputs, utxos: current.utxos }) };
  writeJson(join(dir, 'addresses.json'), addresses);
  writeJson(join(dir, 'utxos.json'), { metadata, utxos: current.utxos });
  writeJson(join(dir, 'pinned-utxos.json'), { height: tip.height, hash: tip.id, utxos: pinned.utxos });
  writeFileSync(join(dir, 'transactions.jsonl'), all.map(t => JSON.stringify(t)).join('\n') + '\n', { mode: 0o600 });
  writeFileSync(join(dir, 'outputs.jsonl'), current.outputs.map(o => JSON.stringify(o)).join('\n') + '\n', { mode: 0o600 });
  writeJson(join(dir, 'manifest.json'), metadata);
  console.log(JSON.stringify({ phase: 'complete', dir, ...metadata }));
}
main().catch(e => { console.error(e instanceof Error && /^E_[A-Z0-9_]+$/.test(e.message) ? e.message : 'E_EXPORT_FAILED'); process.exitCode = 1; });
