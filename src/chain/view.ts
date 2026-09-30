import type { z } from 'zod';
import type { Tip } from '../types.js';
import type { ChainTx, Outspend, TxStatus, statsSchema, utxosSchema } from './schemas.js';
// Future AsOfChainView must implement this surface; algorithms never call fetch directly.
export interface ChainView {
  readonly provider: string;
  blockHashAt(height: number): Promise<string>;
  tip(): Promise<Tip>;
  tipHash(): Promise<string>;
  addressStats(address: string): Promise<z.infer<typeof statsSchema>>;
  addressUtxos(address: string): Promise<z.infer<typeof utxosSchema>>;
  addressTxsChain(address: string, cursor?: string): Promise<ChainTx[]>;
  tx(txid: string): Promise<ChainTx>;
  txStatus(txid: string): Promise<TxStatus>;
  outspend(txid: string, vout: number): Promise<Outspend>;
}
