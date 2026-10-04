import type { ChainTx } from '../chain/schemas.js';
import type { Settlement } from '../types.js';
export function commitOutputs(tx: ChainTx, scripts: ReadonlySet<string>): number[] | null {
  if (!tx.vin.every(v => v.prevout && scripts.has(v.prevout.scriptpubkey))) return null;
  const funding: number[] = [];
  let change = 0;
  for (const [index, out] of tx.vout.entries()) {
    if (scripts.has(out.scriptpubkey)) { if (out.value > 0) change++; }
    else if (out.scriptpubkey_type === 'v1_p2tr') funding.push(index);
    else if (out.scriptpubkey_type !== 'op_return' || out.value !== 0) return null;
  }
  return funding.length > 0 && change <= 1 ? funding : null;
}
export function validFee(tx: ChainTx): boolean {
  if (tx.vin.some(v => !v.prevout)) return false;
  const inputs = tx.vin.reduce((s, v) => s + v.prevout!.value, 0), outputs = tx.vout.reduce((s, v) => s + v.value, 0);
  return Number.isSafeInteger(inputs) && Number.isSafeInteger(outputs) && inputs - outputs === tx.fee;
}
export function revealShaped(commit: ChainTx, index: number, reveal: ChainTx, scripts: ReadonlySet<string>): boolean {
  const input = reveal.vin[0];
  return reveal.vin.length === 1 && input?.txid === commit.txid && input.vout === index && (input.witness?.length ?? input.witnessItemCount ?? 0) >= 3
    && input.prevout?.value === commit.vout[index]?.value && input.prevout?.scriptpubkey === commit.vout[index]?.scriptpubkey
    && reveal.vout.every(v => v.value === 0 || scripts.has(v.scriptpubkey));
}
export function settlementObservation(commit: ChainTx, reveals: readonly ChainTx[], expected: number, scripts: ReadonlySet<string>): Settlement {
  const complete = reveals.length === expected && reveals.every(r => r.status.confirmed);
  const walletInput = commit.vin.reduce((s, v) => s + (scripts.has(v.prevout!.scriptpubkey) ? v.prevout!.value : 0), 0);
  const outputs = [commit, ...reveals].flatMap(t => t.vout).filter(v => scripts.has(v.scriptpubkey));
  const fees = commit.fee + reveals.reduce((s, r) => s + r.fee, 0);
  if (complete && walletInput - outputs.reduce((s, v) => s + v.value, 0) !== fees) throw new Error('E_SETTLEMENT_INTEGRITY');
  return { txid: commit.txid, height: commit.status.block_height!, blockTime: commit.status.block_time!, complete,
    ...(complete ? { completedAt: Math.max(commit.status.block_time!, ...reveals.map(r => r.status.block_time!)) } : {}),
    feeSats: complete ? fees : null, weight: complete ? commit.weight + reveals.reduce((s, r) => s + r.weight, 0) : null,
    drainSats: complete ? fees + outputs.filter(v => v.value <= 546).reduce((s, v) => s + v.value, 0) : null };
}
