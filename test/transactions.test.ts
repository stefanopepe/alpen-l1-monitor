import { expect, it } from 'vitest';
import { assessFee, summarizeStoredTransactions, summarizeTransactions } from '../src/transactions.js';
import { archiveTransactions } from '../src/replay/transactions.js';
import { replayFixture } from './replay-fixture.js';

it('preserves individual commit/reveal fees and rounds each transaction vsize separately', () => {
  const { archive } = replayFixture();
  const txs = archiveTransactions(archive), commit = txs.find(t => t.wallet === 'ee' && t.kind === 'commit')!;
  const reveal = txs.find(t => t.wallet === 'ee' && t.kind === 'reveal' && t.packageId === commit.txid)!;
  expect(commit).toMatchObject({ feeSats: 487, vsize: 172, feeRate: 487 / 172, packageComplete: true });
  expect(reveal).toMatchObject({ feeSats: 403, vsize: 133, feeRate: 403 / 133 });
  expect(commit.vsize + reveal.vsize).toBe(305); // ceil((685 + 529) / 4) would incorrectly yield 304.
  expect(txs.some(t => t.kind === 'deposit')).toBe(true);
  expect(new Set(txs.map(t => t.wallet + ':' + t.txid)).size).toBe(txs.length);
  expect(JSON.stringify(txs)).not.toMatch(/witness|scriptpubkey|descriptor/);
});

it('uses the same block hash, otherwise a contemporaneous bucket, and never the latest fee', () => {
  const { archive } = replayFixture(), tx = Object.values(archive.transactions)[0]!, time = tx.status.block_time!;
  const inputs = [tx], scripts = archive.addresses.filter(a => a.wallet === 'ee').map(a => a.script);
  const buckets = [{ start: time - 1, end: time + 1, rate: 3, source: '1m' }, { start: time + 1, end: time + 1801, rate: 99, source: '1m' }];
  const exact = { kind: 'block_median' as const, start: time, end: time, rate: 2.5 };
  expect(summarizeTransactions('ee', inputs, scripts, [], buckets, new Map([[tx.status.block_hash!, exact]]))[0]!.benchmark).toEqual(exact);
  expect(summarizeTransactions('ee', inputs, scripts, [], buckets, new Map([['a'.repeat(64), exact]]))[0]!.benchmark).toMatchObject({ kind: 'period_median', rate: 3 });
  expect(summarizeTransactions('ee', inputs, scripts, [], buckets.slice(1))[0]!.benchmark).toBeNull();
});

it('reports an estimated premium, distinguishes unknown evidence, and avoids rounded-zero claims', () => {
  const tx = { feeSats: 1000, vsize: 172, benchmark: { kind: 'block_median' as const, rate: 2.51, start: 0, end: 0 } };
  expect(assessFee(tx)).toMatchObject({ status: 'above', benchmarkSats: 432, excessSats: 568 });
  expect(assessFee({ ...tx, feeSats: 400 })).toMatchObject({ status: 'at_or_below', excessSats: 0 });
  expect(assessFee({ ...tx, benchmark: null }).status).toBe('unknown');
  expect(assessFee({ ...tx, benchmark: { ...tx.benchmark, kind: 'period_median', integerQuantized: true, rate: 0 } }).status).toBe('unknown');
});

it('deduplicates stored reveals, rejects malformed/unconfirmed records, and exposes only confirmed summaries', () => {
  const { archive } = replayFixture();
  const addresses = archive.addresses.filter(a => a.wallet === 'ee');
  const commit = Object.values(archive.transactions).find(t => t.fee === 487)!;
  const reveal = Object.values(archive.transactions).find(t => t.vin[0]?.txid === commit.txid && t.fee === 403)!;
  const state = { transactions: { [commit.txid]: commit, [reveal.txid]: reveal, invalid: { txid: 'bad' } }, reveals: { [commit.txid]: [reveal] } };
  const result = summarizeStoredTransactions('ee', addresses, state, [], new Map());
  expect(result).toHaveLength(2); expect(result.every(t => t.packageComplete)).toBe(true);
  expect(summarizeTransactions('ee', [{ ...commit, status: { confirmed: false } }], addresses.map(a => a.script), [])).toEqual([]);
  expect(summarizeStoredTransactions('ee', [], {}, [], new Map())).toEqual([]);
});
