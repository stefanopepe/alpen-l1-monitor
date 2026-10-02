import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { digest, writeJson } from '../replay/archive.js';
import { feeArchiveSchema, feeBucketSchema, type FeeArchive, type FeeBucket } from './schema.js';

// Verified against mempool's mining.getTimeRange and BlocksRepository on 2026-10-02.
// avgFee_50 is an integer-cast bucket average, not a confirmation-price observation.
export const HISTORY_PERIODS = [
  { period: '4y', seconds: 43200 }, { period: '1y', seconds: 28800 },
  { period: '6m', seconds: 10800 }, { period: '3m', seconds: 7200 },
  { period: '1m', seconds: 1800 },
] as const;
const upstreamSchema = z.array(z.object({ timestamp: z.number().int().positive(), avgFee_50: z.number().finite().nonnegative().max(1e9) })).min(1);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function mergeResolutions(series: FeeBucket[][]): FeeBucket[] {
  // A coarse bucket crossing the finer series' boundary is dropped whole, never split
  // or copied into artificial hourly observations. Gaps remain gaps.
  let merged: FeeBucket[] = [];
  for (const rows of [...series].sort((a, b) => (b[0]!.end - b[0]!.start) - (a[0]!.end - a[0]!.start))) {
    const ordered = [...rows].sort((a, b) => a.start - b.start);
    validateBuckets(ordered);
    const first = ordered[0]!.start, last = ordered.at(-1)!.end;
    merged = [...merged.filter(b => b.end <= first || b.start >= last), ...ordered].sort((a, b) => a.start - b.start);
  }
  validateBuckets(merged); return merged;
}
export function validateBuckets(rows: readonly FeeBucket[]) {
  if (!rows.length) throw new Error('E_FEE_HISTORY_EMPTY');
  for (let i = 0; i < rows.length; i++) {
    feeBucketSchema.parse(rows[i]);
    if (i && rows[i]!.start < rows[i - 1]!.end) throw new Error('E_FEE_HISTORY_OVERLAP');
  }
}
export function openFeeArchive(dir: string, seal?: string): FeeArchive {
  if (seal && !/^[a-f0-9]{64}$/.test(seal)) throw new Error('E_FEE_ARCHIVE_SEAL');
  const archive = feeArchiveSchema.parse(JSON.parse(readFileSync(join(dir, ...(seal ? ['seals', seal + '.json'] : ['archive.json'])), 'utf8')));
  const { digest: hash, ...body } = archive;
  if (digest(body) !== hash) throw new Error('E_FEE_ARCHIVE_DIGEST');
  validateBuckets(archive.buckets);
  if (archive.buckets.some(b => Math.max(b.end, b.availableAt ?? b.end) > Date.parse(archive.capturedAt) / 1000)) throw new Error('E_FEE_HISTORY_FUTURE');
  for (const [path, expected] of Object.entries(archive.responses)) {
    if (!/^[a-f0-9]{64}$/.test(expected) || !path.startsWith('/')) throw new Error('E_FEE_ARCHIVE_RESPONSE');
    const raw: unknown = JSON.parse(readFileSync(join(dir, 'raw', expected + '.json'), 'utf8'));
    if (digest(raw) !== expected) throw new Error('E_FEE_ARCHIVE_RESPONSE');
  }
  return archive;
}
export function sealFeeArchive(dir: string, body: Omit<FeeArchive, 'digest'>): FeeArchive {
  validateBuckets(body.buckets);
  if (body.buckets.some(b => b.end > Date.parse(body.capturedAt) / 1000 || (b.availableAt ?? b.end) > Date.parse(body.capturedAt) / 1000)) throw new Error('E_FEE_HISTORY_FUTURE');
  const archive = feeArchiveSchema.parse({ ...body, digest: digest(body) });
  mkdirSync(join(dir, 'seals'), { recursive: true });
  writeJson(join(dir, 'seals', archive.digest + '.json'), archive);
  writeJson(join(dir, 'archive.json'), archive); return archive;
}
export async function fetchFeeHistory(dir: string, options: { fetcher?: typeof fetch; now?: () => Date; progress?: (s: string) => void; pause?: (ms: number) => Promise<void> } = {}) {
  const fetcher = options.fetcher ?? fetch, wait = options.pause ?? pause;
  const now = options.now ?? (() => new Date()), cutoff = now().getTime() / 1000;
  const responses: Record<string, string> = {}, series: FeeBucket[][] = [];
  mkdirSync(join(dir, 'raw'), { recursive: true });
  for (const { period, seconds } of HISTORY_PERIODS) {
    const path = '/api/v1/mining/blocks/fee-rates/' + period;
    let raw: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response | undefined;
      try { response = await fetcher('https://mempool.space' + path, { redirect: 'error', signal: AbortSignal.timeout(15000), cache: 'no-store' }); }
      catch { if (attempt === 3) throw new Error('E_FEE_HISTORY_NETWORK'); }
      if (response?.ok) { raw = await response.json(); break; }
      if (response && response.status !== 429 && response.status < 500) throw new Error('E_FEE_HISTORY_HTTP');
      if (attempt === 3) throw new Error('E_FEE_HISTORY_RETRIES');
      const retry = Number(response?.headers.get('retry-after') ?? 0);
      await wait(Math.min(30000, Math.max(1000 * 2 ** attempt, Number.isFinite(retry) ? retry * 1000 : 0)));
    }
    const parsed = upstreamSchema.parse(raw), observedAt = Math.ceil(now().getTime() / 1000);
    const rows = parsed.map(b => ({ start: Math.floor(b.timestamp / seconds) * seconds,
      end: (Math.floor(b.timestamp / seconds) + 1) * seconds, rate: b.avgFee_50, source: period, availableAt: observedAt }))
      .filter(b => b.end <= cutoff).sort((a, b) => a.start - b.start);
    validateBuckets(rows);
    const hash = digest(raw); responses[path + '#' + hash] = hash;
    if (!existsSync(join(dir, 'raw', hash + '.json'))) writeJson(join(dir, 'raw', hash + '.json'), raw);
    series.push(rows); options.progress?.(`${period}: ${rows.length} complete ${seconds / 3600}-hour buckets`);
    await wait(500);
  }
  const prior = existsSync(join(dir, 'archive.json')) ? openFeeArchive(dir) : null;
  // First-observed values are immutable. Refinements cannot replace earlier evidence.
  const old = prior?.buckets.map(b => ({ ...b, availableAt: b.availableAt ?? Math.ceil(Date.parse(prior.capturedAt) / 1000) })) ?? [];
  const fresh = mergeResolutions(series).filter(b => !old.some(o => o.start < b.end && o.end > b.start));
  return sealFeeArchive(dir, { schemaVersion: 1, network: 'mainnet', target: 'bucket_mean_block_median_sat_vb',
    capturedAt: new Date(Math.ceil(now().getTime() / 1000) * 1000).toISOString(), source: 'https://mempool.space/api/v1/mining/blocks/fee-rates/:period', integerQuantized: true,
    buckets: [...old, ...fresh].sort((a, b) => a.start - b.start), responses: { ...prior?.responses, ...responses } });
}

// Explicit import contract for better-resolution archives. Never infer sat/vB from
// total fees or accept a recommendation series under the block-median target label.
export function importFeeHistory(file: string, dir: string) {
  if (existsSync(join(dir, 'archive.json'))) throw new Error('E_FEE_IMPORT_NEW_ARCHIVE_REQUIRED');
  const input = feeArchiveSchema.omit({ digest: true, responses: true }).parse(JSON.parse(readFileSync(file, 'utf8')));
  const sorted = [...input.buckets].sort((a, b) => a.start - b.start);
  if (sorted.at(-1)!.end > Date.parse(input.capturedAt) / 1000) throw new Error('E_FEE_HISTORY_FUTURE');
  return sealFeeArchive(dir, { ...input, buckets: sorted, responses: {} });
}
