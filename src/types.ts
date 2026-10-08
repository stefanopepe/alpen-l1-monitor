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
  completedAt?: number;
}
export interface PublicationAverage { averageSatVb: number | null; sampleSize: number; complete: boolean }
export interface PublicationReport {
  latest: { commitTxid: string; feeSats: number; feeRateSatVb: number; previous24h: PublicationAverage; previous7d: PublicationAverage } | null;
  nextExpectedAt: number | null; intervalSeconds: number | null; timingSampleSize: number;
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
export interface PostedEpoch {
  epoch: number; l1Height: number; l2Slot: string; l2BlockId: string;
  commitTxid: string; txid: string; blockHeight: number; blockHash: string; blockTime: number;
}
export interface EpochContext {
  sourceRef: string; latest: PostedEpoch | null; coverageComplete: boolean; undecodedCheckpoints: number;
}
export interface PostedEeDa {
  updateSeqNo: string; lastEvmBlock: string; evmTimestamp: string; version: 0;
  commitTxid: string; revealTxids: string[]; chunkCount: number; payloadBytes: number;
  blockHeight: number; blockHash: string; blockTime: number;
}
export interface EeDaContext {
  sourceRef: string; latest: PostedEeDa | null; coverageComplete: boolean;
  pendingPublications: number; undecodedPublications: number;
  pending?: PendingEeDa[];
}
export interface PendingEeDa {
  commitTxid: string; blockHeight: number; blockTime: number; chunkCount: number; confirmedChunks: number;
  observedPayloadBytes: number | null; commitVsize: number; confirmedRevealVsize: number;
  estimatedPayloadBytes: number | null; estimatedRemainingVsize: number | null; estimatedTotalVsize: number | null;
  expectedBlockHeight: number | null; expectedAt: number | null; sampleSize: number;
}
export interface Snapshot {
  publicationReport?: PublicationReport;
  eeDaContext?: EeDaContext;
  epochContext?: EpochContext;
  feeContext?: FeeContext;
  network: string; wallet: string; asOf: string; finishedAt: string; provider: string;
  tip: Tip; ceilingHit: { receive: boolean; change: boolean }; addressesScanned: number;
  composition: Composition; naiveRunway: NaiveRunway; requestsUsed: number;
  primaryIsPublic: boolean; networkTipOld: boolean; historyError: string | null;
  monitorVersion: string; selectorModelVersion: number; upstreamRef: string;
  deployedBuildConfirmed: boolean; configSha256: string;
}
export interface FeeRates {
  fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number; minimumFee: number;
}
export interface FeeContext {
  provider: 'mempool'; observedAt: string; status: 'available' | 'unavailable';
  rates: FeeRates | null; error: string | null;
  pressure?: import('./fees/schema.js').FeePressure;
  completed?: import('zod').infer<typeof import('./observations/schema.js').completedFeesSchema>;
  persistence?: 'durable' | 'unavailable';
  kind?: 'historical_blocks';
}
