import { expect, it } from 'vitest';
import { inventory } from '../src/discovery/scan.js';
import { ProviderError } from '../src/chain/errors.js';
import { compactHistory, emptyHistory, sampleHistory } from '../src/extract/history.js';
import { revealShaped } from '../src/extract/classify.js';
import { computeWalletSnapshot } from '../src/pipeline/snapshot.js';
import { address, config, fakeView, hash, pair, utxo } from './helpers.js';
function fixture() {
  const v = config(), tip = { height: 150, hash: hash(150), blockTime: 90000 };
  const saved = computeWalletSnapshot({ asOfEpoch: 100000, utxos: [utxo(546)], settlements: [], estimator: v.config.estimator, historyComplete: false,
    meta: { network: 'mainnet', wallet: 'ee', asOf: new Date(100000000).toISOString(), finishedAt: new Date(100000000).toISOString(), provider: 'fake', tip,
      ceilingHit: { receive: false, change: false }, addressesScanned: 1, requestsUsed: 1, primaryIsPublic: true, networkTipOld: false,
      historyError: 'E_HISTORY_INCOMPLETE', monitorVersion: 'test', selectorModelVersion: 1, upstreamRef: v.config.upstream.ref, deployedBuildConfirmed: false, configSha256: v.sha256 } });
  const previous = { addresses: [address], utxos: [utxo(546)], snapshot: saved };
  const view = fakeView({ addressUtxos: async () => { throw new ProviderError('fake', 'utxo_limit'); },
    addressStats: async () => ({ chain_stats: { tx_count: 2 }, mempool_stats: { tx_count: 0 } }), blockHashAt: async () => tip.hash });
  return { previous, view };
}
it('reuses exact cached outpoints only when fresh counts and the previous block prove no address activity', async () => {
  const { previous, view } = fixture();
  expect((await inventory(view, [address], previous)).utxos).toEqual(previous.utxos);
  previous.utxos = [];
  expect((await inventory(view, [address], previous)).utxos).toEqual([]);
});
it('fails closed for new activity, mempool activity, provider changes, reorgs and absent cache', async () => {
  for (const change of [{ confirmedTxCount: 3 }, { mempoolTxCount: 1 }]) {
    const { previous, view } = fixture();
    await expect(inventory(view, [{ ...address, ...change }], previous)).rejects.toMatchObject({ kind: 'utxo_limit' });
  }
  const { previous, view } = fixture();
  await expect(inventory(view, [address])).rejects.toMatchObject({ kind: 'utxo_limit' });
  await expect(inventory({ ...view, provider: 'other' }, [address], previous)).rejects.toMatchObject({ kind: 'utxo_limit' });
  await expect(inventory({ ...view, blockHashAt: async () => hash(999) }, [address], previous)).rejects.toMatchObject({ kind: 'inconsistent' });
  await expect(inventory({ ...view, addressStats: async () => ({ chain_stats: { tx_count: 3 }, mempool_stats: { tx_count: 0 } }) }, [address], previous)).rejects.toMatchObject({ kind: 'inconsistent' });
  previous.utxos[0]!.confirmed = false;
  await expect(inventory(view, [address], previous)).rejects.toMatchObject({ kind: 'inconsistent' });
});
it('compacts witness payloads without changing reveal classification or settlement estimates', async () => {
  const { commit, reveal } = pair(), state = emptyHistory();
  reveal.vin[0]!.witness![1] = 'ab'.repeat(100000);
  state.transactions = { [commit.txid]: commit, [reveal.txid]: reveal };
  state.reveals[commit.txid] = [reveal];
  state.addresses[address.address] = { txids: [commit.txid, reveal.txid], coveredSince: -1, cursor: null };
  const compact = compactHistory(state), r = compact.transactions[reveal.txid]!;
  expect(revealShaped(commit, 1, r, new Set([address.script]))).toBe(true);
  expect(r.vin[0]!.witness).toBeUndefined();
  expect(r.vin[0]!.witnessItemCount).toBe(3);
  expect(reveal.vin[0]!.witness![1]).toHaveLength(200000);
  expect(JSON.stringify(compact).length).toBeLessThan(5000);
  const view = fakeView({ addressTxsChain: async () => [reveal, commit] });
  const a = await sampleHistory(view, [address], state, config().config, await view.tip(), 120000);
  const b = await sampleHistory(view, [address], compact, config().config, await view.tip(), 120000);
  expect(b.settlements).toEqual(a.settlements); expect(b.complete).toBe(true);
});
