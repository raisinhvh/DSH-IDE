import type { JobCriterion, JobVerdict } from './types';

export function extractJson(reply: string): unknown | undefined {
  const fences = [...reply.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)];
  for (const fence of fences.reverse()) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  let start = 0, depth = 0, quoted = false, escaped = false;
  let result: unknown;
  for (let i = 0; i < reply.length; i++) {
    const char = reply[i];
    if (depth && quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (depth && char === '"') quoted = true;
    else if (char === '{') { if (!depth) start = i; depth++; }
    else if (char === '}' && depth && !--depth) {
      try { result = JSON.parse(reply.slice(start, i + 1)); } catch {}
    }
  }
  return result;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseChecklist(reply: string): { criteria: { text: string; source: string; check?: string }[] } | { blocked: string } | { error: string } {
  const json = extractJson(reply);
  if (json === undefined) return { error: 'No valid JSON found.' };
  const value = object(json);
  if (typeof value.blocked === 'string' && value.blocked.trim()) return { blocked: value.blocked.trim() };
  const seen = new Set<string>();
  const criteria: { text: string; source: string; check?: string }[] = [];
  for (const item of Array.isArray(value.criteria) ? value.criteria : []) {
    const entry = object(item);
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const source = typeof entry.source === 'string' && /^(spec|checklist|answer:\d+)$/.test(entry.source) ? entry.source : 'spec';
    const check = typeof entry.check === 'string' ? entry.check.trim() : '';
    criteria.push({ text, source, ...(check ? { check } : {}) });
  }
  return criteria.length ? { criteria } : { error: 'No acceptance criteria found.' };
}

export function parseVerdict(reply: string, ids: string[]): JobVerdict | { error: string } {
  const json = extractJson(reply);
  if (json === undefined) return { error: 'No valid JSON found.' };
  const value = object(json);
  if (!Array.isArray(value.results)) return { error: 'No results array found.' };
  const results = new Map<string, JobVerdict['results'][number]>();
  for (const item of value.results) {
    const entry = object(item);
    if (typeof entry.id !== 'string' || !ids.includes(entry.id)) continue;
    results.set(entry.id, { id: entry.id, pass: entry.pass === true, evidence: typeof entry.evidence === 'string' ? entry.evidence.trim() : '' });
  }
  const unbacked = Array.isArray(value.unbacked) ? value.unbacked.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : [];
  return {
    results: ids.map(id => results.get(id) || { id, pass: false, evidence: 'The reviewer gave no verdict for this criterion.' }),
    unbacked: [...new Set(unbacked)],
  };
}

export function parseBlocked(reply: string): string | undefined {
  return /^[ \t]*JOB BLOCKED:[ \t]*(\S[^\r\n]*)/im.exec(reply)?.[1].trim();
}

export function isStalled(history: string[][]): boolean {
  if (history.length < 2) return false;
  const previous = new Set(history[history.length - 2]), current = new Set(history[history.length - 1]);
  return current.size > 0 && previous.size === current.size && [...current].every(id => previous.has(id));
}

export function nextCriterionId(criteria: JobCriterion[]): string {
  return 'C' + (criteria.reduce((max, criterion) => Math.max(max, Number(/^C(\d+)$/.exec(criterion.id)?.[1] || 0)), 0) + 1);
}
