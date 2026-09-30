export function respond(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: {
    'content-type': contentType, 'cache-control': 'private, no-store, max-age=0', 'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer', 'vary': 'Authorization',
  } });
}
export function networkName(): string {
  const network = process.env.NETWORK;
  if (!network || !/^[a-z0-9-]+$/.test(network)) throw new Error('E_NETWORK_REQUIRED');
  return network;
}
