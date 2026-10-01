import { z } from 'zod';
import type { ProviderConfig } from '../config/schema.js';
import { blockSchema, hashSchema, outspendSchema, statsSchema, statusSchema, txSchema, utxosSchema } from './schemas.js';
import { ProviderError } from './errors.js';
import type { ChainView } from './view.js';
import { providerRequest } from './request.js';
export class Budget {
  used = 0;
  constructor(readonly deadline: number, readonly max: number, readonly provider: string) {}
  check(): void { if (this.used >= this.max || Date.now() >= this.deadline) throw new ProviderError(this.provider, 'budget_exhausted'); }
  take(): void { this.check(); this.used++; }
}
export class Esplora implements ChainView {
  readonly provider: string;
  private lastRequest = 0;
  constructor(readonly config: ProviderConfig, public budget: Budget, private readonly fetcher: typeof fetch = fetch) { this.provider = config.name; }
  private async get<T>(path: string, schema: z.ZodType<T>, plain = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      this.budget.check();
      const pause = Math.max(0, this.lastRequest + this.config.min_interval_ms - Date.now());
      if (pause) await new Promise(resolve => setTimeout(resolve, Math.min(pause, Math.max(0, this.budget.deadline - Date.now()))));
      this.budget.take(); this.lastRequest = Date.now();
      const request = providerRequest(this.config, path);
      const headers = { accept: plain ? 'text/plain' : 'application/json', ...request.headers };
      try {
        const response = await this.fetcher(request.url, {
          headers, redirect: 'error', cache: 'no-store',
          signal: AbortSignal.timeout(Math.max(1, Math.min(this.config.timeout_ms, this.budget.deadline - Date.now()))),
        });
        if (!response.ok) {
          // Read a small error body only for classification; never log or return it.
          const body = (await response.text()).slice(0, 500);
          const s = response.status;
          const kind = s === 429 ? 'rate_limited' : s >= 500 ? 'server_error' : s === 408 ? 'timeout' : s === 404 ? 'not_found'
            : /Too many unspent/i.test(body) ? 'utxo_limit' : /Too many history/i.test(body) ? 'history_limit'
              : /invalid network/i.test(body) ? 'wrong_network' : 'bad_request';
          throw new ProviderError(this.provider, kind, s);
        }
        let value: unknown;
        try { value = plain ? (await response.text()).trim() : await response.json(); } catch { throw new ProviderError(this.provider, 'malformed'); }
        const parsed = schema.safeParse(value);
        if (!parsed.success) throw new ProviderError(this.provider, 'malformed');
        return parsed.data;
      } catch (error) {
        const e = error instanceof ProviderError ? error : new ProviderError(this.provider, 'timeout');
        if (e.kind === 'timeout' && attempt < this.config.retries) continue;
        throw e;
      }
    }
  }
  blockHashAt(height: number) { return this.get(`/block-height/${height}`, hashSchema, true); }
  tipHash() { return this.get('/blocks/tip/hash', hashSchema, true); }
  async tip() {
    const hash = await this.tipHash();
    const block = await this.get(`/block/${hash}`, blockSchema);
    if (block.id !== hash) throw new ProviderError(this.provider, 'inconsistent');
    return { hash, height: block.height, blockTime: block.timestamp };
  }
  addressStats(a: string) { return this.get(`/address/${a}`, statsSchema); }
  addressUtxos(a: string) { return this.get(`/address/${a}/utxo`, utxosSchema); }
  addressTxsChain(a: string, cursor?: string) { return this.get(`/address/${a}/txs/chain${cursor ? `/${cursor}` : ''}`, z.array(txSchema).max(25)); }
  async tx(txid: string) {
    const tx = await this.get(`/tx/${txid}`, txSchema);
    if (tx.txid !== txid) throw new ProviderError(this.provider, 'inconsistent');
    return tx;
  }
  txStatus(txid: string) { return this.get(`/tx/${txid}/status`, statusSchema); }
  outspend(txid: string, vout: number) { return this.get(`/tx/${txid}/outspend/${vout}`, outspendSchema); }
}
