import type { ChainTx, EnvelopeEvidence } from '../chain/schemas.js';

// Enough for CodecSsz's four-byte length and checkpoint/sidecar header, or EE's
// six u64 fields. Keep the validated full length, never fabricate a raw witness.
const PREFIX_BYTES = 68;
export function firstEnvelopeEvidence(tx: ChainTx): EnvelopeEvidence | null {
  if (tx.vin[0]?.witness) {
    const payload = envelopePayloads(tx)?.[0];
    return payload ? { version: 1, payloadBytes: payload.length, prefixHex: payload.subarray(0, PREFIX_BYTES).toString('hex') } : null;
  }
  const cached = tx.envelopeEvidence;
  if (!cached || cached.version !== 1 || !Number.isSafeInteger(cached.payloadBytes) || cached.payloadBytes < 0 ||
    !/^(?:[0-9a-f]{2})*$/.test(cached.prefixHex) || cached.prefixHex.length !== Math.min(cached.payloadBytes, PREFIX_BYTES) * 2) return null;
  return cached;
}

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
