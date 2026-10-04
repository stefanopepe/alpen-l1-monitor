import type { Snapshot, Utxo, Settlement } from '../types.js';
import { composition } from '../model/composition.js';
import { naiveRunway, type Estimator } from '../model/naive.js';
import { publicationReport } from '../model/publication.js';
export function computeWalletSnapshot(input: {
  meta: Omit<Snapshot, 'composition' | 'naiveRunway'>; asOfEpoch: number;
  utxos: readonly Utxo[]; settlements: readonly Settlement[]; estimator: Estimator; historyComplete: boolean;
}): Snapshot {
  const measured = composition(input.utxos);
  return { ...input.meta, composition: measured,
    publicationReport: publicationReport(input.settlements, input.meta.eeDaContext?.latest?.commitTxid ?? input.meta.epochContext?.latest?.commitTxid,
      input.asOfEpoch, input.estimator, input.historyComplete && !input.meta.ceilingHit.receive && !input.meta.ceilingHit.change),
    naiveRunway: naiveRunway(measured.spendableSats, measured.balanceSats, input.settlements, input.asOfEpoch, input.estimator,
      input.historyComplete, !input.meta.ceilingHit.receive && !input.meta.ceilingHit.change) };
}
