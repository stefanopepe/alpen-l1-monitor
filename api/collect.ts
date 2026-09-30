import { collectHandler } from '../src/http/collect.js';
export default { fetch: (request: Request) => collectHandler(request, false) };
