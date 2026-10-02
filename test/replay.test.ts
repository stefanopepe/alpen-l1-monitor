import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { replayFixture, reindexFixture } from './replay-fixture.js';
import { hash } from './helpers.js';
import { ArchiveIndex, AsOfChainView } from '../src/replay/asOfView.js';
import { replayAt, runReplay } from '../src/replay/run.js';
import { deriveOutcomes } from '../src/replay/outcomes.js';
import { evaluate, forecasts } from '../src/replay/evaluate.js';
import { validateArchive, writeJson, openArchive, ArchiveClient } from '../src/replay/archive.js';
import { buildReport } from '../src/replay/report.js';
const temp = mkdtempSync(join(tmpdir(), 'bridge-replay-test-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
it('validates complete archives and refuses missing transactions, coverage, or ancestry', () => {
  const { archive } = replayFixture();
  expect(() => validateArchive(archive)).not.toThrow();
  const broken = structuredClone(archive); delete broken.transactions[archive.addresses[0]!.txids[0]!];
  expect(() => validateArchive(broken)).toThrow();
  const missing = structuredClone(archive); missing.addresses[0]!.complete = false;
  expect(() => validateArchive(missing)).toThrow('E_ARCHIVE_COVERAGE');
  const omittedParent = structuredClone(archive);
  delete omittedParent.transactions[Object.values(omittedParent.transactions).find(t => t.status.block_height === 2)!.txid];
  reindexFixture(omittedParent);
  expect(() => validateArchive(omittedParent)).toThrow('E_ARCHIVE_MISSING_PARENT');
  const reorg = structuredClone(archive); reorg.blocks[10]!.previousblockhash = hash(999);
  expect(() => validateArchive(reorg)).toThrow('E_ARCHIVE_BLOCK_GAP');
});
it('restores outputs spent later and hides future reveals and transactions', async () => {
  const { archive } = replayFixture(), index = new ArchiveIndex(archive), address = archive.addresses[0]!;
  const commit = Object.values(archive.transactions).find(t => t.status.block_height === 40)!;
  const before = new AsOfChainView(index, 39), pending = new AsOfChainView(index, 40), complete = new AsOfChainView(index, 41);
  expect((await before.addressUtxos(address.address)).map(u => u.value)).toEqual([500000]);
  expect(await pending.outspend(commit.txid, 1)).toEqual({ spent: false });
  expect(await complete.outspend(commit.txid, 1)).toMatchObject({ spent: true });
  await expect(before.tx(commit.txid)).rejects.toMatchObject({ kind: 'not_found' });
  expect((await pending.addressUtxos(address.address)).some(u => u.value === 546)).toBe(false);
  expect((await complete.addressUtxos(address.address)).some(u => u.value === 546)).toBe(true);
});
it('cannot improve earlier predictions with future transactions, reveals, or address usage', async () => {
  const { archive, v } = replayFixture();
  for (const height of [120, 140, 141, 217, 400]) {
    const full = await replayAt(new ArchiveIndex(archive), v, height, 'ee'), prefix = structuredClone(archive);
    prefix.blocks = prefix.blocks.filter(b => b.height <= height); prefix.anchor = prefix.blocks.at(-1)!;
    prefix.transactions = Object.fromEntries(Object.entries(prefix.transactions).filter(([, t]) => t.status.block_height! <= height));
    reindexFixture(prefix);
    expect((await replayAt(new ArchiveIndex(prefix), v, height, 'ee')).record).toEqual(full.record);
    const changed = structuredClone(archive);
    for (const tx of Object.values(changed.transactions)) if (tx.status.block_height! > height) {
      tx.fee += 1000; tx.vout[0]!.value += 123; tx.status.block_time! += 100;
    }
    expect((await replayAt(new ArchiveIndex(changed), v, height, 'ee')).record).toEqual(full.record);
  }
});
it('supports same-block spends and monotonic clocks when header timestamps move backward', async () => {
  const { archive } = replayFixture();
  const reveal = Object.values(archive.transactions).find(t => t.status.block_height === 41)!;
  reveal.status = { confirmed: true, block_height: 40, block_hash: archive.blocks[40]!.id, block_time: archive.blocks[40]!.timestamp };
  archive.blocks[41]!.timestamp = archive.blocks[40]!.timestamp - 60;
  reindexFixture(archive);
  const index = new ArchiveIndex(archive);
  expect(index.clock(41)).toBe(index.clock(40));
  expect(await new AsOfChainView(index, 40).outspend(reveal.vin[0]!.txid, 1)).toMatchObject({ spent: true });
});
it('accounts for reveal fees and stranded outputs independently and censors unresolved packages', () => {
  const { archive } = replayFixture();
  const outcomes = deriveOutcomes(archive);
  expect(outcomes.filter(e => e.kind === 'settlement').every(e => e.drainSats === 1436)).toBe(true);
  const reveal = Object.values(archive.transactions).find(t => t.status.block_height === 41)!;
  delete archive.transactions[reveal.txid]; reindexFixture(archive);
  expect(deriveOutcomes(archive).find(e => e.height === 40 && e.wallet === 'ee')).toMatchObject({ kind: 'unresolved', drainSats: null });
});
it('is deterministic across sequential calls and backward seeks', async () => {
  const { archive, v } = replayFixture(), index = new ArchiveIndex(archive);
  const first = await replayAt(index, v, 160, 'ee');
  await replayAt(index, v, 200, 'ee'); await replayAt(index, v, 161, 'ee');
  expect(await replayAt(index, v, 160, 'ee')).toEqual(first);
});
it('computes mean baselines from known complete samples and exposes insufficient samples', async () => {
  const { archive, v } = replayFixture(), { record, training } = await replayAt(new ArchiveIndex(archive), v, 161, 'ee');
  const fs = forecasts(record.snapshot, training, Date.parse(record.snapshot.asOf) / 1000, v.config.estimator);
  const short = training.filter(s => s.complete && s.blockTime > Date.parse(record.snapshot.asOf) / 1000 - 7 * 86400);
  expect(fs.find(f => f.model === 'mean7')!.dailySats).toBe(short.length * 1436 / 7);
  expect(forecasts(record.snapshot, [], Date.parse(record.snapshot.asOf) / 1000, v.config.estimator)[1]!.dailySats).toBeNull();
  const pending = await replayAt(new ArchiveIndex(archive), v, 160, 'ee');
  expect(pending.record.forecasts[1]).toMatchObject({ dailySats: null, reason: 'incomplete_reveal_package' });
  expect(forecasts(record.snapshot, training, Date.parse(record.snapshot.asOf) / 1000,
    { ...v.config.estimator, short_window_days: 3 })[1]!.dailySats).toBe(short.length * 1436 / 7);
});
it('exposes unsafe optimism, intervened windows, and missing future coverage', async () => {
  const { archive, v } = replayFixture(), index = new ArchiveIndex(archive), events = deriveOutcomes(archive);
  const { record } = await replayAt(index, v, 160, 'ee');
  record.forecasts.forEach(f => { f.dailySats = 0; });
  record.snapshot.naiveRunway.days = 100000;
  const scored = evaluate([record], events, index.clock(500));
  expect(scored.scores.find(s => s.wallet === 'ee' && s.model === 'current' && s.horizonDays === 5 && s.subset === 'all' && s.sampling === 'daily')).toMatchObject({ underpredictionRate: 1 });
  expect(scored.exhaustion[0]).toMatchObject({ predictedDays: 100000, censored: true });
  const limited = evaluate([record], events, index.clock(161));
  expect(limited.evaluations.every(e => e.actualSats === null && e.reason === 'future_coverage_incomplete')).toBe(true);
  record.forecasts[0]!.dailySats = null;
  expect(evaluate([record], events, index.clock(161)).evaluations[0]).toMatchObject({ actualSats: null, outcomeReason: 'future_coverage_incomplete' });
  record.forecasts[0]!.dailySats = 0;
  const deposit = { wallet: 'ee', txid: hash(123), height: 162, time: index.clock(162), kind: 'deposit' as const, drainSats: null, reason: null, revealTxids: [] };
  const intervened = evaluate([record], [...events, deposit].sort((a,b) => a.height-b.height), index.clock(500));
  expect(intervened.evaluations.every(e => !e.clean)).toBe(true);
  expect(intervened.exhaustion[0]).toMatchObject({ censored: true, reason: 'deposit' });
  expect(intervened.evaluations[0]!.actualSats).toBe(scored.evaluations[0]!.actualSats);
});
it('writes reproducible results and a self-contained report without fetching', async () => {
  const { archive } = replayFixture();
  const a = await runReplay(archive, join(temp, 'a'), { from: '140', to: '180', step: 4 });
  await runReplay(archive, join(temp, 'b'), { from: '140', to: '180', step: 4 });
  for (const file of ['snapshots.jsonl', 'forecasts.jsonl', 'scores.json', 'outcomes.json', 'manifest.json']) {
    expect(readFileSync(join(temp, 'a', file), 'utf8')).toBe(readFileSync(join(temp, 'b', file), 'utf8'));
  }
  expect(a.records).toHaveLength(22);
  const html = readFileSync(buildReport(join(temp, 'a')), 'utf8');
  expect(html).toContain('Largest forecast errors'); expect(html).not.toMatch(/<script[^>]+src=/);
  await expect(runReplay(archive, join(temp, 'bad'), { from: '1', to: '10' })).rejects.toThrow('E_REPLAY_RANGE_OR_WARMUP');
});
it('rejects altered archives on load and never caches an authenticated request URL', async () => {
  const { archive, v } = replayFixture();
  const provider = { ...v.config.providers[0]!, min_interval_ms: 0,
    auth: { scheme: 'query' as const, parameter_name: 'token', secret_env: 'REPLAY_TEST_SECRET' } };
  vi.stubEnv('REPLAY_TEST_SECRET', 'private+replay-test/value');
  const client = new ArchiveClient(provider, join(temp, 'raw'), async url => {
    expect(new URL(String(url)).searchParams.get('token')).toBe('private+replay-test/value');
    return new Response(hash(1));
  });
  const { hashSchema } = await import('../src/chain/schemas.js');
  await client.get('/block-height/1', hashSchema, true);
  expect(Object.keys(client.responses)).toEqual(['/block-height/1']);
  const { z } = await import('zod');
  const leaking = new ArchiveClient(provider, join(temp, 'leaking'), async () => new Response('private+replay-test/value'));
  await expect(leaking.get('/test', z.string(), true)).rejects.toThrow('E_ARCHIVE_SECRET_IN_RESPONSE');
  vi.unstubAllEnvs();
  writeJson(join(temp, 'archive.json'), archive);
  archive.transactions[Object.keys(archive.transactions)[0]!]!.fee = 0;
  writeJson(join(temp, 'archive.json'), archive);
  expect(() => openArchive(temp)).toThrow('E_ARCHIVE_DIGEST');
});
it('waits for every reveal and charges delayed packages to the commit horizon', async () => {
  const { archive, v } = replayFixture();
  const commit = Object.values(archive.transactions).find(t => t.status.block_height === 450)!;
  const firstReveal = Object.values(archive.transactions).find(t => t.vin[0]!.txid === commit.txid)!;
  const funding = { ...commit.vout[1]!, scriptpubkey: '5120' + hash(998877) };
  commit.vout[2]!.value -= funding.value; commit.vout.push(funding);
  const reveal = structuredClone(firstReveal); reveal.txid = hash(998876);
  reveal.vin[0]!.vout = 3; reveal.vin[0]!.prevout = funding;
  reveal.status = { confirmed: true, block_height: 475, block_hash: archive.blocks[475]!.id, block_time: archive.blocks[475]!.timestamp };
  archive.transactions[reveal.txid] = reveal; reindexFixture(archive); validateArchive(archive);
  const index = new ArchiveIndex(archive);
  const before = await replayAt(index, v, 474, 'ee'), after = await replayAt(index, v, 475, 'ee');
  expect(before.training.find(s => s.txid === commit.txid)!.complete).toBe(false);
  expect(after.training.find(s => s.txid === commit.txid)).toMatchObject({ complete: true, drainSats: 2385 });
  const origin = await replayAt(index, v, 449, 'ee');
  const evaluated = evaluate([origin.record], deriveOutcomes(archive), index.clock(500));
  expect(evaluated.evaluations.find(e => e.model === 'current' && e.horizonDays === 1)!.actualSats).toBe(2385);
  archive.transactions[reveal.txid]!.fee = 0;
  expect(deriveOutcomes(archive).find(e => e.txid === commit.txid)!.reason).toBe('package_accounting_discrepancy');
});
it('discovers only addresses used by H and suppresses forecasts at a discovery ceiling', async () => {
  const { archive, v } = replayFixture();
  const a1 = archive.addresses.find(a => a.wallet === 'ee' && a.chain === 0 && a.index === 1)!;
  const a2 = archive.addresses.find(a => a.wallet === 'ee' && a.chain === 0 && a.index === 2)!;
  const deposit = structuredClone(Object.values(archive.transactions)[0]!);
  deposit.txid = hash(998800); deposit.vin[0]!.txid = hash(998801);
  deposit.status = { confirmed: true, block_height: 200, block_hash: archive.blocks[200]!.id, block_time: archive.blocks[200]!.timestamp };
  deposit.vout = [a1, a2].map(a => ({ scriptpubkey: a.script, scriptpubkey_address: a.address, scriptpubkey_type: 'v0_p2wpkh', value: 250000 }));
  archive.transactions[deposit.txid] = deposit; reindexFixture(archive); validateArchive(archive);
  const index = new ArchiveIndex(archive);
  expect((await new AsOfChainView(index, 199).addressStats(a1.address)).chain_stats.tx_count).toBe(0);
  expect((await replayAt(index, v, 199, 'ee')).record.snapshot.ceilingHit.receive).toBe(false);
  const at = (await replayAt(index, v, 200, 'ee')).record;
  expect(at.snapshot.ceilingHit.receive).toBe(true);
  expect(at.forecasts.every(f => f.dailySats === null && f.reason === 'discovery_incomplete')).toBe(true);
});
