export function validTimezone(value: string): boolean {
  if (value.length > 100 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: value }); return true; } catch { return false; }
}

export function reportTime(value: string | number, timezone = 'UTC'): string {
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (!Number.isFinite(date.getTime())) return 'Unavailable';
  const utc = date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  if (timezone === 'UTC') return utc + ' / client UTC';
  const client = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).format(date);
  return `${utc} / ${client} · client`;
}
