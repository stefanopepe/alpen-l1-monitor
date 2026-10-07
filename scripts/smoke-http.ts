import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const cron = randomBytes(32).toString('hex'), wrong = randomBytes(32).toString('hex');
const testnet = process.argv.includes('--testnet');
// Exercise the documented launcher. An ephemeral port avoids hitting another app.
const grouped = process.platform !== 'win32';
const child = spawn('pnpm', ['dev'], {
  detached: grouped, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: '0', NETWORK: testnet ? 'signet' : 'mainnet', STAGING_PREVIEW: testnet ? 'demo' : '', CRON_SECRET: cron, DATABASE_URL: '', DATABASE_URL_METRICS: '' },
});
const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
child.stderr!.resume(); // Drain output without disclosing environment/provider errors.
function stop(signal: NodeJS.Signals) {
  if (!child.pid) return;
  try { if (grouped) process.kill(-child.pid, signal); else child.kill(signal); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}
try {
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('E_SMOKE_START_TIMEOUT')), 15000);
    let output = '';
    const fail = () => { clearTimeout(timer); reject(new Error('E_SMOKE_SERVER')); };
    child.once('error', fail); child.once('exit', fail);
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      output = (output + chunk).slice(-4096);
      const match = /Monitor: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    });
  });
  const cases = testnet ? [
    ['/', 'GET', '', 200], ['/consolidation.html', 'GET', '', 200], ['/network.css', 'GET', '', 200], ['/time-machine.html', 'GET', '', 200],
    ['/api/time-machine', 'GET', '', 409], ['/api/research-refresh', 'GET', cron, 403],
    ['/api/status', 'GET', '', 200], ['/api/status?format=text', 'GET', '', 200],
    ['/api/consolidation?wallet=ee', 'GET', '', 200],
    ['/api/collect', 'GET', cron, 403], ['/api/refresh', 'POST', cron, 403],
  ] as const : [
    ['/', 'GET', '', 200], ['/consolidation.html', 'GET', '', 200], ['/network.css', 'GET', '', 200], ['/time-machine.html', 'GET', '', 200], ['/missing', 'GET', '', 404],
    ['/api/time-machine', 'GET', '', 503], ['/api/research-refresh', 'GET', '', 401], ['/api/research-refresh', 'POST', cron, 405],
    ['/api/status', 'GET', '', 503], ['/api/status', 'GET', cron, 503],
    ['/api/metrics', 'GET', cron, 503], ['/api/collect', 'GET', wrong, 401],
    ['/api/refresh', 'POST', '', 401], ['/api/refresh', 'POST', wrong, 401],
    ['/api/collect?token=' + cron, 'GET', '', 401],
    ['/api/status', 'POST', '', 405], ['/api/refresh', 'GET', cron, 405],
    ['/api/collect', 'POST', cron, 405], ['/api/status?format=xml', 'GET', '', 400],
    ['/api/status', 'GET', wrong, 503], ['/api/status?format=text', 'GET', '', 503],
    ['/api/metrics', 'GET', '', 503], ['/api/collect', 'GET', cron, 503],
    ['/api/refresh', 'POST', cron, 503],
  ] as const;
  const stylesheets = ['/monitor.css', '/time-machine.css', '/monitor.js'].map(path => [path, 'GET', '', 200] as const);
  for (const [path, method, token, expected] of [...cases, ...stylesheets]) {
    const response = await fetch(`${origin}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) });
    if (response.status !== expected) throw new Error(`E_SMOKE_STATUS_${response.status}`);
    if (path.startsWith('/api/') && !response.headers.get('cache-control')?.includes('no-store')) throw new Error('E_SMOKE_CACHE');
    const body = await response.text();
    if (body.includes(wrong) || body.includes(cron)) throw new Error('E_SMOKE_SECRET');
    if (path === '/' && !body.includes('href="/time-machine.html"')) throw new Error('E_SMOKE_TIME_MACHINE_LINK');
    if (path === '/time-machine.html' && (!body.includes('Bitcoin mainnet · Updated analysis') || !body.includes('id="network-fees"'))) throw new Error('E_SMOKE_TIME_MACHINE_REPORT');
    if ((path === '/' || path === '/time-machine.html') && !body.includes('href="/monitor.css"')) throw new Error('E_SMOKE_SHARED_STYLE');
    if ((path === '/' || path === '/consolidation.html') && !body.includes(`data-theme="${testnet ? 'testnet' : 'mainnet'}"`)) throw new Error('E_SMOKE_THEME');
    if (testnet && path.startsWith('/api/status') && response.headers.get('x-monitor-network') !== 'signet') throw new Error('E_SMOKE_NETWORK');
    if (testnet && path === '/api/status?format=text' && !body.includes('DEMO: synthetic testnet wallets')) throw new Error('E_SMOKE_DEMO');
  }
  console.log(`HTTP smoke passed (${testnet ? 'Signet demo' : 'mainnet'}): ${cases.length + stylesheets.length} checks through pnpm dev; ephemeral tokens were not logged.`);
} catch { console.error('E_HTTP_SMOKE'); process.exitCode = 1; }
finally {
  stop('SIGTERM');
  await Promise.race([closed, delay(3000, undefined, { ref: false })]);
  stop('SIGKILL');
  await closed;
}
