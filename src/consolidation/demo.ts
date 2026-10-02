import { HDKey } from '@scure/bip32';
import { createHash } from 'node:crypto';
import { loadConfig, validateConfig } from '../config/load.js';
import { descriptorChecksum } from '../descriptor/checksum.js';
import { parseWalletDescriptor } from '../descriptor/parse.js';
import { deriveAddress } from '../derive/address.js';
import { computeWalletSnapshot } from '../pipeline/snapshot.js';
import type { ReadModel } from '../read/model.js';
import type { Utxo } from '../types.js';

// Deliberately synthetic testnet wallets and nonexistent outpoints. No real inventory.
export function demoData() {
  const input = structuredClone(loadConfig('mainnet', false).config);
  input.network = 'signet';
  input.chain = { ...input.chain, bech32_hrp: 'tb', bip44_coin_type: 1, bip32_versions: { public: '043587cf', private: '04358394' }, checkpoint: { height: 1, hash: '0'.repeat(64) } };
  input.wallets = ['ee', 'ol'].map(id => {
    const root = HDKey.fromMasterSeed(createHash('sha256').update('consolidation-staging-demo-' + id).digest(), { public: 0x043587cf, private: 0x04358394 });
    const account = root.derive("m/84'/1'/0'");
    const body = `wpkh([${root.fingerprint.toString(16).padStart(8, '0')}/84h/1h/0h]${account.publicExtendedKey}/<0;1>/*)`;
    const descriptor = `${body}#${descriptorChecksum(body)}`, parsed = parseWalletDescriptor(descriptor, input.chain);
    return { ...input.wallets[0]!, id, display_name: id.toUpperCase() + ' sample wallet', descriptor,
      vectors: ([0, 1] as const).map(chain => ({ chain, index: 0, address: deriveAddress(parsed, chain, 0, 'tb').address })), vector_source: 'Synthetic staging fixture' };
  });
  const config = validateConfig(input, 'signet', false), asOf = '2026-10-02T12:00:00.000Z';
  const wallets = input.wallets.map(w => {
    const derived = deriveAddress(config.wallets.get(w.id)!, 0, 0, 'tb');
    const utxos: Utxo[] = Array.from({ length: w.id === 'ee' ? 44 : 7 }, (_, i) => ({
      txid: createHash('sha256').update(`nonexistent-staging-output-${w.id}-${i}`).digest('hex'), vout: 0, valueSats: 546,
      confirmed: true, blockHeight: 1, address: derived.address, chain: 0, index: 0, scriptType: 'p2wpkh',
    }));
    const snapshot = computeWalletSnapshot({ asOfEpoch: Date.parse(asOf) / 1000, utxos, settlements: [], estimator: input.estimator, historyComplete: false,
      meta: { network: 'signet', wallet: w.id, asOf, finishedAt: asOf, provider: 'sample', tip: { height: 1, hash: '0'.repeat(64), blockTime: Date.parse(asOf) / 1000 },
        ceilingHit: { receive: false, change: false }, addressesScanned: 2, requestsUsed: 0, primaryIsPublic: false, networkTipOld: false,
        historyError: null, monitorVersion: 'staging', selectorModelVersion: 1, upstreamRef: input.upstream.ref, deployedBuildConfirmed: false, configSha256: config.sha256 } });
    return { wallet: w.id, name: w.display_name, snapshot, utxos };
  });
  return { config, wallets, asOf };
}
export function demoStatus(now: Date): ReadModel {
  const data = demoData();
  return { network: 'signet', readAt: now.toISOString(), preview: { capturedAt: data.asOf, sample: true }, primaryIsPublic: false, providerErrors: [],
    wallets: data.wallets.map(w => ({ wallet: w.wallet, name: w.name, snapshot: w.snapshot, ageSeconds: null, stale: false })) };
}
