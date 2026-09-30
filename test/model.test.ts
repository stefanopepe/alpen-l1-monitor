import { expect, it } from 'vitest';
import { composition } from '../src/model/composition.js';
import { naiveRunway } from '../src/model/naive.js';
import { commitOutputs, revealShaped, settlementObservation, validFee } from '../src/extract/classify.js';
import { address, config, pair, settlement, utxo } from './helpers.js';
it('partitions confirmed, dust, pending and unsupported UTXOs exactly', () => {
  const c = composition([utxo(546), utxo(545, false), utxo(547), utxo(800, false), utxo(1000, true, 'other'), utxo(2000, true, 'p2tr')]);
  expect(c).toMatchObject({ balanceSats: 5438, spendableSats: 2547, strandedSats: 1091, unconfirmedGtDustSats: 800, unsupportedGtDustSats: 1000, largestUtxoSats: 2000 });
  expect(Object.values(c.counts).slice(1).reduce((a,b) => a+b,0)).toBe(c.counts.total);
});
it('never counts 546-sat outputs as assets; dust-only runway is zero without history', () => {
  const c = composition([utxo(546)]);
  expect(c.spendableSats).toBe(0);
  expect(naiveRunway(0, 546, [], 1000000, config().config.estimator, false, true).days).toBe(0);
});
it('rejects duplicates and unsafe integer values', () => {
  expect(() => composition([utxo(1000), utxo(1000)])).toThrow('E_UTXO_INVALID');
  expect(() => composition([utxo(Number.MAX_SAFE_INTEGER + 1)])).toThrow('E_UTXO_INVALID');
});
it.each([true, false])('links EE commits with change=%s and no reveal OP_RETURN', change => {
  const { commit, reveal } = pair(change), scripts = new Set([address.script]);
  expect(validFee(commit)).toBe(true); expect(validFee(reveal)).toBe(true);
  expect(commitOutputs(commit, scripts)).toEqual([1]);
  expect(revealShaped(commit, 1, reveal, scripts)).toBe(true);
  expect(settlementObservation(commit, [reveal], 1, scripts)).toMatchObject({ complete: true, drainSats: 1436, feeSats: 890, weight: 1214 });
});
it('handles OL-style output permutations and excludes consolidations', () => {
  const { commit, reveal } = pair(), scripts = new Set([address.script]);
  [commit.vout[0], commit.vout[1]] = [commit.vout[1]!, commit.vout[0]!]; reveal.vin[0]!.vout = 0;
  reveal.vout.push({ scriptpubkey: '6a00', scriptpubkey_type: 'op_return', value: 0 });
  expect(commitOutputs(commit, scripts)).toEqual([0]); expect(revealShaped(commit, 0, reveal, scripts)).toBe(true);
  const sweep = structuredClone(commit); sweep.vout = [{ scriptpubkey: address.script, scriptpubkey_type: 'v0_p2wpkh', value: 9513 }];
  expect(commitOutputs(sweep, scripts)).toBeNull();
});
it('rejects non-script-path reveals and foreign outputs', () => {
  const { commit, reveal } = pair(); reveal.vin[0]!.witness = ['keypath'];
  expect(revealShaped(commit, 1, reveal, new Set([address.script]))).toBe(false);
});
it('computes an explicitly naive estimate from complete observations and median cadence', () => {
  const rows = Array.from({ length: 40 }, (_, i) => settlement(i));
  const r = naiveRunway(18000, 24000, rows, rows.at(-1)!.blockTime, config().config.estimator, true, true);
  expect(r).toMatchObject({ days: 1, aggregateDays: 4 / 3, costPerSettlementSats: 1500, settlementsPerDay: 12, drainPerDaySats: 18000 });
  expect(naiveRunway(18000, 24000, rows, rows.at(-1)!.blockTime, config().config.estimator, false, true).days).toBeNull();
  expect(naiveRunway(18000, 24000, rows, rows.at(-1)!.blockTime, config().config.estimator, true, false).reason).toBe('discovery_incomplete');
});
it('does not use insufficient, old or zero-interval samples as runway inputs', () => {
  const e = config().config.estimator;
  expect(naiveRunway(2000, 2000, [settlement(0)], 1000000, e, true, true).days).toBeNull();
  const rows = Array.from({ length: 40 }, (_, i) => ({ ...settlement(i), blockTime: 1000000 }));
  expect(naiveRunway(2000, 2000, rows, 1000000, e, true, true).reason).toBe('cadence_unavailable');
  expect(naiveRunway(2000, 2000, rows, 1000000 + 31 * 86400, e, true, true).sampleSize).toBe(0);
});
