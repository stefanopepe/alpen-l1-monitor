import { config, hash } from './helpers.js';
import { validateConfig } from '../src/config/load.js';
import { deriveAddress } from '../src/derive/address.js';
import type { ChainTx } from '../src/chain/schemas.js';
import { digest, type ChainArchive, type ArchiveAddress } from '../src/replay/archive.js';
export function replayFixture() {
  const raw = config().config;
  raw.wallets.forEach(w => { w.gap_scan = { min_indices: 1, gap_limit: 1, ceiling: 3 }; });
  raw.estimator.min_sample = 4; raw.estimator.min_sample_short = 2; raw.estimator.min_intervals = 3; raw.estimator.min_intervals_short = 1;
  const v = validateConfig(raw, raw.network, false);
  const blocks = Array.from({ length: 501 }, (_, h) => ({ id: h === 0 ? raw.chain.checkpoint.hash : hash(10000 + h),
    height: h, timestamp: 1790000000 + h * 21600, previousblockhash: h === 0 ? undefined : h === 1 ? raw.chain.checkpoint.hash : hash(9999 + h) }));
  const status = (h: number) => ({ confirmed: true, block_height: h, block_hash: blocks[h]!.id, block_time: blocks[h]!.timestamp });
  const addresses: ArchiveAddress[] = raw.wallets.flatMap(w => [0, 1].flatMap(c => Array.from({ length: 3 }, (_, i) => ({
    ...deriveAddress(v.wallets.get(w.id)!, c as 0 | 1, i, raw.chain.bech32_hrp), wallet: w.id, chain: c as 0 | 1, index: i, txids: [], complete: true }))));
  const transactions: Record<string, ChainTx> = {};
  let id = 20000;
  for (const wallet of raw.wallets) {
    const a = addresses.find(a => a.wallet === wallet.id && a.chain === 0 && a.index === 0)!;
    const own = (value: number) => ({ scriptpubkey: a.script, scriptpubkey_type: 'v0_p2wpkh', scriptpubkey_address: a.address, value });
    let parentId = hash(id++), parentVout = 0, value = 500000;
    transactions[parentId] = { txid: parentId, fee: 1000, weight: 400, status: status(2),
      vin: [{ txid: hash(id++), vout: 0, prevout: { scriptpubkey: '0014' + 'aa'.repeat(20), scriptpubkey_type: 'v0_p2wpkh', value: 501000 } }], vout: [own(value)] };
    for (let h = 40; h <= 450; h += 5) {
      const commitId = hash(id++), revealId = hash(id++);
      const funding = { scriptpubkey: '5120' + hash(id++), scriptpubkey_type: 'v1_p2tr', value: 949 };
      const commit: ChainTx = { txid: commitId, fee: 487, weight: 685, status: status(h),
        vin: [{ txid: parentId, vout: parentVout, prevout: own(value) }],
        vout: [{ scriptpubkey: '6a08414c504e00000000', scriptpubkey_type: 'op_return', value: 0 }, funding, own(value - 1436)] };
      const reveal: ChainTx = { txid: revealId, fee: 403, weight: 529, status: status(h + 1),
        vin: [{ txid: commitId, vout: 1, prevout: funding, witness: ['signature', 'script', 'control'] }], vout: [own(546)] };
      transactions[commitId] = commit; transactions[revealId] = reveal;
      parentId = commitId; parentVout = 2; value -= 1436;
    }
  }
  const archive: ChainArchive = { schemaVersion: 1, network: raw.network, provider: 'fake', config: raw, configSha256: v.sha256,
    anchor: blocks.at(-1)!, blocks, addresses, transactions, capturedAt: '2026-10-01T00:00:00.000Z',
    monitorVersion: 'fixture', codeRevision: 'fixture', responses: {}, digest: '' };
  reindexFixture(archive);
  return { archive, v };
}
export function reindexFixture(a: ChainArchive) {
  for (const address of a.addresses) address.txids = Object.values(a.transactions).filter(tx => tx.vout.some(o => o.scriptpubkey === address.script) ||
    tx.vin.some(i => i.prevout?.scriptpubkey === address.script)).map(tx => tx.txid).sort();
  const data: Partial<ChainArchive> = { ...a }; delete data.digest; a.digest = digest(data);
}
