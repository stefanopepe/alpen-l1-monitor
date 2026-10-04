import type { EpochContext, Tip } from '../types.js';

export function epochReportLines(context: EpochContext | undefined, tip: Tip): string[] {
  const title = 'Most recent observed OL epoch posted to L1';
  if (!context) return [`${title}: unavailable (not collected; refresh collection or rebuild replay).`];
  const p = context.latest;
  const lines = p ? [`${title}: ${p.epoch}`,
    `Posted in Bitcoin block ${p.blockHeight} at ${new Date(p.blockTime * 1000).toISOString()} | ${tip.height - p.blockHeight + 1} confirmations at report block ${tip.height}`,
    `Reveal transaction: ${p.txid}`,
    `Checkpoint covers L1 through block ${p.l1Height} | OL slot ${p.l2Slot} | OL block ${p.l2BlockId}`] :
    [`${title}: unavailable (no decodable checkpoint in retained wallet history).`];
  if (!context.coverageComplete) lines.push('Partial history or discovery: a newer posting may be missing.');
  if (context.undecodedCheckpoints) lines.push(`${context.undecodedCheckpoints} checkpoint posting(s) could not be decoded; the most recent epoch may be unavailable.`);
  lines.push('Alpen v0.3.2 format: observed posted claim; checkpoint proof and ASM acceptance are not verified.');
  return lines;
}
