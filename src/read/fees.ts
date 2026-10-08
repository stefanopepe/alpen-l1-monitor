import type { PoolClient } from 'pg';
import type { FeeContext, FeeRates } from '../types.js';
import { feeContextSchema } from '../observations/schema.js';
import { groupedRows, readCache, type ReadCache } from './cache.js';

export interface FeeReport {
  observedAt: string | null; rates: FeeRates | null; stale: boolean;
  averageRates24h: FeeRates | null; quoteCoverageSeconds: number;
  latestBlock: { height: number; timestamp: number; medianSatVb: number | null; observedAt: string; empty: boolean } | null;
  blocks24h: { lowest: number | null; highest: number | null; average: number | null; count: number; complete: boolean; unavailableCount: number; emptyCount: number };
}
const keys: (keyof FeeRates)[] = ['fastestFee', 'halfHourFee', 'hourFee', 'economyFee', 'minimumFee'];
const zeroRates = (): FeeRates => ({ fastestFee: 0, halfHourFee: 0, hourFee: 0, economyFee: 0, minimumFee: 0 });

/** Database-only, network-scoped evidence. Old schema-1 databases use retained runs. */
export async function readFeeReport(client: PoolClient, network: string, now: Date, staleAfter: number, fallback: FeeContext[], cache: ReadCache = readCache(network)): Promise<FeeReport> {
  const from = new Date(now.getTime() - 25 * 3600000).toISOString();
  const relation = await client.query("SELECT to_regclass('fee_observations') AS name");
  const source = relation.rows[0]?.name
    ? "SELECT date_trunc('hour',observed_at AT TIME ZONE 'UTC')::text AS bucket,observed_at::text||':'||xmin::text AS revision,data-'pressure' AS data FROM fee_observations WHERE network=$1 AND observed_at >= $2 AND observed_at <= $3"
    : "SELECT date_trunc('hour',started_at AT TIME ZONE 'UTC')::text AS bucket,started_at::text||':'||xmin::text AS revision,(results->'feeContext')-'pressure' AS data FROM runs WHERE network=$1 AND started_at >= $2 AND started_at <= $3 AND finished_at IS NOT NULL";
  const rows = await groupedRows<unknown>(client, cache, 'fee-contexts', source, [network, from, now.toISOString()]);
  const contexts = rows.flatMap(row => { const parsed = feeContextSchema.safeParse(row); return parsed.success ? [parsed.data] : []; });
  return summarizeFees([...fallback, ...contexts], now, staleAfter);
}

export function summarizeFees(contexts: readonly FeeContext[], now: Date, staleAfter = 3300): FeeReport {
  const end = now.getTime() / 1000, start = end - 86400;
  const time = (iso: string) => Date.parse(iso) / 1000;
  const quotes = [...new Map(contexts.filter(c => !c.kind && time(c.observedAt) <= end).map(c => [c.observedAt, c])).values()]
    .sort((a, b) => time(a.observedAt) - time(b.observedAt));
  const current = quotes.at(-1), sums = zeroRates();
  let quoteCoverageSeconds = 0;
  for (const [i, quote] of quotes.entries()) {
    if (quote.status !== 'available' || !quote.rates) continue;
    // Do not carry a quote through an outage or a collection gap beyond 30 minutes.
    const until = Math.min(end, time(quote.observedAt) + 1800, quotes[i + 1] ? time(quotes[i + 1]!.observedAt) : end);
    const seconds = Math.max(0, until - Math.max(start, time(quote.observedAt)));
    quoteCoverageSeconds += seconds;
    for (const key of keys) sums[key] += quote.rates[key] * seconds;
  }
  const completed = contexts.flatMap(c => c.completed?.status === 'available' && time(c.completed.observedAt) <= end ? [c.completed] : [])
    .sort((a, b) => time(a.observedAt) - time(b.observedAt));
  // A backfill adds mined-block facts, never a current quote or a new observed tip.
  const latestObservation = contexts.filter(c => !c.kind).flatMap(c =>
    c.completed?.status === 'available' && time(c.completed.observedAt) <= end ? [c.completed] : [])
    .sort((a, b) => time(a.observedAt) - time(b.observedAt)).at(-1);
  const tip = latestObservation?.blocks?.reduce((a, b) => a.height > b.height ? a : b);
  const blocks = new Map<number, NonNullable<NonNullable<FeeContext['completed']>['blocks']>[number]>();
  for (const observation of completed) for (const block of observation.blocks ?? []) {
    if (tip && block.height <= tip.height && block.timestamp <= end) {
      const previous = blocks.get(block.height);
      // A failed retry cannot erase verified fees for the same immutable block. Reorgs must replace them.
      blocks.set(block.height, previous?.id === block.id && previous.transactionFees && !block.transactionFees
        ? { ...block, transactionFees: previous.transactionFees, transactionFeesError: undefined } : block);
    }
  }
  const ordered = [...blocks.values()].sort((a, b) => a.height - b.height);
  const window = ordered.filter(b => b.timestamp > start);
  const medians = window.flatMap(b => b.transactionFees?.medianSatVb == null ? [] : [b.transactionFees.medianSatVb]);
  const unavailableCount = window.filter(b => !b.transactionFees).length;
  const emptyCount = window.filter(b => b.transactionFees?.transactionCount === 0).length;
  // A mined block can have a header timestamp ahead of the collector's clock.
  const latest = tip ? blocks.get(tip.height) ?? tip : undefined;
  const firstInWindow = ordered.findIndex(b => b.timestamp > start);
  const coverage = ordered.slice(Math.max(0, firstInWindow - 1));
  const complete = !!tip && !!latestObservation && end - time(latestObservation.observedAt) <= staleAfter &&
    unavailableCount === 0 &&
    firstInWindow > 0 && coverage.at(-1)?.height === tip.height &&
    coverage.every((b, i) => i === 0 || b.height === coverage[i - 1]!.height + 1);
  const stale = !current || current.status !== 'available' || !current.rates || end - time(current.observedAt) > staleAfter;
  return {
    observedAt: current?.observedAt ?? null, rates: current?.status === 'available' ? current.rates : null, stale,
    averageRates24h: quoteCoverageSeconds ? Object.fromEntries(keys.map(k => [k, sums[k] / quoteCoverageSeconds])) as unknown as FeeRates : null,
    quoteCoverageSeconds,
    latestBlock: latest && latestObservation ? { height: latest.height, timestamp: latest.timestamp, medianSatVb: latest.transactionFees?.medianSatVb ?? null,
      observedAt: latestObservation.observedAt, empty: latest.transactionFees?.transactionCount === 0 } : null,
    blocks24h: { lowest: medians.length ? Math.min(...medians) : null, highest: medians.length ? Math.max(...medians) : null,
      average: medians.length ? medians.reduce((a, b) => a + b, 0) / medians.length : null, count: medians.length, complete, unavailableCount, emptyCount },
  };
}
