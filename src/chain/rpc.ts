import { hashSchema } from './schemas.js';
// RPC is deliberately separate. Alchemy cannot supply descriptor discovery or wallet inventory.
export async function rpcTip(rpcUrl: string, fetcher: typeof fetch = fetch): Promise<string> {
  try {
    if (new URL(rpcUrl).protocol !== 'https:') throw new Error('E_RPC_URL');
    const r = await fetcher(rpcUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getbestblockhash', params: [] }) });
    if (!r.ok) throw new Error();
    const body = await r.json() as { result?: unknown; error?: unknown; id?: unknown };
    if (body.error || body.id !== 1) throw new Error();
    return hashSchema.parse(body.result);
  } catch { throw new Error('E_RPC_FAILED'); }
}
