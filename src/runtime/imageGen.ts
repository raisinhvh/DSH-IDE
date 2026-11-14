import { CODEX_CLIENT_VERSION, codexHeaders, freshCodexTokens } from '../accounts/codexAuth';
import type { CodexTokens } from '../accounts/codexAuth';
import type { DelegateToolInfo } from '../delegate/host';
import { SEND_MEDIA } from './media';

type Json = Record<string, unknown>;

export const GENERATE_IMAGE = 'generate_image';
// Not a documented public API: the same endpoint the Codex CLI's built-in image tool uses with a ChatGPT sign-in.
const BASE_URL = 'https://chatgpt.com/backend-api/codex/images';
// The request model Codex sends; the backend does not report which image model ran.
const MODEL = 'gpt-image-2';
const SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'];
const QUALITIES = ['auto', 'low', 'medium', 'high'];
const BACKGROUNDS = ['auto', 'opaque', 'transparent'];
const MAX_PROMPT = 32000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
// The Codex image tool takes at most five input images. Inputs are sent as they are, without resizing, so their size is capped.
export const MAX_INPUT_IMAGES = 5;
export const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_TOTAL = 25 * 1024 * 1024;
const TIMEOUT_MS = 300000;

/** images are the agent's input image paths, unresolved. */
export interface ImageRequest { prompt: string; size: string; quality: string; background: string; images: string[] }
/** One Codex account: the directory holding its ChatGPT sign-in (auth.json). */
export interface CodexAuth { home: string }
export interface GeneratedImage { bytes: Buffer; extension: string }

export const GENERATE_IMAGE_TOOL: DelegateToolInfo = {
  name: GENERATE_IMAGE,
  description: `Generate a PNG with GPT Image (the user's ChatGPT account) from a prompt, or edit, combine or restyle input images. It is saved under .dsh/images, its path returned, and shown in the chat (no ${SEND_MEDIA} needed). Can take a minute.`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Subject, style, composition, colors, text. With input images: the change, what to keep, which image is which.' },
      images: { type: 'array', minItems: 1, maxItems: MAX_INPUT_IMAGES, items: { type: 'string' },
        description: `PNG, JPEG or WebP up to ${MAX_INPUT_BYTES / 1024 / 1024} MB each, relative to the working copy or absolute.` },
      size: { type: 'string', enum: SIZES, description: 'Requested size; check the reported one. Default auto.' },
      quality: { type: 'string', enum: QUALITIES, description: 'Default auto. Low is fastest.' },
      background: { type: 'string', enum: BACKGROUNDS, description: 'transparent for icons, sprites, cutouts. Default auto.' },
      name: { type: 'string', description: 'Optional file name, no extension.' },
    },
    required: ['prompt'],
  },
};

export const IMAGE_INSTRUCTIONS = `DSH images: ${GENERATE_IMAGE} creates images, or edits ones passed as input images.`;

/** Validated generation options, or an error message for the agent. */
export function parseImageRequest(args: Record<string, unknown>): ImageRequest | string {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return '"prompt" is required.';
  if (prompt.length > MAX_PROMPT) return `"prompt" must be at most ${MAX_PROMPT} characters.`;
  const request: ImageRequest = { prompt, size: 'auto', quality: 'auto', background: 'auto', images: [] };
  for (const [key, options] of [['size', SIZES], ['quality', QUALITIES], ['background', BACKGROUNDS]] as const) {
    const value = args[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || !options.includes(value)) return `"${key}" must be one of: ${options.join(', ')}.`;
    request[key] = value;
  }
  const images = args.images ?? [];
  if (!Array.isArray(images) || images.some(item => typeof item !== 'string' || !item.trim())) return '"images" must be a list of file paths.';
  if (images.length > MAX_INPUT_IMAGES) return `Pass at most ${MAX_INPUT_IMAGES} input images.`;
  request.images = images.map(item => (item as string).trim());
  return request;
}

/** Why bytes cannot be an input image, or undefined when they can. */
export function inputImageProblem(bytes: Buffer): string | undefined {
  if (!imageExtension(bytes)) return 'not a PNG, JPEG or WebP image';
  if (bytes.length > MAX_INPUT_BYTES) return `larger than ${MAX_INPUT_BYTES / 1024 / 1024} MB`;
  return undefined;
}

/** The endpoint and JSON body for a request: generations without input images, edits with them. */
export function imageRequestBody(request: ImageRequest, inputs: Buffer[]): { url: string; body: Json } {
  const problem = inputs.map(inputImageProblem).find(Boolean);
  if (problem) throw new Error(`An input image is ${problem}.`);
  if (inputs.reduce((total, bytes) => total + bytes.length, 0) > MAX_INPUT_TOTAL) throw new Error(`Input images add up to more than ${MAX_INPUT_TOTAL / 1024 / 1024} MB.`);
  const body: Json = { model: MODEL, prompt: request.prompt, size: request.size, quality: request.quality, background: request.background };
  if (!inputs.length) return { url: `${BASE_URL}/generations`, body };
  const url = (bytes: Buffer): string => { const extension = imageExtension(bytes); return `data:image/${extension === 'jpg' ? 'jpeg' : extension};base64,${bytes.toString('base64')}`; };
  return { url: `${BASE_URL}/edits`, body: { ...body, images: inputs.map(bytes => ({ image_url: url(bytes) })) } };
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

/** Generates one image with a Codex account's ChatGPT sign-in, from the prompt alone or from input image bytes too. */
export async function generateImage(auth: CodexAuth, request: ImageRequest, inputs: Buffer[] = []): Promise<GeneratedImage> {
  const target = imageRequestBody(request, inputs);
  let response = await post(await freshCodexTokens(auth.home), target);
  if (response.status === 401) response = await post(await freshCodexTokens(auth.home, { force: true }), target);
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

async function post(tokens: CodexTokens, target: { url: string; body: Json }): Promise<Response> {
  return fetch(target.url, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      ...codexHeaders(tokens),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      version: CODEX_CLIENT_VERSION,
    },
    body: JSON.stringify(target.body),
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
