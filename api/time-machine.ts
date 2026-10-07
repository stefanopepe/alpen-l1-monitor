import { database } from '../src/db/pool.js';
import { networkName, respond } from '../src/http/respond.js';
import { readTimeMachine } from '../src/read/timeMachine.js';
import { MONITOR_VERSION } from '../src/version.js';
import { createHash } from 'node:crypto';

export default { async fetch(request: Request) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag,x-monitor-version',
    'Access-Control-Allow-Headers': 'If-None-Match', 'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'cache-control': 'private, no-cache, must-revalidate', 'x-monitor-version': MONITOR_VERSION };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers, 'Access-Control-Max-Age': '3600' } });
  if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405);
  if (networkName() !== 'mainnet' || process.env.STAGING_PREVIEW) return respond({ error: 'mainnet_only' }, 409);
  try {
    const data = await readTimeMachine(database('read'), 'mainnet');
    // readAt is a request timestamp, not a data change. Keep unchanged history off the wire.
    const etag = '"' + createHash('sha256').update(JSON.stringify({ ...data, readAt: undefined })).digest('hex') + '"';
    if (request.headers.get('if-none-match')?.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag))
      return new Response(null, { status: 304, headers: { ...headers, ETag: etag } });
    const response = respond(data);
    for (const [key, value] of Object.entries({ ...headers, ETag: etag })) response.headers.set(key, value);
    return response;
  } catch {
    const response = respond({ error: 'time_machine_unavailable' }, 503);
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  }
} };
