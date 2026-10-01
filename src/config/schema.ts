import { z } from 'zod';
const uint = z.number().int().nonnegative().safe();
const positive = uint.positive();
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const auth = z.discriminatedUnion('scheme', [
  z.object({ scheme: z.literal('none') }).strict(),
  z.object({ scheme: z.literal('bearer'), secret_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict(),
  z.object({ scheme: z.literal('header'), secret_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/), header_name: z.string().regex(/^[A-Za-z0-9-]+$/) }).strict(),
  z.object({ scheme: z.literal('query'), secret_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/), parameter_name: z.string().regex(/^[A-Za-z0-9_-]+$/) }).strict(),
]);
export const providerSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/), role: z.enum(['primary', 'failover']), tier: z.enum(['internal', 'public']),
  base_url: z.url().refine(v => { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && !v.endsWith('/'); }),
  auth, timeout_ms: positive, retries: uint.max(2), min_interval_ms: uint, max_tip_lag_blocks: uint,
}).strict();
export const chainSchema = z.object({
  bech32_hrp: z.string().regex(/^[a-z0-9]+$/), bip44_coin_type: uint.max(0x7fffffff),
  bip32_versions: z.object({ public: z.string().regex(/^[0-9a-f]{8}$/), private: z.string().regex(/^[0-9a-f]{8}$/) }).strict(),
  checkpoint: z.object({ height: uint, hash }).strict(), dust_limit_sats: z.literal(546), finality_depth: positive,
}).strict();
export const walletSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/), display_name: z.string().min(1), descriptor: z.string(),
  vectors: z.array(z.object({ chain: z.union([z.literal(0), z.literal(1)]), index: uint.max(0x7fffffff), address: z.string() }).strict()).min(2),
  vector_source: z.string().min(1),
  gap_scan: z.object({ min_indices: positive, gap_limit: positive, ceiling: positive.max(10000) }).strict()
    .refine(v => v.ceiling > v.gap_limit && v.ceiling >= v.min_indices),
}).strict();
export const networkSchema = z.object({
  schema_version: z.literal(1), network: z.string().regex(/^[a-z0-9-]+$/), chain: chainSchema,
  wallets: z.array(walletSchema).min(1), providers: z.array(providerSchema).min(1),
  estimator: z.object({ window_days: positive, short_window_days: positive, min_sample: positive,
    min_sample_short: positive, min_intervals: positive, min_intervals_short: positive }).strict(),
  collection: z.object({ interval_s: positive, lease_ttl_s: positive, max_duration_s: positive,
    deadline_margin_s: positive, max_requests_inventory: positive, max_requests_history: positive,
    history_page_cap: positive, max_tip_age_s: positive, stale_after_s: positive }).strict(),
  retention: z.object({ snapshots_days: positive, daily_samples_days: positive, history_days: positive, runs_days: positive }).strict(),
  upstream: z.object({ repo: z.string(), ref: z.string().regex(/^[0-9a-f]{40}$/), selector_model_version: z.literal(1), deployed_build_confirmed: z.boolean() }).strict(),
}).strict().superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.providers[0]?.role !== 'primary' || v.providers.filter(p => p.role === 'primary').length !== 1) issue('E_PRIMARY');
  if (new Set(v.wallets.map(w => w.id)).size !== v.wallets.length) issue('E_WALLETS');
  if (new Set(v.providers.map(p => p.name)).size !== v.providers.length) issue('E_PROVIDERS');
  if (v.providers.some(p => p.tier === 'public' && p.min_interval_ms === 0)) issue('E_PUBLIC_PACING');
  const c = v.collection;
  if (!(c.deadline_margin_s < c.max_duration_s && c.max_duration_s < c.lease_ttl_s && c.lease_ttl_s < c.interval_s)) issue('E_TIMING');
  const e = v.estimator;
  if (e.short_window_days >= e.window_days || e.window_days > v.retention.history_days || e.min_intervals_short > e.min_intervals) issue('E_WINDOWS');
  if (v.network === 'mainnet' && (v.chain.bech32_hrp !== 'bc' || v.chain.bip44_coin_type !== 0 || v.chain.bip32_versions.public !== '0488b21e')) issue('E_NETWORK_COHERENCE');
  if (v.network === 'signet' && (v.chain.bech32_hrp !== 'tb' || v.chain.bip44_coin_type !== 1 || v.chain.bip32_versions.public !== '043587cf' || v.chain.checkpoint.height === 0)) issue('E_NETWORK_COHERENCE');
});
export type NetworkConfig = z.infer<typeof networkSchema>;
export type WalletConfig = z.infer<typeof walletSchema>;
export type ChainParams = z.infer<typeof chainSchema>;
export type ProviderConfig = z.infer<typeof providerSchema>;
