import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { txSchema } from '../src/chain/schemas.js';
import { commitOutputs, revealShaped, settlementObservation, validFee } from '../src/extract/classify.js';
it.each(['ee', 'ol'])('replays a provenance-stamped live mainnet %s settlement without network access', wallet => {
  const raw = JSON.parse(readFileSync(`test/fixtures/mainnet/${wallet}-settlement.json`, 'utf8'));
  const commit = txSchema.parse(raw.commit), reveals = txSchema.array().parse(raw.reveals), scripts = new Set<string>(raw.wallet_scripts);
  expect(raw.provenance.provider).toBe('blockstream');
  const indices = commitOutputs(commit, scripts)!;
  // The captured OL layout differs from EE: P2TR is first, with OP_RETURN on the reveal.
  expect(indices).toEqual(wallet === 'ee' ? [1] : [0]);
  if (wallet === 'ol') {
    expect(commit.vout.map(o => o.scriptpubkey_type)).toEqual(['v1_p2tr', 'v0_p2wpkh']);
    expect(reveals[0]!.vout.map(o => [o.scriptpubkey_type, o.value])).toEqual([['op_return', 0], ['v0_p2wpkh', 546]]);
  }
  expect(indices.length).toBe(reveals.length);
  reveals.forEach((r, i) => { expect(revealShaped(commit, indices[i]!, r, scripts)).toBe(true); expect(validFee(r)).toBe(true); });
  expect(validFee(commit)).toBe(true);
  const observation = settlementObservation(commit, reveals, indices.length, scripts);
  // Independent wallet-input minus non-dust wallet-output accounting.
  const spendableOutputs = [commit,...reveals].flatMap(t => t.vout).filter(o => scripts.has(o.scriptpubkey) && o.value > 546).reduce((s,o) => s+o.value,0);
  const inputs = commit.vin.reduce((s,i) => s+i.prevout!.value,0);
  expect(observation.complete).toBe(true);
  expect(observation.drainSats).toBe(inputs-spendableOutputs);
});
