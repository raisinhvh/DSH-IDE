import { extname } from 'node:path';

const MAX_BODY = 6000;
const MAX_LINE = 200;

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_LINE);
}

function purpose(text: string, language: string): string | undefined {
  let start = text.replace(/^\uFEFF/, '').replace(/^#![^\n]*\n/, '').trimStart();
  // Luau mode directives such as `--!strict` are not documentation.
  if (language === 'lua') start = start.replace(/^(?:--![^\n]*(?:\n|$)\s*)+/, '');
  let comment: string | undefined;
  if (language === 'python') comment = start.match(/^(?:[rRuUbBfF]{0,2})("""[\s\S]*?"""|'''[\s\S]*?''')/)?.[1].slice(3, -3);
  else if (language === 'lua') comment = start.match(/^--\[\[([\s\S]*?)\]\]/)?.[1] ?? start.match(/^(?:--[^\n]*(?:\n|$))+/)?.[0].replace(/^--\s?/gm, '');
  else if (language === 'rust') comment = start.match(/^(?:\/\/![^\n]*(?:\n|$))+/)?.[0].replace(/^\/\/!\s?/gm, '') ?? start.match(/^\/\*\*([\s\S]*?)\*\//)?.[1];
  else comment = start.match(/^\/\*\*([\s\S]*?)\*\//)?.[1] ?? start.match(/^(?:\/\/[^\n]*(?:\n|$))+/)?.[0].replace(/^\/\/\s?/gm, '');
  if (!comment) return undefined;
  const normalized = comment.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ').trim();
  return clean(normalized.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? normalized) || undefined;
}

// Preserve positions and newlines while masking comments and strings for structural scanning.
function mask(text: string, language: string): string {
  let result = '';
  let state = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const pair = text.slice(i, i + 2);
    if (state === 'line') {
      if (c === '\n') { state = ''; result += c; } else result += ' ';
    } else if (state === 'block') {
      if (pair === '*/') { result += '  '; i++; state = ''; } else result += c === '\n' ? '\n' : ' ';
    } else if (state === 'luaBlock') {
      if (pair === ']]') { result += '  '; i++; state = ''; } else result += c === '\n' ? '\n' : ' ';
    } else if (state) {
      if (c === '\\') { result += ' '; if (i + 1 < text.length) { result += text[++i] === '\n' ? '\n' : ' '; } }
      else if (c === state) { result += ' '; state = ''; }
      else result += c === '\n' ? '\n' : ' ';
    } else if (language === 'js' && c === '/' && pair !== '//' && pair !== '/*' && /(?:^|[=(:,!&|?;{}]|\breturn)\s*$/.test(result.slice(0, i))) {
      result += ' ';
      let inClass = false;
      while (++i < text.length) {
        const part = text[i];
        result += part === '\n' ? '\n' : ' ';
        if (part === '\\' && i + 1 < text.length) { result += ' '; i++; continue; }
        if (part === '[') inClass = true;
        else if (part === ']') inClass = false;
        else if (part === '/' && !inClass || part === '\n') break;
      }
    } else if (language === 'lua' ? pair === '--' : pair === '//') {
      // In Luau `//` is floor division, so only `--` starts a comment there.
      if (language === 'lua' && text.slice(i, i + 4) === '--[[') { result += '    '; i += 3; state = 'luaBlock'; }
      else { result += '  '; i++; state = 'line'; }
    } else if (language !== 'lua' && pair === '/*') { result += '  '; i++; state = 'block'; }
    else if (c === '"' || c === "'" || c === '`') { result += ' '; state = c; }
    else result += c;
  }
  return result;
}

/**
 * For `const name = (args): Type => …` or `= function (…)`, moves the cut from the `=` to the end of the
 * parameter list and return type, so constants holding functions keep their signature.
 */
function functionValueEnd(signature: string, stop: number): number {
  if (signature[stop] !== '=' || signature[stop + 1] === '>') return stop;
  if (!/^\s*(?:async\s+)?(?:\(|<|function\b)/.test(signature.slice(stop + 1))) return stop;
  let nesting = 0;
  for (let index = stop + 1; index < signature.length; index++) {
    const character = signature[index];
    if (character === '(' || character === '[' || character === '<') nesting++;
    else if (character === ')' || character === ']' || (character === '>' && signature[index - 1] !== '=')) nesting--;
    else if (nesting === 0 && signature.startsWith('=>', index)) return index;
    else if (nesting === 0 && character === '{') return index;
  }
  return signature.length;
}

function braceDefinitions(text: string, language: string): string[] {
  const masked = mask(text, language);
  const lines = masked.split('\n');
  const original = text.split('\n');
  const definitions: string[] = [];
  let depth = 0;
  let classDepth = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const atTop = depth === 0;
    const inClass = depth === classDepth;
    const topPattern = language === 'go'
      ? /^(?:func\s+(?:\([^)]*\)\s*)?\w+|type\s+\w+|(?:const|var)\s+\w+)/
      : language === 'rust'
        ? /^(?:(?:pub(?:\([^)]*\))?|async|unsafe|extern\s+\S+)\s+)*(?:fn|struct|enum|trait|type|const|static)\s+\w+/
        : /^(?:(?:export|default|declare|abstract|async)\s+)*(?:function\s*\*?\s*\w+|class\s+\w+|interface\s+\w+|type\s+\w+|enum\s+\w+|(?:const|let|var)\s+\w+)/;
    const methodPattern = /^(?:(?:public|private|protected|static|readonly|abstract|override|async|declare|get|set)\s+)*(?:constructor|[\w$]+)\s*(?:<[^>]*>)?\s*\(/;
    if ((atTop && topPattern.test(trimmed)) || (inClass && language === 'js' && methodPattern.test(trimmed))) {
      let end = i;
      let signature = trimmed;
      let parens = (signature.match(/\(/g)?.length ?? 0) - (signature.match(/\)/g)?.length ?? 0);
      while (end + 1 < lines.length && (parens > 0 || (!/[{;=]/.test(signature) && /\($/.test(signature)))) {
        end++;
        signature += ' ' + lines[end].trim();
        parens += (lines[end].match(/\(/g)?.length ?? 0) - (lines[end].match(/\)/g)?.length ?? 0);
      }
      // Use original text for types and default values, but boundaries from masked text.
      const raw = original.slice(i, end + 1).map(part => part.trim()).join(' ');
      let stop = signature.length;
      let nesting = 0;
      for (let index = 0; index < signature.length; index++) {
        const character = signature[index];
        if (character === '(' || character === '[') nesting++;
        else if (character === ')' || character === ']') nesting--;
        else if (nesting === 0 && (character === '{' || character === ';' || character === '=')) { stop = index; break; }
      }
      stop = functionValueEnd(signature, stop);
      const value = clean(raw.slice(0, stop));
      if (value) definitions.push((inClass ? '  ' : '') + value);
      if (atTop && language === 'js' && /\bclass\s+\w+/.test(trimmed) && line.includes('{')) classDepth = depth + 1;
    }
    for (const c of line) {
      if (c === '{') depth++;
      else if (c === '}') depth = Math.max(0, depth - 1);
    }
    if (classDepth > depth) classDepth = -1;
  }
  return definitions;
}

function pythonDefinitions(text: string): string[] {
  const lines = text.split('\n');
  const definitions: string[] = [];
  let classIndent = -1;
  let triple = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (triple) { if (trimmed.includes(triple)) triple = ''; continue; }
    if (/^(?:[rRuUbBfF]{0,2})("""|''')/.test(trimmed)) {
      const quote = trimmed.match(/("""|''')/)![1];
      if (trimmed.indexOf(quote, trimmed.indexOf(quote) + 3) < 0) triple = quote;
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (classIndent >= 0 && indent <= classIndent) classIndent = -1;
    const top = indent === 0;
    const isClass = top && /^class\s+\w+/.test(trimmed);
    const isFunction = /^(?:async\s+)?def\s+\w+\s*\(/.test(trimmed);
    if (isClass || (isFunction && (top || classIndent >= 0 && indent > classIndent)) || (top && /^[A-Z][A-Z0-9_]*\s*(?::[^=]+)?=/.test(trimmed))) {
      let signature = trimmed;
      let balance = (signature.match(/\(/g)?.length ?? 0) - (signature.match(/\)/g)?.length ?? 0);
      while (balance > 0 && i + 1 < lines.length) {
        const next = lines[++i].trim();
        signature += ' ' + next;
        balance += (next.match(/\(/g)?.length ?? 0) - (next.match(/\)/g)?.length ?? 0);
      }
      if (isFunction || isClass) signature = signature.replace(/:\s*(?:#.*)?$/, '');
      else signature = signature.split('=')[0].trim();
      definitions.push((top ? '' : '  ') + clean(signature));
      if (isClass) classIndent = indent;
    }
  }
  return definitions;
}

function luaDefinitions(text: string): string[] {
  const masked = mask(text, 'lua').split('\n');
  const lines = text.split('\n');
  const definitions: string[] = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = masked[i].trim();
    if (depth === 0 && /^(?:local\s+)?function\s+[\w.:]+\s*\(/.test(line)) {
      let signature = lines[i].trim();
      while (!signature.includes(')') && i + 1 < lines.length) signature += ' ' + lines[++i].trim();
      const close = signature.indexOf(')');
      // Keep a Luau return type annotation, e.g. `function M.get(id: string): Item?`.
      const returnType = signature.slice(close + 1).match(/^\s*:\s*[^=]+?(?=\s*$|\s+(?:local|return|if|for|while)\b)/)?.[0] ?? '';
      definitions.push(clean(signature.slice(0, close + 1) + returnType));
    } else if (depth === 0 && /^(?:export\s+)?type\s+\w+/.test(line)) {
      definitions.push(clean(lines[i].split('=')[0]));
    } else if (depth === 0 && /^(?:local\s+)?[\w.]+\s*=/.test(line) && !/=\s*(?:require\s*\(|game\s*:\s*GetService\s*\()/.test(line)) {
      definitions.push(clean(lines[i].split('=')[0]));
    }
    const tokens = line.match(/\b(?:function|if|for|while|do|repeat|end|until)\b/g) ?? [];
    for (const token of tokens) {
      if (token === 'end' || token === 'until') depth = Math.max(0, depth - 1);
      else if (token !== 'do' || !/\b(?:for|while)\b/.test(line)) depth++;
    }
  }
  return definitions;
}

/** Extracts a compact static reference from supported source files. */
export function outline(path: string, text: string): string | undefined {
  const ext = extname(path).toLowerCase();
  let language: string;
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) language = 'js';
  else if (ext === '.py') language = 'python';
  else if (ext === '.go') language = 'go';
  else if (ext === '.rs') language = 'rust';
  else if (ext === '.lua' || ext === '.luau') language = 'lua';
  else return undefined;
  const description = purpose(text, language);
  const definitions = language === 'python' ? pythonDefinitions(text) : language === 'lua' ? luaDefinitions(text) : braceDefinitions(text, language);
  const result = [description && `Purpose: ${description}`, definitions.length && `Definitions:\n${definitions.join('\n')}`].filter(Boolean).join('\n');
  return result ? result.slice(0, MAX_BODY) : undefined;
}
