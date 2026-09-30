import { loadConfig, validateAllConfigs } from '../src/config/load.js';
import { safeError } from '../src/chain/errors.js';
try {
  validateAllConfigs();
  if (process.env.VERCEL && !process.env.NETWORK) throw new Error('E_NETWORK_REQUIRED');
  if (process.env.NETWORK) loadConfig(process.env.NETWORK, false);
  console.log('Configuration checks passed; all supplied address vectors match.');
} catch (e) { console.error(safeError(e)); process.exitCode = 1; }
