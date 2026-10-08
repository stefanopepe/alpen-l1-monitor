import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from 'pg';
import { enrichBlockFees, sourceBlockSchema } from '../chain/blockFees.js';
import { completedBlockSchema, feeContextSchema } from '../observations/schema.js';
import { Store } from '../db/store.js';
import { setTimeout as delay } from 'node:timers/promises';

export const BLOCK_FEE_SOURCE = 'https://mempool.space/api';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const linkedBlock = sourceBlockSchema.extend({ previousblockhash: hash });
const verifiedBlock = completedBlockSchema.refine(b => !!b.transactionFees && !b.transactionFeesError);
export const blockBackfillSchema = z.object({
  schemaVersion: z.literal(1), network: z.literal('mainnet'), source: z.literal(BLOCK_FEE_SOURCE),
  capturedAt: z.iso.datetime(), fromTime: z.number().int().nonnegative(),
  chain: z.array(linkedBlock).min(1).max(2000), blocks: z.array(verifiedBlock).max(2000),
});
export type BlockBackfill = z.infer<typeof blockBackfillSchema>;

export function validateBlockBackfill(input: unknown): BlockBackfill {
  const capture = blockBackfillSchema.parse(input), seen = new Set<string>();
  for (const [i, b] of capture.chain.entries()) {
    const parent = capture.chain[i + 1];
    if (seen.has(b.id) || (parent && (b.height !== parent.height + 1 || b.previousblockhash !== parent.id))) throw new Error('E_BACKFILL_CHAIN');
    seen.add(b.id);
  }
  const records = new Set<string>();
  for (const b of capture.blocks) {
    const source = capture.chain.find(s => s.id === b.id);
    if (records.has(b.id) || !source || source.height !== b.height || source.timestamp !== b.timestamp ||
      source.tx_count !== b.tx_count || source.extras.totalFees !== b.extras.totalFees ||
      b.transactionFees!.transactionCount !== b.tx_count! - 1 || b.timestamp > Date.parse(capture.capturedAt) / 1000)
      throw new Error('E_BACKFILL_RECORD');
    records.add(b.id);
  }
  return capture;
}

export async function assertBackfillAnchor(capture: BlockBackfill, fetcher: typeof fetch = fetch) {
  const anchor = capture.chain[0]!;
  const r = await fetcher(`${BLOCK_FEE_SOURCE}/block-height/${anchor.height}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!r.ok || (await r.text()).trim() !== anchor.id) throw new Error('E_BACKFILL_REORG');
}

/** Public endpoint only; caller supplies a paced fetcher and a small DB hash lookup. */
export async function captureBlockBackfill(options: {
  fromTime: number; toHeight?: number; fetcher?: typeof fetch; now?: () => Date;
  known: (blocks: z.infer<typeof linkedBlock>[]) => Promise<ReadonlySet<string>>;
  onProgress?: (data: { phase: string; scanned?: number; missing?: number; completed?: number; height?: number }) => void;
}): Promise<BlockBackfill> {
  const { fromTime, toHeight, known, onProgress } = options, fetcher = options.fetcher ?? fetch, now = options.now ?? (() => new Date());
  if (!Number.isSafeInteger(fromTime) || fromTime < 0 || fromTime >= now().getTime() / 1000 ||
    (toHeight !== undefined && (!Number.isSafeInteger(toHeight) || toHeight < 0))) throw new Error('E_BACKFILL_RANGE');
  const chain: z.infer<typeof linkedBlock>[] = [];
  let cursor = toHeight;
  while (chain.length < 2000) {
    const r = await fetcher(`${BLOCK_FEE_SOURCE}/v1/blocks${cursor === undefined ? '' : '/' + cursor}`, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('E_BACKFILL_BLOCKS_HTTP');
    const page = z.array(linkedBlock).min(1).max(15).parse(await r.json());
    if (cursor !== undefined && page[0]!.height !== cursor) throw new Error('E_BACKFILL_PAGE');
    chain.push(...page);
    validateBlockBackfill({ schemaVersion: 1, network: 'mainnet', source: BLOCK_FEE_SOURCE, capturedAt: now().toISOString(), fromTime, chain, blocks: [] });
    onProgress?.({ phase: 'scan', scanned: chain.length, height: page.at(-1)!.height });
    // Header times are not monotonic. Include a two-hour margin and an entire
    // older page rather than stopping at the first timestamp before the window.
    if (page.every(b => b.timestamp < fromTime - 7200) || page.at(-1)!.height === 0) break;
    cursor = page.at(-1)!.height - 1;
    if (chain.length + 15 > 2000) throw new Error('E_BACKFILL_LIMIT');
  }
  const present = await known(chain), missing = chain.filter(b => !present.has(b.id) && b.timestamp <= now().getTime() / 1000);
  onProgress?.({ phase: 'summaries', scanned: chain.length, missing: missing.length });
  const blocks: BlockBackfill['blocks'] = [];
  for (const block of missing) {
    let [verified] = await enrichBlockFees([block], fetcher, BLOCK_FEE_SOURCE);
    for (let retry = 0; retry < 2 && verified?.transactionFeesError === 'E_BLOCK_FEES_UNAVAILABLE'; retry++) {
      await delay(1000 * (retry + 1));
      [verified] = await enrichBlockFees([block], fetcher, BLOCK_FEE_SOURCE);
    }
    if (!verified?.transactionFees) throw new Error(verified?.transactionFeesError ?? 'E_BACKFILL_SUMMARY');
    blocks.push(verified);
    onProgress?.({ phase: 'summary', completed: blocks.length, missing: missing.length, height: block.height });
  }
  const capture = validateBlockBackfill({ schemaVersion: 1, network: 'mainnet', source: BLOCK_FEE_SOURCE, capturedAt: now().toISOString(), fromTime, chain, blocks });
  await assertBackfillAnchor(capture, fetcher);
  return capture;
}

export async function knownBlockFees(pool: Pool, ids: readonly string[]): Promise<Set<string>> {
  const result = await pool.query(`SELECT DISTINCT b->>'id' AS id FROM fee_observations,
    LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(data->'completed'->'blocks')='array' THEN data->'completed'->'blocks' ELSE '[]'::jsonb END) AS b
    WHERE network='mainnet' AND b->>'id'=ANY($1::text[]) AND b->'transactionFees'->>'basis'='median_transaction_fee_per_vbyte'`, [ids]);
  return new Set(result.rows.map(r => r.id as string));
}

/** Idempotent append of compact observations; never revise live quotes or old evidence. */
export async function importBlockBackfill(pool: Pool, input: unknown, fetcher: typeof fetch = fetch) {
  const capture = validateBlockBackfill(input);
  const stamp = await pool.query('SELECT network FROM network_stamp');
  if (stamp.rows.length !== 1 || stamp.rows[0].network !== 'mainnet') throw new Error('E_BACKFILL_NETWORK');
  await assertBackfillAnchor(capture, fetcher);
  const known = await knownBlockFees(pool, capture.blocks.map(b => b.id)), store = new Store(pool);
  let inserted = 0, skipped = 0;
  for (const block of capture.blocks) {
    if (known.has(block.id)) { skipped++; continue; }
    const context = feeContextSchema.parse({ provider: 'mempool', observedAt: capture.capturedAt, status: 'unavailable', rates: null,
      error: 'E_HISTORICAL_QUOTE_UNAVAILABLE', kind: 'historical_blocks',
      completed: { observedAt: capture.capturedAt, status: 'available', blocks: [block], error: null } });
    // UUIDv8 keyed by network, immutable block hash and calculation version.
    const digest = createHash('sha256').update(`block-fees-v1:mainnet:${block.id}`).digest('hex');
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    if (await store.preserveFees('mainnet', id, context) !== 'durable') {
      // Another importer may have inserted the same immutable block meanwhile.
      if (!(await knownBlockFees(pool, [block.id])).has(block.id)) throw new Error('E_BACKFILL_PERSIST');
      skipped++; continue;
    }
    inserted++;
  }
  return { inserted, skipped, capturedAt: capture.capturedAt };
}
