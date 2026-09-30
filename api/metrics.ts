import { authorized } from '../src/http/auth.js';
import { respond, networkName } from '../src/http/respond.js';
import { database } from '../src/db/pool.js';
import { readModel } from '../src/read/model.js';
import { renderMetrics } from '../src/read/render.js';
export default { async fetch(request: Request) {
  if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405);
  if (!authorized(request, 'read')) return respond({ error: 'unauthorized' }, 401);
  try { return respond(renderMetrics(await readModel(database('read'), networkName(), new Date())), 200, 'text/plain; version=0.0.4; charset=utf-8'); }
  catch { return respond({ error: 'storage_unavailable' }, 503); }
} };
