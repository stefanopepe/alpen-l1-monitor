import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/load.js';
import { blockSchema, txSchema, type ChainTx } from '../src/chain/schemas.js';
import { ArchiveClient, canonical, digest, writeJson } from '../src/replay/archive.js';
import { historyInventory, type ExportAddress } from '../src/consolidation/historyInventory.js';
import { compactHistory, emptyHistory } from '../src/extract/history.js';
import { commitOutputs, revealShaped } from '../src/extract/classify.js';
import { computeWalletSnapshot } from '../src/pipeline/snapshot.js';
import { scanWallet } from '../src/pipeline/walletRun.js';
import { database } from '../src/db/pool.js';
import { Store } from '../src/db/store.js';
import { observeQuote, feeApiBaseUrl } from '../src/chain/fees.js';
import { MONITOR_VERSION } from '../src/version.js';
import type { AddressRecord } from '../src/types.js';

async function main() {
  const [directory, mode] = process.argv.slice(2);
  if (!directory || !['--prepare', '--write'].includes(mode ?? '') || process.argv.length !== 4) throw new Error('E_IMPORT_ARGUMENT');
  const dir = resolve(directory), manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (process.env.NETWORK !== manifest.network) throw new Error('E_IMPORT_NETWORK');
  const v = loadConfig(manifest.network), wallet = v.config.wallets.find(w => w.id === manifest.wallet);
  if (manifest.configSha256 !== v.sha256 || !wallet) throw new Error('E_IMPORT_CONFIG');
  const providerIndex = v.config.providers.findIndex(p => p.name === manifest.provider), provider = v.config.providers[providerIndex];
  if (!provider) throw new Error('E_IMPORT_PROVIDER');
  const rawAddresses: (ExportAddress & { txids: string[]; stats: { chain_stats: { tx_count: number }; mempool_stats: { tx_count: number } } })[] = JSON.parse(readFileSync(join(dir, 'addresses.json'), 'utf8'));
  const transactions = readFileSync(join(dir, 'transactions.jsonl'), 'utf8').trim().split('\n').map(s => txSchema.parse(JSON.parse(s)));
  const outputs = readFileSync(join(dir, 'outputs.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  const { utxos } = JSON.parse(readFileSync(join(dir, 'utxos.json'), 'utf8'));
  if (digest({ addresses: rawAddresses, transactions, outputs, utxos }) !== manifest.dataDigest ||
    canonical(historyInventory(rawAddresses, transactions, Number.MAX_SAFE_INTEGER).utxos) !== canonical(utxos)) throw new Error('E_IMPORT_DIGEST');
  if (manifest.mempoolTransactionEntries !== 0 || transactions.some(tx => tx.status.block_height! > manifest.startedAtHeight)) throw new Error('E_IMPORT_CAPTURE_BOUNDARY');
  const addresses: AddressRecord[] = rawAddresses.map(a => ({ address: a.address, script: a.script, chain: a.chain, index: a.index,
    used: a.stats.chain_stats.tx_count + a.stats.mempool_stats.tx_count > 0,
    confirmedTxCount: a.stats.chain_stats.tx_count, mempoolTxCount: a.stats.mempool_stats.tx_count }));
  const client = new ArchiveClient(provider, join(dir, 'evidence'));
  const block = await client.get('/block/' + manifest.startedAtHash, blockSchema);
  if (block.height !== manifest.startedAtHeight) throw new Error('E_IMPORT_BLOCK');
  const scripts = new Set(addresses.map(a => a.script)), spenders = new Map<string, ChainTx>();
  const history = emptyHistory();
  history.transactions = Object.fromEntries(transactions.map(t => [t.txid, t]));
  history.addresses = Object.fromEntries(rawAddresses.filter(a => a.txids.length).map(a => [a.address, { txids: a.txids, cursor: null, coveredSince: -1 }]));
  for (const tx of transactions) for (const input of tx.vin) if (!input.is_coinbase) {
    const key = `${input.txid}:${input.vout}`;
    if (spenders.has(key)) throw new Error('E_IMPORT_DOUBLE_SPEND');
    spenders.set(key, tx);
  }
  for (const commit of transactions) {
    const funding = commitOutputs(commit, scripts);
    if (!funding) continue;
    const reveals = funding.map(index => ({ index, tx: spenders.get(`${commit.txid}:${index}`) }));
    if (reveals.every(r => r.tx && revealShaped(commit, r.index, r.tx, scripts))) history.reveals[commit.txid] = reveals.map(r => r.tx!);
  }
  const snapshot = computeWalletSnapshot({ asOfEpoch: Date.parse(manifest.capturedAt) / 1000, utxos, settlements: [], estimator: v.config.estimator, historyComplete: false,
    meta: { network: v.config.network, wallet: wallet.id, asOf: manifest.capturedAt, finishedAt: manifest.capturedAt, provider: provider.name,
      tip: { height: block.height, hash: block.id, blockTime: block.timestamp }, ceilingHit: { receive: false, change: false }, addressesScanned: addresses.length,
      requestsUsed: manifest.requests, primaryIsPublic: provider.tier === 'public', networkTipOld: false, historyError: 'E_HISTORY_INCOMPLETE',
      monitorVersion: MONITOR_VERSION, selectorModelVersion: v.config.upstream.selector_model_version, upstreamRef: v.config.upstream.ref,
      deployedBuildConfirmed: v.config.upstream.deployed_build_confirmed, configSha256: v.sha256 } });
  const seed = { addresses, utxos, snapshot, history: compactHistory(history) };
  const prepared = { network: v.config.network, wallet: wallet.id, sourceDigest: manifest.dataDigest, addresses: addresses.length,
    transactions: transactions.length, linkedCommits: Object.keys(history.reveals).length, importedUtxos: utxos.length, seedBytes: Buffer.byteLength(JSON.stringify(seed)) };
  writeJson(join(dir, 'import-prepared.json'), prepared);
  if (mode === '--prepare') { console.log(JSON.stringify(prepared)); return; }
  const pool = database('write'), store = new Store(pool), runId = randomUUID();
  let lease;
  try {
    await store.assertConfig(v);
    await store.beginRun(v.config.network, runId);
    lease = await store.acquire(v.config.network, runId, v.config.collection.lease_ttl_s, v.config.collection.interval_s, true);
    if (!lease) { await store.finishRun(runId, 'skipped_lease_or_slot', []); throw new Error('E_IMPORT_COLLECTOR_BUSY'); }
    const before = await pool.query('SELECT wallet,latest_snapshot,utxos FROM wallet_state WHERE network=$1 ORDER BY wallet', [v.config.network]);
    writeJson(join(dir, 'pre-import-state.json'), before.rows);
    // All bulk work stays local. Refresh address heads/inventory and join to the
    // complete imported history before publishing a new, honestly timed snapshot.
    const result = await scanWallet(v, wallet, seed, Date.now() + 600000, providerIndex,
      async (name, kind) => { console.error(JSON.stringify({ provider: name, kind })); });
    if (!result.snapshot.naiveRunway.historyComplete) throw new Error('E_IMPORT_HISTORY_INCOMPLETE');
    result.snapshot.feeContext = await observeQuote(undefined, undefined, feeApiBaseUrl(v.config));
    result.snapshot.feeContext.persistence = await store.preserveFees(v.config.network, runId, result.snapshot.feeContext);
    await store.save(lease, result.snapshot, result.addresses, result.history, result.utxos);
    const results = { schemaVersion: 1, kind: 'local_wallet_import', sourceDigest: manifest.dataDigest,
      feeContext: result.snapshot.feeContext, wallets: [{ wallet: wallet.id, status: 'ok', provider: result.snapshot.provider, asOf: result.snapshot.asOf,
        runwayAvailable: result.snapshot.naiveRunway.days !== null, forecast: { tip: result.snapshot.tip, composition: result.snapshot.composition,
          naiveRunway: result.snapshot.naiveRunway, monitorVersion: result.snapshot.monitorVersion, configSha256: v.sha256 } }] };
    await store.finishRun(runId, 'ok', results);
    writeJson(join(dir, 'import-result.json'), { runId, prepared, snapshot: result.snapshot, storedHistoryBytes: Buffer.byteLength(JSON.stringify(compactHistory(result.history))) });
    console.log(JSON.stringify({ runId, snapshot: result.snapshot, storedHistoryBytes: Buffer.byteLength(JSON.stringify(compactHistory(result.history))) }));
  } catch (e) {
    if (lease) await store.finishRun(runId, 'failed', { kind: 'local_wallet_import', sourceDigest: manifest.dataDigest,
      error: e instanceof Error && /^E_[A-Z0-9_]+$/.test(e.message) ? e.message : 'E_IMPORT_FAILED' });
    throw e;
  } finally {
    // An EE-only import must not consume the scheduling slot for OL.
    if (lease) await store.release(lease, false);
    await pool.end();
  }
}
main().catch(e => { console.error(e instanceof Error && /^E_[A-Z0-9_]+$/.test(e.message) ? e.message : 'E_IMPORT_FAILED'); process.exitCode = 1; });
