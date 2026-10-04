import { z } from 'zod';
export const safeInt = z.number().int().nonnegative().safe();
export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const statusSchema = z.object({ confirmed: z.boolean(), block_height: safeInt.nullish(), block_hash: hashSchema.nullish(), block_time: safeInt.nullish() }).refine(s => !s.confirmed || (s.block_height != null && s.block_hash != null && s.block_time != null));
export const statsSchema = z.object({ chain_stats: z.object({ tx_count: safeInt }), mempool_stats: z.object({ tx_count: safeInt }) });
export const utxosSchema = z.array(z.object({ txid: hashSchema, vout: safeInt, value: safeInt, status: statusSchema }));
const outputSchema = z.object({ scriptpubkey: z.string().regex(/^(?:[0-9a-f]{2})*$/), scriptpubkey_type: z.string(), scriptpubkey_address: z.string().optional(), value: safeInt });
export const txSchema = z.object({ txid: hashSchema, fee: safeInt, weight: safeInt.positive(), status: statusSchema,
  vin: z.array(z.object({ txid: hashSchema, vout: safeInt, prevout: outputSchema.nullable(), witness: z.array(z.string()).optional(), witnessItemCount: safeInt.optional(), is_coinbase: z.boolean().optional() })).min(1),
  vout: z.array(outputSchema).min(1),
});
export const outspendSchema = z.object({ spent: z.boolean(), txid: hashSchema.optional(), vin: safeInt.optional(), status: statusSchema.optional() }).refine(o => !o.spent || (o.txid !== undefined && o.vin !== undefined));
export const blockSchema = z.object({ id: hashSchema, height: safeInt, timestamp: safeInt });
// Local collector evidence only: provider responses cannot supply this cache.
export interface EnvelopeEvidence { version: 1; payloadBytes: number; prefixHex: string }
export type ChainTx = z.infer<typeof txSchema> & { envelopeEvidence?: EnvelopeEvidence };
export type TxStatus = z.infer<typeof statusSchema>;
export type Outspend = z.infer<typeof outspendSchema>;
