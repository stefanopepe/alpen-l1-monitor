import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { BLOCK_FEE_SOURCE, captureBlockBackfill, importBlockBackfill, knownBlockFees } from '../src/fees/blockBackfill.js';
import { safeError } from '../src/chain/errors.js';

const { values } = parseArgs({ options: { hours: { type: 'string', default: '26' }, from: { type: 'string' }, 'to-height': { type: 'string' },
  out: { type: 'string', default: '.local/block-fee-backfill' }, apply: { type: 'boolean', default: false } } });
const directory = resolve(values.out!), file = join(directory, 'capture.json');
const hours = Number(values.hours), toHeight = values['to-height'] === undefined ? undefined : Number(values['to-height']);
if (process.env.NETWORK !== 'mainnet' || !Number.isFinite(hours) || hours < 1 || hours > 168) throw new Error('E_BACKFILL_CONFIGURATION');
const url = values.apply ? process.env.DATABASE_URL : process.env.DATABASE_URL_METRICS;
if (!url) throw new Error('E_BACKFILL_DATABASE_REQUIRED');
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 15000, query_timeout: 30000 });
mkdirSync(join(directory, 'responses'), { recursive: true });
let lastRequest = 0;
// Cache only hash-addressed summaries. Height lookups and block pages are always
// fresh so a cached response cannot conceal a reorg during capture or import.
const paced: typeof fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith(BLOCK_FEE_SOURCE + '/')) throw new Error('E_BACKFILL_SOURCE');
  const immutable = /\/v1\/block\/[a-f0-9]{64}\/summary$/.test(url);
  const path = join(directory, 'responses', createHash('sha256').update(url).digest('hex') + '.json.gz');
  if (immutable && existsSync(path)) return new Response(gunzipSync(readFileSync(path)));
  await delay(Math.max(0, lastRequest + 1000 - Date.now()));
  lastRequest = Date.now();
  const response = await fetch(input, init);
  if (!response.ok || !immutable) return response;
  const body = await response.text();
  writeFileSync(path, gzipSync(body), { mode: 0o600 });
  return new Response(body);
};
try {
  const stamp = await pool.query('SELECT network FROM network_stamp');
  if (stamp.rows.length !== 1 || stamp.rows[0].network !== 'mainnet') throw new Error('E_BACKFILL_NETWORK');
  if (values.apply) {
    const capture: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const result = await importBlockBackfill(pool, capture, paced);
    writeFileSync(join(directory, 'import.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
  } else {
    const capture = await captureBlockBackfill({ fromTime: values.from ? Date.parse(values.from) / 1000 : Math.floor(Date.now() / 1000 - hours * 3600), toHeight, fetcher: paced,
      known: blocks => knownBlockFees(pool, blocks.map(b => b.id)),
      onProgress: p => { if (p.phase !== 'summary' || p.completed! % 10 === 0 || p.completed === p.missing) console.log(JSON.stringify(p)); } });
    writeFileSync(file, JSON.stringify(capture, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ capturedAt: capture.capturedAt, scanned: capture.chain.length, missingVerified: capture.blocks.length,
      fromHeight: capture.chain.at(-1)!.height, toHeight: capture.chain[0]!.height, compactBytes: Buffer.byteLength(JSON.stringify(capture.blocks)), file }));
  }
} catch (e) { console.error(e instanceof Error && /^E_(BACKFILL|BLOCK_FEES)_[A-Z_]+$/.test(e.message) ? e.message : safeError(e)); process.exitCode = 1; }
finally { await pool.end(); }
