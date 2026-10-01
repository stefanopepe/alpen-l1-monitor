import { respond, networkName } from '../src/http/respond.js';
import { database } from '../src/db/pool.js';
import { readModel } from '../src/read/model.js';
import { renderText } from '../src/read/render.js';
export default { async fetch(request: Request) {
  if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405);
  const format = new URL(request.url).searchParams.get('format') ?? 'json';
  if (!['text', 'json'].includes(format)) return respond({ error: 'invalid_format' }, 400);
  try {
    const model = await readModel(database('read'), networkName(), new Date());
    return respond(format === 'text' ? renderText(model) : model, 200, format === 'text' ? 'text/plain; charset=utf-8' : 'application/json');
  } catch { return respond({ error: 'storage_unavailable' }, 503); }
} };
