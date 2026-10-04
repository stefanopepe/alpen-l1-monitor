import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidatedConfig } from '../config/load.js';
import { validateConfig } from '../config/load.js';
import { emptyHistory } from '../extract/history.js';
import { scanWalletView } from '../pipeline/viewRun.js';
import { computeWalletSnapshot } from '../pipeline/snapshot.js';
import type { FeeContext, Settlement } from '../types.js';
import { MONITOR_VERSION } from '../version.js';
import { ArchiveIndex, AsOfChainView } from './asOfView.js';
import { type ChainArchive, canonical, digest, directoryBytes, writeJson } from './archive.js';
import { type ReplayRecord, forecasts, evaluate } from './evaluate.js';
import { deriveOutcomes } from './outcomes.js';
import { implementationProvenance } from './provenance.js';
export interface ReplayOptions { from?: string; to?: string; step?: number; config?: ValidatedConfig; observations?: FeeContext[]; progress?: (s: string) => void }
export async function replayAt(index: ArchiveIndex, v: ValidatedConfig, height: number, walletId: string) {
  const wallet = v.config.wallets.find(w => w.id === walletId);
  if (!wallet) throw new Error('E_REPLAY_WALLET');
  const view = new AsOfChainView(index, height), asOfEpoch = index.clock(height), asOf = new Date(asOfEpoch * 1000).toISOString();
  const known = new Map(index.archive.addresses.filter(a => a.wallet === walletId).map(a => [a.chain + ':' + a.index, a]));
  // Baselines always cover 7/30 days, even when auditing a shorter current-model window.
  const scanConfig = { ...v, config: { ...v.config, estimator: { ...v.config.estimator, window_days: Math.max(30, v.config.estimator.window_days) } } };
  const scan = await scanWalletView(scanConfig, wallet, { addresses: [], history: emptyHistory() }, view, asOfEpoch, { exhaustive: true,
    derive: (_parsed, chain, i) => { const a = known.get(chain + ':' + i); if (!a) throw new Error('E_ARCHIVE_COVERAGE'); return { address: a.address, script: a.script }; } });
  const snapshot = computeWalletSnapshot({ asOfEpoch, utxos: scan.utxos, settlements: scan.history.settlements,
    estimator: v.config.estimator, historyComplete: scan.history.complete,
    meta: { eeDaContext: scan.eeDaContext, epochContext: scan.epochContext, network: v.config.network, wallet: walletId, asOf, finishedAt: asOf, provider: view.provider, tip: scan.tip,
      ceilingHit: scan.ceilingHit, addressesScanned: scan.addresses.length, requestsUsed: 0,
      primaryIsPublic: v.config.providers[0]!.tier === 'public', networkTipOld: false, historyError: scan.history.complete ? null : 'E_HISTORY_INCOMPLETE',
      monitorVersion: MONITOR_VERSION, selectorModelVersion: v.config.upstream.selector_model_version, upstreamRef: v.config.upstream.ref,
      deployedBuildConfirmed: v.config.upstream.deployed_build_confirmed, configSha256: v.sha256 } });
  const training = [...scan.history.settlements].sort((a, b) => a.height - b.height || a.txid.localeCompare(b.txid));
  const record: ReplayRecord = { snapshot, forecasts: forecasts(snapshot, training, asOfEpoch, v.config.estimator), trainingRef: digest(training) };
  return { record, training };
}
function resolveHeight(index: ArchiveIndex, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (/^\d+$/.test(value)) return Number(value);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time / 1000 > index.clock(index.archive.anchor.height)) throw new Error('E_REPLAY_RANGE');
  return index.heightAt(time / 1000);
}
export async function runReplay(archive: ChainArchive, out: string, options: ReplayOptions = {}) {
  const v = options.config ?? validateConfig(archive.config, archive.network, false), index = new ArchiveIndex(archive);
  for (const wallet of v.config.wallets) {
    const original = archive.config.wallets.find(w => w.id === wallet.id);
    if (!original || original.descriptor !== wallet.descriptor || wallet.gap_scan.ceiling > original.gap_scan.ceiling) throw new Error('E_REPLAY_WALLET_CONFIG');
  }
  if (v.config.network !== archive.network) throw new Error('E_REPLAY_NETWORK');
  const first = archive.blocks[0]!.height, endTime = index.clock(archive.anchor.height);
  const warmupDays = Math.max(30, v.config.estimator.window_days);
  const defaultFrom = index.heightAt(Math.max(index.clock(first) + warmupDays * 86400, endTime - 90 * 86400));
  const from = resolveHeight(index, options.from, defaultFrom), to = resolveHeight(index, options.to, archive.anchor.height), step = options.step ?? 1;
  if (!Number.isSafeInteger(step) || step < 1 || !index.blocks.has(from) || !index.blocks.has(to) || from > to ||
    index.clock(from) - index.clock(first) < warmupDays * 86400) throw new Error('E_REPLAY_RANGE_OR_WARMUP');
  const records: ReplayRecord[] = [], trainingSets: Record<string, Settlement[]> = {};
  const quotes = [...(options.observations ?? [])].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  for (let height = from; height <= to; height += step) {
    for (const wallet of v.config.wallets) {
      const { record, training } = await replayAt(index, v, height, wallet.id);
      const time = Date.parse(record.snapshot.asOf);
      const quote = quotes.findLast(q => Date.parse(q.observedAt) <= time);
      if (quote && time - Date.parse(quote.observedAt) <= v.config.collection.stale_after_s * 1000) record.snapshot.feeContext = quote;
      records.push(record); trainingSets[record.trainingRef] = training;
    }
    if ((height - from) % (500 * step) === 0) options.progress?.('Replayed height ' + height + ' / ' + to);
  }
  const events = deriveOutcomes(archive, index), evaluation = evaluate(records, events, endTime);
  mkdirSync(out, { recursive: true });
  const jsonl = (name: string, rows: unknown[]) => writeFileSync(join(out, name), rows.map(canonical).join('\n') + '\n', { mode: 0o600 });
  jsonl('snapshots.jsonl', records);
  jsonl('forecasts.jsonl', records.flatMap(r => r.forecasts.map(f => ({ wallet: r.snapshot.wallet, height: r.snapshot.tip.height, asOf: r.snapshot.asOf, ...f }))));
  writeJson(join(out, 'training.json'), trainingSets);
  writeJson(join(out, 'outcomes.json'), { events, evaluations: evaluation.evaluations, exhaustion: evaluation.exhaustion });
  writeJson(join(out, 'scores.json'), evaluation.scores);
  const manifest = { schemaVersion: 1, archiveDigest: archive.digest, network: archive.network, provider: archive.provider,
    configSha256: v.sha256, config: v.config, monitorVersion: MONITOR_VERSION, fromHeight: from, toHeight: to, step,
    dataThroughHeight: archive.anchor.height, clock: 'running-max block header time', confirmedOnly: true,
    snapshotCount: records.length, distinctTrainingSets: Object.keys(trainingSets).length,
    archiveCodeRevision: archive.codeRevision, implementation: implementationProvenance(), observations: quotes.length };
  writeJson(join(out, 'manifest.json'), manifest);
  writeJson(join(out, 'execution.json'), { generatedAt: new Date().toISOString(), bytesBeforeReport: directoryBytes(out) });
  return { manifest, records, trainingSets, events, ...evaluation };
}
