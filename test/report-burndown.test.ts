import { expect, it } from 'vitest';
import { replayFixture } from './replay-fixture.js';
import { replayAt } from '../src/replay/run.js';
import { ArchiveIndex } from '../src/replay/asOfView.js';
import { buildBurndown } from '../src/replay/report/burndown.js';

async function records() {
  const { archive, v } = replayFixture(), index = new ArchiveIndex(archive);
  return (await Promise.all([160, 164, 168].map(h => replayAt(index, v, h, 'ee')))).map(r => r.record);
}
it('projects to the exact zero-balance time, even beyond recorded data, without extending actual balances', async () => {
  const rows = await records(), origin = rows[0]!;
  origin.snapshot.composition.spendableSats = 100000;
  origin.forecasts.find(f => f.model === 'current')!.dailySats = 10000;
  const chart = buildBurndown(rows, origin, 'current');
  expect(chart.depletion).toBe(Date.parse(origin.snapshot.asOf) + 10 * 86400000);
  expect(chart.projected.at(-1)).toEqual({ x: chart.depletion, y: 0 });
  expect(chart.to).toBeGreaterThan(chart.depletion!);
  expect(Math.max(...chart.actual.map(p => p.x))).toBe(chart.recordedThrough);
  expect(chart.actual.every(p => p.x <= chart.recordedThrough)).toBe(true);
});
it('changes the projection with the selected model and never revises it from later funding', async () => {
  const rows = await records(), origin = rows[0]!;
  origin.snapshot.composition.spendableSats = 50000;
  origin.forecasts.find(f => f.model === 'current')!.dailySats = 10000;
  origin.forecasts.find(f => f.model === 'mean7')!.dailySats = 5000;
  const initial = buildBurndown(rows, origin, 'current');
  expect(buildBurndown(rows, origin, 'mean7').depletion! - initial.origin).toBe(10 * 86400000);
  rows[1]!.snapshot.composition.spendableSats = 250000;
  const funded = buildBurndown(rows, origin, 'current');
  expect(funded.projected).toEqual(initial.projected);
  expect(funded.actual).toContainEqual({ x: Date.parse(rows[1]!.snapshot.asOf), y: 250000, height: rows[1]!.snapshot.tip.height });
});
it('does not invent a zero crossing for unavailable or zero-rate forecasts', async () => {
  const rows = await records(), origin = rows[0]!, current = origin.forecasts.find(f => f.model === 'current')!;
  current.dailySats = null;
  expect(buildBurndown(rows, origin, 'current')).toMatchObject({ depletion: null, projected: [] });
  current.dailySats = 0;
  const flat = buildBurndown(rows, origin, 'current');
  expect(flat.depletion).toBeNull(); expect(flat.projected.every(p => p.y === flat.balance)).toBe(true);
  origin.snapshot.composition.spendableSats = 0;
  expect(buildBurndown(rows, origin, 'current').depletion).toBe(Date.parse(origin.snapshot.asOf));
});
it('supports a single replay block without creating any observed future point', async () => {
  const [record] = await records();
  const chart = buildBurndown([record!], record!, 'current');
  expect(chart.actual).toHaveLength(1);
  expect(chart.actual[0]!.x).toBe(chart.origin);
  expect(chart.to).toBeGreaterThan(chart.from);
});

it('keeps planning balance and runway stable as pending change confirms', async () => {
  const rows = await records(), pending = rows[0]!, confirmed = rows[1]!;
  pending.collected = confirmed.collected = true;
  pending.snapshot.composition.spendableSats = 634;
  pending.snapshot.composition.unconfirmedGtDustSats = 86975;
  pending.snapshot.composition.strandedSats = 54600;
  confirmed.snapshot.composition.spendableSats = 87609;
  confirmed.snapshot.composition.unconfirmedGtDustSats = 0;
  confirmed.snapshot.composition.strandedSats = 54600;
  pending.forecasts.find(f => f.model === 'current')!.dailySats = 10000;
  confirmed.forecasts.find(f => f.model === 'current')!.dailySats = 10000;
  const before = buildBurndown(rows, pending, 'current'), after = buildBurndown(rows, confirmed, 'current');
  expect(before.balance).toBe(87609);
  expect(after.balance).toBe(before.balance);
  expect(before.depletion! - before.origin).toBeCloseTo(8.7609 * 86400000);
  expect(after.depletion! - after.origin).toBe(before.depletion! - before.origin);
  expect(before.actual.filter(p => p.height === pending.snapshot.tip.height || p.height === confirmed.snapshot.tip.height).map(p => p.y)).toEqual([87609, 87609]);
});

it('does not invent a rate or exhaustion when all funding is pending', async () => {
  const [pending] = await records(); pending!.collected = true;
  pending!.snapshot.composition.spendableSats = 0;
  pending!.snapshot.composition.unconfirmedGtDustSats = 100000;
  const current = pending!.forecasts.find(f => f.model === 'current')!;
  current.dailySats = null;
  expect(buildBurndown([pending!], pending!, 'current')).toMatchObject({ balance: 100000, depletion: null, projected: [] });
  current.dailySats = 0;
  expect(buildBurndown([pending!], pending!, 'current').projected.every(p => p.y === 100000)).toBe(true);
  current.dailySats = 10000;
  expect(buildBurndown([pending!], pending!, 'current').depletion).toBe(Date.parse(pending!.snapshot.asOf) + 10 * 86400000);
});

it('preserves archived balances and forecasts without borrowing later pending observations', async () => {
  const rows = await records(), origin = rows[0]!, collected = rows[1]!;
  const before = buildBurndown(rows, origin, 'current');
  collected.collected = true;
  collected.snapshot.composition.spendableSats = 50000;
  collected.snapshot.composition.unconfirmedGtDustSats = 100000;
  const chart = buildBurndown(rows, origin, 'current');
  expect(chart.projected).toEqual(before.projected);
  expect(chart.balance).toBe(origin.snapshot.composition.spendableSats);
  expect(chart.actual.find(p => p.height === collected.snapshot.tip.height)?.y).toBe(150000);
});

it('retains long historical timelines without mistaking unchanged balances for missing samples', async () => {
  const rows = await records();
  rows.forEach((r, i) => { r.snapshot.asOf = new Date(Date.UTC(2026, 6, 1 + i * 30)).toISOString(); r.snapshot.composition.spendableSats = 100000; });
  const chart = buildBurndown(rows, rows.at(-1)!, 'current');
  expect(chart.actual[0]!.x).toBe(Date.parse(rows[0]!.snapshot.asOf));
  expect(chart.actual[0]!.x).toBeLessThan(chart.from);
  expect(chart.actual.some(p => p.y === null)).toBe(false);
});
