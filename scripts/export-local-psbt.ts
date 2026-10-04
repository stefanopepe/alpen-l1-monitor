import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Transaction, TEST_NETWORK, NETWORK } from '@scure/btc-signer';
import { loadConfig } from '../src/config/load.js';
import { Budget, Esplora } from '../src/chain/esplora.js';
import { ProviderError } from '../src/chain/errors.js';
import { feeApiBaseUrl, observeQuote } from '../src/chain/fees.js';
import { buildConsolidation } from '../src/consolidation/transaction.js';
import { historyInventory, type ExportAddress } from '../src/consolidation/historyInventory.js';
import { txSchema } from '../src/chain/schemas.js';
import { canonical, digest, writeJson } from '../src/replay/archive.js';

// Explicit local draft export. No private key, database or broadcast code is used.
async function main() {
  if (process.argv.length !== 3) throw new Error('E_EXPORT_DIRECTORY_REQUIRED');
  const dir = resolve(process.argv[2]!);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const v = loadConfig(manifest.network, false);
  if (v.sha256 !== manifest.configSha256) throw new Error('E_EXPORT_CONFIG');
  const provider = v.config.providers.find(p => p.name === manifest.provider);
  if (!provider || !v.wallets.has(manifest.wallet)) throw new Error('E_EXPORT_IDENTITY');
  const addresses: ExportAddress[] = JSON.parse(readFileSync(join(dir, 'addresses.json'), 'utf8'));
  const transactions = readFileSync(join(dir, 'transactions.jsonl'), 'utf8').trim().split('\n').map(s => txSchema.parse(JSON.parse(s)));
  const outputs = readFileSync(join(dir, 'outputs.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s));
  const { utxos } = JSON.parse(readFileSync(join(dir, 'utxos.json'), 'utf8'));
  if (digest({ addresses, transactions, outputs, utxos }) !== manifest.dataDigest ||
    canonical(historyInventory(addresses, transactions, Number.MAX_SAFE_INTEGER).utxos) !== canonical(utxos)) throw new Error('E_EXPORT_DIGEST');
  const candidates = historyInventory(addresses, transactions, Number.MAX_SAFE_INTEGER).utxos.filter(u => u.valueSats > 0 && u.valueSats <= 546);
  const view = new Esplora({ ...provider, min_interval_ms: Math.max(500, provider.min_interval_ms) }, new Budget(Date.now() + 1800000, 30000, provider.name));
  if (await view.blockHashAt(v.config.chain.checkpoint.height) !== v.config.chain.checkpoint.hash) throw new Error('E_EXPORT_NETWORK');
  const tip = await view.tip(), available = [];
  for (const address of new Set(candidates.map(u => u.address))) {
    const inputs = candidates.filter(u => u.address === address);
    try {
      const live = await view.addressUtxos(address);
      for (const u of inputs) {
        const found = live.find(o => o.txid === u.txid && o.vout === u.vout);
        if (!found?.status.confirmed) continue;
        if (found.value !== u.valueSats) throw new Error('E_INPUT_VALUE');
        available.push(u);
      }
    } catch (e) {
      if (!(e instanceof ProviderError) || e.kind !== 'utxo_limit') throw e;
      // Recheck specific outpoints if this address cannot be listed by the provider.
      for (const u of inputs) {
        const status = await view.txStatus(u.txid), spend = await view.outspend(u.txid, u.vout);
        if (status.confirmed && !spend.spent) available.push(u);
      }
    }
  }
  if (await view.tipHash() !== tip.hash) throw new Error('E_EXPORT_TIP_MOVED');
  const fee = await observeQuote(undefined, undefined, feeApiBaseUrl(v.config));
  if (fee.status !== 'available' || !fee.rates) throw new Error('E_FEES');
  const rate = Math.ceil(Math.max(0.1, fee.rates.economyFee, fee.rates.minimumFee) * 10) / 10;
  if (!available.length) throw new Error('E_NO_OUTPUTS');
  // Balanced batches avoid a one-input tail when more than 1,000 inputs are eligible.
  const count = Math.ceil(available.length / 1000), batches = [];
  for (let batch = 0; batch < count; batch++) {
    const from = Math.floor(batch * available.length / count), to = Math.floor((batch + 1) * available.length / count);
    const quote = buildConsolidation(v, manifest.wallet, available.slice(from, to), rate);
    const tx = Transaction.fromPSBT(quote.psbt);
    if (tx.isFinal || tx.fee !== BigInt(quote.feeSats) || tx.outputsLength !== 1 ||
      tx.getOutputAddress(0, v.config.network === 'mainnet' ? NETWORK : TEST_NETWORK) !== quote.destination ||
      Array.from({ length: tx.inputsLength }, (_, n) => tx.getInput(n)).some(input => input.partialSig?.length || input.finalScriptWitness)) throw new Error('E_EXPORT_PSBT');
    const file: string = `${manifest.wallet}-${manifest.network}-unsigned-${batches.length + 1}.psbt`;
    writeFileSync(join(dir, file), quote.psbt, { mode: 0o600 });
    batches.push({ file, inputs: quote.outputCount, totalSats: quote.totalSats, feeSats: quote.feeSats, recoveredSats: quote.recoveredSats,
      feeRate: quote.feeRate, destination: quote.destination, estimatedVsize: quote.estimatedVsize, quoteId: quote.quoteId });
  }
  const result = { network: manifest.network, wallet: manifest.wallet, checkedAt: new Date().toISOString(), tip, provider: provider.name,
    sourceDigest: manifest.dataDigest, candidates: candidates.length, eligible: available.length, omittedSpentOrUnconfirmed: candidates.length - available.length, fee, batches,
    note: 'Unsigned drafts only. Review and recheck the inputs in Sparrow before signing or broadcasting.' };
  writeJson(join(dir, 'consolidation.json'), result);
  console.log(JSON.stringify(result));
}
main().catch(e => { console.error(e instanceof Error && /^E_[A-Z0-9_]+$/.test(e.message) ? e.message : 'E_EXPORT_FAILED'); process.exitCode = 1; });
