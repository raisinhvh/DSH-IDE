import type { ToolpackContent, ToolpackResult } from './types';

/** Largest `data` (as JSON) a result may carry for batch placeholders; bigger data is dropped. */
const MAX_DATA_CHARS = 200_000;

/** The result's chaining data when it is JSON and small enough. */
function chainingData(value: unknown): { data?: unknown } {
    if (value === undefined) return {};
    try {
        const json = JSON.stringify(value);
        return json !== undefined && json.length <= MAX_DATA_CHARS ? { data: JSON.parse(json) } : {};
    } catch {
        return {};
    }
}

/** Keep binary tool output separate from the text truncation budget. */
export function normalizeToolpackResult(value: unknown): ToolpackResult {
    if (value && typeof value === 'object' && 'content' in value) {
        const raw = value as { content: unknown; isError?: unknown; data?: unknown };
        if (!Array.isArray(raw.content) || raw.content.length > 64) throw new Error('Tool content must be an array of at most 64 blocks.');
        const content: ToolpackContent[] = [];
        let bytes = 0;
        for (const block of raw.content) {
            if (!block || typeof block !== 'object') throw new Error('Invalid tool content block.');
            if (block.type === 'text' && typeof block.text === 'string') {
                bytes += Buffer.byteLength(block.text);
                content.push({ type: 'text', text: block.text });
            } else if (block.type === 'image' && typeof block.data === 'string'
                && ['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType)
                && block.data.length > 0 && block.data.length % 4 === 0
                && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) {
                bytes += block.data.length;
                content.push({ type: 'image', data: block.data, mimeType: block.mimeType });
            } else throw new Error('Tool content supports text or base64 PNG/JPEG/WebP images.');
            if (bytes > 32 * 1024 * 1024) throw new Error('Tool content exceeds 32 MiB.');
        }
        if (raw.isError !== undefined && typeof raw.isError !== 'boolean') throw new Error('isError must be a boolean.');
        return { text: content.filter((block): block is Extract<ToolpackContent, { type: 'text' }> => block.type === 'text').map(block => block.text).join('\n'), content, ...(raw.isError === true ? { isError: true } : {}), ...chainingData(raw.data) };
    }
    if (typeof value === 'string') return { text: value };
    if (value === undefined) return { text: '(no output)' };
    try { return { text: JSON.stringify(value, null, 2) }; } catch { return { text: String(value) }; }
}

export function truncateToolpackResult(result: ToolpackResult, max: number): ToolpackResult {
    if (result.text.length <= max) return result;
    const text = `${result.text.slice(0, max)}\n...[output truncated at ${max} characters; narrow the request]`;
    if (!result.content) return { ...result, text };
    // Preserve image ordering and replace all text with the bounded summary.
    return { ...result, text, content: [{ type: 'text', text }, ...result.content.filter(block => block.type === 'image')] };
}
