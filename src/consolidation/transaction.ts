import { createHash } from 'node:crypto';
import { Transaction } from '@scure/btc-signer';
import { hex } from '@scure/base';
import { deriveAddress } from '../derive/address.js';
import type { ValidatedConfig } from '../config/load.js';
import type { Utxo } from '../types.js';

export function validFeeRate(value: number): boolean {
  return Number.isFinite(value) && value >= 0.1 && value <= 10000 && Math.abs(value * 10 - Math.round(value * 10)) < 1e-8;
}
export function buildConsolidation(v: ValidatedConfig, walletId: string, utxos: readonly Utxo[], feeRate: number) {
  const wallet = v.wallets.get(walletId), config = v.config.wallets.find(w => w.id === walletId);
  if (!wallet || !config) throw new Error('E_WALLET');
  if (!validFeeRate(feeRate)) throw new Error('E_FEE_RATE');
  const rateTenths = Math.round(feeRate * 10);
  feeRate = rateTenths / 10;
  if (!utxos.length) throw new Error('E_NO_OUTPUTS');
  if (utxos.length > 1000) throw new Error('E_TOO_MANY_OUTPUTS');
  const origin = /\[([0-9a-fA-F]{8})\/84[h']\/(\d+)[h']\/(\d+)[h']\]/.exec(config.descriptor);
  if (!origin) throw new Error('E_ORIGIN');
  const fingerprint = Number.parseInt(origin[1]!, 16);
  const originPath = [0x80000054, 0x80000000 + Number(origin[2]), 0x80000000 + Number(origin[3])];
  const derivation = (chain: 0 | 1, index: number): [Uint8Array, { fingerprint: number; path: number[] }][] => [
    [wallet.account.deriveChild(chain).deriveChild(index).publicKey!, { fingerprint, path: [...originPath, chain, index] }],
  ];
  const tx = new Transaction({ version: 2, lockTime: 0 });
  const seen = new Set<string>();
  let totalSats = 0;
  for (const u of [...utxos].sort((a, b) => a.txid.localeCompare(b.txid) || a.vout - b.vout)) {
    const key = `${u.txid}:${u.vout}`;
    if (seen.has(key) || !u.confirmed || u.scriptType !== 'p2wpkh' || !Number.isSafeInteger(u.valueSats) || u.valueSats <= 0 || u.valueSats > 546) throw new Error('E_INPUT');
    seen.add(key);
    const derived = deriveAddress(wallet, u.chain, u.index, v.config.chain.bech32_hrp);
    if (derived.address !== u.address) throw new Error('E_INPUT_OWNERSHIP');
    totalSats += u.valueSats;
    tx.addInput({ txid: u.txid, index: u.vout, sequence: 0xfffffffd,
      witnessUtxo: { script: hex.decode(derived.script), amount: BigInt(u.valueSats) }, bip32Derivation: derivation(u.chain, u.index) });
  }
  // Return to the wallet's known BIP84 change chain. No external destination is accepted.
  const destination = deriveAddress(wallet, 1, 0, v.config.chain.bech32_hrp);
  // Maximum P2WPKH signature witness (109 bytes), marker/flag, CompactSize and one output.
  const inputCountBytes = utxos.length < 253 ? 1 : 3;
  const baseBytes = 4 + inputCountBytes + utxos.length * 41 + 1 + 31 + 4;
  const estimatedVsize = Math.ceil((baseBytes * 4 + 2 + utxos.length * 109) / 4);
  // Multiply integer tenths first so floating-point noise cannot add a satoshi.
  const feeSats = Math.ceil(estimatedVsize * rateTenths / 10), recoveredSats = totalSats - feeSats;
  if (recoveredSats <= 546) throw new Error('E_UNECONOMIC');
  tx.addOutput({ script: hex.decode(destination.script), amount: BigInt(recoveredSats), bip32Derivation: derivation(1, 0) });
  const psbt = tx.toPSBT(0);
  const quoteId = createHash('sha256').update(psbt).update(String(feeRate)).digest('hex');
  return { psbt, quoteId, outputCount: utxos.length, totalSats, feeSats, recoveredSats, feeRate, estimatedVsize, destination: destination.address };
}
