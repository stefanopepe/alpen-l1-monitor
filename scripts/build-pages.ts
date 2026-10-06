import { mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildSync } from 'esbuild';
import { implementationProvenance } from '../src/replay/provenance.js';
import { deploymentNetwork, renderPage } from '../src/ui/page.js';
import { renderTimeMachinePage } from '../src/ui/timeMachine.js';

const network = deploymentNetwork();
const script = buildSync({ entryPoints: ['src/replay/report/client.ts'], bundle: true, write: false, minify: true, platform: 'browser', format: 'iife', target: 'es2022' }).outputFiles[0]!.text;
writeFileSync('config/research-provenance.json', JSON.stringify(implementationProvenance()));
mkdirSync('dist', { recursive: true });
for (const page of ['index.html', 'consolidation.html']) {
  writeFileSync(`dist/${page}`, renderPage(readFileSync(`public/${page}`, 'utf8'), network));
}
for (const stylesheet of ['network.css', 'monitor.css', 'time-machine.css']) copyFileSync(`public/${stylesheet}`, `dist/${stylesheet}`);
writeFileSync('dist/time-machine.html', renderTimeMachinePage(gunzipSync(readFileSync('reports/mainnet-time-machine.html.gz')).toString('utf8'), script, network, readFileSync('reports/mainnet-transactions.json.gz').toString('base64')));
console.log(`Built monitor and consolidation pages for ${network}, plus the automatically updated mainnet time machine.`);
