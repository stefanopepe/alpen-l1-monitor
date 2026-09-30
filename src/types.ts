export interface Utxo {
  txid: string; vout: number; valueSats: number; confirmed: boolean; blockHeight: number | null;
  address: string; chain: 0 | 1; index: number; scriptType: 'p2wpkh' | 'p2tr' | 'other';
}
export interface AddressRecord {
  chain: 0 | 1; index: number; address: string; script: string; used: boolean;
  confirmedTxCount: number; mempoolTxCount: number;
}
export interface Tip { height: number; hash: string; blockTime: number }
export interface Settlement {
  txid: string; height: number; blockTime: number; complete: boolean;
  drainSats: number | null; feeSats: number | null; weight: number | null;
}
export interface Composition {
  balanceSats: number; spendableSats: number; strandedSats: number;
  unconfirmedGtDustSats: number; unsupportedGtDustSats: number; largestUtxoSats: number;
  counts: { total: number; dust: number; confirmedSpendable: number; unconfirmed: number; unsupported: number };
}
export interface NaiveRunway {
  method: 'spendable / (observed median settlement drain * median-interval cadence)';
  days: number | null; aggregateDays: number | null; drainPerDaySats: number | null;
  costPerSettlementSats: number | null; settlementsPerDay: number | null;
  sampleSize: number; sampleSpanDays: number; historyComplete: boolean;
  reason: 'available' | 'no_spendable_funds' | 'discovery_incomplete' | 'history_incomplete' | 'insufficient_settlements' | 'cadence_unavailable';
}
export interface Snapshot {
  network: string; wallet: string; asOf: string; finishedAt: string; provider: string;
  tip: Tip; ceilingHit: { receive: boolean; change: boolean }; addressesScanned: number;
  composition: Composition; naiveRunway: NaiveRunway; requestsUsed: number;
  primaryIsPublic: boolean; networkTipOld: boolean; historyError: string | null;
  monitorVersion: string; selectorModelVersion: number; upstreamRef: string;
  deployedBuildConfirmed: boolean; configSha256: string;
}
