import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { txSchema } from '../src/chain/schemas.js';
import { loadConfig } from '../src/config/load.js';
import { compactHistory, emptyHistory, type HistoryState } from '../src/extract/history.js';
import { latestPostedEpoch } from '../src/extract/epoch.js';
import { latestEeDa } from '../src/extract/eeDa.js';

function fixture(file: string) {
  const f = JSON.parse(readFileSync(`test/fixtures/${file}.json`, 'utf8'));
  const commit = txSchema.parse(f.commit), reveal = txSchema.parse(f.reveals[0]);
  const state: HistoryState = { ...emptyHistory(), transactions: { [commit.txid]: commit, [reveal.txid]: reveal }, reveals: { [commit.txid]: [reveal] } };
  return { state, reveal, scripts: new Set<string>(f.wallet_scripts), tip: f.provenance.tip };
}

it.each(['mainnet/ol-epoch-v032', 'signet/ol-epoch-v032', 'mainnet/ee-settlement'])('preserves %s reports across repeated compact storage round trips', file => {
  const { state, reveal, scripts, tip } = fixture(file);
  const magic = file.startsWith('signet') ? loadConfig('signet', false).config.checkpoint_reporting!.magic_hex : '53545241';
  const report = (s: typeof state) => file.includes('/ee-') ? latestEeDa(s.transactions, scripts, tip, true) : latestPostedEpoch(s.transactions, scripts, tip, true, magic);
  const before = report(state);
  expect(before.latest).not.toBeNull();
  let saved = state;
  for (let i = 0; i < 2; i++) {
    saved = JSON.parse(JSON.stringify(compactHistory(saved)));
    expect(report(saved)).toEqual(before);
    expect(saved.transactions[reveal.txid]!.vin[0]!.witness).toBeUndefined();
    expect(saved.reveals[reveal.vin[0]!.txid]![0]!.envelopeEvidence).toEqual(saved.transactions[reveal.txid]!.envelopeEvidence);
    expect(saved.transactions[reveal.txid]!.envelopeEvidence!.prefixHex.length).toBeLessThanOrEqual(136);
  }
  // Cached evidence does not cross a replay boundary or a checkpoint namespace.
  expect(report({ ...saved, transactions: { ...saved.transactions, [reveal.txid]: { ...saved.transactions[reveal.txid]!, status: { confirmed: false } } } }).latest).toBeNull();
  if (file.startsWith('signet')) expect(latestPostedEpoch(saved.transactions, scripts, tip, true).latest).toBeNull();
  // Remote transaction validation strips local-only evidence supplied by a provider.
  expect(txSchema.parse(saved.transactions[reveal.txid])).not.toHaveProperty('envelopeEvidence');
});

it('does not use old cached evidence when fresh witness bytes are malformed', () => {
  const { state, reveal, scripts, tip } = fixture('mainnet/ol-epoch-v032');
  const saved = compactHistory(state), tx = saved.transactions[reveal.txid]!;
  tx.vin[0]!.witness = ['00', '00', '00'];
  expect(latestPostedEpoch(saved.transactions, scripts, tip, true)).toMatchObject({ latest: null, undecodedCheckpoints: 1 });
  expect(compactHistory(saved).transactions[reveal.txid]!.envelopeEvidence).toBeUndefined();
});

it('keeps legacy compacted history without posting evidence explicitly undecodable', () => {
  const { state, reveal, scripts, tip } = fixture('mainnet/ee-settlement');
  const saved = compactHistory(state); delete saved.transactions[reveal.txid]!.envelopeEvidence;
  expect(latestEeDa(saved.transactions, scripts, tip, true)).toMatchObject({ latest: null, undecodedPublications: 1 });
});
