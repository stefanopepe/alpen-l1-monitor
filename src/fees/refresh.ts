import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { captureFeeHistory } from './archive.js';
import { feeArchiveSchema, feeModelConfigSchema } from './schema.js';
import { readResearchPressure } from '../read/research.js';
import { runFeeStudy } from './study.js';
import { digest } from '../replay/archive.js';

export async function refreshFeeResearch(pool: Pool, now = new Date()) {
  const stamp = await pool.query('SELECT network FROM network_stamp');
  if (stamp.rows.length !== 1 || stamp.rows[0].network !== 'mainnet') throw new Error('E_RESEARCH_NETWORK');
  const holder = randomUUID();
  const lock = await pool.query(`INSERT INTO fee_research(network,holder,expires_at,last_attempt_at)
    VALUES('mainnet',$1,now()+interval '13 minutes',now()) ON CONFLICT(network) DO UPDATE
    SET holder=$1,expires_at=now()+interval '13 minutes',last_attempt_at=now()
    WHERE fee_research.expires_at<now() RETURNING archive,study->'timeline' AS timeline`, [holder]);
  if (!lock.rowCount) return { status: 'skipped_lease_held' };
  try {
    await pool.query(`INSERT INTO time_machine_samples(network,wallet,day,snapshot)
      SELECT network,wallet,day,snapshot FROM daily_samples WHERE network='mainnet'
      ON CONFLICT DO NOTHING`);
    const seed: unknown = lock.rows[0].archive ?? JSON.parse(readFileSync('config/fee-history-seed.json', 'utf8'));
    const prior = feeArchiveSchema.parse(seed), { digest: expected, ...body } = prior;
    if (digest(body) !== expected) throw new Error('E_RESEARCH_ARCHIVE_DIGEST');
    const { archive } = await captureFeeHistory(prior);
    const pressure = await readResearchPressure(pool, now);
    const provenance = JSON.parse(readFileSync('config/research-provenance.json', 'utf8')) as { sourceSha256: string };
    const asOf = Math.ceil(Date.now() / 1000);
    const study = runFeeStudy(archive, pressure, feeModelConfigSchema.parse({}), asOf, undefined, undefined, provenance.sourceSha256);
    if (study.coverage.end < asOf - 3 * 3600 || !study.forecasts.some(f => f.model === 'seasonal' && !f.reason)) throw new Error('E_RESEARCH_HISTORY_STALE');
    // Preserve earlier daily forecasts; only the latest hourly origin is served.
    const previous = lock.rows[0].timeline as typeof study.timeline;
    study.timeline = [...new Map([...(study.timeline ?? []), ...(previous ?? []).filter(t => t.origin % 86400 === 0 && t.origin >= asOf - 180 * 86400)]
      .map(t => [t.origin, t])).values()].sort((a, b) => a.origin - b.origin);
    const saved = await pool.query(`UPDATE fee_research SET archive=$2,study=$3,updated_at=now(),last_error=NULL,
      holder=NULL,expires_at='-infinity' WHERE network='mainnet' AND holder=$1 AND expires_at>now() RETURNING updated_at`,
    [holder, JSON.stringify(archive), JSON.stringify(study)]);
    if (!saved.rowCount) throw new Error('E_RESEARCH_LEASE_LOST');
    return { status: 'ok', asOf: new Date(asOf * 1000).toISOString(), historyThrough: new Date(study.coverage.end * 1000).toISOString(), buckets: archive.buckets.length };
  } catch {
    await pool.query(`UPDATE fee_research SET holder=NULL,expires_at='-infinity',last_error='refresh_failed'
      WHERE network='mainnet' AND holder=$1`, [holder]);
    throw new Error('E_RESEARCH_REFRESH');
  }
}
