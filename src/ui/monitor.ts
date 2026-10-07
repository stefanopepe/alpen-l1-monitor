import { renderTransactionText } from './explorer.js';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const out = el('out');
const load = el<HTMLButtonElement>('load');
async function loadStatus() {
  load.disabled = true;
  el('transactions').hidden = true;
  el('transaction-text').replaceChildren();
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const response = await fetch('/api/status?format=text&timezone=' + encodeURIComponent(timezone), { cache: 'no-store' });
    if(response.ok && response.headers.get('x-monitor-network')!==document.documentElement.dataset.network){out.textContent='The wallet data belongs to a different network. Reload this deployment.';return}
    if(response.ok){
      const preview=response.headers.get('x-monitor-preview')==='1';
      el('collection-controls').hidden=preview;
      el('schedule').textContent=preview?'Preview data · Automatic and manual collection are disabled.':'Collection runs automatically every 15 minutes. Reload to see the latest saved data.';
    }
    if (response.ok) {
      const [report, transactions = ''] = (await response.text()).split('\n\nTRANSACTION DETAILS\n');
      renderTransactionText(out, report!, document.documentElement.dataset.network!);
      renderTransactionText(el('transaction-text'), transactions.trim(), document.documentElement.dataset.network!);
      el('transactions').hidden = !transactions.trim();
    } else out.textContent = 'Status is temporarily unavailable. Try reloading shortly.';
  } catch {
    out.textContent = 'Unable to read status. Check your connection and try again.';
  } finally {
    load.disabled = false;
  }
}
load.onclick = loadStatus;
el<HTMLButtonElement>('refresh').onclick = async () => {
  const button = el<HTMLButtonElement>('refresh');
  const token = el<HTMLInputElement>('write');
  button.disabled = true;
  out.textContent = 'Collecting… Existing snapshots remain available through Reload status.';
  try {
    const response = await fetch('/api/refresh', { method: 'POST', headers: { Authorization: 'Bearer ' + token.value } });
    if (response.ok) await loadStatus();
    else out.textContent = response.status === 401 ? 'Refresh token not accepted.' : 'Collection failed. Reload status to view the last saved data.';
  } catch {
    out.textContent = 'Refresh connection ended. Reload status to check the last saved data.';
  } finally {
    button.disabled = false;
    token.value = '';
  }
};
loadStatus();
