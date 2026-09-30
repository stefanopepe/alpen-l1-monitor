import { readFileSync } from 'node:fs';
import type { Utxo, Settlement, AddressRecord } from '../src/types.js';
import { validateConfig } from '../src/config/load.js';
import type { ChainTx } from '../src/chain/schemas.js';
import type { ChainView } from '../src/chain/view.js';
export const rawConfig = () => JSON.parse(readFileSync('config/networks/mainnet.json', 'utf8'));
export const config = () => validateConfig(rawConfig(), 'mainnet', false);
export const hash = (n: number) => n.toString(16).padStart(64, '0');
export const utxo = (valueSats: number, confirmed = true, scriptType: Utxo['scriptType'] = 'p2wpkh', index = valueSats): Utxo => ({ txid: hash(index), vout: 0, valueSats, confirmed, blockHeight: confirmed ? 100 : null, address: 'wallet', chain: 0, index: 0, scriptType });
export const settlement = (index: number, cost = 1500): Settlement => ({ txid: hash(index), height: 100 + index, blockTime: 1000000 + index * 7200, complete: true, drainSats: cost, feeSats: cost - 546, weight: 1200 });
export const address: AddressRecord = { address: 'wallet', script: '0014' + '11'.repeat(20), chain: 0, index: 0, used: true, confirmedTxCount: 2, mempoolTxCount: 0 };
export const status = (height = 100) => ({ confirmed: true, block_height: height, block_hash: hash(height), block_time: height * 600 });
export function pair(change = true): { commit: ChainTx; reveal: ChainTx } {
  const funding = { scriptpubkey: '5120' + '22'.repeat(32), scriptpubkey_type: 'v1_p2tr', value: 949 };
  const commit: ChainTx = { txid: hash(1), fee: 487, weight: 685, status: status(),
    vin: [{ txid: hash(99), vout: 0, prevout: { scriptpubkey: address.script, scriptpubkey_type: 'v0_p2wpkh', value: change ? 10000 : 1436 } }],
    vout: [{ scriptpubkey: '6a08414c504e00000000', scriptpubkey_type: 'op_return', value: 0 }, funding,
      ...(change ? [{ scriptpubkey: address.script, scriptpubkey_type: 'v0_p2wpkh', value: 8564 }] : [])] };
  const reveal: ChainTx = { txid: hash(2), fee: 403, weight: 529, status: status(101),
    vin: [{ txid: commit.txid, vout: 1, prevout: funding, witness: ['signature', 'script', 'control'] }],
    vout: [{ scriptpubkey: address.script, scriptpubkey_type: 'v0_p2wpkh', value: 546 }] };
  return { commit, reveal };
}
export function fakeView(overrides: Partial<ChainView> = {}): ChainView {
  return { provider: 'fake', blockHashAt: async () => config().config.chain.checkpoint.hash,
    tip: async () => ({ height: 200, hash: hash(200), blockTime: 120000 }), tipHash: async () => hash(200),
    addressStats: async () => ({ chain_stats: { tx_count: 0 }, mempool_stats: { tx_count: 0 } }), addressUtxos: async () => [],
    addressTxsChain: async () => [], tx: async () => { throw new Error('Unexpected tx'); }, txStatus: async () => status(),
    outspend: async () => ({ spent: false }), ...overrides };
}
