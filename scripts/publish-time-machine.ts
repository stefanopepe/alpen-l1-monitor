import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';

// Publish the explicitly selected portable report, without bundling its local archive.
const source = process.argv[2];
if (!source || process.argv.length !== 3) throw new Error('Usage: pnpm replay:publish PATH_TO_REPORT_HTML');
const html = readFileSync(source, 'utf8');
const packed = /<script type="application\/json" id="data">([^<]+)<\/script>/.exec(html)?.[1];
if (!packed) throw new Error('E_REPORT_DATA_MISSING');
const data = z.object({
  manifest: z.object({ network: z.literal('mainnet') }),
  records: z.array(z.object({ snapshot: z.object({ asOf: z.string().datetime() }) })).min(1),
  feeStudy: z.object({ network: z.literal('mainnet'), asOf: z.number().int().nonnegative() }),
}).parse(JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString('utf8')));
const main = '<main class="container-xxl py-4" id="main">';
if (!html.includes(main) || !html.includes('id="network-fees"')) throw new Error('E_COMBINED_REPORT_REQUIRED');
const capturedAt = new Date(Math.max(...data.records.map(record => Date.parse(record.snapshot.asOf)))).toISOString();
const feeAsOf = new Date(data.feeStudy.asOf * 1000).toISOString();
const banner = `<aside class="alert alert-light border mb-4" aria-label="Saved report">
  <a href="/">← Back to monitor</a> · <strong>Bitcoin mainnet · Saved analysis</strong>
  <p class="mb-0 mt-2">Wallet history through <time datetime="${capturedAt}">${capturedAt.replace('T', ' ').replace('.000Z', ' UTC')}</time>.
  Fee study as of <time datetime="${feeAsOf}">${feeAsOf.replace('T', ' ').replace('.000Z', ' UTC')}</time>.
  This dashboard is a saved research snapshot; balances and forecasts do not update live.</p>
</aside>`;
const published = html.replace('<title>Alpen · Wallet runway</title>', '<title>Alpen · Fee analysis time machine · Mainnet</title>')
  .replace(main, main + '\n' + banner);
mkdirSync('reports', { recursive: true });
writeFileSync('reports/mainnet-time-machine.html.gz', gzipSync(published, { level: 9 }));
console.log(`Published saved mainnet dashboard: wallet history ${capturedAt}; fee study ${feeAsOf}.`);
