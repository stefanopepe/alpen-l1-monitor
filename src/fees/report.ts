import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { buildSync } from 'esbuild';
import { z } from 'zod';
import { MODEL_IDS, type FeeStudy } from './schema.js';

const require = createRequire(import.meta.url);
export const feePanelMarkup = () => readFileSync(fileURLToPath(new URL('./report/panel.html', import.meta.url)), 'utf8');
export function readFeeStudy(path: string): FeeStudy {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  // Reports only consume generated study files. Fail clearly on incompatible versions.
  z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), target: z.literal('bucket_mean_block_median_sat_vb'), network: z.literal('mainnet'),
    asOf: z.number().int().nonnegative(), archiveDigest: z.string().regex(/^[a-f0-9]{64}$/),
    forecasts: z.array(z.object({ model: z.enum(MODEL_IDS), points: z.array(z.object({ time: z.number().finite(), central: z.number().finite().nonnegative() })), summaries: z.array(z.unknown()) })),
    profile: z.array(z.object({ weekday: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), factor: z.number().finite().positive() })),
    scores: z.array(z.unknown()), evaluations: z.array(z.unknown()), warnings: z.array(z.string()),
  }).parse(data);
  return data as FeeStudy;
}
export function buildFeeReport(dir: string): string {
  const study = readFeeStudy(join(dir, 'study.json'));
  const packed = gzipSync(Buffer.from(JSON.stringify(study)), { level: 9 }).toString('base64');
  const css = readFileSync(require.resolve('bootstrap/dist/css/bootstrap.min.css'), 'utf8').replace(/\/\*# sourceMappingURL=.*?\*\//g, '') +
    readFileSync(fileURLToPath(new URL('../replay/report/styles.css', import.meta.url)), 'utf8');
  const script = buildSync({ entryPoints: [fileURLToPath(new URL('./report/client.ts', import.meta.url))], bundle: true, write: false,
    minify: true, platform: 'browser', format: 'iife', target: 'es2022', legalComments: 'inline' }).outputFiles[0]!.text;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Alpen · Seasonal Bitcoin fees</title><style>${css}</style></head><body><header class="topbar"><div class="container-xxl brand">ALPEN / FEE RESEARCH</div></header><main class="container-xxl py-4"><h1>Seasonal Bitcoin fees</h1><p class="text-secondary">Historical patterns, current fee levels and observed demand pressure.</p><p id="error" role="alert"></p>${feePanelMarkup()}</main><script type="application/json" id="data">${packed}</script><script>${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  const path = join(dir, 'report.html'); writeFileSync(path + '.tmp', html, { mode: 0o600 }); renameSync(path + '.tmp', path); return path;
}
