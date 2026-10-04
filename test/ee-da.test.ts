import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { Script } from '@scure/btc-signer';
import { txSchema, type ChainTx } from '../src/chain/schemas.js';
import { latestEeDa } from '../src/extract/eeDa.js';
import { eeDaReportLines } from '../src/read/eeDa.js';
import { snapshotSchema } from '../src/read/model.js';
import { replayAt } from '../src/replay/run.js';
import { ArchiveIndex } from '../src/replay/asOfView.js';
import { replayFixture, reindexFixture } from './replay-fixture.js';
import { hash } from './helpers.js';
function fixture() {
  const f = JSON.parse(readFileSync('test/fixtures/mainnet/ee-settlement.json', 'utf8'));
  const commit = txSchema.parse(f.commit), reveal = txSchema.parse(f.reveals[0]);
  return { commit, reveal, scripts: new Set<string>(f.wallet_scripts), tip: f.provenance.tip };
}
function payload(tx: ChainTx) {
  return Buffer.concat(Script.decode(Buffer.from(tx.vin[0]!.witness![1]!, 'hex')).slice(4, -1) as Uint8Array[]);
}
function setPayload(tx: ChainTx, bytes: Buffer) {
  const pubkey = Script.decode(Buffer.from(tx.vin[0]!.witness![1]!, 'hex'))[0]!;
  tx.vin[0]!.witness![1] = Buffer.from(Script.encode([pubkey, 'CHECKSIG', 0, 'IF', bytes, 'ENDIF'])).toString('hex');
}
it('decodes the captured EE DA sequence and terminal EVM block, independently of OL epochs', () => {
  const { commit, reveal, scripts, tip } = fixture();
  const ctx = latestEeDa({ [commit.txid]: commit, [reveal.txid]: reveal }, scripts, tip, true);
  expect(ctx).toMatchObject({ latest: { updateSeqNo: '285', lastEvmBlock: '411840', version: 0,
    chunkCount: 1, payloadBytes: 60, commitTxid: commit.txid, revealTxids: [reveal.txid], blockHeight: 966607 },
    pendingPublications: 0, undecodedPublications: 0, coverageComplete: true });
  expect(eeDaReportLines(ctx, tip).join('\n')).toContain('Most recent observed EE DA update fully posted to L1: #285');
});
it('waits for every chunk, orders chunks by commit output and timestamps completion at the last reveal block', () => {
  const { commit, reveal, scripts, tip } = fixture();
  const second = structuredClone(reveal), raw = payload(reveal);
  second.txid = hash(999); second.vin[0]!.vout = 2; second.status.block_height!++;
  second.status.block_hash = hash(second.status.block_height!); second.status.block_time!--;
  commit.vout.splice(2, 0, structuredClone(commit.vout[1]!)); commit.vout[3]!.value -= commit.vout[1]!.value;
  setPayload(reveal, raw.subarray(0, 4)); setPayload(second, raw.subarray(4));
  const txs = { [second.txid]: second, [reveal.txid]: reveal, [commit.txid]: commit };
  expect(latestEeDa(txs, scripts, tip, true).latest).toMatchObject({ updateSeqNo: '285', chunkCount: 2,
    blockHeight: second.status.block_height, blockTime: second.status.block_time, revealTxids: [reveal.txid, second.txid] });
  second.status.confirmed = false;
  expect(latestEeDa(txs, scripts, tip, true)).toMatchObject({ latest: null, pendingPublications: 1 });
  second.status.confirmed = true;
  expect(latestEeDa(txs, scripts, { ...tip, height: reveal.status.block_height }, true)).toMatchObject({ latest: null, pendingPublications: 1 });
  const duplicate = { ...second, txid: hash(1000) };
  expect(latestEeDa({ ...txs, [duplicate.txid]: duplicate }, scripts, tip, true)).toMatchObject({ latest: null, undecodedPublications: 1 });
});
it('preserves sequence zero and u64 precision', () => {
  const { commit, reveal, scripts, tip } = fixture(), raw = payload(reveal);
  raw.writeBigUInt64BE(0n); raw.writeBigUInt64BE(18446744073709551615n, 8); setPayload(reveal, raw);
  const txs = { [commit.txid]: commit, [reveal.txid]: reveal };
  expect(latestEeDa(txs, scripts, tip, true).latest).toMatchObject({ updateSeqNo: '0', lastEvmBlock: '18446744073709551615' });
  raw.writeBigUInt64BE(18446744073709551615n); setPayload(reveal, raw);
  expect(latestEeDa(txs, scripts, tip, true).latest?.updateSeqNo).toBe('18446744073709551615');
});
it.each(['version', 'missing_witness', 'truncated', 'non_contiguous'])('reports %s as undecodable rather than advancing', kind => {
  const { commit, reveal, scripts, tip } = fixture();
  if (kind === 'version') commit.vout[0]!.scriptpubkey = '6a08414c504e00000001';
  if (kind === 'missing_witness') delete reveal.vin[0]!.witness;
  if (kind === 'truncated') setPayload(reveal, payload(reveal).subarray(0, 47));
  if (kind === 'non_contiguous') { [commit.vout[1], commit.vout[2]] = [commit.vout[2]!, commit.vout[1]!]; reveal.vin[0]!.vout = 2; }
  expect(latestEeDa({ [commit.txid]: commit, [reveal.txid]: reveal }, scripts, tip, false)).toMatchObject({ latest: null, undecodedPublications: 1, coverageComplete: false });
});
it('requires a confirmed wallet-funded ALPN commit and exposes legacy/partial coverage', () => {
  const { commit, reveal, scripts, tip } = fixture(), txs = { [commit.txid]: commit, [reveal.txid]: reveal };
  expect(latestEeDa(txs, new Set(), tip, true).latest).toBeNull();
  expect(eeDaReportLines(latestEeDa(txs, scripts, tip, false), tip).join('\n')).toContain('a newer DA update may be missing');
  commit.status.confirmed = false;
  expect(latestEeDa(txs, scripts, tip, true).latest).toBeNull();
  commit.status.confirmed = true; commit.vout[0]!.scriptpubkey = '6a084241442100000000';
  expect(latestEeDa(txs, scripts, tip, true).latest).toBeNull();
  expect(eeDaReportLines(undefined, tip).join('\n')).toContain('not collected');
});
it('keeps future DA out of earlier snapshots and retains the context in stored-read validation', async () => {
  const { archive, v } = replayFixture(), original = fixture().reveal;
  const script = archive.addresses.find(a => a.wallet === 'ee')!.script;
  const reveal = Object.values(archive.transactions).find(t => t.status.block_height === 41 && t.vout.some(o => o.scriptpubkey === script))!;
  reveal.vin[0]!.witness = original.vin[0]!.witness;
  reindexFixture(archive);
  const index = new ArchiveIndex(archive);
  expect((await replayAt(index, v, 40, 'ee')).record.snapshot.eeDaContext?.latest).toBeNull();
  const s = (await replayAt(index, v, 41, 'ee')).record.snapshot;
  expect(s.eeDaContext?.latest).toMatchObject({ updateSeqNo: '285', blockHeight: 41 });
  expect(snapshotSchema.parse(s).eeDaContext).toEqual(s.eeDaContext);
  expect((await replayAt(index, v, 40, 'ee')).record.snapshot.eeDaContext?.latest).toBeNull();
  expect((await replayAt(index, v, 41, 'ol')).record.snapshot.eeDaContext).toBeUndefined();
});
