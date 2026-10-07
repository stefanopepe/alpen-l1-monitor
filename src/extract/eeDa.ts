import type { ChainTx } from '../chain/schemas.js';
import type { EeDaContext, PendingEeDa, PostedEeDa, Tip } from '../types.js';
import { median } from '../model/naive.js';
import { commitOutputs, revealShaped, validFee } from './classify.js';
import { firstEnvelopeEvidence, hexBytes, push } from './envelope.js';
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
  const pendingDetails: PendingEeDa[] = [];
  const samples: { height: number; payload: number; revealVsize: number; chunks: number; blocks: number; seconds: number }[] = [];
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
    const chunks = reveals.map(firstEnvelopeEvidence);
    if (pending) {
      pendingPublications++;
      pendingDetails.push({ commitTxid: commit.txid, blockHeight: commit.status.block_height!, blockTime: commit.status.block_time!,
        chunkCount: funding.length, confirmedChunks: reveals.length,
        observedPayloadBytes: chunks.every(chunk => chunk !== null) ? chunks.reduce((sum, chunk) => sum + chunk!.payloadBytes, 0) : null,
        commitVsize: Math.ceil(commit.weight / 4), confirmedRevealVsize: reveals.reduce((sum, tx) => sum + Math.ceil(tx.weight / 4), 0),
        estimatedPayloadBytes: null, estimatedRemainingVsize: null, estimatedTotalVsize: null,
        expectedBlockHeight: null, expectedAt: null, sampleSize: 0 });
      continue;
    }
    if (chunks.some(chunk => !chunk?.payloadBytes)) { undecodedPublications++; continue; }
    const payloadBytes = chunks.reduce((sum, chunk) => sum + chunk!.payloadBytes, 0);
    const payload = Buffer.concat(chunks.map(chunk => Buffer.from(chunk!.prefixHex, 'hex'))).subarray(0, 48);
    // Six big-endian u64s: sequence, last EVM block, timestamp, base fee, gas used, gas limit.
    // Following bytes encode BatchStateDiff; this monitor reports header metadata only.
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 48) { undecodedPublications++; continue; }
    const completion = [commit, ...reveals].reduce((last, tx) => tx.status.block_height! > last.status.block_height! ? tx : last);
    samples.push({ height: completion.status.block_height!, payload: payloadBytes, chunks: funding.length,
      revealVsize: reveals.reduce((sum, tx) => sum + Math.ceil(tx.weight / 4), 0),
      blocks: completion.status.block_height! - commit.status.block_height!,
      seconds: Math.max(0, completion.status.block_time! - commit.status.block_time!) });
    const posted: PostedEeDa = { updateSeqNo: payload.readBigUInt64BE(0).toString(), lastEvmBlock: payload.readBigUInt64BE(8).toString(),
      evmTimestamp: payload.readBigUInt64BE(16).toString(), version: 0, commitTxid: commit.txid, revealTxids: reveals.map(tx => tx.txid),
      chunkCount: funding.length, payloadBytes, blockHeight: completion.status.block_height!,
      blockHash: completion.status.block_hash!, blockTime: completion.status.block_time! };
    if (!latest || BigInt(posted.updateSeqNo) > BigInt(latest.updateSeqNo) || (posted.updateSeqNo === latest.updateSeqNo &&
      (posted.blockHeight > latest.blockHeight || (posted.blockHeight === latest.blockHeight && posted.commitTxid > latest.commitTxid)))) latest = posted;
  }
  // Use only completed, decoded publications preceding each pending commit. Unknown
  // witnesses cannot reveal exact payload sizes; all extrapolated values stay labelled.
  for (const p of pendingDetails) {
    const previous = samples.filter(s => s.height <= p.blockHeight).sort((a, b) => b.height - a.height).slice(0, 20);
    p.sampleSize = previous.length;
    if (!previous.length || !coverageComplete) continue;
    const remaining = p.chunkCount - p.confirmedChunks;
    // If an already-confirmed chunk is unreadable, do not call its payload zero.
    p.estimatedPayloadBytes = p.observedPayloadBytes !== null ? p.observedPayloadBytes + Math.ceil(median(previous.map(s => s.payload / s.chunks))! * remaining) : null;
    p.estimatedRemainingVsize = Math.ceil(median(previous.map(s => s.revealVsize / s.chunks))! * remaining);
    p.estimatedTotalVsize = p.commitVsize + p.confirmedRevealVsize + p.estimatedRemainingVsize;
    // At least three complete packages are needed to claim a historical timing estimate.
    if (previous.length >= 3) {
      p.expectedBlockHeight = p.blockHeight + Math.ceil(median(previous.map(s => s.blocks))!);
      p.expectedAt = p.blockTime + Math.ceil(median(previous.map(s => s.seconds))!);
    }
  }
  return { sourceRef: EPOCH_SOURCE_REF, latest, coverageComplete, pendingPublications, undecodedPublications,
    pending: pendingDetails.sort((a, b) => a.blockHeight - b.blockHeight || a.commitTxid.localeCompare(b.commitTxid)) };
}
