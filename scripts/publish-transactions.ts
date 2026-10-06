import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { openArchive } from '../src/replay/archive.js';
import { archiveTransactions } from '../src/replay/transactions.js';
import { feeArchiveSchema } from '../src/fees/schema.js';

const dir = process.argv[2];
if (!dir) throw new Error('Usage: node --import tsx scripts/publish-transactions.ts ARCHIVE_DIR');
const archive = openArchive(dir);
const html = gunzipSync(readFileSync('reports/mainnet-time-machine.html.gz')).toString();
const packed = /<script type="application\/json" id="data">([^<]+)<\/script>/.exec(html)![1]!;
const report = JSON.parse(gunzipSync(Buffer.from(packed, 'base64')).toString()) as { manifest: { archiveDigest: string } };
if (archive.network !== 'mainnet' || archive.digest !== report.manifest.archiveDigest) throw new Error('E_TRANSACTION_ARCHIVE_MISMATCH');
const fees = feeArchiveSchema.parse(JSON.parse(readFileSync('config/fee-history-seed.json', 'utf8')));
const transactions = archiveTransactions(archive, fees.buckets);
writeFileSync('reports/mainnet-transactions.json.gz', gzipSync(JSON.stringify({ archiveDigest: archive.digest, transactions }), { level: 9 }));
console.log(`Published ${transactions.length} transaction summaries from the verified replay archive.`);
