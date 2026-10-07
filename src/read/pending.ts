import type { Snapshot } from '../types.js';
import type { FeeReport } from './fees.js';
import { reportTime } from './time.js';

const number = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
export function pendingBlobLines(snapshot: Snapshot, fees: FeeReport, stale: boolean, readAt: string, timezone: string): string[] {
  const context = snapshot.eeDaContext;
  if (!context?.pendingPublications) return [];
  if (!context.pending?.length) return ['Pending blob sizes, timing and cost: unavailable in this saved scan; collected on the next wallet refresh.'];
  const lines: string[] = [], rate = !fees.stale ? fees.rates?.fastestFee : undefined;
  const current = !stale && !snapshot.networkTipOld;
  for (const [index, p] of context.pending.entries()) {
    const size = p.estimatedPayloadBytes, total = p.estimatedTotalVsize, remaining = p.estimatedRemainingVsize;
    lines.push('', `Pending blob ${index + 1} · ${p.confirmedChunks}/${p.chunkCount} reveal chunks confirmed`,
      `Pending blob commit: ${p.commitTxid}`,
      `Commit confirmed: block ${number(p.blockHeight)} · ${reportTime(p.blockTime, timezone)}`,
      `Blob payload: ${size === null ? 'Unavailable · unrevealed bytes are not public' : '≈' + number(size) + ' bytes'}`,
      `Payload virtual size: ${size === null ? 'Unavailable' : '≈' + number(size / 4) + ' vB · witness payload only'}`,
      `Total transaction size: ${total === null ? 'Unavailable' : '≈' + number(total) + ' vB · commit + all reveals, including overhead'}`,
      `Transaction overhead: ${total === null || size === null ? 'Unavailable' : '≈' + number(Math.max(0, total - size / 4)) + ' vB'}`,
      `Observed so far: ${p.observedPayloadBytes === null ? 'Unreadable payload' : number(p.observedPayloadBytes) + ' payload bytes'} · ${number(p.commitVsize + p.confirmedRevealVsize)} vB confirmed`,
      `Remaining reveal size: ${remaining === null ? 'Unavailable' : '≈' + number(remaining) + ' vB'}`);
    if (!current) lines.push('Expected completion: unavailable · stale wallet data or chain tip');
    else if (p.expectedAt === null || p.expectedBlockHeight === null) lines.push('Expected completion: unavailable · needs at least 3 previous complete publications');
    else {
      const blocks = p.expectedBlockHeight - snapshot.tip.height, minutes = (p.expectedAt * 1000 - Date.parse(readAt)) / 60000;
      lines.push(`Expected completion: ${reportTime(p.expectedAt, timezone)} · estimated block ${number(p.expectedBlockHeight)}`,
        blocks <= 0 || minutes <= 0 ? 'Historical completion estimate is overdue · awaiting reveals; no reliable remaining countdown' :
          `Time remaining: ≈${number(blocks)} Bitcoin blocks / ≈${number(Math.ceil(minutes))} minutes · based on observed commit-to-completion delays`);
    }
    const canPrice = current && rate !== undefined && remaining !== null;
    lines.push(`Expected remaining cost: ${canPrice ? '≈' + number(Math.ceil(remaining * rate)) + ' sats at ' + number(rate) + ' sat/vB' : 'Unavailable · needs fresh fees, wallet data and a size estimate'}`,
      `Whole publication at current fees: ${canPrice && total !== null ? '≈' + number(Math.ceil(total * rate)) + ' sats · includes the already-confirmed commit and reveals' : 'Unavailable'}`);
    if (canPrice) lines.push(`Fee basis: current high-priority recommendation · observed ${reportTime(fees.observedAt!, timezone)}; this is a price estimate, not the submitted fee`);
    lines.push(p.sampleSize && context.coverageComplete ? `Size basis: median per-chunk size from ${p.sampleSize} preceding complete publications; unseen chunks may differ. Timing assumes normal publication and confirmation.` :
      'Estimate basis: unavailable · no preceding decoded sample or incomplete history');
  }
  return lines;
}
