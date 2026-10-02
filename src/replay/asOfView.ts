import type { ChainView } from '../chain/view.js';
import type { ChainTx } from '../chain/schemas.js';
import { ProviderError } from '../chain/errors.js';
import type { ArchiveAddress, ArchiveBlock, ChainArchive } from './archive.js';
export class ArchiveIndex {
  readonly blocks = new Map<number, ArchiveBlock>();
  readonly clocks = new Map<number, number>();
  readonly addresses = new Map<string, ArchiveAddress>();
  readonly histories = new Map<string, ChainTx[]>();
  readonly spends = new Map<string, { tx: ChainTx; vin: number }>();
  constructor(readonly archive: ChainArchive) {
    let clock = 0;
    for (const b of archive.blocks) { this.blocks.set(b.height, b); clock = Math.max(clock, b.timestamp); this.clocks.set(b.height, clock); }
    for (const a of archive.addresses) {
      if (!a.complete) throw new Error('E_ARCHIVE_COVERAGE');
      this.addresses.set(a.address, a);
      const rows = a.txids.map(id => { const tx = archive.transactions[id]; if (!tx) throw new Error('E_ARCHIVE_HISTORY_INCOMPLETE'); return tx; });
      this.histories.set(a.address, rows.sort((x, y) => y.status.block_height! - x.status.block_height! || x.txid.localeCompare(y.txid)));
    }
    for (const tx of Object.values(archive.transactions)) for (const [vin, input] of tx.vin.entries()) {
      if (input.is_coinbase) continue;
      const key = input.txid + ':' + input.vout;
      if (this.spends.has(key)) throw new Error('E_ARCHIVE_DOUBLE_SPEND');
      this.spends.set(key, { tx, vin });
    }
  }
  clock(height: number): number {
    const time = this.clocks.get(height); if (time === undefined) throw new Error('E_ARCHIVE_HEIGHT'); return time;
  }
  heightAt(time: number): number {
    const first = this.archive.blocks[0]!;
    if (time < this.clock(first.height)) throw new Error('E_ARCHIVE_TIME');
    let lo = 0, hi = this.archive.blocks.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (this.clock(this.archive.blocks[mid]!.height) <= time) lo = mid; else hi = mid - 1; }
    return this.archive.blocks[lo]!.height;
  }
}
export class AsOfChainView implements ChainView {
  readonly provider: string;
  constructor(readonly index: ArchiveIndex, readonly height: number) { index.clock(height); this.provider = 'archive-' + index.archive.provider; }
  private visible(tx: ChainTx) { return tx.status.confirmed && tx.status.block_height! <= this.height; }
  private missing(): never { throw new ProviderError(this.provider, 'not_found'); }
  private address(a: string): ArchiveAddress { const record = this.index.addresses.get(a); if (!record) throw new Error('E_ARCHIVE_COVERAGE'); return record; }
  private rows(a: string): ChainTx[] { this.address(a); return this.index.histories.get(a)!.filter(t => this.visible(t)); }
  async blockHashAt(height: number): Promise<string> {
    if (height > this.height) return this.missing();
    const checkpoint = this.index.archive.config.chain.checkpoint;
    if (height === checkpoint.height) return checkpoint.hash;
    return this.index.blocks.get(height)?.id ?? this.missing();
  }
  async tip() { const b = this.index.blocks.get(this.height)!; return { height: this.height, hash: b.id, blockTime: b.timestamp }; }
  async tipHash() { return (await this.tip()).hash; }
  async addressStats(a: string) { return { chain_stats: { tx_count: this.rows(a).length }, mempool_stats: { tx_count: 0 } }; }
  async addressTxsChain(a: string, cursor?: string) {
    const rows = this.rows(a), start = cursor === undefined ? 0 : rows.findIndex(t => t.txid === cursor) + 1;
    if (cursor !== undefined && start === 0) return this.missing();
    return rows.slice(start, start + 25);
  }
  async addressUtxos(a: string) {
    const script = this.address(a).script;
    return this.rows(a).flatMap(tx => tx.vout.flatMap((out, vout) => {
      const spender = this.index.spends.get(tx.txid + ':' + vout);
      return out.scriptpubkey === script && !(spender && this.visible(spender.tx)) ?
        [{ txid: tx.txid, vout, value: out.value, status: tx.status }] : [];
    }));
  }
  async tx(txid: string) { const tx = this.index.archive.transactions[txid]; return tx && this.visible(tx) ? tx : this.missing(); }
  async txStatus(txid: string) { return (await this.tx(txid)).status; }
  async outspend(txid: string, vout: number) {
    const tx = await this.tx(txid); if (!tx.vout[vout]) return this.missing();
    const spend = this.index.spends.get(txid + ':' + vout);
    return spend && this.visible(spend.tx) ? { spent: true, txid: spend.tx.txid, vin: spend.vin, status: spend.tx.status } : { spent: false };
  }
}
