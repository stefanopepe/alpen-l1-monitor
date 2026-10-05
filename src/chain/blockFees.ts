import { z } from 'zod';
import { completedBlockSchema } from '../observations/schema.js';

// Parse provider fields separately so only our verified calculation can set transactionFees.
export const sourceBlockSchema = completedBlockSchema.omit({ transactionFees: true, transactionFeesError: true }).extend({
  tx_count: z.number().int().positive().max(20000),
  extras: completedBlockSchema.shape.extras.extend({ totalFees: z.number().int().safe().nonnegative() }),
});
const summarySchema = z.array(z.object({
  txid: z.string().regex(/^[a-f0-9]{64}$/),
  // Core BTC-to-satoshi conversion can leave artifacts such as 27300.000000000004.
  fee: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)
    .refine(value => Math.abs(value - Math.round(value)) < 1e-6).transform(value => Math.round(value)),
  vsize: z.number().finite().positive().max(1000000),
})).min(1).max(20000);
type Block = z.infer<typeof completedBlockSchema>;
type SourceBlock = z.infer<typeof sourceBlockSchema>;

async function transactionFees(block: SourceBlock, fetcher: typeof fetch, baseUrl: string, deadline: AbortSignal): Promise<Block> {
  try {
    deadline.throwIfAborted();
    const response = await fetcher(`${baseUrl}/v1/block/${block.id}/summary`, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'E_BLOCK_FEES_RATE_LIMITED' : 'E_BLOCK_FEES_HTTP');
    const parsed = summarySchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('E_BLOCK_FEES_SCHEMA');
    const txs = parsed.data;
    if (txs.length !== block.tx_count || new Set(txs.map(tx => tx.txid)).size !== txs.length ||
      txs[0]!.fee !== 0 || txs.reduce((sum, tx) => sum + tx.fee, 0) !== block.extras.totalFees)
      throw new Error('E_BLOCK_FEES_INCOMPLETE');
    // The summary is in block order: exclude only coinbase, retaining genuine zero-fee transactions.
    // mempool reports weight/4 as vsize; Bitcoin's virtual size rounds it up per transaction.
    const rates = txs.slice(1).map(tx => tx.fee / Math.ceil(tx.vsize)).sort((a, b) => a - b);
    const i = Math.floor(rates.length / 2);
    const medianSatVb = !rates.length ? null : rates.length % 2 ? rates[i]! : (rates[i - 1]! + rates[i]!) / 2;
    return { ...block, transactionFees: { basis: 'median_transaction_fee_per_vbyte', transactionCount: rates.length, medianSatVb } };
  } catch (e) {
    const error = e instanceof Error && /^E_BLOCK_FEES_[A-Z_]+$/.test(e.message) ? e.message : 'E_BLOCK_FEES_UNAVAILABLE';
    return { ...block, transactionFeesError: error };
  }
}

/** At most 15 summaries, three concurrent requests, and 20 seconds for the entire enrichment. */
export async function enrichBlockFees(blocks: SourceBlock[], fetcher: typeof fetch, baseUrl: string): Promise<Block[]> {
  const deadline = AbortSignal.timeout(20000), results: Block[] = new Array(blocks.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, blocks.length) }, async () => {
    while (cursor < blocks.length) {
      const index = cursor++;
      results[index] = await transactionFees(blocks[index]!, fetcher, baseUrl, deadline);
    }
  }));
  return results;
}
