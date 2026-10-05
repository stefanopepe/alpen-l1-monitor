import { expect, it, vi } from 'vitest';
import { observeCompletedFees, observeFees } from '../src/chain/fees.js';
import { summarizeFees } from '../src/read/fees.js';
import { renderText } from '../src/read/render.js';
import { completedBlockSchema } from '../src/observations/schema.js';
import type { FeeContext } from '../src/types.js';
import { hash } from './helpers.js';

const now = new Date('2026-10-05T08:00:00Z'), epoch = now.getTime() / 1000;
const tx = (id: number, fee: number, vsize = 100) => ({ txid: hash(id), fee, vsize, rate: 999 });
const txs = [tx(0, 0), tx(1, 20), tx(2, 30), tx(3, 90)];
const block = (height = 10, timestamp = epoch - 60, rows = txs) => ({ id: hash(height + 100), height, timestamp,
  weight: 10000, tx_count: rows.length, extras: { medianFee: 0, feeRange: [0.2, 0.3, 0.9], totalFees: rows.reduce((n, t) => n + t.fee, 0) } });
const quote = (blocks: ReturnType<typeof completedBlockSchema.parse>[], seconds = 0): FeeContext => ({ provider: 'mempool', observedAt: new Date(now.getTime() + seconds * 1000).toISOString(),
  status: 'available', rates: { fastestFee: 0.9, halfHourFee: 0.3, hourFee: 0.1, economyFee: 0.003, minimumFee: 0 }, error: null,
  completed: { observedAt: new Date(now.getTime() + seconds * 1000).toISOString(), status: 'available', blocks, error: null } });
const verified = (b: ReturnType<typeof block>, median: number | null = 0.3) => ({ ...b,
  transactionFees: { basis: 'median_transaction_fee_per_vbyte' as const, transactionCount: median === null ? 0 : b.tx_count - 1, medianSatVb: median } });

it('calculates a fractional median from actual fees, independent of empty space, upstream median and CPFP rate', async () => {
  const base = 'https://mempool.space/signet/api';
  const fetcher = vi.fn<typeof fetch>(async url => Response.json(String(url).endsWith('/blocks') ? [block()] : txs));
  const result = await observeCompletedFees(fetcher, () => now, base);
  expect(result.blocks?.[0]).toMatchObject({ extras: { medianFee: 0 }, transactionFees: { medianSatVb: 0.3, transactionCount: 3 } });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${base}/v1/blocks`, `${base}/v1/block/${block().id}/summary`]);
  const report = summarizeFees([quote(result.blocks!)], now);
  expect(report.latestBlock?.medianSatVb).toBe(0.3);
  const text = renderText({ network: 'signet', readAt: now.toISOString(), wallets: [], providerErrors: [], primaryIsPublic: false, fees: report });
  expect(text).toMatch(/Latest block · median:\s+0.3 · block 10/);
  expect(text).toMatch(/No priority\s+<0.01/);
});

it.each([
  { rows: [tx(0, 0), tx(1, 20, 100.25), tx(2, 30, 100.75)], expected: 25 / 101 },
  { rows: [tx(0, 0), tx(1, 0), tx(2, 0), tx(3, 30)], expected: 0 },
  { rows: [tx(0, 0)], expected: null },
])('rounds virtual sizes per transaction and distinguishes actual zero from coinbase-only blocks: $expected', async ({ rows, expected }) => {
  const result = await observeCompletedFees(async url => Response.json(String(url).endsWith('/blocks') ? [block(10, epoch - 60, rows)] : rows), () => now);
  expect(result.blocks?.[0]?.transactionFees).toMatchObject({ medianSatVb: expected, transactionCount: rows.length - 1 });
});

it.each([
  { name: 'missing transaction', rows: txs.slice(0, -1) },
  { name: 'duplicate transaction', rows: [txs[0], txs[1], txs[1], txs[3]] },
  { name: 'mismatched fee total', rows: [txs[0], txs[1], txs[2], tx(3, 91)] },
  { name: 'invalid virtual size', rows: [txs[0], txs[1], txs[2], tx(3, 90, 0)] },
  { name: 'fractional satoshi fee', rows: [txs[0], txs[1], txs[2], tx(3, 90.1)] },
  { name: 'coinbase out of order', rows: [txs[1], txs[0], txs[2], txs[3]] },
])('excludes $name instead of turning bad source data into a zero fee', async ({ rows }) => {
  const result = await observeCompletedFees(async url => Response.json(String(url).endsWith('/blocks') ? [block()] : rows), () => now);
  expect(result.status).toBe('available');
  expect(result.blocks?.[0]?.transactionFees).toBeUndefined();
  expect(result.blocks?.[0]?.transactionFeesError).toMatch(/^E_BLOCK_FEES_/);
  expect(summarizeFees([quote(result.blocks!)], now)).toMatchObject({ latestBlock: { medianSatVb: null },
    blocks24h: { count: 0, average: null, unavailableCount: 1, complete: false } });
});

it('tolerates only sub-microsatoshi floating-point conversion noise in upstream transaction fees', async () => {
  const rows = [tx(0, 0), tx(1, 27300.000000000004, 182.5)];
  const b = { ...block(10, epoch - 60, rows), extras: { ...block().extras, totalFees: 27300 } };
  const result = await observeCompletedFees(async url => Response.json(String(url).endsWith('/blocks') ? [b] : rows), () => now);
  expect(result.blocks?.[0]?.transactionFees?.medianSatVb).toBe(27300 / 183);
});

it('keeps good blocks and quotes after summary errors and ignores provider-supplied calculated fields', async () => {
  const result = await observeFees(async url => {
    const path = String(url);
    if (path.endsWith('/recommended')) return Response.json(quote([block()]).rates);
    if (path.endsWith('/blocks')) return Response.json([block(), { ...verified(block(11)), transactionFeesError: 'E_BLOCK_FEES_FAKE' }, block(12)]);
    if (path.includes(hash(110))) return Response.json(txs);
    if (path.includes(hash(111))) return new Response('private upstream message', { status: 429 });
    throw new Error('secret URL');
  }, () => now);
  expect(result).toMatchObject({ status: 'available', completed: { status: 'available', blocks: [
    { transactionFees: { medianSatVb: 0.3 } }, { transactionFeesError: 'E_BLOCK_FEES_RATE_LIMITED' }, { transactionFeesError: 'E_BLOCK_FEES_UNAVAILABLE' },
  ] } });
  expect(result.completed?.blocks?.[1]?.transactionFees).toBeUndefined();
  expect(JSON.stringify(result)).not.toMatch(/secret|private/);
});

it('limits summary concurrency to three and bounds the number of requests', async () => {
  let active = 0, peak = 0, summaries = 0;
  await observeCompletedFees(async url => {
    if (String(url).endsWith('/blocks')) return Response.json(Array.from({ length: 15 }, (_, i) => block(i + 1)));
    active++; summaries++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    return Response.json(txs);
  }, () => now);
  expect(peak).toBe(3); expect(summaries).toBe(15);
});

it('uses only verified transaction medians for the 24-hour average and labels legacy data as unavailable', () => {
  const blocks = [verified(block(1, epoch - 86401)), verified(block(2), 0.2), verified(block(3), 0.8), block(4), verified(block(5), null)];
  let report = summarizeFees([quote(blocks)], now);
  expect(report.blocks24h).toEqual({ lowest: 0.2, highest: 0.8, average: 0.5, count: 2, unavailableCount: 1, emptyCount: 1, complete: false });
  expect(report.latestBlock).toMatchObject({ medianSatVb: null, empty: true });
  const text = renderText({ network: 'mainnet', readAt: now.toISOString(), wallets: [], providerErrors: [], primaryIsPublic: false, fees: report });
  expect(text).toContain('coinbase only');
  expect(text).toMatch(/Block fees unavailable:\s+1 observed blocks/);
  expect(text).toMatch(/Coinbase-only blocks:\s+1/);
  report = summarizeFees([quote(blocks), quote([verified(block(4), 0.5)], -1)], now);
  expect(report.blocks24h).toMatchObject({ average: 0.5, count: 3, unavailableCount: 0, complete: true });
});

it('preserves verified fees on a failed same-block retry, but never across a reorg or from the future', () => {
  const previous = quote([verified(block(), 0.7)], -60);
  const failed = quote([block()]);
  expect(summarizeFees([previous, failed], now).latestBlock?.medianSatVb).toBe(0.7);
  const reorg = quote([{ ...block(), id: hash(999) }]);
  expect(summarizeFees([previous, reorg], now).latestBlock?.medianSatVb).toBeNull();
  const refreshed = quote([verified(block(), 0.9)], 60);
  expect(summarizeFees([previous, failed, refreshed], now).latestBlock?.medianSatVb).toBe(0.7);
});

it('never formats a tiny positive block fee as zero, but retains a true zero fee', () => {
  for (const [value, label] of [[0.0001, '<0.01'], [0, '0']] as const) {
    const fees = summarizeFees([quote([verified(block(), value)])], now);
    const text = renderText({ network: 'mainnet', readAt: now.toISOString(), wallets: [], providerErrors: [], primaryIsPublic: false, fees });
    expect(text).toContain(`Latest block · median:     ${label} · block 10`);
  }
});

it('shows an observed mined tip with a future header time without adding it to the 24-hour window', () => {
  const fees = summarizeFees([quote([verified(block(10, epoch + 60), 0.7), verified(block(9), 0.3)])], now);
  expect(fees.latestBlock).toMatchObject({ height: 10, medianSatVb: 0.7 });
  expect(fees.blocks24h).toMatchObject({ count: 1, average: 0.3, complete: false });
});
