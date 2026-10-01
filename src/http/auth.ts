import { createHash, timingSafeEqual } from 'node:crypto';
const digest = (s: string) => createHash('sha256').update(s).digest();
const valid = (s: string | undefined): s is string => Boolean(s && s.length >= 32 && !/[\s,]/.test(s));
export function authorized(request: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  const header = request.headers.get('authorization');
  if (!header || !/^Bearer [^\s]+$/.test(header) || header.length > 4096) return false;
  const token = digest(header.slice(7));
  return valid(env.CRON_SECRET) && timingSafeEqual(token, digest(env.CRON_SECRET));
}
