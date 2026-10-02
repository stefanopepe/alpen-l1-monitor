import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { loadConfig, validateConfig } from '../src/config/load.js';
import { safeError } from '../src/chain/errors.js';
import { fetchArchive, openArchive, directoryBytes, writeJson } from '../src/replay/archive.js';
import { runReplay } from '../src/replay/run.js';
import { buildReport } from '../src/replay/report.js';
import { feeContextSchema } from '../src/observations/schema.js';
const args = process.argv.slice(2), command = args.shift();
function option(key: string): string | undefined {
  const i = args.indexOf('--' + key);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) throw new Error('E_REPLAY_ARGUMENT');
  return value;
}
const help = `Usage: pnpm replay <command> [options]
  fetch                Capture/resume/update a sealed archive from configured primary Esplora
    --network mainnet --archive .local/replay/mainnet [--provider alpen]
  refresh              Fetch newer finalized blocks, replay and rebuild the report
    [--network mainnet] [--archive DIR] [--out .local/replay/audit-mainnet]
  run                  Offline replay and self-contained report
    --archive DIR [--from HEIGHT|UTC] [--to HEIGHT|UTC] [--step blocks:N]
    [--config FILE] [--observations FILE] [--out DIR] [--seal ARCHIVE_DIGEST] [--fees-study FILE]
  report               Regenerate HTML from saved result files: --out DIR [--fees-study FILE]
  export-observations  Export issued forecasts/fee quotes using DATABASE_URL_METRICS
    [--network mainnet] [--from UTC] [--to UTC] [--out FILE]
Defaults: both wallets, latest 90 days, 30-day warm-up, every block.
Fetch extends completed archives and preserves earlier seals under seals/ by digest.
An interrupted capture/update resumes its pinned boundary. Repeat after completion to advance again.
Fetch/refresh use provider credentials. Offline run/report need no network or database.
`;
try {
  if (!command || command === 'help' || args.includes('--help')) { console.log(help); }
  else {
    const allowed = new Set(['network', 'archive', 'provider', 'from', 'to', 'step', 'config', 'observations', 'out', 'seal', 'fees-study']);
    for (let i = 0; i < args.length; i += 2) if (!args[i]?.startsWith('--') || !allowed.has(args[i]!.slice(2)) || !args[i + 1]) throw new Error('E_REPLAY_ARGUMENT');
    const network = option('network') ?? process.env.NETWORK ?? 'mainnet';
    if (!/^[a-z0-9-]+$/.test(network)) throw new Error('E_NETWORK_REQUIRED');
    const archiveDir = resolve(option('archive') ?? join('.local', 'replay', network));
    if (command === 'fetch') {
      const a = await fetchArchive(loadConfig(network), archiveDir, { provider: option('provider'), progress: console.log });
      console.log(JSON.stringify({ archive: archiveDir, digest: a.digest, throughHeight: a.anchor.height, bytes: directoryBytes(archiveDir), transactions: Object.keys(a.transactions).length }));
    } else if (command === 'run' || command === 'refresh') {
      if (command === 'refresh' && option('seal')) throw new Error('E_REPLAY_REFRESH_SEAL');
      const archive = command === 'refresh'
        ? await fetchArchive(loadConfig(network), archiveDir, { provider: option('provider'), progress: console.log })
        : openArchive(archiveDir, option('seal'));
      const stepArg = option('step') ?? 'blocks:1';
      if (!/^blocks:[1-9]\d*$/.test(stepArg)) throw new Error('E_REPLAY_STEP');
      const configPath = option('config');
      const config = configPath ? validateConfig(JSON.parse(readFileSync(configPath, 'utf8')), archive.network, false) : undefined;
      const observationsPath = option('observations');
      let observations;
      if (observationsPath) {
        const exported = z.object({ schemaVersion: z.literal(1), network: z.string(), observations: z.array(z.object({ feeContext: feeContextSchema.nullable() })) }).parse(JSON.parse(readFileSync(observationsPath, 'utf8')));
        if (exported.network !== archive.network) throw new Error('E_OBSERVATIONS_NETWORK');
        observations = exported.observations.flatMap(o => o.feeContext ? [o.feeContext] : []);
      }
      const out = resolve(option('out') ?? (command === 'refresh' ? join('.local', 'replay', 'audit-' + network)
        : join('.local', 'replay', 'runs', new Date().toISOString().replace(/[:.]/g, '-'))));
      const result = await runReplay(archive, out, { from: option('from'), to: option('to'), step: Number(stepArg.slice(7)), config, observations, progress: console.log });
      const report = buildReport(out, option('fees-study'));
      console.log(JSON.stringify({ report, bytes: directoryBytes(out), archiveBytes: directoryBytes(archiveDir), snapshots: result.records.length,
        primaryScores: result.scores.filter(s => s.horizonDays === 5 && s.subset === 'all' && s.sampling === 'daily') }));
    } else if (command === 'report') {
      const out = option('out'); if (!out) throw new Error('E_REPLAY_OUT_REQUIRED');
      console.log(JSON.stringify({ report: buildReport(resolve(out), option('fees-study')), bytes: directoryBytes(resolve(out)) }));
    } else if (command === 'export-observations') {
      const { database } = await import('../src/db/pool.js');
      const { exportObservations } = await import('../src/read/observations.js');
      const to = option('to') ?? new Date().toISOString(), from = option('from') ?? new Date(Date.parse(to) - 90 * 86400000).toISOString();
      const out = resolve(option('out') ?? '.local/replay/observations.json'), pool = database('read');
      try { const result = await exportObservations(pool, network, from, to); mkdirSync(dirname(out), { recursive: true }); writeJson(out, result); console.log(JSON.stringify({ out, runs: result.observations.length })); }
      finally { await pool.end(); }
    } else throw new Error('E_REPLAY_COMMAND');
  }
} catch (e) { console.error(safeError(e)); process.exitCode = 1; }
