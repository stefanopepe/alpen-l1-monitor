import { database } from '../src/db/pool.js';
import { networkName, respond } from '../src/http/respond.js';
import { readTimeMachine } from '../src/read/timeMachine.js';
import { MONITOR_VERSION } from '../src/version.js';

export default { async fetch(request: Request) {
  if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405);
  if (networkName() !== 'mainnet' || process.env.STAGING_PREVIEW) return respond({ error: 'mainnet_only' }, 409);
  try {
    const response = respond(await readTimeMachine(database('read'), 'mainnet'));
    response.headers.set('Access-Control-Allow-Origin', '*');
    response.headers.set('x-monitor-version', MONITOR_VERSION);
    return response;
  } catch { return respond({ error: 'time_machine_unavailable' }, 503); }
} };
