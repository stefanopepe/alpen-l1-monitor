import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import collect from '../api/collect.js';
import refresh from '../api/refresh.js';
import status from '../api/status.js';
import metrics from '../api/metrics.js';
const routes: Record<string, { fetch: (r: Request) => Promise<Response> }> = { '/api/collect': collect, '/api/refresh': refresh, '/api/status': status, '/api/metrics': metrics };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost:3000'), route = routes[url.pathname];
    if (url.pathname === '/' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(readFileSync('public/index.html')); return; }
    if (!route) { res.writeHead(404); res.end(); return; }
    const headers = new Headers();
    for (const [k, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(k, value);
    const response = await route.fetch(new Request(url, { method: req.method, headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  } catch { res.writeHead(500); res.end('Internal error'); }
}).listen(3000, '127.0.0.1', () => console.log('Monitor: http://localhost:3000'));
