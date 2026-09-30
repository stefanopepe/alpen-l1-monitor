// BIP380 descriptor checksum: the 40-bit polymod MUST NOT use JS bitwise numbers.
const INPUT = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECK = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];
function polymod(c: bigint, value: number): bigint {
  const top = c >> 35n;
  c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(value);
  for (let i = 0; i < 5; i++) if ((top >> BigInt(i)) & 1n) c ^= GEN[i]!;
  return c;
}
export function descriptorChecksum(body: string): string {
  let c = 1n, cls = 0, count = 0;
  for (const ch of body) {
    const pos = INPUT.indexOf(ch);
    if (pos < 0) throw new Error('E_CHARSET');
    c = polymod(c, pos & 31); cls = cls * 3 + (pos >> 5);
    if (++count === 3) { c = polymod(c, cls); cls = 0; count = 0; }
  }
  if (count) c = polymod(c, cls);
  for (let i = 0; i < 8; i++) c = polymod(c, 0);
  c ^= 1n;
  return Array.from({ length: 8 }, (_, i) => CHECK[Number((c >> BigInt(5 * (7 - i))) & 31n)]).join('');
}
