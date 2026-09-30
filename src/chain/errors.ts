export type ErrorKind = 'timeout' | 'rate_limited' | 'server_error' | 'utxo_limit' | 'history_limit' | 'not_found' | 'bad_request' | 'wrong_network' | 'malformed' | 'inconsistent' | 'stale_tip' | 'budget_exhausted';
export class ProviderError extends Error {
  constructor(public readonly provider: string, public readonly kind: ErrorKind, public readonly status?: number) { super(`E_PROVIDER_${kind.toUpperCase()}`); }
}
export function safeError(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error && /^E_[A-Z_]+$/.test(error.message)) return error.message;
  return 'E_INTERNAL';
}
