import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { buildSync } from 'esbuild';
import timeMachine from '../api/time-machine.js';
import researchRefresh from '../api/research-refresh.js';
import collect from '../api/collect.js';
import refresh from '../api/refresh.js';
import status from '../api/status.js';
import metrics from '../api/metrics.js';
import consolidation from '../api/consolidation.js';
import { deploymentNetwork, renderPage } from '../src/ui/page.js';
import { renderTimeMachinePage } from '../src/ui/timeMachine.js';
const script = buildSync({ entryPoints: ['src/replay/report/client.ts'], bundle: true, write: false, minify: true, platform: 'browser', format: 'iife', target: 'es2022' }).outputFiles[0]!.text;
const monitorScript = buildSync({ entryPoints: ['src/ui/monitor.ts'], bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2022' }).outputFiles[0]!.text;
const routes: Record<string, { fetch: (r: Request) => Promise<Response> }> = { '/api/time-machine': timeMachine, '/api/research-refresh': researchRefresh, '/api/collect': collect, '/api/refresh': refresh, '/api/status': status, '/api/metrics': metrics, '/api/consolidation': consolidation };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost:3000'), route = routes[url.pathname];
    const page = url.pathname === '/' ? 'public/index.html' : url.pathname === '/consolidation.html' ? 'public/consolidation.html' : null;
    if (page && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(renderPage(readFileSync(page, 'utf8'), deploymentNetwork())); return; }
    if (url.pathname === '/time-machine.html' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(renderTimeMachinePage(gunzipSync(readFileSync('reports/mainnet-time-machine.html.gz')).toString('utf8'), script, deploymentNetwork(), readFileSync('reports/mainnet-transactions.json.gz').toString('base64'))); return; }
    if (['/network.css', '/monitor.css', '/time-machine.css'].includes(url.pathname) && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(readFileSync('public' + url.pathname)); return; }
    if (url.pathname === '/monitor.js' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(monitorScript); return; }
    if (!route) { res.writeHead(404); res.end(); return; }
    const headers = new Headers();
    for (const [k, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(k, value);
    const response = await route.fetch(new Request(url, { method: req.method, headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('Internal error'); }
});
server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address === 'object') console.log(`Monitor: http://127.0.0.1:${address.port}`);
});
