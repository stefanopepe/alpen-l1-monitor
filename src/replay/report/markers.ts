import type { TransactionSummary } from '../../transactions.js';

export const markerColors = { below: '#167b70', typical: '#466a9f', above: '#c27616', unknown: '#8b929c' };
export function markerFeeBand(transactions: readonly TransactionSummary[]): keyof typeof markerColors {
  if (transactions.some(t => !t.benchmark || (t.benchmark.integerQuantized && t.benchmark.rate === 0))) return 'unknown';
  const paid = transactions.reduce((sum, t) => sum + t.feeSats, 0);
  const reference = transactions.reduce((sum, t) => sum + t.vsize * t.benchmark!.rate, 0);
  // A whole-sat historical quote cannot resolve differences smaller than half a sat/vB.
  const tolerance = Math.max(reference * 0.1, transactions.reduce((sum, t) => sum + (t.benchmark!.integerQuantized ? t.vsize * 0.5 : 0), 0));
  return paid < reference - tolerance ? 'below' : paid > reference + tolerance ? 'above' : 'typical';
}

export interface MarkerPoint {
  value: [number, string]; txid: string; transactions: TransactionSummary[];
  symbolSize?: number; itemStyle?: { color: string };
  label?: { show: boolean; formatter: string; position: 'top'; distance: number; fontSize: number; color: string };
}
export const commitVsize = (point: MarkerPoint) => point.transactions.reduce((sum, tx) => sum + tx.vsize, 0);
export function transactionMarkers(transactions: readonly TransactionSummary[], range: { min: number; max: number }, plotWidth: number): MarkerPoint[] {
  const groups = new Map<string, MarkerPoint>();
  for (const tx of transactions) {
    const lane = tx.kind === 'commit' ? 'Commit' : tx.kind === 'reveal' ? 'Reveal' : 'Wallet action';
    const key = tx.blockHash + ':' + lane, group = groups.get(key);
    if (group) group.transactions.push(tx);
    else groups.set(key, { value: [tx.time * 1000, lane], txid: tx.txid, transactions: [tx] });
  }
  const points = [...groups.values()], span = Math.max(1, range.max - range.min);
  // Full size contrast at a one-day view; fade back to compact markers by 48h.
  const detail = Math.max(0, Math.min(1, (48 * 3600000 - span) / (24 * 3600000)));
  const commits = points.filter(p => p.value[1] === 'Commit').sort((a, b) => a.value[0] - b.value[0]);
  const visibleSizes = commits.filter(p => p.value[0] >= range.min && p.value[0] <= range.max).map(commitVsize);
  const smallest = Math.max(1, visibleSizes.length ? Math.min(...visibleSizes) : 1);
  // Relative logarithmic sizes make meaningful differences visible without letting
  // an off-screen outlier flatten the view, or magnifying 1-vB rounding differences.
  const scale = Math.max(1, Math.log2(Math.max(smallest, ...visibleSizes) / smallest));
  for (const p of points) {
    p.symbolSize = 9;
    p.itemStyle = { color: p.value[1] === 'Wallet action' ? '#bc8731' : markerColors[markerFeeBand(p.transactions)] };
  }
  for (const [index, p] of commits.entries()) {
    const left = commits[index - 1], right = commits[index + 1];
    const gap = Math.min(left ? p.value[0] - left.value[0] : Infinity, right ? right.value[0] - p.value[0] : Infinity) / span * Math.max(1, plotWidth);
    const relative = Math.max(0, Math.min(1, Math.log2(commitVsize(p) / smallest) / scale));
    const desired = 9 + 19 * relative * detail;
    p.symbolSize = Math.max(9, Math.min(desired, gap * 0.8));
    p.label = { show: detail > 0 && gap >= 64 && p.value[0] >= range.min && p.value[0] <= range.max,
      formatter: commitVsize(p).toLocaleString('en-US') + ' vB', position: 'top', distance: 4, fontSize: 10, color: '#536777' };
  }
  return points;
}
