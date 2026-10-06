import { mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { deploymentNetwork, renderPage } from '../src/ui/page.js';

const network = deploymentNetwork();
mkdirSync('dist', { recursive: true });
for (const page of ['index.html', 'consolidation.html']) {
  writeFileSync(`dist/${page}`, renderPage(readFileSync(`public/${page}`, 'utf8'), network));
}
copyFileSync('public/network.css', 'dist/network.css');
writeFileSync('dist/time-machine.html', gunzipSync(readFileSync('reports/mainnet-time-machine.html.gz')));
console.log(`Built monitor and consolidation pages for ${network}, plus the saved mainnet time machine.`);
