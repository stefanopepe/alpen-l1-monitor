/** Shared markup for the portable report and the older hosted archive. */
export function renderTransactionPresentation(source: string): string {
  if (source.includes('id="transactionInspector"')) return source;
  return source.replace('<div class="burndown-chart">', `<p class="chart-caption" id="timelineHelp">Drag the overview handles below to zoom out or select a longer timeline. Drag the selected window to pan · Ctrl + scroll or pinch to zoom · ↻ resets the view.</p>
    <p class="chart-caption" id="visibleRange" role="status"></p><div class="burndown-chart">`)
    .replace(/<canvas id="balanceChart"[^>]*><\/canvas>/, '<div id="balanceChart" role="img" aria-label="Interactive funding timeline with transaction markers" aria-describedby="timelineHelp"></div>')
    .replace('Funding or wallet action</span>', 'Transaction markers · click to inspect</span>')
    .replace('<p class="chart-caption" id="burndownCaption"></p>', `<p class="chart-caption" id="burndownCaption"></p>
      <p class="chart-caption">Confirmed transactions appear in separate commit, reveal and wallet-action rows. Hover for fees and size; click to inspect. Multiple transactions in the same row and block share a marker.</p>
      <section class="transaction-inspector" id="transactionInspector" aria-labelledby="transactionTitle" tabindex="-1">
        <div class="section-heading"><h3 id="transactionTitle">Transaction details</h3><a id="transactionExplorer" target="_blank" rel="noopener noreferrer" hidden>View on mempool.space ↗</a></div>
        <p id="transactionWhen" class="chart-caption">Choose a marker or a transaction below.</p>
        <label for="transactionChoice" class="form-label">Transactions in this block</label><select class="form-select" id="transactionChoice" disabled></select>
        <div class="transaction-stats" id="transactionStats"></div>
        <p class="chart-caption" id="transactionBenchmark"></p><p class="chart-caption" id="transactionPackage"></p>
        <div id="transactionRelated" class="transaction-related"></div><p id="transactionId" class="transaction-id"></p>
      </section>`)
    .replace('Funding &amp; wallet actions <span', 'Transactions in view <span')
    .replace('<div class="list-group list-group-flush event-list mt-3" id="events"></div>', `<div class="transaction-filters"><label for="transactionFilter">Show</label><select id="transactionFilter" class="form-select"><option value="all">All transactions</option><option value="commit">Commits</option><option value="reveal">Reveals</option><option value="deposit">Funding received</option><option value="other">Other wallet activity</option></select></div><div class="list-group list-group-flush event-list mt-3" id="events"></div><button type="button" class="btn btn-outline-secondary" id="moreTransactions" hidden>Show more transactions</button>`);
}
export const transactionStyles = `
.burndown-chart{height:520px!important}#balanceChart{width:100%;height:100%}
@media(max-width:575px){.burndown-chart{height:470px!important}}
.transaction-inspector{border:1px solid #dce5eb;background:#f6f8fa;padding:1rem;margin:1rem 0;color:#193240}
.transaction-inspector .section-heading{margin-bottom:.5rem}.transaction-inspector a{font-size:13px;color:#173c55}
.transaction-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin:1rem 0}
.transaction-stats span,.transaction-stats small{display:block;font-size:12px;color:#687f8f}.transaction-stats strong{font:600 17px/1.6 ui-monospace,monospace;display:block}
.transaction-id{overflow-wrap:anywhere;font:12px ui-monospace,monospace;margin:1rem 0 0}.transaction-related{display:flex;gap:.5rem;flex-wrap:wrap}
.transaction-related .btn{font-size:12px;padding:.4rem}.transaction-filters{display:flex;align-items:center;gap:.5rem;margin-top:1rem}
.event-list .transaction-selected{background:#e8eef3}.event-list .event-fees{display:block;color:#193240;font-size:12px;margin-top:.25rem}
@media(max-width:575px){.transaction-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.transaction-inspector .section-heading{display:block}}
`;
