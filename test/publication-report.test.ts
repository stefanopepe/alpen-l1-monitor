import { expect, it } from 'vitest';
import { publicationReport } from '../src/model/publication.js';
import { summarizeFees } from '../src/read/fees.js';
import { reportTime, validTimezone } from '../src/read/time.js';
import { renderText } from '../src/read/render.js';
import { snapshotSchema, type ReadModel } from '../src/read/model.js';
import { computeWalletSnapshot } from '../src/pipeline/snapshot.js';
import type { FeeContext, Settlement } from '../src/types.js';
import { config, hash, utxo } from './helpers.js';

const now = Date.parse('2026-10-04T15:00:00Z') / 1000;
const estimator = { ...config().config.estimator, min_intervals: 2 };
const iso = (t: number) => new Date(t * 1000).toISOString();
const settlement = (id: number, completedAt: number, fee: number): Settlement => ({ txid: hash(id), height: id, blockTime: completedAt - 600,
  completedAt, complete: true, feeSats: fee, weight: 4000, drainSats: fee + 546 });

it('compares package rates to preceding completion windows without including the target or later reveals', () => {
  const rows = [settlement(1, now - 2 * 86400, 5500), settlement(2, now - 7200, 2500), settlement(3, now - 3600, 3000),
    { ...settlement(4, now - 1800, 99000), blockTime: now - 6000 }, settlement(5, now + 500, 99000)];
  const result = publicationReport(rows, hash(3), now, estimator, true);
  expect(result.latest).toMatchObject({ feeSats: 3000, feeRateSatVb: 3,
    previous24h: { averageSatVb: 2.5, sampleSize: 1, complete: true }, previous7d: { averageSatVb: 4, sampleSize: 2, complete: true } });
  expect(publicationReport(rows, hash(3), now, estimator, false)).toMatchObject({ nextExpectedAt: null,
    latest: { previous24h: { averageSatVb: null, complete: false } } });
});

it('estimates the next commit once and leaves a missed estimate overdue instead of rolling it forward', () => {
  const rows = [settlement(1, now - 10800, 1000), settlement(2, now - 7200, 1000), settlement(3, now - 3600, 1000)];
  const result = publicationReport(rows, hash(3), now, estimator, true);
  expect(result).toMatchObject({ intervalSeconds: 3600, nextExpectedAt: now - 600, timingSampleSize: 3 });
  expect(publicationReport(rows, hash(3), now + 7200, estimator, true).nextExpectedAt).toBe(result.nextExpectedAt);
  expect(publicationReport(rows.slice(0, 1), hash(1), now, estimator, true).nextExpectedAt).toBeNull();
});

const quote = (time: number, value: number): FeeContext => ({ provider: 'mempool', observedAt: iso(time), status: 'available', error: null,
  rates: { fastestFee: value, halfHourFee: value, hourFee: value, economyFee: 0, minimumFee: 0 } });
it('weights saved recommendations by time, preserves zero fees and leaves long gaps uncovered', () => {
  const q = [quote(now - 3600, 2), quote(now - 2700, 4), quote(now, 8), quote(now + 10, 1000)];
  const result = summarizeFees([...q, q[0]!], new Date(now * 1000));
  expect(result).toMatchObject({ rates: { fastestFee: 8 }, quoteCoverageSeconds: 2700, stale: false,
    averageRates24h: { fastestFee: 10 / 3, economyFee: 0 } });
  const failed: FeeContext = { ...quote(now - 2400, 0), status: 'unavailable', rates: null, error: 'E_FEE_HTTP' };
  expect(summarizeFees([...q, failed], new Date(now * 1000)).quoteCoverageSeconds).toBe(1200);
  expect(summarizeFees([quote(now - 4000, 2)], new Date(now * 1000)).stale).toBe(true);
});

it('deduplicates mined blocks, replaces reorg heights and detects missing 24-hour block coverage', () => {
  const first = quote(now - 600, 2), second = quote(now, 2);
  const block = (height: number, timestamp: number, rate: number, id = height) => ({ height, id: hash(id), timestamp, weight: 4000000,
    extras: { medianFee: rate, feeRange: [rate] } });
  first.completed = { status: 'available', error: null, observedAt: first.observedAt,
    blocks: [block(1, now - 86401, 99), block(2, now - 1000, 2), block(3, now - 900, 100)] };
  second.completed = { status: 'available', error: null, observedAt: second.observedAt,
    blocks: [block(3, now - 900, 4, 30), block(4, now - 50, 6)] };
  const result = summarizeFees([first, second, first], new Date(now * 1000));
  expect(result.blocks24h).toEqual({ lowest: 2, highest: 6, average: 4, count: 3, complete: true });
  expect(result.latestBlock?.height).toBe(4);
  first.completed.blocks!.splice(1, 1);
  expect(summarizeFees([first, second], new Date(now * 1000)).blocks24h.complete).toBe(false);
});

it('uses client timezone rules at each timestamp, including daylight saving and different calendar dates', () => {
  expect(reportTime('2026-10-04T15:00:00Z', 'Asia/Nicosia')).toContain('18:00:00 GMT+3');
  expect(reportTime('2026-12-04T15:00:00Z', 'Asia/Nicosia')).toContain('17:00:00 GMT+2');
  expect(reportTime('2026-10-04T23:30:00Z', 'Asia/Nicosia')).toContain('05 Oct 2026');
  expect(validTimezone('Mars/Test')).toBe(false);
  expect(validTimezone('Asia/Nicosia\nspoof')).toBe(false);
});

it('persists report data, renders real report labels and keeps IDs in transaction details', () => {
  const v = config();
  const snapshot = computeWalletSnapshot({ asOfEpoch: now, settlements: [settlement(1, now - 7200, 2500), settlement(2, now - 3600, 3000)],
    utxos: [utxo(10000)], estimator, historyComplete: true,
    meta: { network: 'mainnet', wallet: 'ee', asOf: iso(now), finishedAt: iso(now), provider: 'test', tip: { height: 100, hash: hash(100), blockTime: now },
      ceilingHit: { receive: false, change: false }, addressesScanned: 40, requestsUsed: 0, primaryIsPublic: false, networkTipOld: false,
      historyError: null, monitorVersion: '2.4.0', selectorModelVersion: 1, upstreamRef: v.config.upstream.ref, deployedBuildConfirmed: false, configSha256: v.sha256,
      eeDaContext: { sourceRef: v.config.upstream.ref, coverageComplete: true, pendingPublications: 2, undecodedPublications: 0,
        latest: { updateSeqNo: '123', lastEvmBlock: '2481920', evmTimestamp: String(now), version: 0, commitTxid: hash(2), revealTxids: [hash(22)],
          chunkCount: 1, payloadBytes: 48320, blockHeight: 99, blockHash: hash(99), blockTime: now - 3600 } } } });
  const saved = snapshotSchema.parse(snapshot);
  expect(saved.publicationReport).toEqual(snapshot.publicationReport);
  const model: ReadModel = { network: 'mainnet', readAt: iso(now), primaryIsPublic: false, providerErrors: [],
    wallets: [{ wallet: 'ee', name: 'EE', stale: false, ageSeconds: 0, snapshot: saved }] };
  const text = renderText(model, 'Asia/Nicosia');
  expect(text).toMatch(/Last EE block included:\s+2,481,920/);
  expect(text).toContain('↑ 20% · average 2.5 sat/vB');
  expect(text).toMatch(/Blobs awaiting completion:\s+2/);
  expect(text).not.toContain('updateSeqNo');
  expect(text.split('TRANSACTION DETAILS')[0]).not.toContain(hash(22));
  expect(text).toContain(hash(22));
  const legacy = { ...saved }; delete legacy.publicationReport;
  expect(snapshotSchema.parse(legacy).publicationReport).toBeUndefined();
});
