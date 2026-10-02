import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { fetchFeeHistory, importFeeHistory, openFeeArchive } from '../src/fees/archive.js';
import { safeError } from '../src/chain/errors.js';
import { implementationSources } from '../src/replay/provenance.js';
import { freezeEvaluation, readEvaluationPlan, validateHeldOut, type EvaluationPlan } from '../src/fees/validation.js';
import { writeJson } from '../src/replay/archive.js';

const args = process.argv.slice(2), command = args.shift();
const usage = `Usage: pnpm fees <command> [options]
  fetch   --archive DIR                       Capture multi-resolution mainnet fee history
  import  --input FILE --archive DIR          Import explicit bucket-median fee history
  observe --out FILE                         Append a live fee/pressure observation
  run     --archive DIR --out DIR             Fit, walk-forward test, forecast and report
          [--config FILE] [--observations FILE] [--as-of UTC] [--seal DIGEST] [--plan FILE]
  tune    --archive DIR --observations FILE --through UTC --out DIR
  freeze  --archive DIR --out FILE --start UTC --end UTC [--config FILE] [--baseline baseline|rolling|ewma|weekday_hour]
  report  --out DIR                           Rebuild a saved study's portable HTML
Defaults: --archive .local/fees/mainnet --out .local/fees/study
Model target: bucket-average network block-median sat/vB, not a confirmation quote.
EE transaction sizes and wallet runway are outside this experiment.
`;
try {
  if (!command || command === 'help' || args.includes('--help')) console.log(usage);
  else {
    const allowed: Record<string, string[]> = { fetch: ['archive'], import: ['archive', 'input'], observe: ['out'],
      tune: ['archive', 'observations', 'through', 'out', 'config'], run: ['archive', 'out', 'config', 'observations', 'as-of', 'seal', 'plan'], freeze: ['archive', 'out', 'config', 'start', 'end', 'baseline'], report: ['out'] };
    if (!allowed[command]) throw new Error('E_FEES_COMMAND');
    const options: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]?.slice(2), value = args[i + 1];
      if (!args[i]?.startsWith('--') || !key || !allowed[command]!.includes(key) || options[key] || !value || value.startsWith('--')) throw new Error('E_FEES_ARGUMENT');
      options[key] = value;
    }
    const archiveDir = resolve(options.archive ?? '.local/fees/mainnet'), out = resolve(options.out ?? '.local/fees/study');
    if (command === 'fetch') {
      const a = await fetchFeeHistory(archiveDir, { progress: console.log });
      console.log(JSON.stringify({ archive: archiveDir, digest: a.digest, buckets: a.buckets.length }));
    } else if (command === 'import') {
      if (!options.input) throw new Error('E_FEES_INPUT_REQUIRED');
      const a = importFeeHistory(resolve(options.input), archiveDir);
      console.log(JSON.stringify({ archive: archiveDir, digest: a.digest, buckets: a.buckets.length }));
    } else if (command === 'freeze') {
      const { feeModelConfigSchema } = await import('../src/fees/schema.js');
      const config = feeModelConfigSchema.parse(options.config ? JSON.parse(readFileSync(resolve(options.config), 'utf8')) : {});
      if (!options.start || !options.end || !options.out) throw new Error('E_FEE_PLAN_RANGE_REQUIRED');
      const plan = freezeEvaluation(out, openFeeArchive(archiveDir), config, Date.parse(options.start) / 1000, Date.parse(options.end) / 1000, options.baseline as EvaluationPlan['baseline'] | undefined);
      console.log(JSON.stringify({ file: out, digest: plan.digest, state: 'frozen_before_holdout' }));
    } else if (command === 'observe') {
      const { observeFees } = await import('../src/chain/fees.js');
      const { feeContextSchema } = await import('../src/observations/schema.js');
      const { existsSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      const file = resolve(options.out ?? '.local/fees/observations.json');
      const schema = z.object({ schemaVersion: z.literal(1), network: z.literal('mainnet'), observations: z.array(z.object({ feeContext: feeContextSchema.nullable() }).passthrough()) }).passthrough();
      const existing = existsSync(file) ? schema.parse(JSON.parse(readFileSync(file, 'utf8'))) : { schemaVersion: 1 as const, network: 'mainnet' as const, observations: [] };
      const feeContext = await observeFees();
      existing.observations.push({ feeContext }); mkdirSync(dirname(file), { recursive: true }); writeJson(file, existing);
      console.log(JSON.stringify({ file, observations: existing.observations.length, quote: feeContext.status, pressure: feeContext.pressure?.status }));
    } else {
      const { buildFeeReport } = await import('../src/fees/report.js');
      if (command === 'run' || command === 'tune') {
        const { runFeeStudy } = await import('../src/fees/study.js');
        const { feeModelConfigSchema, feePressureSchema } = await import('../src/fees/schema.js');
        const plan = options.plan ? readEvaluationPlan(resolve(options.plan)) : null;
        const config = feeModelConfigSchema.parse(options.config ? JSON.parse(readFileSync(resolve(options.config), 'utf8')) : plan?.config ?? {});
        const pressure = options.observations ? z.object({ network: z.literal('mainnet'), observations: z.array(z.object({
          feeContext: z.object({ pressure: feePressureSchema.optional() }).nullable(),
        })) }).parse(JSON.parse(readFileSync(resolve(options.observations), 'utf8'))).observations.flatMap(o => o.feeContext?.pressure ? [o.feeContext.pressure] : []) : [];
        const archive = openFeeArchive(archiveDir, options.seal);
        if (command === 'tune') {
          if (!options.through) throw new Error('E_FEE_TRAINING_END_REQUIRED');
          const { tunePressure } = await import('../src/fees/pressureStudy.js');
          const proposal = tunePressure(archive, pressure, config, Date.parse(options.through) / 1000);
          mkdirSync(out, { recursive: true }); writeJson(join(out, 'pressure-training.json'), proposal);
          if (proposal.selectedConfig) writeJson(join(out, 'proposed-config.json'), proposal.selectedConfig);
          else rmSync(join(out, 'proposed-config.json'), { force: true });
          console.log(JSON.stringify({ out, state: proposal.state }));
        } else {
          const asOf = options['as-of'] ? Date.parse(options['as-of']) / 1000 : Math.ceil(Math.max(Date.parse(archive.capturedAt), ...pressure.map(p => Date.parse(p.observedAt))) / 1000);
          if (!Number.isFinite(asOf)) throw new Error('E_FEES_AS_OF');
          mkdirSync(out, { recursive: true });
          const study = runFeeStudy(archive, pressure, config, asOf, console.log, plan?.start);
          if (plan) study.validation = validateHeldOut(study, plan, archive);
          writeJson(join(out, 'implementation.json'), { sourceSha256: study.sourceSha256, files: implementationSources() });
          writeJson(join(out, 'inputs.json'), { schemaVersion: 1, archive, pressure, config, asOf, plan });
          writeJson(join(out, 'study.json'), study);
        }
      }
      if (command !== 'tune') console.log(JSON.stringify({ report: buildFeeReport(out) }));
    }
  }
} catch (e) { console.error(safeError(e)); process.exitCode = 1; }
