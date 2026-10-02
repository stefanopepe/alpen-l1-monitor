import type { ChainView } from '../chain/view.js';
import type { ValidatedConfig } from '../config/load.js';
import type { WalletConfig } from '../config/schema.js';
import type { AddressRecord, Tip } from '../types.js';
import { discover, inventory, type AddressDeriver } from '../discovery/scan.js';
import { sampleHistory, type HistoryState } from '../extract/history.js';
export interface WalletScanState { addresses: AddressRecord[]; history: HistoryState }
export async function scanWalletView(v: ValidatedConfig, wallet: WalletConfig, previous: WalletScanState, view: ChainView, asOf: number,
  options: { exhaustive?: boolean; derive?: AddressDeriver; afterInventory?: (tip: Tip) => Promise<void> } = {}) {
  const scan = await discover(view, v.config, wallet, v.wallets.get(wallet.id)!, previous.addresses, options.derive);
  const { utxos, tip } = await inventory(view, scan.addresses);
  await options.afterInventory?.(tip);
  const history = await sampleHistory(view, scan.addresses, previous.history, v.config, tip, asOf, options.exhaustive);
  return { ...scan, utxos, tip, history };
}
