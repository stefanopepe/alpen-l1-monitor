import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Script } from '@scure/btc-signer';
import { txSchema, type ChainTx } from '../src/chain/schemas.js';
import { decodeCheckpoint, EPOCH_SOURCE_REF, isCheckpointTag, latestPostedEpoch } from '../src/extract/epoch.js';
import { epochReportLines } from '../src/read/epoch.js';
import { snapshotSchema, type ReadModel } from '../src/read/model.js';
import { renderMetrics, renderText } from '../src/read/render.js';
import { replayAt } from '../src/replay/run.js';
import { ArchiveIndex } from '../src/replay/asOfView.js';
import { replayFixture, reindexFixture } from './replay-fixture.js';
import { hash } from './helpers.js';
const fixture = () => {
  const f = JSON.parse(readFileSync('test/fixtures/mainnet/ol-settlement.json', 'utf8'));
  return { commit: txSchema.parse(f.commit), reveal: txSchema.parse(f.reveals[0]), scripts: new Set<string>(f.wallet_scripts), tip: f.provenance.tip };
};
function rewritePayload(tx: ChainTx, change: (bytes: Buffer) => Buffer, chunkSize = 520) {
  const witness = tx.vin[0]!.witness!, ops = Script.decode(Buffer.from(witness[1]!, 'hex'));
  const raw = Buffer.concat(ops.slice(4, -1) as Uint8Array[]), edited = change(raw), chunks: Buffer[] = [];
  for (let at = 0; at < edited.length; at += chunkSize) chunks.push(edited.subarray(at, at + chunkSize));
  witness[1] = Buffer.from(Script.encode([ops[0]!, 'CHECKSIG', 0, 'IF', ...chunks, 'ENDIF'])).toString('hex');
}
it('decodes the captured mainnet OL checkpoint using the v0.3.2 CodecSsz framing', () => {
  const { reveal } = fixture();
  expect(decodeCheckpoint(reveal)).toEqual({ epoch: 103, l1Height: 969386, l2Slot: '1030',
    l2BlockId: 'a9d412d063ec1e5ea7529fce377d18dd5a59e91dac6da6015dff2e77faa97a18' });
  // Epoch zero is real; u64 slots must not lose precision in JSON.
  rewritePayload(reveal, raw => { raw.writeUInt32LE(0, 2); raw.writeBigUInt64LE(18446744073709551615n, 10); return raw; }, 3);
  expect(decodeCheckpoint(reveal)).toMatchObject({ epoch: 0, l2Slot: '18446744073709551615' });
  reveal.vin[0]!.witness!.push('50abcd');
  expect(decodeCheckpoint(reveal)?.epoch).toBe(0);
});
it('supports four-byte upstream length prefixes and configurable magic', () => {
  const { reveal } = fixture();
  rewritePayload(reveal, raw => { const prefix = Buffer.alloc(4); prefix.writeUInt32BE(0xc0000000 + raw.length - 2); return Buffer.concat([prefix, raw.subarray(2)]); });
  reveal.vout[0]!.scriptpubkey = '6a06414c504e0101';
  expect(decodeCheckpoint(reveal)).toBeNull();
  expect(decodeCheckpoint(reveal, '414c504e')?.epoch).toBe(103);
});
it.each(['length', 'truncated', 'offset', 'sidecar', 'opcode', 'hex', 'missing_witness', 'tag', 'tag_position'])('rejects %s without inventing an epoch', kind => {
  const { reveal } = fixture();
  if (kind === 'length') rewritePayload(reveal, raw => { raw[1] = 0; return raw; });
  if (kind === 'truncated') rewritePayload(reveal, raw => raw.subarray(0, 15));
  if (kind === 'offset') rewritePayload(reveal, raw => { raw.writeUInt32LE(55, 50); return raw; });
  if (kind === 'sidecar') rewritePayload(reveal, raw => { raw.writeUInt32LE(111, 58); return raw; });
  if (kind === 'opcode') reveal.vin[0]!.witness![1] = reveal.vin[0]!.witness![1]!.slice(0, -2) + '93';
  if (kind === 'hex') reveal.vin[0]!.witness![1] += 'z';
  if (kind === 'missing_witness') delete reveal.vin[0]!.witness;
  if (kind === 'tag') reveal.vout[0]!.scriptpubkey = '6a06535452410102';
  if (kind === 'tag_position') reveal.vout.reverse();
  expect(decodeCheckpoint(reveal)).toBeNull();
});
it('selects the highest confirmed posted epoch, independent of order and block timestamps', () => {
  const { commit, reveal, scripts, tip } = fixture();
  const newer = structuredClone(reveal); newer.txid = hash(900); newer.status.block_height!++; newer.status.block_time!--;
  rewritePayload(newer, raw => { raw.writeUInt32LE(104, 2); return raw; });
  const txs = { [newer.txid]: newer, [commit.txid]: commit, [reveal.txid]: reveal };
  const result = latestPostedEpoch(txs, scripts, tip, true);
  expect(result).toMatchObject({ latest: { epoch: 104, txid: newer.txid, blockHeight: 969393, commitTxid: commit.txid }, coverageComplete: true, sourceRef: EPOCH_SOURCE_REF });
  expect(latestPostedEpoch(Object.fromEntries(Object.entries(txs).reverse()), scripts, tip, true)).toEqual(result);
  newer.status.confirmed = false;
  expect(latestPostedEpoch(txs, scripts, tip, true).latest?.epoch).toBe(103);
  newer.status.confirmed = true; newer.status.block_height = tip.height + 1;
  expect(latestPostedEpoch(txs, scripts, tip, true).latest?.epoch).toBe(103);
  reveal.status.confirmed = false;
  expect(latestPostedEpoch(txs, scripts, tip, false).latest).toBeNull();
});
it('requires wallet-funded commit/reveal evidence and exposes undecodable postings and partial coverage', () => {
  const { commit, reveal, scripts, tip } = fixture(), txs = { [commit.txid]: commit, [reveal.txid]: reveal };
  expect(latestPostedEpoch(txs, new Set(), tip, true).latest).toBeNull();
  expect(latestPostedEpoch({ [reveal.txid]: reveal }, scripts, tip, true).latest).toBeNull();
  reveal.vin[0]!.witness![1] = '00';
  const ctx = latestPostedEpoch(txs, scripts, tip, false);
  expect(ctx).toMatchObject({ latest: null, undecodedCheckpoints: 1, coverageComplete: false });
  expect(epochReportLines(ctx, tip).join('\n')).toContain('a newer posting may be missing');
  expect(epochReportLines(ctx, tip).join('\n')).toContain('could not be decoded');
});
it('reports a checkpoint only from its reveal block and removes it on a backward replay seek', async () => {
  const { archive, v } = replayFixture(), original = fixture().reveal;
  const olScript = archive.addresses.find(a => a.wallet === 'ol')!.script;
  const reveal = Object.values(archive.transactions).find(t => t.status.block_height === 41 && t.vout.some(o => o.scriptpubkey === olScript))!;
  reveal.vin[0]!.witness = original.vin[0]!.witness;
  rewritePayload(reveal, raw => { raw.writeUInt32LE(35, 6); return raw; });
  reveal.vout.unshift(original.vout[0]!);
  reindexFixture(archive);
  const index = new ArchiveIndex(archive);
  expect((await replayAt(index, v, 40, 'ol')).record.snapshot.epochContext?.latest).toBeNull();
  const snapshot = (await replayAt(index, v, 41, 'ol')).record.snapshot;
  expect(snapshot.epochContext?.latest).toMatchObject({ epoch: 103, blockHeight: 41 });
  expect((await replayAt(index, v, 40, 'ol')).record.snapshot.epochContext?.latest).toBeNull();
  expect((await replayAt(index, v, 41, 'ee')).record.snapshot.epochContext).toBeUndefined();
  expect(snapshotSchema.parse(snapshot).epochContext).toEqual(snapshot.epochContext);
  const legacy = { ...snapshot }; delete legacy.epochContext;
  expect(snapshotSchema.parse(legacy).epochContext).toBeUndefined();
  const model: ReadModel = { network: 'mainnet', readAt: snapshot.asOf, primaryIsPublic: true, providerErrors: [],
    wallets: [{ wallet: 'ol', name: 'Alpen OL', stale: false, ageSeconds: 0, snapshot }] };
  expect(renderText(model)).toMatch(/Current Strata epoch:\s+103/);
  expect(renderText(model)).toMatch(/Confirmations:\s+1/);
  expect(renderText(model)).toMatch(/Proofs \/ acceptance:\s+Not verified/);
  expect(renderMetrics(model)).toContain('bridge_wallet_latest_posted_epoch{network="mainnet",wallet="ol"} 103');
  model.wallets[0]!.snapshot = legacy;
  expect(renderText(model)).toContain('Unavailable · not collected');
  expect(renderMetrics(model)).not.toContain('bridge_wallet_latest_posted_epoch{');
  expect(isCheckpointTag(original, '53545241')).toBe(true);
});
it('reproduces the latest live epoch captured on October 4 with complete scan coverage', () => {
  const raw = JSON.parse(readFileSync('test/fixtures/mainnet/ol-epoch-v032.json', 'utf8'));
  const commit = txSchema.parse(raw.commit), reveal = txSchema.parse(raw.reveals[0]);
  const ctx = latestPostedEpoch({ [commit.txid]: commit, [reveal.txid]: reveal }, new Set(raw.wallet_scripts), raw.provenance.tip, true);
  expect(ctx).toMatchObject({ latest: { epoch: 111, l1Height: 969834, l2Slot: '1110', blockHeight: 969840,
    txid: 'edfac662d71ad52e416b43da16689faccf04c8cb6d780bf7ccb869821a2a1769' }, undecodedCheckpoints: 0 });
});
