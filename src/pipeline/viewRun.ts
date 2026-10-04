import { latestEeDa } from '../extract/eeDa.js';
import { latestPostedEpoch } from '../extract/epoch.js';
import type { ChainView } from '../chain/view.js';
import type { ValidatedConfig } from '../config/load.js';
import type { WalletConfig } from '../config/schema.js';
import type { AddressRecord, Snapshot, Tip, Utxo } from '../types.js';
import { discover, inventory, type AddressDeriver } from '../discovery/scan.js';
import { sampleHistory, type HistoryState } from '../extract/history.js';
export interface WalletScanState { addresses: AddressRecord[]; history: HistoryState; utxos?: Utxo[]; snapshot?: Snapshot }
export async function scanWalletView(v: ValidatedConfig, wallet: WalletConfig, previous: WalletScanState, view: ChainView, asOf: number,
  options: { exhaustive?: boolean; derive?: AddressDeriver; afterInventory?: (tip: Tip) => Promise<void> } = {}) {
  const scan = await discover(view, v.config, wallet, v.wallets.get(wallet.id)!, previous.addresses, options.derive);
  const { utxos, tip } = await inventory(view, scan.addresses, previous);
  await options.afterInventory?.(tip);
  const history = await sampleHistory(view, scan.addresses, previous.history, v.config, tip, asOf, options.exhaustive);
  const magic = v.config.checkpoint_reporting?.magic_hex ?? (v.config.network === 'mainnet' ? '53545241' : undefined);
  const epochContext = wallet.id === 'ol' && magic ? latestPostedEpoch(history.state.transactions, new Set(scan.addresses.map(a => a.script)), tip,
    history.complete && !scan.ceilingHit.receive && !scan.ceilingHit.change, magic) : undefined;
  const eeDaContext = wallet.id === 'ee' ? latestEeDa(history.state.transactions, new Set(scan.addresses.map(a => a.script)), tip,
    history.complete && !scan.ceilingHit.receive && !scan.ceilingHit.change) : undefined;
  return { ...scan, utxos, tip, history, epochContext, eeDaContext };
}
