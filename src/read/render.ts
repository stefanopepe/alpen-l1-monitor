import { eeDaReportLines } from './eeDa.js';
import { epochReportLines } from './epoch.js';
import type { ReadModel } from './model.js';
export function renderText(model: ReadModel): string {
  const lines = [`bridge-wallet-monitor v2 | ${model.network} | read at ${model.readAt}`,
    'Stage 0: naive runway only; no funding alert guarantee.', model.primaryIsPublic ? 'PUBLIC ESPLORA PRIMARY' : 'Internal Esplora primary'];
  for (const w of model.wallets) {
    lines.push('', `${w.name} (${w.wallet}) — ${w.stale ? 'STALE / UNAVAILABLE' : 'CURRENT'}`);
    if (!w.snapshot) { lines.push('No successful collection yet.'); continue; }
    const s = w.snapshot, c = s.composition, r = s.naiveRunway;
    lines.push(`As of ${s.asOf} | block ${s.tip.height} | ${s.provider}`,
      `Spendable: ${c.spendableSats} sats | stranded: ${c.strandedSats} sats`,
      `Inventory total: ${c.balanceSats} sats | unconfirmed above dust: ${c.unconfirmedGtDustSats} sats`,
      `Largest spendable UTXO: ${c.largestUtxoSats} sats | UTXOs: ${c.counts.total}`,
      `Naive spendable runway: ${r.days === null ? `unavailable (${r.reason})` : `${r.days.toFixed(2)} days`}`,
      `Settlement sample: ${r.sampleSize} | history complete: ${r.historyComplete}`);
    if (w.wallet === 'ee') lines.push(...eeDaReportLines(s.eeDaContext, s.tip));
    if (w.wallet === 'ol') lines.push(...epochReportLines(s.epochContext, s.tip));
    if (s.ceilingHit.receive || s.ceilingHit.change) lines.push('DISCOVERY CEILING: balances are LOWER BOUNDS; runway unavailable.');
    if (s.networkTipOld) lines.push('CHAIN TIP OLD: investigate provider/network freshness.');
    if (s.feeContext) lines.push(`Network fee context (mempool, ${s.feeContext.observedAt}): ${w.feeContextStale ? 'STALE / UNAVAILABLE' : `${s.feeContext.rates?.fastestFee} sat/vB fastest recommendation`}. Informational; not a runway input.`);
    if (s.feeContext?.pressure) lines.push(`Pressure collected ${s.feeContext.pressure.observedAt}: ${s.feeContext.pressure.status !== 'available' ? 'UNAVAILABLE' : Date.parse(model.readAt) - Date.parse(s.feeContext.pressure.observedAt) > 1800000 ? 'STALE' : 'AVAILABLE / UNVALIDATED'}.`);
    if (s.feeContext?.completed) lines.push(`Completed-block fees collected ${s.feeContext.completed.observedAt}: ${s.feeContext.completed.status}; durable evidence: ${s.feeContext.persistence ?? 'legacy run retention only'}.`);
    if (!s.deployedBuildConfirmed) lines.push('Deployed sequencer build unconfirmed.');
  }
  return lines.join('\n') + '\n';
}
const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
export function renderMetrics(model: ReadModel): string {
  const lines: string[] = [];
  const emitted = new Set<string>();
  function metric(name: string, value: number, labels: Record<string, string>, help: string, type = 'gauge') {
    if (!Number.isFinite(value)) throw new Error('E_METRIC_VALUE');
    if (!emitted.has(name)) { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`); emitted.add(name); }
    lines.push(`${name}{${Object.entries({ network: model.network, ...labels }).map(([k, v]) => `${k}="${escape(v)}"`).join(',')}} ${value}`);
  }
  metric('bridge_monitor_primary_is_public', Number(model.primaryIsPublic), {}, 'Primary provider is public.');
  for (const w of model.wallets) {
    const label = { wallet: w.wallet }, s = w.snapshot;
    metric('bridge_wallet_last_update_timestamp', s ? Date.parse(s.asOf) / 1000 : 0, label, 'Last successful inventory scan start, epoch seconds.');
    metric('bridge_wallet_stale', Number(w.stale), label, 'Missing or stale snapshot.');
    metric('bridge_wallet_snapshot_available', Number(s !== null), label, 'Stored snapshot exists.');
    metric('bridge_wallet_runway_available', Number(s?.naiveRunway.days !== null && s !== null), label, 'Naive runway is available.');
    if (!s) continue;
    if (w.wallet === 'ol') {
      const epoch = s.epochContext;
      metric('bridge_wallet_posted_epoch_available', Number(!!epoch?.latest), label, 'An OL checkpoint epoch was decoded from observed confirmed L1 history.');
      metric('bridge_wallet_posted_epoch_coverage_complete', Number(!!epoch?.coverageComplete && epoch.undecodedCheckpoints === 0), label, 'Wallet discovery and retained history are complete with no undecoded checkpoint postings.');
      if (epoch?.latest) {
        metric('bridge_wallet_latest_posted_epoch', epoch.latest.epoch, label, 'Highest observed OL checkpoint epoch posted to Bitcoin; ASM acceptance is unverified.');
        metric('bridge_wallet_latest_posted_epoch_block_height', epoch.latest.blockHeight, label, 'Bitcoin block containing the observed epoch reveal.');
      }
    }
    for (const [field, suffix] of [['spendableSats', 'spendable_sats'], ['strandedSats', 'stranded_sats'], ['balanceSats', 'balance_sats'], ['largestUtxoSats', 'largest_utxo_sats'], ['unconfirmedGtDustSats', 'unconfirmed_gt_dust_sats']] as const)
      metric(`bridge_wallet_${suffix}`, s.composition[field], label, 'Wallet inventory in satoshis, as of last update.');
    metric('bridge_wallet_discovery_ceiling_hit', Number(s.ceilingHit.receive || s.ceilingHit.change), label, 'Discovery incomplete; balances are lower bounds.');
    metric('bridge_wallet_history_complete', Number(s.naiveRunway.historyComplete), label, 'Settlement window coverage complete.');
    metric('bridge_wallet_settlement_sample_size', s.naiveRunway.sampleSize, label, 'Complete settlements in naive runway sample.');
    if (s.naiveRunway.days !== null) metric('bridge_wallet_naive_runway_days', s.naiveRunway.days, label, 'Naive spendable runway; not the selector model.');
    if (s.naiveRunway.drainPerDaySats !== null) metric('bridge_wallet_naive_drain_per_day_sats', s.naiveRunway.drainPerDaySats, label, 'Observed median settlement drain times cadence.');
    metric('bridge_monitor_version', 1, { ...label, version: s.monitorVersion }, 'Collector version of snapshot.');
    metric('bridge_monitor_upstream_ref', 1, { ...label, ref: s.upstreamRef }, 'Assumed upstream build.');
    metric('bridge_monitor_deployed_build_confirmed', Number(s.deployedBuildConfirmed), label, 'Upstream deployment was confirmed.');
  }
  for (const e of model.providerErrors) metric('bridge_monitor_provider_errors_total', e.total, { provider: e.provider }, 'Provider attempt failures.', 'counter');
  return lines.join('\n') + '\n';
}
