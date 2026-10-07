import { renderPage } from './page.js';
import { renderFundingPresentation } from './fundingPresentation.js';

/** Apply the monitor's presentation to the portable snapshot without changing its evidence. */
export function renderTimeMachinePage(source: string, script: string, network = 'mainnet', transactions = ''): string {
  source = renderFundingPresentation(source);
  if (transactions) source = source.replace('</head>', `<script type="application/json" id="transactionData">${transactions}</script></head>`);
  if (script) {
    const start = source.lastIndexOf('<script>'), end = source.indexOf('</script>', start);
    if (start < 0 || end < 0) throw new Error('E_TIME_MACHINE_SCRIPT');
    source = source.slice(0, start) + '<script>' + script.replace(/<\/script/gi, '<\\/script') + source.slice(end);
  }
  const endpoint = network === 'mainnet' ? '/api/time-machine' : 'https://ee-ol-wallet-monitor.vercel.app/api/time-machine';
  // Older published templates predate posting-context panels in the current client.
  if (!source.includes('id="eeDaContext"')) source = source.replace('<p class="small text-secondary" id="fee">', '<div id="eeDaContext" style="white-space:pre-line"></div><div id="epochContext" style="white-space:pre-line"></div><p class="small text-secondary" id="fee">');
  const headingStart = source.indexOf('<div class="page-heading ');
  const headingEnd = source.indexOf('<div id="loadError"', headingStart);
  if (headingStart < 0 || headingEnd < 0 || !source.includes('<header class="topbar">')) throw new Error('E_TIME_MACHINE_LAYOUT');
  const archive = `<p class="archive-label"><span>Historical replay and wallet backtest · UTC:</span> <strong id="archiveRange">Loading archive…</strong>
    <small id="archiveBlocks"></small><small id="archiveEnd"></small></p>\n`;
  const header = `<header class="monitor-header">
    <!-- NETWORK_BANNER -->
    <h1>Alpen sequencer monitor</h1>
    <p>Fee analysis time machine · Wallet history · Seasonal fees</p>
    <p><a href="/">← Back to monitor</a></p>
    <span id="network" hidden></span>
  </header>`;
  const page = (source.slice(0, headingStart) + archive + source.slice(headingEnd))
    .replace(/<title>[^<]*<\/title>/, '<title>Alpen sequencer monitor · Fee analysis time machine</title>')
    .replace('</head>', '<link rel="stylesheet" href="/monitor.css">\n<link rel="stylesheet" href="/network.css">\n<link rel="stylesheet" href="/time-machine.css">\n</head>')
    .replace(/<header class="topbar">[\s\S]*?<\/header>/, header)
    .replace(/<aside class="alert alert-light border mb-4"[\s\S]*?<\/aside>/, `<aside class="saved-report" aria-label="Data freshness">
      <strong>Bitcoin mainnet · Updated analysis</strong>
      <p id="liveStatus" role="status">Connecting to the monitor… Current estimates are unavailable until fresh observations load.</p>
      <p>Wallet observations update every 15 minutes; the seasonal fee study refreshes hourly. This page checks for updates every five minutes while visible and waits longer after a failed request.</p>
      <p id="researchStatus">Loading the latest fee study…</p>
      <p>The historical replay and its wallet accuracy scores remain fixed to the archive dates below. Later dates show collected observations, with hourly samples for the last 14 days and daily samples for older dates.</p>
    </aside>`)
    .replace('<body', `<body data-live-endpoint="${endpoint}"`)
    .replace('<a href="/">← Back to monitor</a> · ', '')
    .replace('<footer>Alpen wallet analytics <span>Local report', '<footer>Alpen sequencer monitor <span>Historical replay + collected observations')
    // Match the chart palette too; packed report data contains no color literals.
    .replaceAll('#087f72', '#173c55').replaceAll('rgba(54, 164, 151,', 'rgba(23, 60, 85,');
  // This archive is mainnet evidence, including when linked from the Signet monitor.
  return renderPage(page, 'mainnet');
}
