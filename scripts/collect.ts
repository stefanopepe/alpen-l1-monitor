import { runCollect } from '../src/pipeline/collectRun.js';
import { safeError } from '../src/chain/errors.js';
import { database } from '../src/db/pool.js';
try { const r = await runCollect(process.argv.includes('--force')); console.log(JSON.stringify(r)); if (r.wallets.some(w => w.status === 'failed')) process.exitCode = 1; }
catch (e) { console.error(safeError(e)); process.exitCode = 1; }
finally { if (process.env.DATABASE_URL) await database('write').end(); }
