import { respond, networkName } from '../src/http/respond.js';
import { consolidationQuote } from '../src/consolidation/service.js';
import { validFeeRate } from '../src/consolidation/transaction.js';

const messages: Record<string, string> = {
  E_WALLET: 'Wallet not found.',
  E_NO_OUTPUTS: 'No confirmed stranded outputs are available to consolidate.',
  E_UNECONOMIC: 'The fee is too high to recover a spendable amount. Check again when fees are lower.',
  E_TOO_MANY_OUTPUTS: 'This wallet needs more than one consolidation transaction.',
  E_DISCOVERY: 'The wallet scan is incomplete. Complete the scan before downloading a transaction.',
  E_FEES: 'The fee quote is unavailable. Try again shortly.',
};
export default { async fetch(request: Request) {
  if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405);
  const params = new URL(request.url).searchParams;
  const wallet = params.get('wallet'), format = params.get('format') ?? 'json', quote = params.get('quote');
  const rate = params.get('feeRate'), feeRate = rate === null ? undefined : Number(rate);
  if (rate !== null && (!/^\d+(?:\.\d+)?$/.test(rate) || !validFeeRate(feeRate!) || params.getAll('feeRate').length !== 1))
    return respond({ error: 'invalid_fee_rate', message: 'Enter a fee rate from 0.1 to 10,000 sat/vB in steps of 0.1.' }, 400);
  if (!wallet || !/^[a-z0-9_]{1,32}$/.test(wallet) || !['json', 'psbt'].includes(format)) return respond({ error: 'invalid_request' }, 400);
  if (format === 'psbt' && !/^[0-9a-f]{64}$/.test(quote ?? '')) return respond({ error: 'quote_required', message: 'Reload the fee estimate before downloading.' }, 400);
  try {
    const result = await consolidationQuote(networkName(), wallet, feeRate);
    if (format === 'psbt') {
      if (result.quoteId !== quote) return respond({ error: 'quote_changed', message: 'The outputs or fee have changed. Reload the estimate before downloading.' }, 409);
      return new Response(Buffer.from(result.psbt), { headers: {
        'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${wallet}-${result.network}-${result.sample ? 'sample-' : ''}consolidation.psbt"`,
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
      } });
    }
    return respond({ ...result, psbt: undefined });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const message = messages[code] ?? 'Unable to verify the wallet outputs. Try again shortly.';
    return respond({ error: messages[code] ? code : 'unavailable', message }, code === 'E_WALLET' ? 404 : ['E_NO_OUTPUTS', 'E_UNECONOMIC'].includes(code) ? 422 : 503);
  }
} };
