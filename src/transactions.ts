import { z } from 'zod';
import type { FeeBucket } from './fees/schema.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const output = z.object({ scriptpubkey: z.string(), value: z.number().int().nonnegative() });
// Parse only the fields needed for inspection. Witnesses, descriptors and addresses never leave storage.
const transaction = z.object({
  txid: hash, fee: z.number().int().safe().nonnegative(), weight: z.number().int().safe().positive(),
  status: z.object({ confirmed: z.boolean(), block_height: z.number().int().optional(), block_time: z.number().int().optional(), block_hash: hash.optional() }),
  vin: z.array(z.object({ prevout: output.nullable() })), vout: z.array(output),
});
export interface FeeBenchmark {
  kind: 'block_median' | 'period_median'; rate: number; start: number; end: number; integerQuantized?: boolean;
}
export interface TransactionSummary {
  wallet: string; txid: string; height: number; time: number; blockHash: string;
  kind: 'commit' | 'reveal' | 'deposit' | 'consolidation' | 'spend' | 'unknown';
  feeSats: number; vsize: number; feeRate: number; packageId?: string; packageComplete?: boolean;
  benchmark: FeeBenchmark | null;
}
export interface TransactionPackage { commitTxid: string; revealTxids: string[]; complete: boolean }
export function assessFee(tx: Pick<TransactionSummary, 'feeSats' | 'vsize' | 'benchmark'>) {
  const b = tx.benchmark;
  // A zero in integer-quantized historical data does not mean confirmation was free.
  if (!b || (b.integerQuantized && b.rate === 0)) return { status: 'unknown' as const, benchmarkSats: null, excessSats: null, premium: null };
  const benchmarkSats = Math.ceil(tx.vsize * b.rate), excessSats = Math.max(0, tx.feeSats - benchmarkSats);
  return { status: excessSats > 0 ? 'above' as const : 'at_or_below' as const, benchmarkSats, excessSats,
    premium: benchmarkSats > 0 ? excessSats / benchmarkSats : null };
}
export function summarizeTransactions(wallet: string, inputs: unknown[], scripts: readonly string[], packages: readonly TransactionPackage[],
  buckets: readonly FeeBucket[] = [], blockRates: ReadonlyMap<string, FeeBenchmark> = new Map()): TransactionSummary[] {
  const owned = new Set(scripts), relations = new Map<string, { kind: 'commit' | 'reveal'; packageId: string; packageComplete: boolean }>();
  for (const p of packages) {
    relations.set(p.commitTxid, { kind: 'commit', packageId: p.commitTxid, packageComplete: p.complete });
    for (const id of p.revealTxids) relations.set(id, { kind: 'reveal', packageId: p.commitTxid, packageComplete: p.complete });
  }
  const unique = new Map<string, TransactionSummary>();
  for (const input of inputs) {
    const parsed = transaction.safeParse(input);
    if (!parsed.success) continue;
    const tx = parsed.data, s = tx.status;
    if (!s.confirmed || s.block_height === undefined || s.block_time === undefined || !s.block_hash) continue;
    const relation = relations.get(tx.txid), ownInputs = tx.vin.filter(i => i.prevout && owned.has(i.prevout.scriptpubkey));
    const ownOutputs = tx.vout.some(o => owned.has(o.scriptpubkey));
    if (!relation && !ownInputs.length && !ownOutputs) continue;
    const kind = relation?.kind ?? (!ownInputs.length ? 'deposit' : ownInputs.length !== tx.vin.length ? 'unknown' :
      tx.vout.every(o => o.value === 0 || owned.has(o.scriptpubkey)) ? 'consolidation' : 'spend');
    const bucket = buckets.find(b => b.start <= s.block_time! && b.end > s.block_time!);
    const benchmark = blockRates.get(s.block_hash) ?? (bucket ? { kind: 'period_median' as const, rate: bucket.rate,
      start: bucket.start, end: bucket.end, integerQuantized: true } : null);
    const vsize = Math.ceil(tx.weight / 4);
    unique.set(tx.txid, { wallet, txid: tx.txid, height: s.block_height, time: s.block_time, blockHash: s.block_hash,
      kind, feeSats: tx.fee, vsize, feeRate: tx.fee / vsize, ...relation, benchmark });
  }
  return [...unique.values()].sort((a, b) => a.time - b.time || a.txid.localeCompare(b.txid));
}
export function summarizeStoredTransactions(wallet: string, addresses: unknown, history: unknown, buckets: readonly FeeBucket[], blockRates: ReadonlyMap<string, FeeBenchmark>) {
  const state = z.object({ transactions: z.record(z.string(), z.unknown()).default({}), reveals: z.record(z.string(), z.array(transaction)).default({}) }).parse(history);
  const scripts = z.array(z.object({ script: z.string() })).parse(addresses).map(a => a.script);
  // sampleHistory retains these lists only after every expected reveal is confirmed.
  const packages = Object.entries(state.reveals).map(([commitTxid, reveals]) => ({ commitTxid, revealTxids: reveals.map(tx => tx.txid),
    complete: reveals.length > 0 && reveals.every(tx => tx.status.confirmed) && transaction.safeParse(state.transactions[commitTxid]).success }));
  return summarizeTransactions(wallet, [...Object.values(state.transactions), ...Object.values(state.reveals).flat()], scripts, packages, buckets, blockRates);
}
