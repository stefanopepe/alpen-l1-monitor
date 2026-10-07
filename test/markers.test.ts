import { expect, it } from 'vitest';
import { markerFeeBand, transactionMarkers } from '../src/replay/report/markers.js';
import { transactionUrl } from '../src/ui/explorer.js';
import type { TransactionSummary } from '../src/transactions.js';
import { renderPage } from '../src/ui/page.js';
const hour = 3600000;
const tx = (id: number, vsize = 200, rate = 2): TransactionSummary => ({ wallet: 'ee', txid: String(id).padStart(64, '0'), height: id,
  blockHash: String(id).padStart(64, '0'), time: id * 3600, kind: 'commit', vsize, feeSats: vsize * rate, feeRate: rate,
  benchmark: { kind: 'block_median', rate: 2, start: 0, end: 0 } });
it('colors historical fees against their own benchmark and leaves missing or rounded-zero references unknown', () => {
  expect(markerFeeBand([tx(1, 200, 1)])).toBe('below');
  expect(markerFeeBand([tx(1, 200, 2.1)])).toBe('typical');
  expect(markerFeeBand([tx(1, 200, 4)])).toBe('above');
  expect(markerFeeBand([{ ...tx(1), benchmark: null }])).toBe('unknown');
  expect(markerFeeBand([{ ...tx(1), benchmark: { kind: 'period_median', rate: 0, integerQuantized: true, start: 0, end: 1 } }])).toBe('unknown');
  expect(markerFeeBand([tx(1, 100, 4), tx(2, 900, 1)])).toBe('below');
});
it('keeps overview markers compact and sizes zoomed commits without enlarging crowded neighbors', () => {
  const transactions = [tx(1, 100), tx(2, 1000)];
  expect(transactionMarkers(transactions, { min: 0, max: 72 * hour }, 800).map(p => p.symbolSize)).toEqual([9, 9]);
  const zoomed = transactionMarkers(transactions, { min: 0, max: 6 * hour }, 800);
  expect(zoomed[1]!.symbolSize).toBeGreaterThan(zoomed[0]!.symbolSize!);
  expect(zoomed[0]!.symbolSize).toBe(9);
  transactions[1]!.time = transactions[0]!.time + 10;
  expect(transactionMarkers(transactions, { min: 0, max: 6 * hour }, 320).map(p => p.symbolSize)).toEqual([9, 9]);
  expect(transactionMarkers(transactions, { min: 0, max: 72 * hour }, 800).map(p => p.symbolSize)).toEqual([9, 9]);
});
it('makes real 172/208/276-vB differences visible without scaling against off-screen outliers', () => {
  const transactions = [tx(1, 172), tx(2, 208), tx(3, 276)];
  const range = { min: 0, max: 6 * hour };
  const markers = transactionMarkers(transactions, range, 800);
  expect(markers.map(p => p.symbolSize)).toEqual([9, expect.any(Number), expect.any(Number)]);
  expect(markers[1]!.symbolSize! - markers[0]!.symbolSize!).toBeGreaterThan(5);
  expect(markers[2]!.symbolSize! - markers[1]!.symbolSize!).toBeGreaterThan(7);
  expect(markers.map(p => p.label?.formatter)).toEqual(['172 vB', '208 vB', '276 vB']);
  expect(markers.every(p => p.label?.show)).toBe(true);
  const withOutlier = transactionMarkers([...transactions, tx(100, 1000000)], range, 800);
  expect(withOutlier.slice(0, 3).map(p => p.symbolSize)).toEqual(markers.map(p => p.symbolSize));
});
it('preserves equal-sized commits and does not exaggerate one-vB rounding differences', () => {
  const markers = transactionMarkers([tx(1, 172), tx(2, 172), tx(3, 173)], { min: 0, max: 6 * hour }, 800);
  expect(markers[0]!.symbolSize).toBe(markers[1]!.symbolSize);
  expect(markers[2]!.symbolSize! - markers[1]!.symbolSize!).toBeLessThan(0.2);
});
it('links to the evidence network and refuses unsupported networks or invalid transaction IDs', () => {
  expect(transactionUrl('mainnet', tx(1).txid)).toBe('https://mempool.space/tx/' + tx(1).txid);
  expect(transactionUrl('signet', tx(1).txid)).toBe('https://mempool.space/signet/tx/' + tx(1).txid);
  expect(transactionUrl('custom-signet', tx(1).txid)).toBeNull();
  expect(transactionUrl('signet', '<script>')).toBeNull();
});
it('offers the correct deployed network destinations, including mainnet archives viewed on a Signet host', () => {
  for (const network of ['mainnet', 'signet']) {
    const html = renderPage('<html lang="en"><!-- NETWORK_BANNER --></html>', network);
    expect(html).toContain('aria-label="Switch Bitcoin network"');
    expect(html).toContain(`value="https://ee-ol-wallet-monitor${network === 'signet' ? '-signet' : ''}.vercel.app/" selected`);
    expect(html).toContain('https://ee-ol-wallet-monitor.vercel.app/');
    expect(html).toContain('https://ee-ol-wallet-monitor-signet.vercel.app/');
  }
});
