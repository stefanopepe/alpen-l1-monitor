import { expect, it } from 'vitest';
import { pendingBlobLines } from '../src/read/pending.js';
import { summarizeFees } from '../src/read/fees.js';
import { demoStatus } from '../src/consolidation/demo.js';
import { snapshotSchema } from '../src/read/model.js';

const time = '2026-10-02T12:00:00.000Z', seconds = Date.parse(time) / 1000;
function fixture() {
  const snapshot = demoStatus(new Date(time)).wallets[0]!.snapshot!;
  snapshot.networkTipOld = false; snapshot.tip.height = 102;
  snapshot.eeDaContext = { sourceRef: 'a'.repeat(40), latest: null, coverageComplete: true, pendingPublications: 1, undecodedPublications: 0,
    pending: [{ commitTxid: 'b'.repeat(64), blockHeight: 100, blockTime: seconds - 1200, chunkCount: 2, confirmedChunks: 1,
      observedPayloadBytes: 400, commitVsize: 200, confirmedRevealVsize: 250, estimatedPayloadBytes: 1000,
      estimatedRemainingVsize: 300, estimatedTotalVsize: 750, expectedAt: seconds + 1200, expectedBlockHeight: 104, sampleSize: 5 }] };
  const fees = summarizeFees([{ observedAt: time, provider: 'mempool', status: 'available', error: null,
    rates: { fastestFee: 2, halfHourFee: 1, hourFee: 1, economyFee: 1, minimumFee: 0 } }], new Date(time));
  return { snapshot, fees };
}
it('separates witness payload from overhead and remaining cost from the full package', () => {
  const { snapshot, fees } = fixture();
  expect(snapshotSchema.parse(snapshot).eeDaContext).toEqual(snapshot.eeDaContext);
  const text = pendingBlobLines(snapshot, fees, false, time, 'UTC').join('\n');
  expect(text).toContain('≈1,000 bytes'); expect(text).toContain('≈250 vB · witness payload only');
  expect(text).toContain('≈750 vB · commit + all reveals'); expect(text).toContain('Transaction overhead: ≈500 vB');
  expect(text).toContain('Expected remaining cost: ≈600 sats at 2 sat/vB');
  expect(text).toContain('Whole publication at current fees: ≈1,500 sats');
  expect(text).toContain('≈2 Bitcoin blocks / ≈20 minutes');
});
it('suppresses stale quotes, retains zero rates, and calls missed estimates overdue', () => {
  const { snapshot, fees } = fixture();
  fees.rates!.fastestFee = 0;
  expect(pendingBlobLines(snapshot, fees, false, time, 'UTC').join('\n')).toContain('Expected remaining cost: ≈0 sats');
  fees.stale = true;
  expect(pendingBlobLines(snapshot, fees, false, time, 'UTC').join('\n')).toContain('Expected remaining cost: Unavailable');
  expect(pendingBlobLines(snapshot, fees, true, time, 'UTC').join('\n')).toContain('Expected completion: unavailable · stale');
  snapshot.tip.height = 105;
  expect(pendingBlobLines(snapshot, fees, false, time, 'UTC').join('\n')).toContain('Historical completion estimate is overdue');
});
