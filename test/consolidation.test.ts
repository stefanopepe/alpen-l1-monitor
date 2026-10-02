import { afterEach, expect, it, vi } from 'vitest';
import { Transaction, TEST_NETWORK } from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { createHash } from 'node:crypto';
import { demoData } from '../src/consolidation/demo.js';
import { buildConsolidation } from '../src/consolidation/transaction.js';
import { candidateInputs, verifyInputs } from '../src/consolidation/service.js';
import { fakeView, status } from './helpers.js';
import handler from '../api/consolidation.js';
import statusHandler from '../api/status.js';
import collectHandler from '../api/collect.js';
import refreshHandler from '../api/refresh.js';

afterEach(() => vi.unstubAllEnvs());
it('exports an unsigned PSBT with all dust inputs, one wallet output and correct signing paths', () => {
  const d = demoData(), wallet = d.wallets[0]!;
  const quote = buildConsolidation(d.config, wallet.wallet, wallet.utxos, 1.2);
  const tx = Transaction.fromPSBT(quote.psbt);
  expect(tx.isFinal).toBe(false);
  expect(tx.inputsLength).toBe(44);
  expect(tx.outputsLength).toBe(1);
  expect(tx.fee).toBe(BigInt(quote.feeSats));
  expect(tx.getOutput(0).amount).toBe(BigInt(24024 - quote.feeSats));
  expect(tx.getOutputAddress(0, TEST_NETWORK)).toBe(quote.destination);
  for (let i = 0; i < tx.inputsLength; i++) {
    expect(tx.getInput(i).partialSig).toBeUndefined();
    expect(tx.getInput(i).sequence).toBe(0xfffffffd);
    expect(tx.getInput(i).witnessUtxo?.amount).toBe(546n);
  }
  // Prove wallet import/signing can use the exported BIP32 paths, without real keys or funds.
  const root = HDKey.fromMasterSeed(createHash('sha256').update('consolidation-staging-demo-ee').digest(), { public: 0x043587cf, private: 0x04358394 });
  for (let i = 0; i < tx.inputsLength; i++) {
    const path = tx.getInput(i).bip32Derivation![0]![1];
    expect(path.fingerprint).toBe(root.fingerprint);
    const key = path.path.reduce((key, index) => key.deriveChild(index), root);
    expect(tx.signIdx(key.privateKey!, i)).toBe(true);
  }
  tx.finalize();
  expect(tx.isFinal).toBe(true);
  expect(tx.vsize).toBeLessThanOrEqual(quote.estimatedVsize);
  expect(Number(tx.fee) / tx.vsize).toBeGreaterThanOrEqual(1.2);
  expect(tx.getOutput(0).bip32Derivation?.[0]?.[1].path).toEqual([0x80000054, 0x80000001, 0x80000000, 1, 0]);
});
it('does not sweep working capital, unconfirmed inputs, foreign addresses or duplicate inputs', () => {
  const d = demoData(), wallet = d.wallets[0]!, u = wallet.utxos[0]!;
  for (const change of [{ valueSats: 547 }, { confirmed: false }, { address: d.wallets[1]!.utxos[0]!.address }, { scriptType: 'p2tr' as const }]) {
    expect(() => buildConsolidation(d.config, wallet.wallet, [{ ...u, ...change }], 1)).toThrow();
  }
  expect(() => buildConsolidation(d.config, wallet.wallet, [u, u], 1)).toThrow('E_INPUT');
  expect(() => buildConsolidation(d.config, wallet.wallet, wallet.utxos, 10)).toThrow('E_UNECONOMIC');
  expect(() => buildConsolidation(d.config, wallet.wallet, wallet.utxos, NaN)).toThrow('E_FEE_RATE');
  expect(candidateInputs(d.config, { ...wallet, utxos: [...wallet.utxos, { ...u, valueSats: 100000 }, { ...u, confirmed: false }] })).toHaveLength(44);
});
it('accounts for the CompactSize boundary when a batch exceeds 252 inputs', () => {
  const d = demoData(), wallet = d.wallets[0]!;
  const inputs = Array.from({ length: 253 }, (_, i) => ({ ...wallet.utxos[0]!, txid: i.toString(16).padStart(64, '0') }));
  const q = buildConsolidation(d.config, wallet.wallet, inputs, 1);
  expect(q.estimatedVsize).toBe(Math.ceil(((4 + 3 + 253 * 41 + 1 + 31 + 4) * 4 + 2 + 253 * 109) / 4));
});
it('rechecks unspent outputs and rejects changed values instead of trusting a saved snapshot', async () => {
  const d = demoData(), inputs = d.wallets[0]!.utxos.slice(0, 3);
  const view = fakeView({ addressUtxos: async () => [
    { txid: inputs[0]!.txid, vout: 0, value: 546, status: status() },
    { txid: inputs[1]!.txid, vout: 0, value: 546, status: { confirmed: false } },
  ] });
  expect(await verifyInputs(view, inputs)).toEqual([inputs[0]]);
  view.addressUtxos = async () => [{ txid: inputs[0]!.txid, vout: 0, value: 500, status: status() }];
  await expect(verifyInputs(view, inputs)).rejects.toThrow('E_INPUT_VALUE');
});
it('preview downloads contain sample PSBTs, require the displayed quote and never enable collection', async () => {
  vi.stubEnv('STAGING_PREVIEW', 'demo'); vi.stubEnv('NETWORK', 'mainnet');
  const request = (query = '', method = 'GET') => new Request('https://test/api/consolidation?wallet=ee' + query, { method });
  const quote = await (await handler.fetch(request())).json();
  expect(quote.sample).toBe(true); expect(quote.feeRate).toBe(1); expect(quote.psbt).toBeUndefined();
  const response = await handler.fetch(request('&format=psbt&quote=' + quote.quoteId));
  expect(response.status).toBe(200);
  expect(response.headers.get('content-disposition')).toContain('sample-consolidation.psbt');
  expect(Transaction.fromPSBT(new Uint8Array(await response.arrayBuffer())).inputsLength).toBe(44);
  expect((await handler.fetch(request('&format=psbt'))).status).toBe(400);
  expect((await handler.fetch(request('&format=psbt&quote=' + '0'.repeat(64)))).status).toBe(409);
  expect((await handler.fetch(request('', 'POST'))).status).toBe(405);
  expect((await statusHandler.fetch(new Request('https://test/api/status'))).status).toBe(200);
  expect((await collectHandler.fetch(new Request('https://test/api/collect'))).status).toBe(403);
  expect((await refreshHandler.fetch(new Request('https://test/api/refresh', { method: 'POST' }))).status).toBe(403);
});
it('uses the selected 0.1-step fee in both the quote and downloaded PSBT', async () => {
  vi.stubEnv('STAGING_PREVIEW', 'demo'); vi.stubEnv('NETWORK', 'mainnet');
  const request = (query: string) => new Request('https://test/api/consolidation?wallet=ee&' + query);
  let previous: string | undefined;
  for (const rate of [0.1, 0.9, 1, 1.1, 1.2]) {
    const response = await handler.fetch(request('feeRate=' + rate));
    expect(response.status).toBe(200);
    const quote = await response.json();
    expect(quote.feeRate).toBe(rate);
    expect(quote.feeSats).toBe(Math.ceil(quote.estimatedVsize * Math.round(rate * 10) / 10));
    expect(quote.recoveredSats).toBe(quote.totalSats - quote.feeSats);
    const download = await handler.fetch(request(`feeRate=${rate}&format=psbt&quote=${quote.quoteId}`));
    expect(download.status).toBe(200);
    const tx = Transaction.fromPSBT(new Uint8Array(await download.arrayBuffer()));
    expect(tx.fee).toBe(BigInt(quote.feeSats));
    expect(tx.getOutput(0).amount).toBe(BigInt(quote.recoveredSats));
    if (previous) expect((await handler.fetch(request(`feeRate=${rate}&format=psbt&quote=${previous}`))).status).toBe(409);
    previous = quote.quoteId;
  }
  for (const rate of ['0', '-0.1', '0.01', '1.15', 'NaN', 'Infinity', '', '10000.1', '1&feeRate=2']) {
    expect((await handler.fetch(request('feeRate=' + rate))).status).toBe(400);
  }
  expect((await handler.fetch(request('feeRate=10'))).status).toBe(422);
});
