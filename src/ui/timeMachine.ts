import { renderPage } from './page.js';

/** Apply the monitor's presentation to the portable snapshot without changing its evidence. */
export function renderTimeMachinePage(source: string): string {
  const headingStart = source.indexOf('<div class="page-heading ');
  const headingEnd = source.indexOf('<div id="loadError"', headingStart);
  if (headingStart < 0 || headingEnd < 0 || !source.includes('<header class="topbar">')) throw new Error('E_TIME_MACHINE_LAYOUT');
  const archive = `<p class="archive-label"><span>Replay coverage · UTC:</span> <strong id="archiveRange">Loading archive…</strong>
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
    .replace('<aside class="alert alert-light border mb-4"', '<aside class="saved-report"')
    .replace('<a href="/">← Back to monitor</a> · ', '')
    .replace('<footer>Alpen wallet analytics <span>Local report', '<footer>Alpen sequencer monitor <span>Saved analysis')
    // Match the chart palette too; packed report data contains no color literals.
    .replaceAll('#087f72', '#173c55').replaceAll('rgba(54, 164, 151,', 'rgba(23, 60, 85,');
  // This archive is mainnet evidence, including when linked from the Signet monitor.
  return renderPage(page, 'mainnet');
}
