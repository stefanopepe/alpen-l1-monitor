/** Use the evidence network, which can differ from the host of a historical report. */
export function transactionUrl(network: string, txid: string): string | null {
  const prefixes: Record<string, string> = { mainnet: '', signet: 'signet/', testnet: 'testnet/', testnet4: 'testnet4/' };
  if (!Object.hasOwn(prefixes, network) || !/^[a-f0-9]{64}$/.test(txid)) return null;
  return 'https://mempool.space/' + prefixes[network] + 'tx/' + txid;
}

export function transactionLink(network: string, txid: string, label = txid): HTMLElement {
  const url = transactionUrl(network, txid), link = document.createElement(url ? 'a' : 'span');
  link.textContent = label;
  if (url) {
    const anchor = link as HTMLAnchorElement;
    anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    anchor.setAttribute('aria-label', 'View transaction ' + txid + ' on mempool.space');
  }
  return link;
}

/** Only transaction-labelled lines are linked; block IDs and source hashes stay plain text. */
export function renderTransactionText(element: HTMLElement, text: string, network: string) {
  element.replaceChildren();
  for (const [index, line] of text.split('\n').entries()) {
    if (index) element.append('\n');
    if (!/^(?:(?:EE|OL|DA|Checkpoint|Pending blob).*?(?:commit|reveal|data transaction)|Reveal transaction)/i.test(line)) { element.append(line); continue; }
    let offset = 0;
    for (const match of line.matchAll(/\b[a-f0-9]{64}\b/g)) {
      element.append(line.slice(offset, match.index), transactionLink(network, match[0]));
      offset = match.index + match[0].length;
    }
    element.append(line.slice(offset));
  }
}
