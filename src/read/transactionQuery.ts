// SQL projection matches the input contract in transactions.ts. Witness bytes,
// envelope payloads, address cursors and unused script metadata never cross the wire.
const output = (value: string) => `jsonb_build_object('scriptpubkey',${value}->'scriptpubkey','value',${value}->'value')`;
const transaction = (value: string) => `jsonb_build_object(
  'txid',${value}->'txid','fee',${value}->'fee','weight',${value}->'weight','status',${value}->'status',
  'vin',COALESCE((SELECT jsonb_agg(jsonb_build_object('prevout',CASE WHEN i->'prevout' IS NULL OR i->'prevout'='null'::jsonb
    THEN 'null'::jsonb ELSE ${output("(i->'prevout')")} END)) FROM jsonb_array_elements(${value}->'vin') AS i),'[]'::jsonb),
  'vout',COALESCE((SELECT jsonb_agg(${output('o')}) FROM jsonb_array_elements(${value}->'vout') AS o),'[]'::jsonb))`;

export const transactionSource = `SELECT wallet,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('script',a->'script')) FROM jsonb_array_elements(addresses) AS a),'[]'::jsonb) AS addresses,
  jsonb_build_object(
    'transactions',COALESCE((SELECT jsonb_object_agg(t.key,${transaction('t.value')}) FROM jsonb_each(COALESCE(history->'transactions','{}'::jsonb)) AS t),'{}'::jsonb),
    'reveals',COALESCE((SELECT jsonb_object_agg(r.key,(SELECT COALESCE(jsonb_agg(${transaction('tx')}),'[]'::jsonb) FROM jsonb_array_elements(r.value) AS tx))
      FROM jsonb_each(COALESCE(history->'reveals','{}'::jsonb)) AS r),'{}'::jsonb)
  ) AS history FROM wallet_state WHERE network=$1 AND wallet=$2`;
