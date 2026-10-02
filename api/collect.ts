import { collectHandler } from '../src/http/collect.js';
import { respond } from '../src/http/respond.js';
export default { fetch: (request: Request) => process.env.STAGING_PREVIEW ? Promise.resolve(respond({ error: 'preview_read_only' }, 403)) : collectHandler(request, false) };
