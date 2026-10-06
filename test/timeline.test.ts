import { expect, it } from 'vitest';
import { init } from 'echarts/core';
import { timelineOptions } from '../src/replay/report/timeline.js';
import type { Burndown } from '../src/replay/report/burndown.js';
import type { TransactionSummary } from '../src/transactions.js';

const day = 86400000, start = Date.UTC(2026, 6, 1);
const burn: Burndown = {
  origin: start + 90 * day, balance: 1000, dailySats: 100, depletion: start + 100 * day,
  from: start + 83 * day, to: start + 102 * day, recordedThrough: start + 90 * day,
  actual: [{ x: start, y: 2000 }, { x: start + 80 * day, y: 1000 }, { x: start + 82 * day, y: null }, { x: start + 90 * day, y: 1000 }],
  projected: [{ x: start + 90 * day, y: 1000 }, { x: start + 100 * day, y: 0 }],
};
const transactions: TransactionSummary[] = ['commit', 'reveal'].map((kind, i) => ({
  wallet: 'ee', txid: String(i).repeat(64), height: 100, time: (start + 89 * day) / 1000, blockHash: 'b'.repeat(64),
  kind: kind as 'commit' | 'reveal', vsize: 172, feeSats: 500, feeRate: 500 / 172, benchmark: null,
}));

it('uses ECharts native dataZoom across both panes and restores the default without altering evidence', () => {
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 900, height: 520 });
  try {
    chart.setOption(timelineOptions(burn, transactions, start));
    const originalSeries = chart.getOption().series;
    chart.dispatchAction({ type: 'dataZoom', startValue: start, endValue: start + 60 * day });
    const zooms = chart.getOption().dataZoom as { startValue: number; endValue: number }[];
    expect(zooms).toHaveLength(2);
    expect(zooms.every(z => z.startValue === start && z.endValue === start + 60 * day)).toBe(true);
    expect(chart.getOption().series).toEqual(originalSeries);
    chart.dispatchAction({ type: 'restore' });
    const restored = chart.getOption().dataZoom as { startValue: number; endValue: number }[];
    expect(restored.every(z => z.startValue === burn.from && z.endValue === burn.to)).toBe(true);
    expect(chart.renderToSVGString()).toContain('<svg');
  } finally { chart.dispose(); }
});

it('keeps separately inspectable commit/reveal data in the same block and preserves missing balance samples', () => {
  const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 900, height: 520 });
  try {
    chart.setOption(timelineOptions(burn, transactions, start));
    const series = chart.getOption().series as { id: string; data: unknown[] }[];
    expect(series.find(s => s.id === 'funding')!.data).toContainEqual([start + 82 * day, null]);
    const events = series.filter(s => s.id.startsWith('transactions-')).flatMap(s => s.data) as { txid: string; transactions: TransactionSummary[] }[];
    expect(events).toHaveLength(2);
    expect(events.map(e => e.txid).sort()).toEqual(transactions.map(t => t.txid).sort());
    expect(events.flatMap(e => e.transactions)).toEqual(expect.arrayContaining(transactions));
  } finally { chart.dispose(); }
});
