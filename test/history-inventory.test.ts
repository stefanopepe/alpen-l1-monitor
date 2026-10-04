import { expect, it } from 'vitest';
import { historyInventory } from '../src/consolidation/historyInventory.js';
import type { ChainTx } from '../src/chain/schemas.js';
const address = { address: 'test', script: '0014' + 'aa'.repeat(20), chain: 0 as const, index: 7 };
const output = { scriptpubkey: address.script, scriptpubkey_type: 'v0_p2wpkh', value: 546 };
const parent: ChainTx = { txid: '01'.repeat(32), fee: 0, weight: 100, status: { confirmed: true, block_height: 1, block_hash: '11'.repeat(32), block_time: 1 }, vin: [{ txid: '00'.repeat(32), vout: 0, prevout: null, is_coinbase: true }], vout: [output, output] };
const spend: ChainTx = { txid: '02'.repeat(32), fee: 1, weight: 100, status: { confirmed: true, block_height: 2, block_hash: '22'.repeat(32), block_time: 2 }, vin: [{ txid: parent.txid, vout: 0, prevout: output }], vout: [{ ...output, value: 545 }] };
it('reconstructs explicit outpoints including spends and block cutoffs, independent of history order', () => {
  expect(historyInventory([address], [spend, parent], 1).utxos).toHaveLength(2);
  const result = historyInventory([address], [spend, parent], 2);
  expect(result.outputs).toHaveLength(3);
  expect(result.utxos.map(u => u.valueSats)).toEqual([546, 545]);
  expect(result.outputs[0]?.spentBy).toBe(spend.txid);
});
it('refuses missing parents, value disagreement, duplicate transactions and double spends', () => {
  expect(() => historyInventory([address], [spend], 2)).toThrow('E_EXPORT_MISSING_PARENT');
  const bad = structuredClone(spend); bad.vin[0]!.prevout!.value++;
  expect(() => historyInventory([address], [parent, bad], 2)).toThrow('E_EXPORT_MISSING_PARENT');
  expect(() => historyInventory([address], [parent, parent], 2)).toThrow('E_EXPORT_DUPLICATE_TX');
  expect(() => historyInventory([address], [parent, spend, { ...spend, txid: '03'.repeat(32) }], 2)).toThrow('E_EXPORT_DOUBLE_SPEND');
});
it('handles more than 10,000 historical outputs without mistaking spent history for inventory', () => {
  const funding = { ...parent, vout: Array.from({ length: 10001 }, () => output) };
  const sweep = { ...spend, vin: funding.vout.map((prevout, vout) => ({ txid: funding.txid, vout, prevout })),
    vout: [{ ...output, value: 10001 * 546 - 1000 }] };
  const result = historyInventory([address], [sweep, funding], 2);
  expect(result.outputs).toHaveLength(10002);
  expect(result.utxos).toHaveLength(1);
  expect(result.utxos[0]?.valueSats).toBe(5459546);
});
