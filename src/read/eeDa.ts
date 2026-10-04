import type { EeDaContext, Tip } from '../types.js';

export function eeDaReportLines(context: EeDaContext | undefined, tip: Tip): string[] {
  const title = 'Most recent observed EE DA update fully posted to L1';
  if (!context) return [`${title}: unavailable (not collected; refresh collection or rebuild replay).`];
  const p = context.latest;
  const lines = p ? [`${title}: #${p.updateSeqNo}`,
    `Last EVM block covered: ${p.lastEvmBlock} | ${p.chunkCount}/${p.chunkCount} data chunks confirmed | ${p.payloadBytes} bytes`,
    `Publication complete in Bitcoin block ${p.blockHeight} at ${new Date(p.blockTime * 1000).toISOString()} | ${tip.height - p.blockHeight + 1} confirmations at report block ${tip.height}`,
    `DA commit transaction: ${p.commitTxid}`,
    `DA reveal transaction${p.revealTxids.length === 1 ? '' : 's'}: ${p.revealTxids.join(', ')}`] :
    [`${title}: unavailable (no complete decodable publication in retained wallet history).`];
  if (context.pendingPublications) lines.push(`${context.pendingPublications} DA publication(s) awaiting all confirmed reveal chunks in observed history.`);
  if (!context.coverageComplete) lines.push('Partial history or discovery: a newer DA update may be missing.');
  if (context.undecodedPublications) lines.push(`${context.undecodedPublications} DA publication(s) could not be decoded; the most recent update may be unavailable.`);
  lines.push('EE update sequence is independent of the OL epoch. Posted data observed; state diff, proof and OL acceptance are not verified.');
  return lines;
}
