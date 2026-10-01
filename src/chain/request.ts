import type { ProviderConfig } from '../config/schema.js';

// Construct credentials only at the request boundary. Never log this return value.
export function providerRequest(config: ProviderConfig, path: string): { url: string; headers: Record<string, string> } {
  const url = new URL(`${config.base_url}${path}`);
  const headers: Record<string, string> = {};
  const auth = config.auth;
  if (auth.scheme !== 'none') {
    const secret = process.env[auth.secret_env];
    if (!secret || /[\r\n]/.test(secret)) throw new Error('E_PROVIDER_SECRET_MISSING');
    if (auth.scheme === 'query') url.searchParams.set(auth.parameter_name, secret);
    else headers[auth.scheme === 'bearer' ? 'authorization' : auth.header_name] = auth.scheme === 'bearer' ? `Bearer ${secret}` : secret;
  }
  return { url: url.toString(), headers };
}
