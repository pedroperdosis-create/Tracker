export const TON_VIEWER_BASE = "https://tonviewer.com";

export function shortAddress(address: string, start = 3, end = 4): string {
  if (address.length <= start + end) {
    return address;
  }
  return `${address.slice(0, start)}...${address.slice(-end)}`;
}

export function addressLink(address: string): string {
  return `${TON_VIEWER_BASE}/${address}`;
}

export function txLink(hash: string): string {
  return `${TON_VIEWER_BASE}/transaction/${hash}`;
}

export function normalizeAddress(address: string): string {
  return address.trim();
}

export function isValidAddress(address: string): boolean {
  return /^(EQ|UQ)[A-Za-z0-9_-]{46,48}$/.test(address.trim());
}
