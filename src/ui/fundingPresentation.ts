import { renderTransactionPresentation, transactionStyles } from './transactionPresentation.js';
import { chartLicensesMarkup } from './chartLicenses.js';
/** Keep portable reports and older hosted archives on the same funding terminology. */
export function renderFundingPresentation(source: string): string {
  return renderTransactionPresentation(source).replace('</head>', '<style>' + transactionStyles + '</style>' + (source.includes('id="chartLicenses"') ? '' : chartLicensesMarkup) + '</head>')
    .replace('Spendable balance · sats', 'Funding balance · sats')
    .replace('Spendable at this block', 'Funding balance')
    .replace('<strong id="balance">—</strong><small>sats</small>', '<strong id="balance">—</strong><small id="balanceHelp">sats</small>')
    .replace('<span><i class="legend-line actual"></i>Recorded spendable balance</span>', '<span><i class="legend-line actual"></i>Funding balance</span>')
    .replace('The dashed line assumes a constant spending rate and no new funding. The solid line includes actual deposits and wallet actions.', 'Pending funds stay in the balance. The projection assumes they confirm normally, spending continues at the selected rate and no new funding arrives. Confirmation details are in Wallet inventory.')
    .replace('Spendable balance includes confirmed usable outputs above 546 sats. Dust is shown separately.', 'The planning balance combines confirmed funding and recorded pending outputs above 546 sats. Small outputs and unsupported confirmed outputs are excluded. Historical replay retains its confirmed-chain balances because historical mempool data is unavailable. This is a funding projection, not a simulation of transaction timing. The <a href="https://github.com/alpenlabs/alpen/blob/d24ebe2396eecd04201f3d1a4de39fdf8a4827ef/crates/btcio/src/writer/chunked_envelope/signer.rs#L80-L101" target="_blank" rel="noopener noreferrer">operator-reported deployed source</a> still requires confirmation before using funds for a new commit.')
    .replace('This choice changes the dashed balance projection and the highlighted accuracy metrics.', 'This choice changes the balance projection and the highlighted accuracy metrics. Collected balances include pending funds, assuming normal confirmation.')
    .replace('A projected zero is an estimate; chain silence does not prove wallet failure.', 'A projected zero is an estimate; confirmation delays and chain silence do not prove wallet exhaustion.');
}
