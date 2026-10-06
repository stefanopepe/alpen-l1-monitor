import type { ReplayRecord } from '../evaluate.js';
import type { FeeStudy } from '../../fees/schema.js';
import type { TransactionSummary } from '../../transactions.js';

export interface LiveTimeMachine {
  network: string; readAt: string; staleAfterSeconds: number; records: ReplayRecord[];
  study: FeeStudy | null; researchUpdatedAt: string | null; researchError: string | null;
  transactions?: TransactionSummary[];
}
export function mergeCollected(archive: readonly ReplayRecord[], live: readonly ReplayRecord[]): ReplayRecord[] {
  const end = Math.max(...archive.map(r => Date.parse(r.snapshot.asOf)));
  return [...archive, ...new Map(live.filter(r => r.snapshot.network === 'mainnet' && Date.parse(r.snapshot.asOf) > end)
    .map(r => [r.snapshot.wallet + ':' + r.snapshot.asOf, r])).values()]
    .sort((a, b) => Date.parse(a.snapshot.asOf) - Date.parse(b.snapshot.asOf));
}
export function walletFresh(record: ReplayRecord, staleAfterSeconds: number, now = Date.now()): boolean {
  const age = (now - Date.parse(record.snapshot.asOf)) / 1000;
  return record.collected === true && age >= 0 && age <= staleAfterSeconds;
}
