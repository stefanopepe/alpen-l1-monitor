import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { providerRequest } from '../chain/request.js';
import { blockSchema, hashSchema, outspendSchema, statsSchema, txSchema, type ChainTx } from '../chain/schemas.js';
import type { ValidatedConfig } from '../config/load.js';
import { validateConfig } from '../config/load.js';
import type { NetworkConfig, ProviderConfig } from '../config/schema.js';
import { deriveAddress } from '../derive/address.js';
import { commitOutputs, validFee } from '../extract/classify.js';
import { MONITOR_VERSION } from '../version.js';

export const archiveBlockSchema = blockSchema.extend({ previousblockhash: hashSchema.optional() });
export type ArchiveBlock = z.infer<typeof archiveBlockSchema>;
export interface ArchiveAddress { wallet: string; chain: 0 | 1; index: number; address: string; script: string; txids: string[]; complete: boolean }
export interface ChainArchive {
  schemaVersion: 1; network: string; provider: string; config: NetworkConfig; configSha256: string;
  anchor: ArchiveBlock; blocks: ArchiveBlock[]; addresses: ArchiveAddress[]; transactions: Record<string, ChainTx>;
  capturedAt: string; monitorVersion: string; codeRevision: string; responses: Record<string, string>; digest: string;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function writeJson(path: string, value: unknown) {
  const temp = path + '.tmp';
  writeFileSync(temp, canonical(value), { mode: 0o600 }); renameSync(temp, path);
}
export function directoryBytes(path: string): number {
  return readdirSync(path, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? directoryBytes(join(path, e.name)) : statSync(join(path, e.name)).size), 0);
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Only sanitized API paths and successful bodies enter the archive. Auth URLs never do.
export class ArchiveClient {
  private lastRequest = 0;
  readonly responses: Record<string, string> = {};
  requests = 0;
  constructor(readonly provider: ProviderConfig, readonly dir: string, private readonly fetcher: typeof fetch = fetch) {
    mkdirSync(join(dir, 'raw'), { recursive: true }); mkdirSync(join(dir, 'requests'), { recursive: true });
  }
  async get<T>(path: string, schema: z.ZodType<T>, plain = false, cached = true): Promise<T> {
    if (!/^\/[a-zA-Z0-9_/-]+$/.test(path)) throw new Error('E_ARCHIVE_REQUEST_PATH');
    const key = createHash('sha256').update(path).digest('hex'), refFile = join(this.dir, 'requests', key + '.json');
    if (cached && existsSync(refFile)) {
      const ref = JSON.parse(readFileSync(refFile, 'utf8')) as { path: string; hash: string };
      if (ref.path !== path || !/^[a-f0-9]{64}$/.test(ref.hash)) throw new Error('E_ARCHIVE_CACHE');
      const value: unknown = JSON.parse(readFileSync(join(this.dir, 'raw', ref.hash + '.json'), 'utf8'));
      if (digest(value) !== ref.hash) throw new Error('E_ARCHIVE_CACHE');
      this.responses[path] = ref.hash;
      return schema.parse(value);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      await sleep(Math.max(0, this.lastRequest + this.provider.min_interval_ms - Date.now()));
      this.lastRequest = Date.now(); this.requests++;
      const request = providerRequest(this.provider, path);
      let response: Response;
      try {
        response = await this.fetcher(request.url, { headers: request.headers, redirect: 'error', cache: 'no-store',
          signal: AbortSignal.timeout(this.provider.timeout_ms) });
      } catch {
        if (attempt === 4) throw new Error('E_ARCHIVE_NETWORK');
        await sleep(Math.min(30000, 1000 * 2 ** attempt)); continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 4) throw new Error('E_ARCHIVE_RATE_OR_SERVER');
        const seconds = Number(response.headers.get('retry-after'));
        await sleep(Math.min(30000, Math.max(1000 * 2 ** attempt, Number.isFinite(seconds) ? seconds * 1000 : 0))); continue;
      }
      if (!response.ok) throw new Error('E_ARCHIVE_HTTP');
      let value: unknown;
      try { value = plain ? (await response.text()).trim() : await response.json(); } catch { throw new Error('E_ARCHIVE_RESPONSE'); }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new Error('E_ARCHIVE_SCHEMA');
      const secret = this.provider.auth.scheme === 'none' ? undefined : process.env[this.provider.auth.secret_env];
      if (secret && [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)].some(s => canonical(value).includes(s))) throw new Error('E_ARCHIVE_SECRET_IN_RESPONSE');
      const hash = digest(value), file = join(this.dir, 'raw', hash + '.json');
      if (!existsSync(file)) writeJson(file, value);
      writeJson(refFile, { path, hash });
      this.responses[path] = hash;
      return parsed.data;
    }
    throw new Error('E_ARCHIVE_RETRIES');
  }
}

export async function fetchArchive(v: ValidatedConfig, dir: string, options: { provider?: string; progress?: (message: string) => void; fetcher?: typeof fetch } = {}): Promise<ChainArchive> {
  const provider = v.config.providers.find(p => p.name === (options.provider ?? v.config.providers[0]!.name));
  if (!provider) throw new Error('E_ARCHIVE_PROVIDER');
  const previous = existsSync(join(dir, 'archive.json')) ? openArchive(dir) : undefined;
  if (previous && (previous.configSha256 !== v.sha256 || previous.provider !== provider.name)) throw new Error('E_ARCHIVE_CAPTURE_CHANGED');
  const client = new ArchiveClient(provider, dir, options.fetcher), progress = options.progress ?? (() => {});
  const captureFile = join(dir, 'capture.json');
  let anchor: ArchiveBlock | undefined;
  if (existsSync(captureFile)) {
    const capture = JSON.parse(readFileSync(captureFile, 'utf8')) as { provider: string; configSha256: string; anchor: ArchiveBlock; previousDigest?: string };
    if (capture.provider !== provider.name || capture.configSha256 !== v.sha256) throw new Error('E_ARCHIVE_CAPTURE_CHANGED');
    const pending = archiveBlockSchema.parse(capture.anchor);
    if (!previous) {
      if (capture.previousDigest) throw new Error('E_ARCHIVE_CAPTURE_CHANGED');
      anchor = pending;
    } else if (pending.id !== previous.anchor.id) {
      if (capture.previousDigest !== previous.digest || pending.height <= previous.anchor.height) throw new Error('E_ARCHIVE_CAPTURE_CHANGED');
      anchor = pending;
      progress('Resuming update from block ' + previous.anchor.height + ' through ' + anchor.height);
    }
  }
  if (!anchor) {
    const tipHash = await client.get('/blocks/tip/hash', hashSchema, true, false);
    const tip = await client.get('/block/' + tipHash, archiveBlockSchema);
    const anchorHash = await client.get('/block-height/' + Math.max(0, tip.height - v.config.chain.finality_depth), hashSchema, true, false);
    anchor = await client.get('/block/' + anchorHash, archiveBlockSchema);
  }
  const boundary = anchor;
  const checkAnchor = async () => {
    if (await client.get('/block-height/' + boundary.height, hashSchema, true, false) !== boundary.id ||
      (previous && await client.get('/block-height/' + previous.anchor.height, hashSchema, true, false) !== previous.anchor.id) ||
      await client.get('/block-height/' + v.config.chain.checkpoint.height, hashSchema, true, false) !== v.config.chain.checkpoint.hash) throw new Error('E_ARCHIVE_CHAIN_CHANGED');
  };
  await checkAnchor();
  if (previous && anchor.height <= previous.anchor.height) {
    progress('Archive is current through finalized block ' + previous.anchor.height);
    return previous;
  }
  writeJson(captureFile, { provider: provider.name, configSha256: v.sha256, anchor, previousDigest: previous?.digest });
  if (previous) progress('Updating finalized archive from block ' + previous.anchor.height + ' to ' + anchor.height);
  const transactions: Record<string, ChainTx> = {}, addresses: ArchiveAddress[] = [];
  for (const wallet of v.config.wallets) {
    for (const chain of [0, 1] as const) {
      for (let index = 0; index < wallet.gap_scan.ceiling; index++) {
        const a = deriveAddress(v.wallets.get(wallet.id)!, chain, index, v.config.chain.bech32_hrp);
        const ids = new Set<string>();
        let complete = false;
        // Refresh the head on every resume; stable cursor pages can be reused.
        for (let pass = 0; pass < 3 && !complete; pass++) {
          let cursor: string | undefined;
          const visited = new Set<string>();
          for (;;) {
            const path = '/address/' + a.address + '/txs/chain' + (cursor ? '/' + cursor : '');
            // A cached page is safe only if all its transactions were in the prior seal.
            // More recent pages may have moved during a reorg or interrupted capture.
            const cached = Boolean(cursor && previous?.transactions[cursor]);
            const page: ChainTx[] = await client.get(path, z.array(txSchema).max(25), false, cached);
            for (const tx of page) {
              if (!tx.status.confirmed || visited.has(tx.txid)) throw new Error('E_ARCHIVE_PAGINATION');
              visited.add(tx.txid); ids.add(tx.txid);
              if (tx.status.block_height! <= anchor.height) transactions[tx.txid] = tx;
            }
            if (page.length < 25) break;
            cursor = page.at(-1)!.txid;
          }
          const stats = await client.get('/address/' + a.address, statsSchema, false, false);
          complete = ids.size === stats.chain_stats.tx_count;
        }
        if (!complete) throw new Error('E_ARCHIVE_HISTORY_INCOMPLETE');
        addresses.push({ ...a, wallet: wallet.id, chain, index, txids: [...ids].filter(id => transactions[id]).sort(), complete: true });
        if (index % 10 === 0) progress('History ' + wallet.id + ' chain ' + chain + ' index ' + index + '; ' + Object.keys(transactions).length + ' transactions');
      }
    }
  }
  const scripts = new Set(addresses.map(a => a.script));
  const knownSpends = new Set(Object.values(transactions).flatMap(tx => tx.vin.map(i => i.txid + ':' + i.vout)));
  const priorReveals = new Map(Object.values(previous?.transactions ?? {}).flatMap(tx => tx.vin.map(i => [i.txid + ':' + i.vout, tx] as const)));
  for (const commit of Object.values(transactions)) {
    const funding = commitOutputs(commit, scripts);
    if (!funding) continue;
    for (const index of funding) {
      const key = commit.txid + ':' + index, saved = priorReveals.get(key);
      if (saved) { transactions[saved.txid] = saved; continue; }
      if (knownSpends.has(key)) continue;
      const spend = await client.get('/tx/' + commit.txid + '/outspend/' + index, outspendSchema, false, false);
      if (!spend.spent || !spend.status?.confirmed || spend.status.block_height! > anchor.height) continue;
      const tx = await client.get('/tx/' + spend.txid, txSchema, false, Boolean(previous?.transactions[spend.txid!]));
      if (tx.txid !== spend.txid || !tx.status.confirmed || tx.status.block_height! > anchor.height) throw new Error('E_ARCHIVE_LINK');
      transactions[tx.txid] = tx;
    }
  }
  // All wallet history is retained. Contiguous headers also cover the audit warm-up.
  const txTimes = Object.values(transactions).map(t => t.status.block_time!);
  const earliest = Math.min(anchor.timestamp - (90 + v.config.estimator.window_days) * 86400, ...txTimes);
  const blocks: ArchiveBlock[] = [];
  let next = anchor.height;
  while (next >= 0 && (!previous || next > previous.anchor.height)) {
    const page = await client.get('/blocks/' + next, z.array(archiveBlockSchema).min(1).max(10), false, false);
    if (page[0]!.height !== next) throw new Error('E_ARCHIVE_BLOCK_PAGE');
    for (const block of page) {
      if (previous && block.height <= previous.anchor.height) break;
      if (block.height !== next) throw new Error('E_ARCHIVE_BLOCK_GAP');
      blocks.push(block); next--;
    }
    if (blocks.at(-1)!.timestamp < earliest - 86400 || next < 0) break;
    if (blocks.length % 1000 === 0) progress('Headers ' + blocks.length + '; ' + client.requests + ' network requests');
  }
  blocks.reverse();
  if (previous) blocks.unshift(...previous.blocks);
  await checkAnchor();
  let codeRevision = 'unknown';
  try { codeRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source archives may omit Git. */ }
  const data: Omit<ChainArchive, 'digest'> = { schemaVersion: 1, network: v.config.network, provider: provider.name,
    config: v.config, configSha256: v.sha256, anchor, blocks, addresses, transactions, capturedAt: new Date().toISOString(),
    monitorVersion: MONITOR_VERSION, codeRevision, responses: { ...previous?.responses, ...client.responses } };
  const archive = { ...data, digest: digest(data) };
  validateArchive(archive);
  if (previous) {
    // A refresh may extend a finalized seal, never revise or omit its history.
    for (const tx of Object.values(previous.transactions)) {
      if (canonical(transactions[tx.txid]) !== canonical(tx)) throw new Error('E_ARCHIVE_PREVIOUS_HISTORY_CHANGED');
    }
    const seals = join(dir, 'seals'); mkdirSync(seals, { recursive: true });
    writeJson(join(seals, previous.digest + '.json'), previous);
  }
  writeJson(join(dir, 'archive.json'), archive);
  progress('Sealed ' + Object.keys(transactions).length + ' transactions and ' + blocks.length + ' blocks');
  return archive;
}

export function validateArchive(a: ChainArchive): ValidatedConfig {
  if (a.schemaVersion !== 1 || !a.blocks.length || !a.addresses.length) throw new Error('E_ARCHIVE_FORMAT');
  const v = validateConfig(a.config, a.network, false);
  if (v.sha256 !== a.configSha256) throw new Error('E_ARCHIVE_CONFIG');
  const blockMap = new Map<number, ArchiveBlock>();
  for (const [i, raw] of a.blocks.entries()) {
    const b = archiveBlockSchema.parse(raw), previous = a.blocks[i - 1];
    if (previous && (b.height !== previous.height + 1 || b.previousblockhash !== previous.id)) throw new Error('E_ARCHIVE_BLOCK_GAP');
    blockMap.set(b.height, b);
  }
  if (a.blocks.at(-1)!.id !== a.anchor.id || a.blocks.at(-1)!.height !== a.anchor.height) throw new Error('E_ARCHIVE_ANCHOR');
  const txs = Object.values(a.transactions), spenders = new Set<string>();
  const ownedScripts = new Set(a.addresses.map(address => address.script));
  for (const tx of txs) {
    txSchema.parse(tx);
    if (a.transactions[tx.txid] !== tx || !tx.status.confirmed) throw new Error('E_ARCHIVE_TX');
    const b = blockMap.get(tx.status.block_height!);
    if (!b || b.id !== tx.status.block_hash || b.timestamp !== tx.status.block_time) throw new Error('E_ARCHIVE_TX_BLOCK');
    if (!tx.vin.some(i => i.is_coinbase) && !validFee(tx)) throw new Error('E_ARCHIVE_FEE');
    for (const input of tx.vin) {
      if (input.is_coinbase) continue;
      const key = input.txid + ':' + input.vout;
      if (spenders.has(key)) throw new Error('E_ARCHIVE_DOUBLE_SPEND');
      spenders.add(key);
      const parent = a.transactions[input.txid];
      if (!parent && input.prevout && ownedScripts.has(input.prevout.scriptpubkey)) throw new Error('E_ARCHIVE_MISSING_PARENT');
      if (parent && (parent.status.block_height! > tx.status.block_height! ||
        canonical(parent.vout[input.vout]) !== canonical(input.prevout))) throw new Error('E_ARCHIVE_PREVOUT');
    }
  }
  const expected = v.config.wallets.reduce((n, w) => n + 2 * w.gap_scan.ceiling, 0);
  const seen = new Set<string>();
  for (const address of a.addresses) {
    const w = v.config.wallets.find(w => w.id === address.wallet), parsed = v.wallets.get(address.wallet);
    if (!w || !parsed || !address.complete || ![0, 1].includes(address.chain) || address.index < 0 || address.index >= w.gap_scan.ceiling) throw new Error('E_ARCHIVE_COVERAGE');
    const derived = deriveAddress(parsed, address.chain, address.index, v.config.chain.bech32_hrp);
    const key = address.wallet + ':' + address.chain + ':' + address.index;
    if (seen.has(key) || derived.address !== address.address || derived.script !== address.script) throw new Error('E_ARCHIVE_ADDRESS');
    seen.add(key);
    const actual = txs.filter(tx => tx.vout.some(o => o.scriptpubkey === address.script) || tx.vin.some(i => i.prevout?.scriptpubkey === address.script)).map(tx => tx.txid).sort();
    if (canonical(actual) !== canonical(address.txids)) throw new Error('E_ARCHIVE_HISTORY_INCOMPLETE');
  }
  if (seen.size !== expected) throw new Error('E_ARCHIVE_COVERAGE');
  return v;
}
export function openArchive(dir: string, sealDigest?: string): ChainArchive {
  if (sealDigest && !/^[a-f0-9]{64}$/.test(sealDigest)) throw new Error('E_ARCHIVE_DIGEST');
  const saved = sealDigest ? join(dir, 'seals', sealDigest + '.json') : undefined;
  const archive = JSON.parse(readFileSync(saved && existsSync(saved) ? saved : join(dir, 'archive.json'), 'utf8')) as ChainArchive;
  const { digest: expected, ...data } = archive;
  if (digest(data) !== expected || (sealDigest && sealDigest !== expected)) throw new Error('E_ARCHIVE_DIGEST');
  validateArchive(archive);
  const bodies = new Map<string, unknown>();
  for (const hash of new Set(Object.values(archive.responses))) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('E_ARCHIVE_RAW');
    const raw: unknown = JSON.parse(readFileSync(join(dir, 'raw', hash + '.json'), 'utf8'));
    if (digest(raw) !== hash) throw new Error('E_ARCHIVE_RAW');
    bodies.set(hash, raw);
  }
  for (const [path, hash] of Object.entries(archive.responses)) {
    const raw = bodies.get(hash);
    const txs = /^\/address\/[^/]+\/txs\/chain(?:\/|$)/.test(path) ? z.array(txSchema).parse(raw) :
      /^\/tx\/[a-f0-9]{64}$/.test(path) ? [txSchema.parse(raw)] : [];
    for (const tx of txs) if (tx.status.confirmed && tx.status.block_height! <= archive.anchor.height &&
      canonical(archive.transactions[tx.txid]) !== canonical(tx)) throw new Error('E_ARCHIVE_RAW_TX_MISMATCH');
  }
  return archive;
}
