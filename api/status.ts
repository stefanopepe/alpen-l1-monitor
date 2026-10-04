import { respond, networkName } from '../src/http/respond.js';
import { database } from '../src/db/pool.js';
import { readModel } from '../src/read/model.js';
import { renderText } from '../src/read/render.js';
import { stagingStatus } from '../src/consolidation/inventory.js';
import { demoStatus } from '../src/consolidation/demo.js';
import { validTimezone } from '../src/read/time.js';
import { MONITOR_VERSION } from '../src/version.js';
export default { async fetch(request: Request) {
  if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405);
  const format = new URL(request.url).searchParams.get('format') ?? 'json';
  if (!['text', 'json'].includes(format)) return respond({ error: 'invalid_format' }, 400);
  const timezone = new URL(request.url).searchParams.get('timezone') ?? 'UTC';
  if (!validTimezone(timezone)) return respond({ error: 'invalid_timezone' }, 400);
  try {
    const model = process.env.STAGING_PREVIEW === 'demo' ? demoStatus(new Date()) : process.env.STAGING_PREVIEW === '1' ? stagingStatus(networkName(), new Date()) : await readModel(database('read'), networkName(), new Date());
    const response = respond(format === 'text' ? renderText(model, timezone) : model, 200, format === 'text' ? 'text/plain; charset=utf-8' : 'application/json');
    response.headers.set('x-monitor-network', model.network);
    response.headers.set('x-monitor-version', MONITOR_VERSION);
    if (model.preview) response.headers.set('x-monitor-preview', '1');
    return response;
  } catch { return respond({ error: 'storage_unavailable' }, 503); }
} };
