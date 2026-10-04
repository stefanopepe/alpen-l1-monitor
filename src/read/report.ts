import type { ReadModel } from './model.js';
import type { PublicationAverage, Snapshot } from '../types.js';
import { summarizeFees } from './fees.js';
import { reportTime } from './time.js';

const number = (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const rate = (value: number | null | undefined) => value == null ? 'Unavailable' : number(value);
const row = (label: string, value: string | number) => `${(label + ':').padEnd(26)} ${value}`;
const reason: Record<string, string> = {
  discovery_incomplete: 'address discovery incomplete', history_incomplete: 'history incomplete',
  insufficient_settlements: 'insufficient settlement history', cadence_unavailable: 'cadence unavailable',
};
function trend(current: number | undefined, baseline: PublicationAverage | undefined): string {
  if (!baseline?.complete) return 'Unavailable · incomplete history';
  const average = baseline.averageSatVb;
  if (current === undefined || average === null || !baseline.sampleSize) return 'Unavailable · no previous publications';
  const percent = average === 0 ? null : Math.round((current / average - 1) * 1000) / 10;
  const unchanged = Math.abs(current - average) <= Math.max(1, current, average) * 1e-12;
  const arrow = unchanged ? '→' : current > average ? '↑' : '↓';
  const change = unchanged ? '0%' : percent === null ? 'from zero' : percent === 0 ? '<0.1%' : number(Math.abs(percent)) + '%';
  return `${arrow} ${change} · average ${number(average)} sat/vB · ${baseline.sampleSize} publications`;
}
function publicationCost(s: Snapshot): string[] {
  const latest = s.publicationReport?.latest;
  return [row('Total publication cost', latest ? `${number(latest.feeSats)} sats` : 'Unavailable'),
    row('Fee rate', latest ? `${number(latest.feeRateSatVb)} sat/vB` : 'Unavailable'),
    row('Trend vs previous 24h', trend(latest?.feeRateSatVb, latest?.previous24h)),
    row('Trend vs previous 7d', trend(latest?.feeRateSatVb, latest?.previous7d))];
}

export function renderReport(model: ReadModel, timezone = 'UTC'): string {
  const snapshots = model.wallets.flatMap(w => w.snapshot ? [w.snapshot] : []);
  const ol = model.wallets.find(w => w.wallet === 'ol'), epoch = ol?.snapshot?.epochContext;
  const fees = model.fees ?? summarizeFees(snapshots.flatMap(s => s.feeContext ? [s.feeContext] : []), new Date(model.readAt));
  const lines = ['ALPEN SEQUENCER MONITOR', '', row('Network', model.network === 'mainnet' ? 'Mainnet' : `Testnet · ${model.network}`),
    row('Report time', reportTime(model.readAt, timezone)), row('Client timezone', timezone),
    row('Provider', [...new Set(snapshots.map(s => s.provider))].join(', ') || 'Unavailable'),
    row('Data', model.preview?.sample ? 'DEMO: synthetic testnet wallets and example fees; no live wallet data.' : model.preview ? 'PREVIEW · saved inventory' : 'LIVE · saved observations'),
    row('Current Strata epoch', epoch?.latest ? `${number(epoch.latest.epoch)} · latest posted to Bitcoin${ol?.stale ? ' · STALE' : ''}${!epoch.coverageComplete || epoch.undecodedCheckpoints ? ' · partial evidence' : ''}` : 'Unavailable · no readable checkpoint collected'),
    row('Bitcoin block', snapshots.length ? number(Math.max(...snapshots.map(s => s.tip.height))) + ' · latest wallet scan' : 'Unavailable')];
  if (model.preview) lines.push(row('Preview captured', reportTime(model.preview.capturedAt, timezone)));
  const block = fees.latestBlock, b = fees.blocks24h;
  lines.push('', '', 'BITCOIN FEES · sat/vB', '',
    row('Latest block · median', block ? `${rate(block.medianSatVb)} · block ${number(block.height)}${Date.parse(model.readAt) - Date.parse(block.observedAt) > 3300000 ? ' · STALE' : ''}` : 'Unavailable'),
    row('Last 24h · lowest', rate(b.lowest)), row('Last 24h · highest', rate(b.highest)), row('Last 24h · average', rate(b.average)),
    row('Basis', 'Median fee rate of each mined block'), row('24h block coverage', `${b.complete ? 'Complete' : b.count ? 'Partial · available blocks only' : 'Unavailable'} · ${b.count} blocks`));
  if (block) lines.push(row('Block fees observed', reportTime(block.observedAt, timezone)));
  lines.push('', '', 'MEMPOOL RECOMMENDATIONS · sat/vB', '', `Priority              Current       24h average${fees.quoteCoverageSeconds < 86399 ? ' · partial' : ''}`);
  for (const [label, key] of [['No priority', 'economyFee'], ['Low priority', 'hourFee'], ['Medium priority', 'halfHourFee'], ['High priority', 'fastestFee']] as const)
    lines.push(`${label.padEnd(22)}${(fees.stale ? 'Unavailable' : rate(fees.rates?.[key])).padEnd(14)}${rate(fees.averageRates24h?.[key])}`);
  lines.push('', row('Fees updated', fees.observedAt ? reportTime(fees.observedAt, timezone) + (fees.stale ? ' · STALE / UNAVAILABLE' : '') : 'Unavailable'),
    row('24h quote coverage', `${number(fees.quoteCoverageSeconds / 3600)} / 24 hours`));
  const alerts: string[] = [];
  for (const w of model.wallets) {
    lines.push('', '', `${w.wallet.toUpperCase()} WALLET — ${w.stale ? 'STALE / UNAVAILABLE' : 'CURRENT'}`, '');
    const s = w.snapshot;
    if (!s) { lines.push('No successful collection yet.'); alerts.push(`${w.wallet.toUpperCase()}: no successful collection`); continue; }
    const c = s.composition, r = s.naiveRunway, next = s.publicationReport?.nextExpectedAt;
    lines.push(row('Updated', reportTime(s.asOf, timezone)), row('Bitcoin block', number(s.tip.height)), '',
      row('Total balance', `${number(c.balanceSats)} sats`), row('Spendable', `${number(c.spendableSats)} sats`),
      row('Stranded', `${number(c.strandedSats)} sats`), row('Unconfirmed above dust', `${number(c.unconfirmedGtDustSats)} sats`),
      row('Largest spendable UTXO', `${number(c.largestUtxoSats)} sats`), row('UTXOs', number(c.counts.total)),
      row('Estimated runway', r.days === null ? `Unavailable · ${reason[r.reason] ?? r.reason}` : `${number(r.days)} days`),
      row('Settlement sample', number(r.sampleSize)), '', 'Next expected transaction · estimated confirmation',
      w.stale ? 'Unavailable · stale wallet data' : !s.publicationReport ? 'Unavailable · not collected' : next ? `${reportTime(next, timezone)}${next * 1000 < Date.parse(model.readAt) ? ' · OVERDUE' : ''}` : 'Unavailable · insufficient or incomplete history');
    if (c.unsupportedGtDustSats) alerts.push(`${w.wallet.toUpperCase()}: ${number(c.unsupportedGtDustSats)} sats in unsupported outputs`);
    if (w.stale) alerts.push(`${w.wallet.toUpperCase()}: stale wallet data`);
    if (s.ceilingHit.receive || s.ceilingHit.change) alerts.push(`${w.wallet.toUpperCase()}: discovery limit reached; balances are lower bounds`);
    if (s.networkTipOld) alerts.push(`${w.wallet.toUpperCase()}: chain tip old`);
    if (!r.historyComplete) alerts.push(`${w.wallet.toUpperCase()}: settlement history incomplete`);
    if (w.wallet === 'ee') {
      const context = s.eeDaContext, p = context?.latest;
      lines.push('', 'Latest published blob');
      if (p) lines.push(row('Last EE block included', BigInt(p.lastEvmBlock).toLocaleString('en-US')), row('Payload size', `${number(p.payloadBytes)} bytes`),
        ...publicationCost(s), row('Bitcoin posting block', number(p.blockHeight)), row('Publication time', reportTime(p.blockTime, timezone)),
        row('Confirmations', number(s.tip.height - p.blockHeight + 1)));
      else lines.push(context ? 'Unavailable · no complete readable blob found' : 'Unavailable · not collected');
      if (!context) alerts.push('EE: publication data not collected');
      lines.push('', row('Blobs awaiting completion', context ? context.pendingPublications : 'Unavailable'));
      if (context && !context.coverageComplete) alerts.push('EE: posting history incomplete; latest progress may be missing');
      if (context?.undecodedPublications) alerts.push(`EE: unreadable publications: ${context.undecodedPublications}; latest progress may be incomplete`);
    }
    if (w.wallet === 'ol') {
      const context = s.epochContext, p = context?.latest;
      lines.push('', 'Latest published checkpoint');
      if (p) lines.push(row('Last OL block included', p.l2BlockId), row('Last OL slot included', BigInt(p.l2Slot).toLocaleString('en-US')),
        row('Last L1 block included', number(p.l1Height)), ...publicationCost(s), row('Bitcoin posting block', number(p.blockHeight)),
        row('Publication time', reportTime(p.blockTime, timezone)), row('Confirmations', number(s.tip.height - p.blockHeight + 1)));
      else lines.push(context ? 'Unavailable · no readable checkpoint found' : 'Unavailable · not collected');
      if (!context) alerts.push('OL: publication data not collected');
      if (context && !context.coverageComplete) alerts.push('OL: posting history incomplete; latest progress may be missing');
      if (context?.undecodedCheckpoints) alerts.push(`OL: unreadable checkpoints: ${context.undecodedCheckpoints}; latest progress may be incomplete`);
    }
  }
  lines.push('', '', 'DATA QUALITY', '');
  for (const w of model.wallets) {
    const s = w.snapshot, ctx = s?.eeDaContext ?? s?.epochContext;
    lines.push(row(`${w.wallet.toUpperCase()} wallet history`, !s ? 'Unavailable' : s.naiveRunway.historyComplete ? 'Complete' : 'Partial'),
      row(`${w.wallet.toUpperCase()} address discovery`, !s ? 'Unavailable' : s.ceilingHit.receive || s.ceilingHit.change ? 'Partial' : 'Complete'),
      row(`${w.wallet.toUpperCase()} publication data`, !ctx ? 'Not collected' : ('undecodedPublications' in ctx ? ctx.undecodedPublications : ctx.undecodedCheckpoints) ? 'Unreadable entries' : ctx.coverageComplete ? 'Readable' : 'Partial'),
      row(`${w.wallet.toUpperCase()} deployed build`, s?.deployedBuildConfirmed ? 'Confirmed' : 'Unconfirmed'));
  }
  if (fees.stale) alerts.push('Current mempool recommendations unavailable');
  lines.push(row('Proofs / acceptance', 'Not verified'), row('EE state diff', 'Not verified'), '', row('Alerts', alerts.length ? '\n' + alerts.map(a => '• ' + a).join('\n') : 'None'), '', '',
    'CALCULATION BASIS', '', row('Runway', 'Observed settlement spending; network fee forecasts excluded'),
    row('Next transaction', 'Last observed commit + median commit interval; confirmation estimate'),
    row('Publication cost', 'Combined commit and reveal fees'), row('Publication fee rate', '4 × combined fees / combined weight'),
    row('Fee trends', 'Same wallet; average complete publication rate; preceding 24h / 7d; latest excluded'),
    row('Mempool averages', 'Time-weighted saved quotes; gaps over 30 minutes excluded'),
    row('Pending blobs', 'Started publications awaiting complete confirmed data; not the sequencer queue'),
    '', '↑ Higher fee rate   ↓ Lower fee rate   → Unchanged', '', '', 'TRANSACTION DETAILS', '');
  for (const s of snapshots) {
    const p = s.eeDaContext?.latest ?? s.epochContext?.latest;
    if (!p) continue;
    lines.push(`${s.wallet.toUpperCase()} commit: ${p.commitTxid}`);
    for (const txid of 'revealTxids' in p ? p.revealTxids : [p.txid]) lines.push(`${s.wallet.toUpperCase()} data transaction: ${txid}`);
  }
  return lines.join('\n') + '\n';
}
