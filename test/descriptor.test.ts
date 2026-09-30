import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { descriptorChecksum } from '../src/descriptor/checksum.js';
import { parseWalletDescriptor } from '../src/descriptor/parse.js';
import { deriveAddress } from '../src/derive/address.js';
import { validateConfig } from '../src/config/load.js';
import { config, rawConfig } from './helpers.js';
const seal = (body: string) => `${body}#${descriptorChecksum(body)}`;
const main = config().config;
const body = main.wallets[0]!.descriptor.split('#')[0]!;
const key = /\]([^/]+)/.exec(body)![1]!;
const replaceKey = (edit: (b: Uint8Array) => void) => { const b = base58check(sha256).decode(key); edit(b); return body.replace(key, base58check(sha256).encode(b)); };
describe('descriptor validation', () => {
  it('matches all six externally supplied mainnet vectors and published BIP380 checksum', () => {
    expect(() => config()).not.toThrow();
    expect(descriptorChecksum('raw(deadbeef)')).toBe('89f8spxm');
    expect(descriptorChecksum(body)).toBe('lecc6wxp');
    expect(descriptorChecksum(body.replaceAll('h/', "'/").replace('h]', "']"))).toBe('g39kk0vu');
  });
  it.each([
    [body, 'E_CHECKSUM_MISSING'], [body + '#aaaaaaa', 'E_CHECKSUM_FORMAT'], [body + '#aaaaaaaa', 'E_CHECKSUM_MISMATCH'],
    [seal(body.replace('84h', '84H')), 'E_HARDENED_MARKER'], [seal(body.replace('/*)', '/*h)')), 'E_HARDENED_WILDCARD'],
    [seal(body.replace('<0;1>', '<1;0>')), 'E_MULTIPATH'], [seal(body.replace('<0;1>', '0')), 'E_MULTIPATH'],
    [seal(body.replace('wpkh(', 'tr(')), 'E_UNSUPPORTED_SCRIPT'], [seal(`sh(${body})`), 'E_UNSUPPORTED_SCRIPT'],
    [seal(body.replace(/\[[^\]]+\]/, '')), 'E_GRAMMAR'], [seal(body.replace('/84h', '')), 'E_GRAMMAR'],
    [seal(body.replace('84h', '44h')), 'E_ORIGIN_PURPOSE'], [seal(body.replace('/0h/0h', '/1h/0h')), 'E_NETWORK_COINTYPE'],
    [seal(body.replace('/0h]', '/1h]')), 'E_CHILD_NUMBER'], [seal(body.replace(key, key.slice(0, -1) + '0')), 'E_KEY_BASE58'],
    [seal(replaceKey(b => { b[4] = 2; })), 'E_DEPTH'],
    [seal(replaceKey(b => { b.fill(255, 46); })), 'E_KEY_POINT'],
    [seal(replaceKey(b => { b[45] = 0; })), 'E_PRIVATE_KEY'],
    [seal(replaceKey(b => { new DataView(b.buffer).setUint32(0, 0x04b24746); })), 'E_SLIP132'],
    [seal(replaceKey(b => { new DataView(b.buffer).setUint32(0, 0x045f1cf6); })), 'E_SLIP132'],
  ])('rejects malformed or incompatible descriptors', (descriptor, error) => {
    try { parseWalletDescriptor(descriptor, main.chain); throw new Error('accepted'); }
    catch (e) { expect((e as Error).message).toBe(error); expect((e as Error).message).not.toContain(key); }
  });
  it('rejects unsupported charset', () => expect(() => descriptorChecksum('wpkh(☃)')).toThrow('E_CHARSET'));
  it('keeps key identity stable across h/apostrophe spellings', () => {
    expect(parseWalletDescriptor(seal(body.replaceAll('h/', "'/").replace('h]', "']")), main.chain).keyIdentity).toBe(parseWalletDescriptor(seal(body), main.chain).keyIdentity);
  });
  it('enforces vector coverage, HRP and identity', () => {
    const c = rawConfig(); c.wallets[0].vectors = c.wallets[0].vectors.filter((v: { chain: number }) => v.chain === 0);
    expect(() => validateConfig(c, 'mainnet', false)).toThrow('E_VECTOR_COVERAGE');
    c.wallets[0].vectors = c.wallets[1].vectors;
    expect(() => validateConfig(c, 'mainnet', false)).toThrow('E_VECTOR_MISMATCH');
  });
  it('supports a synthetic signet profile and rejects crossed mainnet/testnet keys', () => {
    // Test-only deterministic seed. These are not operational signet vectors or a production config.
    const chain = { ...main.chain, bech32_hrp: 'tb', bip44_coin_type: 1, bip32_versions: { public: '043587cf', private: '04358394' }, checkpoint: { height: 1, hash: '1'.repeat(64) } };
    const account = HDKey.fromMasterSeed(new Uint8Array(32).fill(7), { public: 0x043587cf, private: 0x04358394 }).derive("m/84'/1'/0'");
    const descriptor = seal(`wpkh([12345678/84h/1h/0h]${account.publicExtendedKey}/<0;1>/*)`);
    const parsed = parseWalletDescriptor(descriptor, chain);
    expect(deriveAddress(parsed, 0, 0, 'tb').address).toMatch(/^tb1q/);
    expect(() => parseWalletDescriptor(descriptor, main.chain)).toThrow('E_NETWORK_VERSION');
    expect(() => parseWalletDescriptor(main.wallets[0]!.descriptor, chain)).toThrow('E_NETWORK_VERSION');
    const c = rawConfig(); c.network = 'signet'; c.chain = chain; c.wallets = [{ ...c.wallets[0], descriptor,
      vectors: [0, 1].map(n => ({ chain: n, index: 0, address: deriveAddress(parsed, n as 0 | 1, 0, 'tb').address })), vector_source: 'synthetic-test-only' }];
    expect(() => validateConfig(c, 'signet', false)).not.toThrow();
  });
  it('rejects duplicate wallet key material and unsafe config timing', () => {
    const c = rawConfig(); c.wallets[1].descriptor = c.wallets[0].descriptor;
    expect(() => validateConfig(c, 'mainnet', false)).toThrow('E_DUPLICATE_KEY');
    const t = rawConfig(); t.collection.lease_ttl_s = 700;
    expect(() => validateConfig(t, 'mainnet', false)).toThrow('E_CONFIG_SCHEMA');
  });
});
