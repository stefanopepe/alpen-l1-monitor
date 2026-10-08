import { z } from 'zod';
import { feePressureSchema } from '../fees/schema.js';
const rate = z.number().finite().nonnegative();
export const transactionFeesSchema = z.object({
  basis: z.literal('median_transaction_fee_per_vbyte'),
  transactionCount: z.number().int().nonnegative(), medianSatVb: rate.nullable(),
}).refine(v => v.transactionCount === 0 ? v.medianSatVb === null : v.medianSatVb !== null);
export const completedBlockSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), height: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(), weight: z.number().int().min(0).max(4000000),
  tx_count: z.number().int().positive().max(20000).optional(),
  extras: z.object({ medianFee: rate, feeRange: z.array(rate).min(1).max(100), totalFees: z.number().int().safe().nonnegative().optional() }),
  transactionFees: transactionFeesSchema.optional(),
  transactionFeesError: z.string().regex(/^E_BLOCK_FEES_[A-Z_]+$/).optional(),
});
export const completedFeesSchema = z.object({
  observedAt: z.iso.datetime(), status: z.enum(['available', 'unavailable']),
  blocks: z.array(completedBlockSchema).min(1).max(15).nullable(), error: z.string().nullable(),
}).refine(v => v.status === 'available' ? v.blocks !== null && v.error === null : v.blocks === null && v.error !== null);
export const feeRatesSchema = z.object({ fastestFee: rate, halfHourFee: rate, hourFee: rate, economyFee: rate, minimumFee: rate });
export const feeContextSchema = z.object({
  provider: z.literal('mempool'), observedAt: z.iso.datetime(), status: z.enum(['available', 'unavailable']),
  rates: feeRatesSchema.nullable(), error: z.string().nullable(),
  pressure: feePressureSchema.optional(),
  completed: completedFeesSchema.optional(),
  persistence: z.enum(['durable', 'unavailable']).optional(),
  kind: z.literal('historical_blocks').optional(),
}).refine(v => v.status === 'available' ? v.rates !== null && v.error === null : v.rates === null)
  .refine(v => !v.kind || (v.status === 'unavailable' && v.rates === null && !v.pressure && v.completed?.status === 'available'));
