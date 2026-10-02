import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildSync } from 'esbuild';
import type { ReplayRecord, Evaluation, Score } from './evaluate.js';
import type { OutcomeEvent } from './outcomes.js';
import { feePanelMarkup, readFeeStudy } from '../fees/report.js';
import { writeJson } from './archive.js';

const require = createRequire(import.meta.url);
export function buildReport(dir: string, feeStudyFile?: string): string {
  const records = readFileSync(join(dir, 'snapshots.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as ReplayRecord);
  const outcomes = JSON.parse(readFileSync(join(dir, 'outcomes.json'), 'utf8')) as { events: OutcomeEvent[]; evaluations: Evaluation[]; exhaustion: unknown[] };
  const scores = JSON.parse(readFileSync(join(dir, 'scores.json'), 'utf8')) as Score[];
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { network: string };
  const training: unknown = JSON.parse(readFileSync(join(dir, 'training.json'), 'utf8'));
  const savedFeeStudy = join(dir, 'fee-study.json');
  const feeStudy = feeStudyFile ? readFeeStudy(feeStudyFile) : existsSync(savedFeeStudy) ? readFeeStudy(savedFeeStudy) : undefined;
  if (feeStudy && feeStudy.network !== manifest.network) throw new Error('E_FEE_STUDY_NETWORK');
  if (feeStudyFile && feeStudy) writeJson(savedFeeStudy, feeStudy);
  const data = gzipSync(Buffer.from(JSON.stringify({ records, ...outcomes, scores, manifest, training, feeStudy })), { level: 9 }).toString('base64');
  const bootstrap = readFileSync(require.resolve('bootstrap/dist/css/bootstrap.min.css'), 'utf8').replace(/\/\*# sourceMappingURL=.*?\*\//g, '');
  const ui = fileURLToPath(new URL('./report/', import.meta.url));
  const script = buildSync({ entryPoints: [join(ui, 'client.ts')], bundle: true, write: false, minify: true,
    platform: 'browser', format: 'iife', target: 'es2022', legalComments: 'inline' }).outputFiles[0]!.text;
  const html = readFileSync(join(ui, 'template.html'), 'utf8')
    .replace('<!-- FEE_STUDY -->', () => feeStudy ? feePanelMarkup() : '')
    .replace('<!-- FEE_NAV -->', () => feeStudy ? '<a href="#network-fees">Seasonal fees</a>' : '')
    .replace('/* REPORT_STYLES */', () => bootstrap + '\n' + readFileSync(join(ui, 'styles.css'), 'utf8'))
    .replace('REPORT_DATA', () => data)
    .replace('/* REPORT_SCRIPT */', () => script.replace(/<\/script/gi, '<\\/script'));
  const path = join(dir, 'report.html'); writeFileSync(path + '.tmp', html, { mode: 0o600 }); renameSync(path + '.tmp', path); return path;
}
