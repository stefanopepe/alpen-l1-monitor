import { mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { deploymentNetwork, renderPage } from '../src/ui/page.js';
import { renderTimeMachinePage } from '../src/ui/timeMachine.js';

const network = deploymentNetwork();
mkdirSync('dist', { recursive: true });
for (const page of ['index.html', 'consolidation.html']) {
  writeFileSync(`dist/${page}`, renderPage(readFileSync(`public/${page}`, 'utf8'), network));
}
for (const stylesheet of ['network.css', 'monitor.css', 'time-machine.css']) copyFileSync(`public/${stylesheet}`, `dist/${stylesheet}`);
writeFileSync('dist/time-machine.html', renderTimeMachinePage(gunzipSync(readFileSync('reports/mainnet-time-machine.html.gz')).toString('utf8')));
console.log(`Built monitor and consolidation pages for ${network}, plus the saved mainnet time machine.`);
