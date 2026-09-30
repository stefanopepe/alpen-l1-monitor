import { createHash, timingSafeEqual } from 'node:crypto';
const digest = (s: string) => createHash('sha256').update(s).digest();
const valid = (s: string | undefined): s is string => Boolean(s && s.length >= 32 && !/[\s,]/.test(s));
export function authorized(request: Request, mode: 'collect' | 'read', env: NodeJS.ProcessEnv = process.env): boolean {
  const header = request.headers.get('authorization');
  if (!header || !/^Bearer [^\s]+$/.test(header) || header.length > 4096) return false;
  const token = digest(header.slice(7));
  if (mode === 'collect') return valid(env.CRON_SECRET) && timingSafeEqual(token, digest(env.CRON_SECRET));
  const tokens = env.METRICS_BEARER_TOKENS?.split(',') ?? [];
  if (!tokens.length || tokens.length > 2 || tokens.some(t => !valid(t) || t === env.CRON_SECRET)) return false;
  let match = false;
  for (const t of tokens) match = timingSafeEqual(token, digest(t)) || match;
  return match;
}
