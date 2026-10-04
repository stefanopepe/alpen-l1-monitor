import { feeRatesSchema, completedBlockSchema } from '../observations/schema.js';
import type { FeeContext } from '../types.js';
import { z } from 'zod';
import { projectedBlockSchema, type FeePressure } from '../fees/schema.js';
import type { NetworkConfig } from '../config/schema.js';
const mainnetFeeApi = 'https://mempool.space/api';
export function feeApiBaseUrl(config: Pick<NetworkConfig, 'network' | 'fee_api_base_url'>): string | null {
  return config.fee_api_base_url === undefined ? config.network === 'mainnet' ? mainnetFeeApi : null : config.fee_api_base_url;
}
// Informational only. A fee quote can never prevent collecting wallet inventory.
export async function observeFees(fetcher: typeof fetch = fetch, now = () => new Date(), baseUrl: string | null = mainnetFeeApi): Promise<FeeContext> {
  // Independent bounded requests: projection failure must not discard a fee quote.
  const [quote, pressure, completed] = await Promise.all([observeQuote(fetcher, now, baseUrl), observePressure(fetcher, now, baseUrl), observeCompletedFees(fetcher, now, baseUrl)]);
  if (pressure.status === 'available' && completed.status === 'available' && completed.blocks?.length) {
    pressure.blockFullness = { observedAt: completed.observedAt, ratio: completed.blocks.reduce((s, b) => s + b.weight / 4000000, 0) / completed.blocks.length };
  }
  return { ...quote, pressure, completed };
}

export async function observeCompletedFees(fetcher: typeof fetch = fetch, now = () => new Date(), baseUrl: string | null = mainnetFeeApi): Promise<NonNullable<FeeContext['completed']>> {
  try {
    if (!baseUrl) throw new Error('E_COMPLETED_SOURCE_UNAVAILABLE');
    const response = await fetcher(`${baseUrl}/v1/blocks`, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'E_COMPLETED_RATE_LIMITED' : 'E_COMPLETED_HTTP');
    const parsed = z.array(completedBlockSchema).min(1).max(15).safeParse(await response.json());
    if (!parsed.success || new Set(parsed.data.map(b => b.id)).size !== parsed.data.length) throw new Error('E_COMPLETED_SCHEMA');
    return { observedAt: now().toISOString(), status: 'available', blocks: parsed.data, error: null };
  } catch (e) {
    const error = e instanceof Error && /^E_COMPLETED_[A-Z_]+$/.test(e.message) ? e.message : 'E_COMPLETED_UNAVAILABLE';
    return { observedAt: now().toISOString(), status: 'unavailable', blocks: null, error };
  }
}
export async function observeQuote(fetcher: typeof fetch = fetch, now = () => new Date(), baseUrl: string | null = mainnetFeeApi): Promise<FeeContext> {
  try {
    if (!baseUrl) throw new Error('E_FEE_SOURCE_UNAVAILABLE');
    const response = await fetcher(`${baseUrl}/v1/fees/recommended`, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'E_FEE_RATE_LIMITED' : 'E_FEE_HTTP');
    const rates = feeRatesSchema.safeParse(await response.json());
    if (!rates.success) throw new Error('E_FEE_SCHEMA');
    return { provider: 'mempool', observedAt: now().toISOString(), status: 'available', rates: rates.data, error: null };
  } catch (e) {
    const error = e instanceof Error && /^E_FEE_[A-Z_]+$/.test(e.message) ? e.message : 'E_FEE_UNAVAILABLE';
    return { provider: 'mempool', observedAt: now().toISOString(), status: 'unavailable', rates: null, error };
  }
}

export async function observePressure(fetcher: typeof fetch = fetch, now = () => new Date(), baseUrl: string | null = mainnetFeeApi): Promise<FeePressure> {
  try {
    if (!baseUrl) throw new Error('E_PRESSURE_SOURCE_UNAVAILABLE');
    const response = await fetcher(`${baseUrl}/v1/fees/mempool-blocks`, {
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(response.status === 429 ? 'E_PRESSURE_RATE_LIMITED' : 'E_PRESSURE_HTTP');
    const parsed = z.array(projectedBlockSchema).min(1).max(100).safeParse(await response.json());
    if (!parsed.success) throw new Error('E_PRESSURE_SCHEMA');
    return { observedAt: now().toISOString(), status: 'available', blocks: parsed.data, error: null };
  } catch (e) {
    const error = e instanceof Error && /^E_PRESSURE_[A-Z_]+$/.test(e.message) ? e.message : 'E_PRESSURE_UNAVAILABLE';
    return { observedAt: now().toISOString(), status: 'unavailable', blocks: null, error };
  }
}
