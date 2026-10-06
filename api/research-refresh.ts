import { authorized } from '../src/http/auth.js';
import { networkName, respond } from '../src/http/respond.js';
import { database } from '../src/db/pool.js';
import { refreshFeeResearch } from '../src/fees/refresh.js';

export default { async fetch(request: Request) {
  if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405);
  if (!authorized(request)) return respond({ error: 'unauthorized' }, 401);
  if (process.env.STAGING_PREVIEW) return respond({ error: 'preview_disabled' }, 403);
  if (networkName() !== 'mainnet') return respond({ status: 'not_applicable', network: networkName() });
  try { return respond(await refreshFeeResearch(database('write'))); }
  catch { return respond({ error: 'research_refresh_failed' }, 503); }
} };
