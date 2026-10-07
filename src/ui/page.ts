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
    .replace('<!-- NETWORK_BANNER -->', `<div class="network-banner" aria-label="Network"><strong>${label}${testnet ? ' · Test coins only' : ''}</strong><select aria-label="Switch Bitcoin network" onchange="window.location.assign(this.value)">
      <option value="https://ee-ol-wallet-monitor.vercel.app/"${network === 'mainnet' ? ' selected' : ''}>Bitcoin mainnet</option>
      <option value="https://ee-ol-wallet-monitor-signet.vercel.app/"${network === 'signet' ? ' selected' : ''}>Public Signet</option>
      ${!['mainnet', 'signet'].includes(network) ? `<option value="/" selected>${name}</option>` : ''}
    </select></div>`);
}
