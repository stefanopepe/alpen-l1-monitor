import { bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ParsedWallet } from '../descriptor/parse.js';
export function deriveAddress(wallet: ParsedWallet, chain: 0 | 1, index: number, hrp: string) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= 0x80000000) throw new Error('E_DERIVE_INDEX');
  const pub = wallet.account.deriveChild(chain).deriveChild(index).publicKey;
  if (!pub) throw new Error('E_PRIVATE_KEY');
  const hash = ripemd160(sha256(pub));
  return { address: bech32.encode(hrp, [0, ...bech32.toWords(hash)]), script: `0014${bytesToHex(hash)}` };
}
