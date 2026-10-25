import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join } from 'node:path';
import type { DelegateToolInfo } from '../delegate/host';
import { SEND_MEDIA } from './media';

type Json = Record<string, unknown>;

export const GENERATE_IMAGE = 'generate_image';
// Not a documented public API: the same endpoint the Codex CLI's built-in image tool uses with a ChatGPT sign-in.
const ENDPOINT = 'https://chatgpt.com/backend-api/codex/images/generations';
// The request model Codex sends; the backend does not report which image model ran.
const MODEL = 'gpt-image-2';
const ORIGINATOR = 'codex_cli_rs';
const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];
const QUALITIES = ['auto', 'low', 'medium', 'high'];
const BACKGROUNDS = ['auto', 'opaque', 'transparent'];
const MAX_PROMPT = 32000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 300000;

export interface ImageRequest { prompt: string; size: string; quality: string; background: string }
/** How to reach one Codex account: its CLI command, environment (CODEX_HOME set) and config directory. */
export interface CodexAuth { command: string; env: NodeJS.ProcessEnv; home: string }
export interface GeneratedImage { bytes: Buffer; extension: string }

export const GENERATE_IMAGE_TOOL: DelegateToolInfo = {
  name: GENERATE_IMAGE,
  description: 'Generate an image from a text prompt with GPT Image, using the user\'s ChatGPT (Codex) account. '
    + `The PNG is saved under .dsh/images in the workspace and its path is returned. Call ${SEND_MEDIA} with that path to show it to the user. Generation can take a minute.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to draw: subject, style, composition, colors, any text to render.' },
      size: { type: 'string', enum: SIZES, description: 'Requested width x height in pixels; the result may differ, so check the reported size. Default auto.' },
      quality: { type: 'string', enum: QUALITIES, description: 'Default auto. Low is fastest.' },
      background: { type: 'string', enum: BACKGROUNDS, description: 'Use transparent for icons, sprites and cutouts. Default auto.' },
      name: { type: 'string', description: 'Optional short file name, without extension.' },
    },
    required: ['prompt'],
  },
};

export const IMAGE_INSTRUCTIONS = `DSH images: to create an image (art, icons, textures, mockups), call ${GENERATE_IMAGE} on the dsh-delegate MCP server. It saves the file under .dsh/images in the workspace; call ${SEND_MEDIA} to show it to the user.`;

/** Validated generation options, or an error message for the agent. */
export function parseImageRequest(args: Record<string, unknown>): ImageRequest | string {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return '"prompt" is required.';
  if (prompt.length > MAX_PROMPT) return `"prompt" must be at most ${MAX_PROMPT} characters.`;
  const request: ImageRequest = { prompt, size: 'auto', quality: 'auto', background: 'auto' };
  for (const [key, options] of [['size', SIZES], ['quality', QUALITIES], ['background', BACKGROUNDS]] as const) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !options.includes(value)) return `"${key}" must be one of: ${options.join(', ')}.`;
    request[key] = value;
  }
  return request;
}

/** A file name from the agent's name or the prompt's first words, stamped so repeated prompts do not collide. */
export function imageFileName(name: unknown, prompt: string, extension: string, now = new Date()): string {
  const slug = (source: string): string => source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  const base = (typeof name === 'string' && slug(name)) || slug(prompt.split(/\s+/).slice(0, 6).join(' ')) || 'image';
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${base}-${stamp}.${extension}`;
}

/** The file extension for image bytes, from their signature. */
export function imageExtension(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return undefined;
}

/** "WIDTHxHEIGHT" of a PNG, from its header. */
export function pngSize(bytes: Buffer): string | undefined {
  return imageExtension(bytes) === 'png' && bytes.length >= 24 ? `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}` : undefined;
}

/** Generates one image with a Codex account's ChatGPT sign-in. */
export async function generateImage(auth: CodexAuth, request: ImageRequest): Promise<GeneratedImage> {
  let tokens = await readTokens(auth.home);
  if (expiring(tokens.access)) { await refreshTokens(auth); tokens = await readTokens(auth.home); }
  let response = await post(auth, tokens, request);
  if (response.status === 401) { await refreshTokens(auth); response = await post(auth, await readTokens(auth.home), request); }
  const body = await response.text();
  if (!response.ok) throw new Error(`Image generation failed (HTTP ${response.status}): ${errorText(body)}`);
  let parsed: Json;
  try { parsed = JSON.parse(body) as Json; } catch { throw new Error('Image generation returned a response that is not JSON.'); }
  const first = Array.isArray(parsed.data) ? parsed.data[0] as Json | undefined : undefined;
  const encoded = first && typeof first.b64_json === 'string' ? first.b64_json : '';
  if (!encoded) throw new Error('Image generation returned no image.');
  if (encoded.length * 0.75 > MAX_IMAGE_BYTES) throw new Error('Image generation returned an image larger than 32 MiB.');
  const bytes = Buffer.from(encoded, 'base64');
  const extension = imageExtension(bytes);
  if (!extension) throw new Error('Image generation returned data that is not a PNG, JPEG or WebP image.');
  return { bytes, extension };
}

interface Tokens { access: string; accountId?: string; fedramp: boolean }

async function readTokens(home: string): Promise<Tokens> {
  let auth: Json;
  try { auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as Json; } catch { throw new Error('This Codex account has no ChatGPT sign-in file. Sign in again in Accounts.'); }
  const tokens = auth.tokens && typeof auth.tokens === 'object' ? auth.tokens as Json : {};
  if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw new Error('This Codex account is not signed in with ChatGPT. Sign in again in Accounts.');
  const claims = jwtClaims(tokens.id_token)['https://api.openai.com/auth'];
  const info = claims && typeof claims === 'object' ? claims as Json : {};
  const accountId = typeof tokens.account_id === 'string' && tokens.account_id ? tokens.account_id
    : typeof info.chatgpt_account_id === 'string' ? info.chatgpt_account_id : undefined;
  return { access: tokens.access_token, accountId, fedramp: info.chatgpt_account_is_fedramp === true };
}

function jwtClaims(token: unknown): Json {
  if (typeof token !== 'string') return {};
  try { return JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')) as Json; } catch { return {}; }
}

function expiring(access: string): boolean {
  const exp = jwtClaims(access).exp;
  return typeof exp === 'number' && exp * 1000 < Date.now() + 5 * 60 * 1000;
}

async function post(auth: CodexAuth, tokens: Tokens, request: ImageRequest): Promise<Response> {
  const version = await codexVersion(auth);
  return fetch(ENDPOINT, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${tokens.access}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      originator: ORIGINATOR,
      'User-Agent': `${ORIGINATOR}/${version} (${type()} ${release()}; ${arch()}) dsh-ide`,
      version,
      ...(tokens.accountId ? { 'ChatGPT-Account-ID': tokens.accountId } : {}),
      ...(tokens.fedramp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
    },
    body: JSON.stringify({ model: MODEL, ...request }),
  });
}

/** The backend's error message, never the raw body beyond a short excerpt. */
function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as Json;
    const error = parsed.error && typeof parsed.error === 'object' ? parsed.error as Json : parsed;
    const message = typeof error.message === 'string' ? error.message : typeof parsed.detail === 'string' ? parsed.detail : '';
    if (message) return message.slice(0, 500);
  } catch { /* not JSON */ }
  return body.trim().slice(0, 300) || '(empty response)';
}

let version: Promise<string> | undefined;

function codexVersion(auth: CodexAuth): Promise<string> {
  version ??= new Promise(resolve => {
    execFile(auth.command, ['--version'], { env: auth.env, windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(/(\d+\.\d+\.\d+)/.exec(error ? '' : stdout)?.[1] || '0.0.0');
    });
  });
  return version;
}

/** Asks Codex to refresh its own ChatGPT tokens, so the CLI stays the only writer of auth.json. */
function refreshTokens(auth: CodexAuth): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(auth.command, ['app-server', '--listen', 'stdio://'], { env: auth.env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Refreshing the Codex sign-in timed out.')), 20000);
    const send = (message: Json): void => { child.stdin.write(JSON.stringify(message) + '\n'); };
    child.on('error', () => finish(new Error('Codex CLI could not start. Check its path in Settings.')));
    child.on('close', () => finish(new Error('Codex exited before refreshing its sign-in.')));
    child.stdin.on('error', () => undefined);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { finish(new Error('Codex app-server output was too large.')); return; }
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        let message: Json;
        try { message = JSON.parse(line) as Json; } catch { continue; }
        if (message.id === 1) {
          if (message.error) { finish(new Error('Codex app-server rejected the connection.')); return; }
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/read', params: { refreshToken: true } });
        } else if (message.id === 2) {
          finish(message.error ? new Error('Codex could not refresh its ChatGPT sign-in. Sign in again in Accounts.') : undefined);
          return;
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dsh-ide', title: 'DSH IDE', version: '0.4.6' }, capabilities: null } });
  });
}
