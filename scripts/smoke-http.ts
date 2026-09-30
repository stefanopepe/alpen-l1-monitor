import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
const cron = randomBytes(32).toString('hex'), read = randomBytes(32).toString('hex');
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/dev.ts'], {
  stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NETWORK: 'mainnet', CRON_SECRET: cron, METRICS_BEARER_TOKENS: read, DATABASE_URL: '', DATABASE_URL_METRICS: '' },
});
try {
  await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error('E_SMOKE_SERVER'); })]);
  const cases = [
    ['/', 'GET', '', 200], ['/api/status', 'GET', '', 401], ['/api/metrics', 'GET', cron, 401],
    ['/api/collect', 'GET', read, 401], ['/api/refresh', 'POST', '', 401],
    ['/api/status?format=text', 'GET', read, 503], ['/api/metrics', 'GET', read, 503], ['/api/refresh', 'POST', cron, 503],
  ] as const;
  for (const [path, method, token, expected] of cases) {
    const response = await fetch(`http://127.0.0.1:3000${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(5000) });
    if (response.status !== expected) throw new Error(`E_SMOKE_STATUS_${response.status}`);
    if (path !== '/' && !response.headers.get('cache-control')?.includes('no-store')) throw new Error('E_SMOKE_CACHE');
  }
  console.log(`HTTP smoke passed: ${cases.length} checks; ephemeral tokens were not logged.`);
} catch { console.error('E_HTTP_SMOKE'); process.exitCode = 1; }
finally { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; }
