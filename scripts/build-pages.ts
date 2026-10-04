import { mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { deploymentNetwork, renderPage } from '../src/ui/page.js';

const network = deploymentNetwork();
mkdirSync('dist', { recursive: true });
for (const page of ['index.html', 'consolidation.html']) {
  writeFileSync(`dist/${page}`, renderPage(readFileSync(`public/${page}`, 'utf8'), network));
}
copyFileSync('public/network.css', 'dist/network.css');
console.log(`Built monitor and consolidation pages for ${network}.`);
