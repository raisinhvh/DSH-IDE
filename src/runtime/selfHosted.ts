/** Helpers for the generic "Self-hosted" OpenAI-compatible provider. Pure: no vscode import. */
export const SELF_HOSTED = 'self-hosted';
export const SELF_HOSTED_ENV = 'SELF_HOSTED_API_KEY';

function isPrivateHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || name === '::1' || name.endsWith('.local')) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Validates and canonicalizes a base URL: http(s) only, plain http only for local or LAN hosts, no query or hash. */
export function normalizeBaseURL(input: string): string {
  const text = (input ?? '').trim();
  if (!text) throw new Error('Enter the base URL of your OpenAI-compatible server.');
  let url: URL;
  try { url = new URL(text); }
  catch { throw new Error('The base URL is not a valid URL. Example: https://gateway.example.com/v1'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The base URL must start with http:// or https://.');
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    throw new Error('Plain http:// is only allowed for localhost and local network addresses. Use https:// for other hosts.');
  }
  url.search = '';
  url.hash = '';
  url.username = '';
  url.password = '';
  return url.toString().replace(/\/+$/, '');
}

/** Sorted unique model ids from an OpenAI `GET /models` response. */
export function parseModelIds(json: unknown): string[] {
  const data = json && typeof json === 'object' ? (json as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) throw new Error('The server did not return an OpenAI-style model list.');
  const ids = new Set<string>();
  for (const item of data) {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  return [...ids].sort();
}
