import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Capture only implementation inputs. Never inspect env files or credentials.
export function implementationSources(): Record<string, string> {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? files(dir + '/' + e.name) : [dir + '/' + e.name]);
  return Object.fromEntries([...files('src'), 'scripts/replay.ts', 'scripts/fees.ts', 'package.json', 'pnpm-lock.yaml'].sort()
    .map(file => [file, readFileSync(join(root, file), 'utf8')]));
}
// Hash the actual implementation, including uncommitted edits.
export function implementationProvenance() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const hash = createHash('sha256');
  for (const [file, source] of Object.entries(implementationSources())) hash.update(file + '\0').update(source).update('\0');
  let revision = 'unknown';
  try { revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source bundles may omit Git. */ }
  return { revision, sourceSha256: hash.digest('hex') };
}
