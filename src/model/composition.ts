import type { Composition, Utxo } from '../types.js';
export const DUST_LIMIT_SATS = 546;
export const SELECTOR_MODEL_VERSION = 1;
export function commitCandidateFilter(u: Utxo): boolean {
  return u.valueSats > DUST_LIMIT_SATS && u.confirmed && (u.scriptType === 'p2wpkh' || u.scriptType === 'p2tr');
}
export function composition(utxos: readonly Utxo[]): Composition {
  const result: Composition = { balanceSats: 0, spendableSats: 0, strandedSats: 0, unconfirmedGtDustSats: 0, unsupportedGtDustSats: 0, largestUtxoSats: 0,
    counts: { total: utxos.length, dust: 0, confirmedSpendable: 0, unconfirmed: 0, unsupported: 0 } };
  const seen = new Set<string>();
  for (const u of utxos) {
    if (!Number.isSafeInteger(u.valueSats) || u.valueSats < 0 || seen.has(`${u.txid}:${u.vout}`)) throw new Error('E_UTXO_INVALID');
    seen.add(`${u.txid}:${u.vout}`); result.balanceSats += u.valueSats;
    if (u.valueSats <= DUST_LIMIT_SATS) { result.strandedSats += u.valueSats; result.counts.dust++; }
    else if (!u.confirmed) { result.unconfirmedGtDustSats += u.valueSats; result.counts.unconfirmed++; }
    else if (commitCandidateFilter(u)) { result.spendableSats += u.valueSats; result.counts.confirmedSpendable++; result.largestUtxoSats = Math.max(result.largestUtxoSats, u.valueSats); }
    else { result.unsupportedGtDustSats += u.valueSats; result.counts.unsupported++; }
  }
  if (!Number.isSafeInteger(result.balanceSats)) throw new Error('E_SATS_OVERFLOW');
  return result;
}
