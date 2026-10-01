import { authorized } from './auth.js';
import { respond } from './respond.js';
import { runCollect } from '../pipeline/collectRun.js';
import { safeError } from '../chain/errors.js';
export async function collectHandler(request: Request, manual: boolean): Promise<Response> {
  if (request.method !== (manual ? 'POST' : 'GET')) return respond({ error: 'method_not_allowed' }, 405);
  if (!authorized(request)) return respond({ error: 'unauthorized' }, 401);
  try {
    const result = await runCollect(manual || new URL(request.url).searchParams.get('force') === '1');
    return respond(result, result.wallets.some(w => w.status === 'failed') ? 503 : 200);
  } catch (e) { return respond({ error: safeError(e) }, 503); }
}
