import { assessFee, type TransactionSummary } from '../../transactions.js';

const labels: Record<TransactionSummary['kind'], string> = { commit: 'Checkpoint commit', reveal: 'Checkpoint reveal', deposit: 'Funding received', consolidation: 'Consolidation', spend: 'Wallet spending', unknown: 'Unclassified transaction' };
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number, digits = 0) => new Intl.NumberFormat('en', { maximumFractionDigits: digits }).format(n);
const when = (n: number) => new Date(n * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
export function feeLabel(tx: TransactionSummary) {
  const assessment = assessFee(tx);
  const reference = tx.benchmark?.kind === 'block_median' ? 'same-block median' : 'period benchmark';
  return assessment.status === 'unknown' ? 'Fee comparison unavailable' :
    (assessment.status === 'above' ? '+' + fmt(assessment.excessSats!) + ' sats vs ' : 'At or below ') +
    reference + ' (' + fmt(tx.benchmark!.rate, 3) + ' sat/vB)';
}
export class TransactionInspector {
  private transactions: TransactionSummary[] = [];
  private selected: string | undefined;
  private userSelected = false;
  private from = 0;
  private to = Infinity;
  private limit = 50;
  constructor(private network: string) {
    el('transactionFilter').onchange = () => { this.limit = 50; this.renderList(); };
    el('moreTransactions').onclick = () => { this.limit += 50; this.renderList(); };
    el('transactionChoice').onchange = () => this.inspect(el<HTMLSelectElement>('transactionChoice').value);
  }
  update(transactions: TransactionSummary[], from: number, to: number) {
    this.transactions = transactions; this.from = from; this.to = to;
    if (!this.userSelected || !transactions.some(tx => tx.txid === this.selected)) this.selected = transactions.at(-1)?.txid;
    if (this.selected) this.inspect(this.selected, false, false);
    else this.clear();
    this.renderList();
  }
  setRange(from: number, to: number) { this.from = from; this.to = to; this.limit = 50; this.renderList(); }
  inspect(txid: string, focus = false, userSelected = true) {
    const tx = this.transactions.find(t => t.txid === txid);
    if (!tx) return;
    this.selected = txid;
    this.userSelected ||= userSelected;
    el('transactionTitle').textContent = labels[tx.kind];
    el('transactionWhen').textContent = when(tx.time) + ' · Confirmed in block ' + fmt(tx.height) + (tx.kind === 'deposit' ? ' · Fee paid by the sending transaction; not a sequencer spending cost.' : '');
    const link = el<HTMLAnchorElement>('transactionExplorer'); link.hidden = false;
    link.href = 'https://mempool.space/' + (this.network === 'mainnet' ? '' : this.network + '/') + 'tx/' + tx.txid;
    el('transactionId').textContent = tx.txid;
    const choice = el<HTMLSelectElement>('transactionChoice'); choice.replaceChildren(); choice.disabled = false;
    for (const peer of this.transactions.filter(t => t.blockHash === tx.blockHash)) {
      const option = document.createElement('option'); option.value = peer.txid;
      option.textContent = labels[peer.kind] + ' · ' + peer.txid.slice(0, 12) + '… · ' + fmt(peer.feeSats) + ' sats'; choice.append(option);
    }
    choice.value = txid;
    const assessment = assessFee(tx), b = tx.benchmark, stats = el('transactionStats'); stats.replaceChildren();
    const reference = b?.kind === 'block_median' ? 'same-block median' : 'period benchmark';
    for (const [name, val, help] of [['Virtual size', fmt(tx.vsize) + ' vB', 'Weight ÷ 4, rounded up'], ['Fee paid', fmt(tx.feeSats) + ' sats', 'This transaction only'],
      ['Fee rate', fmt(tx.feeRate, 3) + ' sat/vB', 'Fee ÷ virtual size'], [b ? 'Fee vs ' + reference : 'Fee comparison', assessment.status === 'above' ? '+' + fmt(assessment.excessSats!) + ' sats' : assessment.status === 'at_or_below' ? 'At or below' : 'Unavailable',
        assessment.status === 'above' ? (assessment.premium === null ? '' : fmt(assessment.premium * 100, 1) + '% ') + 'above ' + fmt(b!.rate, 3) + ' sat/vB' : assessment.status === 'at_or_below' ? fmt(b!.rate, 3) + ' sat/vB reference rate' : 'No precise comparison available']]) {
      const stat = document.createElement('div'), label = document.createElement('span'), number = document.createElement('strong'), detail = document.createElement('small');
      label.textContent = name!; number.textContent = val!; detail.textContent = help!; stat.append(label, number, detail); stats.append(stat);
    }
    el('transactionBenchmark').textContent = b ?
      (b.kind === 'block_median' ? 'Same-block median: ' : 'Same-block median not recorded. Period benchmark: average block median across ' + when(b.start) + ' – ' + when(b.end) + ', ') +
      fmt(b.rate, 3) + ' sat/vB.' + (b.integerQuantized ? ' Historical values are quantized to whole sat/vB; small differences are inconclusive.' : '') +
      (assessment.benchmarkSats === null ? ' This rounded value cannot support a fee comparison.' : ' Fee at this reference rate: ' + fmt(assessment.benchmarkSats) + ' sats.') +
      (b.kind === 'period_median' ? ' This period average does not establish how the transaction compares with others in its block.' : '') +
      ' Being above a median does not establish overpayment or avoidable fees. Submission-time conditions and package dependencies affect the fee needed for confirmation.' :
      'Same-block median and period benchmark not recorded. Actual size and fees are known; a fee comparison is unavailable. Today’s fee rate is never substituted.';
    const related = tx.packageId ? this.transactions.filter(t => t.packageId === tx.packageId) : [];
    el('transactionPackage').textContent = related.length ? (tx.packageComplete ? 'Complete commit/reveal package' : 'Known commit/reveal transactions (completeness unverified)') + ': ' +
      fmt(related.reduce((s, t) => s + t.feeSats, 0)) + ' sats · ' + fmt(related.reduce((s, t) => s + t.vsize, 0)) + ' vB · ' +
      fmt(related.reduce((s, t) => s + t.feeSats, 0) / related.reduce((s, t) => s + t.vsize, 0), 3) + ' sat/vB combined. Individual fees above are not package totals.' : '';
    const links = el('transactionRelated'); links.replaceChildren();
    for (const other of related.filter(t => t.txid !== txid)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'btn btn-outline-secondary';
      button.textContent = 'Inspect ' + labels[other.kind].toLowerCase() + ' · ' + other.txid.slice(0, 8) + '…';
      button.onclick = () => this.inspect(other.txid); links.append(button);
    }
    this.renderList();
    if (focus) { el('transactionInspector').focus({ preventScroll: true }); el('transactionInspector').scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
  }
  private clear() {
    for (const id of ['transactionStats', 'transactionBenchmark', 'transactionPackage', 'transactionRelated', 'transactionId']) el(id).replaceChildren();
    el('transactionTitle').textContent = 'Transaction details'; el('transactionWhen').textContent = 'Transaction details were not included in this report.';
    el('transactionExplorer').hidden = true; el<HTMLSelectElement>('transactionChoice').disabled = true; el('transactionChoice').replaceChildren();
  }
  private renderList() {
    const filter = el<HTMLSelectElement>('transactionFilter').value;
    const visible = this.transactions.filter(t => t.time * 1000 >= this.from && t.time * 1000 <= this.to &&
      (filter === 'all' || (filter === 'other' ? !['commit', 'reveal', 'deposit'].includes(t.kind) : t.kind === filter))).toReversed();
    el('eventCount').textContent = '· ' + visible.length + (visible.length === 1 ? ' transaction' : ' transactions'); el('events').replaceChildren();
    for (const tx of visible.slice(0, this.limit)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'list-group-item list-group-item-action' + (tx.txid === this.selected ? ' transaction-selected' : '');
      button.setAttribute('aria-pressed', String(tx.txid === this.selected)); button.textContent = labels[tx.kind] + ' · ' + tx.txid.slice(0, 12) + '…';
      const date = document.createElement('span'); date.className = 'event-date'; date.textContent = when(tx.time) + ' · Block ' + tx.height;
      const fees = document.createElement('span'); fees.className = 'event-fees'; fees.textContent = fmt(tx.vsize) + ' vB · ' + fmt(tx.feeSats) + ' sats · ' + fmt(tx.feeRate, 3) + ' sat/vB · ' + feeLabel(tx);
      button.append(date, fees); button.onclick = () => this.inspect(tx.txid, true); el('events').append(button);
    }
    if (!visible.length) el('events').textContent = 'No recorded transactions in this view. Zoom out or change the filter.';
    el('moreTransactions').hidden = visible.length <= this.limit;
  }
}
