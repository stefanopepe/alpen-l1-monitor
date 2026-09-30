import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { descriptorChecksum } from './checksum.js';
import type { ChainParams } from '../config/schema.js';
export interface ParsedWallet { account: HDKey; keyIdentity: string; materialIdentity: string; checksum: string }
const err = (code: string): never => { throw new Error(code); };
export function parseWalletDescriptor(desc: string, net: ChainParams): ParsedWallet {
  const split = desc.lastIndexOf('#');
  if (split < 0) return err('E_CHECKSUM_MISSING');
  const body = desc.slice(0, split), checksum = desc.slice(split + 1);
  if (!/^[a-z0-9]{8}$/.test(checksum)) return err('E_CHECKSUM_FORMAT');
  if (descriptorChecksum(body) !== checksum) return err('E_CHECKSUM_MISMATCH');
  if (!body.startsWith('wpkh(')) return err('E_UNSUPPORTED_SCRIPT');
  if (/\dH/.test(body.slice(0, body.indexOf(']') + 1))) return err('E_HARDENED_MARKER');
  if (/\*[h']/.test(body)) return err('E_HARDENED_WILDCARD');
  if (!body.endsWith('/<0;1>/*)')) return err('E_MULTIPATH');
  const m = /^wpkh\(\[([0-9a-fA-F]{8})\/(\d+)[h']\/(\d+)[h']\/(\d+)[h']\]([A-Za-z0-9]+)\/<0;1>\/\*\)$/.exec(body);
  if (!m) return err('E_GRAMMAR');
  const fpr = m[1]!, purpose = m[2]!, coin = m[3]!, acct = m[4]!, key = m[5]!;
  let bytes: Uint8Array;
  try { bytes = base58check(sha256).decode(key); } catch { return err('E_KEY_BASE58'); }
  if (bytes.length !== 78) return err('E_KEY_LENGTH');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), version = view.getUint32(0);
  if (bytes[45] === 0 || version === Number.parseInt(net.bip32_versions.private, 16)) return err('E_PRIVATE_KEY');
  if ([0x04b24746, 0x045f1cf6, 0x049d7cb2, 0x044a5262].includes(version)) return err('E_SLIP132');
  if (version !== Number.parseInt(net.bip32_versions.public, 16)) return err('E_NETWORK_VERSION');
  if (Number(purpose) !== 84) return err('E_ORIGIN_PURPOSE');
  if (Number(coin) !== net.bip44_coin_type) return err('E_NETWORK_COINTYPE');
  if (bytes[4] !== 3) return err('E_DEPTH');
  if (Number(acct) > 0x7fffffff || view.getUint32(9) !== 0x80000000 + Number(acct)) return err('E_CHILD_NUMBER');
  let account: HDKey;
  try { account = HDKey.fromExtendedKey(key, { public: version, private: Number.parseInt(net.bip32_versions.private, 16) }); }
  catch { return err('E_KEY_POINT'); }
  const materialIdentity = bytesToHex(sha256(bytes.slice(13)));
  const identity = `${fpr.toLowerCase()}/84h/${Number(coin)}h/${Number(acct)}h/${materialIdentity}/wpkh`;
  return { account, checksum, materialIdentity, keyIdentity: bytesToHex(sha256(new TextEncoder().encode(identity))) };
}
