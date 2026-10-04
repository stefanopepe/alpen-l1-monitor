import { envelopePayloads, hexBytes, push } from './envelope.js';
import type { ChainTx } from '../chain/schemas.js';
import type { EpochContext, PostedEpoch, Tip } from '../types.js';
import { commitOutputs, revealShaped, validFee } from './classify.js';

export const EPOCH_SOURCE_REF = '60dae8ee2ed9ec9c75b9e52a7382b7c52d7835b6'; // alpen v0.3.2
export function isCheckpointTag(tx: ChainTx, magicHex: string): boolean {
  try {
    const script = hexBytes(tx.vout[0]!.scriptpubkey), cursor = { at: 1 };
    if (script[0] !== 0x6a) return false;
    const tag = push(script, cursor);
    return cursor.at === script.length && tag.length >= 6 && tag.length <= 80 &&
      tag.subarray(0, 4).toString('hex') === magicHex && tag[4] === 1 && tag[5] === 1;
  } catch { return false; }
}
/** Decode the posted claim, not ASM acceptance, sequencer authentication, or its ZK proof. */
export function decodeCheckpoint(tx: ChainTx, magicHex = '53545241'): Omit<PostedEpoch, 'commitTxid' | 'txid' | 'blockHeight' | 'blockHash' | 'blockTime'> | null {
  try {
    if (!isCheckpointTag(tx, magicHex)) return null;
    const payloads = envelopePayloads(tx);
    if (!payloads) return null;
    // The upstream extractor decodes the first envelope as CodecSsz<CheckpointPayload>.
    const raw = payloads[0];
    if (!raw?.length) return null;
    const width = raw[0]! < 128 ? 1 : raw[0]! < 192 ? 2 : 4;
    const length = raw.readUIntBE(0, width) & (width === 1 ? 0x7f : width === 2 ? 0x3fff : 0x3fffffff);
    if (raw.length !== width + length) return null;
    const ssz = raw.subarray(width);
    // CheckpointTip: epoch u32, consumed L1 height u32, OL slot u64, OL block ID bytes32.
    // Followed by two SSZ offsets (sidecar and proof). See docs/l1-epoch.md.
    if (ssz.length < 168 || ssz.readUInt32LE(48) !== 56) return null;
    const proofOffset = ssz.readUInt32LE(52);
    if (proofOffset < 168 || proofOffset > ssz.length || ssz.length - proofOffset > 4096) return null;
    const sidecar = ssz.subarray(56, proofOffset), logsOffset = sidecar.readUInt32LE(4);
    if (sidecar.readUInt32LE(0) !== 112 || logsOffset < 112 || logsOffset > sidecar.length || logsOffset - 112 > 262144) return null;
    return { epoch: ssz.readUInt32LE(0), l1Height: ssz.readUInt32LE(4),
      // Keep the u64 exact in JSON, including values beyond Number.MAX_SAFE_INTEGER.
      l2Slot: ssz.readBigUInt64LE(8).toString(), l2BlockId: ssz.subarray(16, 48).toString('hex') };
  } catch { return null; }
}
export function latestPostedEpoch(transactions: Record<string, ChainTx>, scripts: ReadonlySet<string>, tip: Tip,
  coverageComplete: boolean, magicHex = '53545241'): EpochContext {
  let latest: PostedEpoch | null = null, undecodedCheckpoints = 0;
  for (const tx of Object.values(transactions)) {
    if (!tx.status.confirmed || tx.status.block_height! > tip.height || !isCheckpointTag(tx, magicHex)) continue;
    const input = tx.vin[0]!, commit = transactions[input.txid];
    // Attribute the reveal to the watched wallet, not an arbitrary incoming transaction.
    if (!commit?.status.confirmed || commit.status.block_height! > tx.status.block_height! ||
      !commitOutputs(commit, scripts)?.includes(input.vout) || !revealShaped(commit, input.vout, tx, scripts) || !validFee(commit) || !validFee(tx)) continue;
    const claim = decodeCheckpoint(tx, magicHex);
    if (!claim || claim.l1Height > tx.status.block_height!) { undecodedCheckpoints++; continue; }
    const posted = { ...claim, commitTxid: commit.txid, txid: tx.txid, blockHeight: tx.status.block_height!,
      blockHash: tx.status.block_hash!, blockTime: tx.status.block_time! };
    if (!latest || posted.epoch > latest.epoch || (posted.epoch === latest.epoch &&
      (posted.blockHeight > latest.blockHeight || (posted.blockHeight === latest.blockHeight && posted.txid > latest.txid)))) latest = posted;
  }
  return { sourceRef: EPOCH_SOURCE_REF, latest, coverageComplete, undecodedCheckpoints };
}
