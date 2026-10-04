import type { ChainTx } from '../chain/schemas.js';

export const hexBytes = (hex: string): Buffer => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('E_EPOCH_HEX');
  return Buffer.from(hex, 'hex');
};
// Read actual Bitcoin push instructions, including chunk boundaries inside a field.
export function push(script: Buffer, cursor: { at: number }): Buffer {
  const op = script[cursor.at++];
  if (op === undefined || op > 0x4e) throw new Error('E_EPOCH_PUSH');
  let size = op;
  if (op >= 0x4c) {
    const width = 1 << (op - 0x4c);
    size = script.readUIntLE(cursor.at, width); cursor.at += width;
  }
  if (size > 520 || cursor.at + size > script.length) throw new Error('E_EPOCH_PUSH');
  const bytes = script.subarray(cursor.at, cursor.at + size); cursor.at += size;
  return bytes;
}
export function envelopePayloads(tx: ChainTx): Buffer[] | null {
  try {
    const witness = tx.vin[0]?.witness?.map(hexBytes);
    if (!witness) return null;
    if (witness.at(-1)?.[0] === 0x50) witness.pop(); // BIP341 annex
    const control = witness.at(-1);
    if (witness.length !== 3 || !control || (control[0]! & 0xfe) !== 0xc0 ||
      control.length < 33 || control.length > 4129 || (control.length - 33) % 32 !== 0) return null;
    const script = witness[1]!, cursor = { at: 0 };
    if (push(script, cursor).length !== 32 || script[cursor.at++] !== 0xac) return null;
    const payloads: Buffer[] = [];
    while (cursor.at < script.length) {
      if (push(script, cursor).length !== 0 || script[cursor.at++] !== 0x63) return null;
      const chunks: Buffer[] = [];
      while (cursor.at < script.length && script[cursor.at] !== 0x68) chunks.push(push(script, cursor));
      if (script[cursor.at++] !== 0x68) return null;
      payloads.push(Buffer.concat(chunks));
    }
    return payloads;
  } catch { return null; }
}
