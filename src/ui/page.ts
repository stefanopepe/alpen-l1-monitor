export function deploymentNetwork(): string {
  // Demo fixtures use synthetic Signet wallets, regardless of the host's live profile.
  const network = process.env.STAGING_PREVIEW === 'demo' ? 'signet' : process.env.NETWORK ?? 'mainnet';
  if (!/^[a-z0-9-]+$/.test(network)) throw new Error('E_NETWORK_REQUIRED');
  return network;
}

export function renderPage(source: string, network: string): string {
  if (!/^[a-z0-9-]+$/.test(network)) throw new Error('E_NETWORK_REQUIRED');
  const testnet = network !== 'mainnet';
  const name = network === 'signet' ? 'Signet' : network === 'testnet4' ? 'Testnet4' : network;
  const label = testnet ? `Testnet · ${name}` : 'Mainnet';
  return source.replace('<html lang="en">', `<html lang="en" data-network="${network}" data-theme="${testnet ? 'testnet' : 'mainnet'}">`)
    .replace('</title>', ` · ${label}</title>`)
    .replace('<!-- NETWORK_BANNER -->', `<div class="network-banner" aria-label="Network"><strong>${label}</strong><span>${testnet ? 'Test coins only' : 'Bitcoin mainnet'}</span></div>`);
}
