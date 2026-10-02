import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { validateConfig } from '../src/config/load.js';
import { ArchiveIndex } from '../src/replay/asOfView.js';
import { fetchArchive, openArchive, writeJson, type ChainArchive } from '../src/replay/archive.js';
import { deriveOutcomes } from '../src/replay/outcomes.js';
import { replayAt } from '../src/replay/run.js';
import { hash } from './helpers.js';
import { reindexFixture, replayFixture } from './replay-fixture.js';

const temp = mkdtempSync(join(tmpdir(), 'bridge-refresh-test-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function fixture() {
  const { archive: remote } = replayFixture();
  remote.config.providers[0]!.min_interval_ms = 1;
  const v = validateConfig(remote.config, remote.network, false);
  remote.configSha256 = v.sha256; remote.provider = v.config.providers[0]!.name;
  const address = remote.addresses.find(a => a.wallet === 'ee' && a.chain === 0 && a.index === 1)!;
  const deposit = structuredClone(Object.values(remote.transactions)[0]!);
  deposit.txid = hash(900000); deposit.vin[0]!.txid = hash(900001); deposit.vin[0]!.prevout!.value = 311000;
  deposit.vout = [{ scriptpubkey: address.script, scriptpubkey_address: address.address, scriptpubkey_type: 'v0_p2wpkh', value: 310000 }];
  deposit.status = { confirmed: true, block_height: 451, block_hash: remote.blocks[451]!.id, block_time: remote.blocks[451]!.timestamp };
  remote.transactions[deposit.txid] = deposit; reindexFixture(remote);
  const previous = structuredClone(remote);
  previous.blocks = previous.blocks.slice(0, 451); previous.anchor = previous.blocks.at(-1)!;
  previous.transactions = Object.fromEntries(Object.entries(previous.transactions).filter(([, tx]) => tx.status.block_height! <= 450));
  reindexFixture(previous);
  return { previous, remote, v, deposit };
}

function provider(remote: ChainArchive, intercept?: (path: string) => Response | undefined) {
  const requests: string[] = [];
  const fetcher: typeof fetch = async input => {
    const path = new URL(String(input)).pathname.replace(/^\/api/, ''); requests.push(path);
    const intercepted = intercept?.(path); if (intercepted) return intercepted;
    const json = (value: unknown) => Response.json(value);
    if (path === '/blocks/tip/hash') return new Response(remote.anchor.id);
    if (path.startsWith('/block-height/')) return new Response(remote.blocks[Number(path.split('/').at(-1))]!.id);
    if (path.startsWith('/block/')) return json(remote.blocks.find(b => b.id === path.split('/').at(-1)));
    if (path.startsWith('/blocks/')) {
      const end = Number(path.split('/').at(-1)); return json(remote.blocks.slice(Math.max(0, end - 9), end + 1).reverse());
    }
    if (path.startsWith('/address/')) {
      const parts = path.split('/'), a = remote.addresses.find(a => a.address === parts[2])!;
      const txs = a.txids.map(id => remote.transactions[id]!).sort((a,b) => b.status.block_height! - a.status.block_height! || a.txid.localeCompare(b.txid));
      if (parts.length === 3) return json({ chain_stats: { tx_count: txs.length }, mempool_stats: { tx_count: 0 } });
      const offset = parts[5] ? txs.findIndex(t => t.txid === parts[5]) + 1 : 0;
      return json(txs.slice(offset, offset + 25));
    }
    throw new Error('Unexpected archive request: ' + path);
  };
  return { fetcher, requests };
}

it('extends a sealed archive with new funding on either descriptor chain and preserves historical predictions', async () => {
  const { previous, remote, v, deposit } = fixture(), dir = join(temp, 'funding');
  // A second deposit exercises the change descriptor independently of receive discovery.
  const change = remote.addresses.find(a => a.wallet === 'ol' && a.chain === 1 && a.index === 0)!;
  const second = structuredClone(deposit); second.txid = hash(900002); second.vin[0]!.txid = hash(900003);
  second.vout[0] = { ...second.vout[0]!, scriptpubkey: change.script, scriptpubkey_address: change.address };
  remote.transactions[second.txid] = second; reindexFixture(remote);
  mkdirSync(dir);
  writeJson(join(dir, 'archive.json'), previous);
  const before = await replayAt(new ArchiveIndex(previous), v, 450, 'ee');
  const api = provider(remote), updated = await fetchArchive(v, dir, { fetcher: api.fetcher });
  expect(updated.anchor.height).toBe(494);
  expect(openArchive(dir).digest).toBe(updated.digest);
  expect(openArchive(dir, updated.digest).digest).toBe(updated.digest);
  expect(openArchive(dir, previous.digest)).toEqual(previous);
  expect((await replayAt(new ArchiveIndex(updated), v, 450, 'ee')).record).toEqual(before.record);
  const after = await replayAt(new ArchiveIndex(updated), v, 451, 'ee');
  expect(after.record.snapshot.composition.spendableSats - before.record.snapshot.composition.spendableSats).toBe(310000);
  const oldOL = await replayAt(new ArchiveIndex(previous), v, 450, 'ol');
  const newOL = await replayAt(new ArchiveIndex(updated), v, 451, 'ol');
  expect(newOL.record.snapshot.composition.spendableSats - oldOL.record.snapshot.composition.spendableSats).toBe(310000);
  expect(deriveOutcomes(updated).find(e => e.txid === deposit.txid)).toMatchObject({ kind: 'deposit', fundingSats: 310000, drainSats: null });
  expect(api.requests.filter(p => /^\/blocks\/\d+$/.test(p)).every(p => Number(p.split('/').at(-1)) > previous.anchor.height)).toBe(true);
  // No new finalized block means an inexpensive check, not a complete re-download.
  const again = provider(remote);
  expect((await fetchArchive(v, dir, { fetcher: again.fetcher })).digest).toBe(updated.digest);
  expect(again.requests.some(p => p.startsWith('/address/'))).toBe(false);
});

it('keeps the old seal usable after an interrupted update and resumes the pinned new boundary', async () => {
  const { previous, remote, v } = fixture(), dir = join(temp, 'resume');
  mkdirSync(dir); writeJson(join(dir, 'archive.json'), previous);
  const broken = provider(remote, p => p.startsWith('/address/') ? new Response('', { status: 400 }) : undefined);
  await expect(fetchArchive(v, dir, { fetcher: broken.fetcher })).rejects.toThrow('E_ARCHIVE_HTTP');
  expect(openArchive(dir).digest).toBe(previous.digest);
  expect(JSON.parse(readFileSync(join(dir, 'capture.json'), 'utf8')).anchor.height).toBe(494);
  const resumed = provider(remote, p => p === '/blocks/tip/hash' ? new Response('', { status: 400 }) : undefined);
  expect((await fetchArchive(v, dir, { fetcher: resumed.fetcher })).anchor.height).toBe(494);
  expect(resumed.requests).not.toContain('/blocks/tip/hash');
});

it('rejects a changed finalized chain instead of silently combining old and new histories', async () => {
  const { previous, remote, v } = fixture(), dir = join(temp, 'reorg');
  mkdirSync(dir); writeJson(join(dir, 'archive.json'), previous);
  const api = provider(remote, p => p === '/block-height/450' ? new Response(hash(999999)) : undefined);
  await expect(fetchArchive(v, dir, { fetcher: api.fetcher })).rejects.toThrow('E_ARCHIVE_CHAIN_CHANGED');
  expect(openArchive(dir).digest).toBe(previous.digest);
});

it('rejects omission of previously sealed funding even when new address counts appear complete', async () => {
  const { previous, remote, v } = fixture(), dir = join(temp, 'omission');
  // A standalone deposit has no children, so only preservation of the prior seal catches its omission.
  const standalone = structuredClone(remote.transactions[hash(900000)]!);
  standalone.txid = hash(910000); standalone.vin[0]!.txid = hash(910001);
  standalone.status = { ...standalone.status, block_height: 449, block_hash: previous.blocks[449]!.id, block_time: previous.blocks[449]!.timestamp };
  previous.transactions[standalone.txid] = standalone; reindexFixture(previous);
  mkdirSync(dir); writeJson(join(dir, 'archive.json'), previous);
  await expect(fetchArchive(v, dir, { fetcher: provider(remote).fetcher })).rejects.toThrow('E_ARCHIVE_PREVIOUS_HISTORY_CHANGED');
  expect(openArchive(dir).digest).toBe(previous.digest);
});
