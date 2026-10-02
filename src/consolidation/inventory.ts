import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { database } from '../db/pool.js';
import { snapshotSchema, type ReadModel } from '../read/model.js';

const uint = z.number().int().nonnegative().safe();
export const inventorySchema = z.object({
  wallet: z.string(), name: z.string(), snapshot: snapshotSchema,
  utxos: z.array(z.object({
    txid: z.string().regex(/^[0-9a-f]{64}$/), vout: uint.max(0xffffffff), valueSats: uint,
    confirmed: z.boolean(), blockHeight: uint.nullable(), address: z.string(),
    chain: z.union([z.literal(0), z.literal(1)]), index: uint.max(0x7fffffff),
    scriptType: z.enum(['p2wpkh', 'p2tr', 'other']),
  })),
});
const stagingSchema = z.object({ network: z.string(), capturedAt: z.iso.datetime(), wallets: z.array(inventorySchema) });
export type Inventory = z.infer<typeof inventorySchema>;
export function stagingInventory(network: string) {
  const data = stagingSchema.parse(JSON.parse(readFileSync('config/staging-snapshot.json', 'utf8')));
  if (data.network !== network || data.wallets.some(w => w.snapshot.network !== network || w.wallet !== w.snapshot.wallet)) throw new Error('E_STAGING_NETWORK');
  return data;
}
export function stagingStatus(network: string, now: Date): ReadModel {
  const data = stagingInventory(network);
  return { network, readAt: now.toISOString(), preview: { capturedAt: data.capturedAt }, primaryIsPublic: false, providerErrors: [],
    wallets: data.wallets.map(w => ({ wallet: w.wallet, name: w.name, snapshot: w.snapshot,
      ageSeconds: Math.max(0, (now.getTime() - Date.parse(w.snapshot.asOf)) / 1000), stale: now.getTime() - Date.parse(w.snapshot.asOf) > 3300000 })) };
}
export async function readInventory(network: string, wallet: string): Promise<Inventory> {
  if (process.env.STAGING_PREVIEW === '1') {
    const inventory = stagingInventory(network).wallets.find(w => w.wallet === wallet);
    if (!inventory) throw new Error('E_WALLET');
    return inventory;
  }
  const result = await database('read').query(`SELECT w.wallet,w.display_name AS name,s.latest_snapshot AS snapshot,s.utxos
    FROM wallets w JOIN wallet_state s USING(network,wallet) WHERE w.network=$1 AND w.wallet=$2`, [network, wallet]);
  if (result.rowCount !== 1) throw new Error('E_INVENTORY');
  const inventory = inventorySchema.parse(result.rows[0]);
  if (inventory.snapshot.network !== network || inventory.snapshot.wallet !== wallet) throw new Error('E_INVENTORY');
  return inventory;
}
