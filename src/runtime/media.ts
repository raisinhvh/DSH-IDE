import { extname } from 'node:path';
import type { DelegateToolInfo } from '../delegate/host';

export const SEND_MEDIA = 'send_media';
export const MAX_MEDIA_FILES = 8;
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
};

export function mediaType(path: string): string { return MEDIA_TYPES[extname(path).toLowerCase()] || 'application/octet-stream'; }

export const SEND_MEDIA_TOOL: DelegateToolInfo = {
  name: SEND_MEDIA,
  description: 'Show files to the user in the DSH chat: images, video and audio play inline; other files appear as a link they can open. '
    + 'Use it to share screenshots, renders, charts, recordings or generated assets instead of only describing them. The files are copied when sent, so later changes do not affect what the user sees.',
  inputSchema: {
    type: 'object',
    properties: {
      paths: { type: 'array', minItems: 1, maxItems: MAX_MEDIA_FILES, items: { type: 'string' }, description: 'Files to show, relative to the working copy or absolute.' },
      caption: { type: 'string', description: 'Optional short markdown text shown above the files.' },
    },
    required: ['paths'],
  },
};

export const MEDIA_INSTRUCTIONS = `DSH media: to show the user an image, video, audio clip or other file (for example a screenshot or render you made), call ${SEND_MEDIA} on the dsh-delegate MCP server with its path. It appears in the chat.`;
