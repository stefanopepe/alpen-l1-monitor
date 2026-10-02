import { renderFeeStudy } from './view.js';
import type { FeeStudy } from '../schema.js';
async function start() {
  const packed = Uint8Array.from(atob(document.getElementById('data')!.textContent ?? ''), c => c.charCodeAt(0));
  const study = await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).json() as FeeStudy;
  renderFeeStudy(document.getElementById('network-fees')!, study);
}
void start().catch(() => { document.getElementById('error')!.textContent = 'Unable to open this study. Rebuild with pnpm fees report and use a current browser.'; });
