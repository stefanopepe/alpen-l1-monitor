import { expect, it, vi } from 'vitest';
import { observeFees } from '../src/chain/fees.js';
import { decodeRunResults } from '../src/read/observations.js';
const now = () => new Date('2026-10-01T00:00:00.000Z');
it('captures a bounded free fee quote without authentication and uses observation time', async () => {
  const fetcher = vi.fn(async () => Response.json({ fastestFee: 1, halfHourFee: 0.8, hourFee: 0.6, economyFee: 0.3, minimumFee: 0.1 }));
  const quote = await observeFees(fetcher, now);
  expect(quote).toMatchObject({ status: 'available', observedAt: now().toISOString(), rates: { fastestFee: 1 } });
  expect(fetcher.mock.calls[0]).toBeDefined();
});
it.each([429, 500])('turns upstream %s into an unavailable quote without blocking collection', async code => {
  expect(await observeFees(async () => new Response('credential-like upstream body', { status: code }), now)).toMatchObject({ status: 'unavailable', rates: null });
});
it('redacts exceptions and rejects malformed fee observations', async () => {
  expect(await observeFees(async () => { throw new Error('https://private?token=secret'); }, now)).toMatchObject({ error: 'E_FEE_UNAVAILABLE' });
  expect(await observeFees(async () => Response.json({ fastestFee: -1 }), now)).toMatchObject({ error: 'E_FEE_SCHEMA', rates: null });
});
it('exports legacy runs without inventing historical fee quotes', () => {
  expect(decodeRunResults([{ wallet: 'ee', status: 'ok' }])).toMatchObject({ legacy: true, feeContext: null });
  expect(() => decodeRunResults({ schemaVersion: 99 })).toThrow('E_OBSERVATIONS_SCHEMA');
});
