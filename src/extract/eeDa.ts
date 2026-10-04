import type { ChainTx } from '../chain/schemas.js';
import type { EeDaContext, PostedEeDa, Tip } from '../types.js';
import { commitOutputs, revealShaped, validFee } from './classify.js';
import { envelopePayloads, hexBytes, push } from './envelope.js';
import { EPOCH_SOURCE_REF } from './epoch.js';

function markerVersion(tx: ChainTx): number | null {
  try {
    const script = hexBytes(tx.vout[0]!.scriptpubkey), cursor = { at: 1 };
    if (script[0] !== 0x6a) return null;
    const marker = push(script, cursor);
    if (cursor.at !== script.length || marker.length !== 8 || marker.subarray(0, 4).toString('hex') !== '414c504e') return null;
    return marker.readUInt32BE(4);
  } catch { return null; }
}
/** Observe publication of every chunk; decode metadata without validating the state diff or proof. */
export function latestEeDa(transactions: Record<string, ChainTx>, scripts: ReadonlySet<string>, tip: Tip, coverageComplete: boolean): EeDaContext {
  let latest: PostedEeDa | null = null, pendingPublications = 0, undecodedPublications = 0;
  const confirmed = (tx: ChainTx) => tx.status.confirmed && tx.status.block_height! <= tip.height;
  const spends = new Map<string, ChainTx[]>();
  for (const tx of Object.values(transactions)) if (confirmed(tx)) {
    const input = tx.vin[0]!;
    const key = `${input.txid}:${input.vout}`;
    spends.set(key, [...spends.get(key) ?? [], tx]);
  }
  for (const commit of Object.values(transactions)) {
    const version = markerVersion(commit);
    if (version === null || !confirmed(commit)) continue;
    const funding = commitOutputs(commit, scripts);
    if (!funding || !validFee(commit)) continue;
    // v0's reveal outputs are the consecutive P2TR run immediately after output zero.
    if (version !== 0 || funding.some((vout, index) => vout !== index + 1)) { undecodedPublications++; continue; }
    const reveals: ChainTx[] = [];
    let pending = false, malformed = false;
    for (const vout of funding) {
      const candidates = spends.get(`${commit.txid}:${vout}`) ?? [];
      if (!candidates.length) { pending = true; continue; }
      const reveal = candidates[0]!;
      if (candidates.length !== 1 || reveal.status.block_height! < commit.status.block_height! ||
        !revealShaped(commit, vout, reveal, scripts) || !validFee(reveal)) { malformed = true; break; }
      reveals.push(reveal);
    }
    if (malformed) { undecodedPublications++; continue; }
    if (pending) { pendingPublications++; continue; }
    const chunks = reveals.map(tx => envelopePayloads(tx)?.[0]);
    if (chunks.some(chunk => !chunk?.length)) { undecodedPublications++; continue; }
    const payload = Buffer.concat(chunks as Buffer[]);
    // Six big-endian u64s: sequence, last EVM block, timestamp, base fee, gas used, gas limit.
    // Following bytes encode BatchStateDiff; this monitor reports header metadata only.
    if (payload.length <= 48) { undecodedPublications++; continue; }
    const completion = [commit, ...reveals].reduce((last, tx) => tx.status.block_height! > last.status.block_height! ? tx : last);
    const posted: PostedEeDa = { updateSeqNo: payload.readBigUInt64BE(0).toString(), lastEvmBlock: payload.readBigUInt64BE(8).toString(),
      evmTimestamp: payload.readBigUInt64BE(16).toString(), version: 0, commitTxid: commit.txid, revealTxids: reveals.map(tx => tx.txid),
      chunkCount: funding.length, payloadBytes: payload.length, blockHeight: completion.status.block_height!,
      blockHash: completion.status.block_hash!, blockTime: completion.status.block_time! };
    if (!latest || BigInt(posted.updateSeqNo) > BigInt(latest.updateSeqNo) || (posted.updateSeqNo === latest.updateSeqNo &&
      (posted.blockHeight > latest.blockHeight || (posted.blockHeight === latest.blockHeight && posted.commitTxid > latest.commitTxid)))) latest = posted;
  }
  return { sourceRef: EPOCH_SOURCE_REF, latest, coverageComplete, pendingPublications, undecodedPublications };
}
