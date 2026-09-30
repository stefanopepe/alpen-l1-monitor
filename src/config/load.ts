import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { bech32 } from '@scure/base';
import { networkSchema, type NetworkConfig } from './schema.js';
import { parseWalletDescriptor, type ParsedWallet } from '../descriptor/parse.js';
import { deriveAddress } from '../derive/address.js';
import { SELECTOR_MODEL_VERSION } from '../model/composition.js';
export interface ValidatedConfig { config: NetworkConfig; sha256: string; wallets: Map<string, ParsedWallet> }
export function validateConfig(input: unknown, network: string, requireSecrets = true): ValidatedConfig {
  const result = networkSchema.safeParse(input);
  // Zod errors can contain input values. Never let them escape into logs or HTTP responses.
  if (!result.success) throw new Error('E_CONFIG_SCHEMA');
  const config = result.data;
  if (config.network !== network) throw new Error('E_NETWORK_CONFIG');
  const wallets = new Map<string, ParsedWallet>(), keys = new Set<string>();
  for (const w of config.wallets) {
    const parsed = parseWalletDescriptor(w.descriptor, config.chain);
    if (keys.has(parsed.materialIdentity)) throw new Error('E_DUPLICATE_KEY');
    keys.add(parsed.materialIdentity);
    if (![0, 1].every(c => w.vectors.some(v => v.chain === c))) throw new Error('E_VECTOR_COVERAGE');
    for (const v of w.vectors) {
      let prefix: string;
      try { prefix = bech32.decode(v.address as `${string}1${string}`).prefix; } catch { throw new Error('E_VECTOR_FORMAT'); }
      if (v.address !== v.address.toLowerCase()) throw new Error('E_VECTOR_FORMAT');
      if (prefix !== config.chain.bech32_hrp) throw new Error('E_VECTOR_HRP');
      if (deriveAddress(parsed, v.chain, v.index, prefix).address !== v.address) throw new Error('E_VECTOR_MISMATCH');
    }
    wallets.set(w.id, parsed);
  }
  if (requireSecrets) for (const p of config.providers) {
    if (p.auth.scheme !== 'none' && !process.env[p.auth.secret_env]) throw new Error('E_PROVIDER_SECRET_MISSING');
  }
  return { config, wallets, sha256: createHash('sha256').update(JSON.stringify(config)).digest('hex') };
}
export function loadConfig(network = process.env.NETWORK, requireSecrets = true): ValidatedConfig {
  if (!network || !/^[a-z0-9-]+$/.test(network)) throw new Error('E_NETWORK_REQUIRED');
  let input: unknown;
  try { input = JSON.parse(readFileSync(join(process.cwd(), 'config', 'networks', `${network}.json`), 'utf8')); }
  catch { throw new Error('E_CONFIG_MISSING'); }
  const validated = validateConfig(input, network, requireSecrets);
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(readFileSync(join(process.cwd(), 'config', 'upstream-manifest.json'), 'utf8')); }
  catch { throw new Error('E_COMPATIBILITY_MANIFEST'); }
  if (JSON.stringify(manifest[network]) !== JSON.stringify(validated.config.upstream) || validated.config.upstream.selector_model_version !== SELECTOR_MODEL_VERSION) throw new Error('E_COMPATIBILITY_MANIFEST');
  return validated;
}
export function validateAllConfigs(): void {
  const identities = new Set<string>();
  for (const file of readdirSync('config/networks').filter(f => f.endsWith('.json'))) {
    const v = loadConfig(file.slice(0, -5), false);
    for (const w of v.wallets.values()) {
      if (identities.has(w.materialIdentity)) throw new Error('E_DUPLICATE_KEY');
      identities.add(w.materialIdentity);
    }
  }
}
