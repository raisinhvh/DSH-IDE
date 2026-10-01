import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

interface ToolpackContext { log(message: string): void; status(text: string): void; dataDir: string }
interface ToolpackTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolpackContext): unknown | Promise<unknown>;
}
interface ToolpackDefinition {
  name: string;
  description: string;
  tools: ToolpackTool[];
  setup?(ctx: ToolpackContext): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

interface Waiter { res: ServerResponse; timer: ReturnType<typeof setTimeout>; closed: boolean }
interface Place { session: string; name: string; placeId: string; lastSeen: number; queue: Array<{ id: number; op: string; args: Record<string, unknown> }>; waiters: Waiter[] }
interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; session: string }
interface State {
  server?: Server;
  ctx?: ToolpackContext;
  code: string;
  port: number;
  lastStatus: string;
  statusTimer?: ReturnType<typeof setInterval>;
  nextId: number;
  places: Map<string, Place>;
  pending: Map<number, Pending>;
}

const state: State = {
  code: '', port: 34872, lastStatus: '', nextId: 1,
  places: new Map(), pending: new Map(),
};
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function updateStatus(): void {
  const ctx = state.ctx;
  if (!ctx || !state.code) return;
  prunePlaces();
  const connected = connectedPlaces();
  const text = connected.length === 1
    ? `Connected to Roblox Studio (place: ${connected[0].name}). Pairing code: ${state.code}`
    : connected.length > 1
      ? `Connected to Roblox Studio (${connected.length} places: ${connected.map(place => place.name).join(', ')}). Pairing code: ${state.code}`
      : `Waiting for Roblox Studio. Pairing code: ${state.code} (port ${state.port})`;
  if (text !== state.lastStatus) {
    state.lastStatus = text;
    ctx.status(text);
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function connectedPlaces(): Place[] { return [...state.places.values()].filter(place => Date.now() - place.lastSeen < 35_000); }
function prunePlaces(): void {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [session, place] of state.places) if (place.lastSeen < cutoff) {
    for (const waiter of place.waiters.splice(0)) { waiter.closed = true; clearTimeout(waiter.timer); if (!waiter.res.destroyed && !waiter.res.writableEnded) { waiter.res.writeHead(204); waiter.res.end(); } }
    state.places.delete(session);
  }
}

function deliver(waiter: Waiter, command: { id: number; op: string; args: Record<string, unknown> }): void {
  if (waiter.closed || waiter.res.destroyed || waiter.res.writableEnded) return;
  waiter.closed = true;
  clearTimeout(waiter.timer);
  json(waiter.res, 200, command);
}

function dispatch(place: Place): void {
  while (place.queue.length && place.waiters.length) {
    const waiter = place.waiters.shift();
    const command = place.queue.shift();
    if (waiter && command) deliver(waiter, command);
  }
}

function refreshPlace(url: URL): Place {
  const name = url.searchParams.get('place') ?? '';
  const session = url.searchParams.get('session') || name;
  let place = state.places.get(session);
  if (!place) { place = { session, name, placeId: url.searchParams.get('placeId') ?? '', lastSeen: Date.now(), queue: [], waiters: [] }; state.places.set(session, place); }
  place.name = name; place.placeId = url.searchParams.get('placeId') ?? ''; place.lastSeen = Date.now();
  prunePlaces(); updateStatus(); return place;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (String(req.headers['x-dsh-token'] ?? '').toUpperCase() !== state.code) {
    json(res, 401, { error: 'wrong pairing code' });
    return;
  }
  const host = req.headers.host ?? '127.0.0.1';
  let url: URL;
  try { url = new URL(req.url ?? '/', `http://${host}`); }
  catch { json(res, 400, { error: 'invalid request URL' }); return; }

  if (req.method === 'GET' && url.pathname === '/ping') {
    refreshPlace(url);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/poll') {
    const place = refreshPlace(url);
    const command = place.queue.shift();
    if (command) { json(res, 200, command); return; }
    const waiter: Waiter = {
      res, closed: false,
      timer: setTimeout(() => {
        const index = place.waiters.indexOf(waiter);
        if (index >= 0) place.waiters.splice(index, 1);
        waiter.closed = true;
        if (!res.destroyed && !res.writableEnded) { res.writeHead(204); res.end(); }
      }, 20_000),
    };
    place.waiters.push(waiter);
    res.on('close', () => {
      if (waiter.closed) return;
      waiter.closed = true;
      clearTimeout(waiter.timer);
      const index = place.waiters.indexOf(waiter);
      if (index >= 0) place.waiters.splice(index, 1);
    });
    dispatch(place);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/result') {
    let body = '';
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body, 'utf8') > 5 * 1024 * 1024) {
        tooLarge = true;
        json(res, 413, { error: 'request body too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge || res.writableEnded) return;
      let result: unknown;
      try { result = JSON.parse(body); }
      catch { json(res, 400, { error: 'invalid JSON body' }); return; }
      if (!isRecord(result) || typeof result.id !== 'number' || typeof result.ok !== 'boolean') {
        json(res, 400, { error: 'result must contain numeric id and boolean ok' });
        return;
      }
      const pending = state.pending.get(result.id);
      if (pending) {
        state.pending.delete(result.id);
        clearTimeout(pending.timer);
        if (result.ok) pending.resolve(result.data);
        else pending.reject(new Error(typeof result.error === 'string' ? result.error : 'Roblox Studio command failed.'));
      }
      json(res, 200, {});
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function command(place: Place, op: string, args: Record<string, unknown>): Promise<unknown> {
  const id = state.nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      const queue = place.queue;
      const index = queue.findIndex(item => item.id === id);
      if (index >= 0) queue.splice(index, 1);
      reject(new Error('Roblox Studio did not respond in 30s.'));
    }, 30_000);
    state.pending.set(id, { resolve, reject, timer, session: place.session });
    place.queue.push({ id, op, args });
    dispatch(place);
  });
}

function resolvePlace(args: Record<string, unknown>): Place {
  prunePlaces();
  const places = connectedPlaces();
  const noConnection = `Roblox Studio is not connected. In Studio open the 'DSH Bridge' plugin widget, enter the pairing code (${state.code}) and make sure HTTP requests are allowed.`;
  const label = (place: Place): string => `${place.name} (placeId: ${place.placeId}, session: ${place.session})`;
  if (!places.length) throw new Error(noConnection);
  const requested = stringArg(args, 'place');
  if (requested !== undefined) {
    let matches = places.filter(place => place.session === requested);
    if (!matches.length) matches = places.filter(place => place.name.toLowerCase() === requested.toLowerCase());
    if (!matches.length) matches = places.filter(place => place.name.toLowerCase().includes(requested.toLowerCase()) || place.placeId === requested);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) throw new Error(`Multiple Roblox Studio places match "${requested}": ${matches.map(label).join('; ')}. Pass an exact session or a more specific place.`);
    throw new Error(`No connected Roblox Studio place matches "${requested}". Connected places: ${places.map(label).join('; ')}`);
  }
  if (places.length === 1) return places[0];
  throw new Error(`Several Roblox Studio places are connected: ${places.map(label).join('; ')}. Pass the place argument.`);
}

function stringArg(args: Record<string, unknown>, name: string, required = false): string | undefined {
  const value = args[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.length === 0)) throw new Error(`${name} must be a${required ? ' non-empty' : ''} string.`);
  return value;
}

function numberArg(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function placeSchema(): Record<string, unknown> { return { type: 'string', description: 'Select a connected place by session, name, partial name, or placeId.' }; }
function commandFor(args: Record<string, unknown>, op: string, sent: Record<string, unknown>): Promise<unknown> { return command(resolvePlace(args), op, sent); }

function dataRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Roblox Studio returned an invalid response.');
  return value;
}

function textValue(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function formatTree(data: Record<string, unknown>, depth: number): string {
  const root = dataRecord(data.root);
  const rootChildren = typeof root.childCount === 'number' ? root.childCount : 0;
  const lines = [`${textValue(root, 'path')} [${textValue(root, 'className')}]${depth === 0 && rootChildren > 0 ? ` (+${rootChildren} children)` : ''}`];
  if (Array.isArray(data.nodes)) {
    for (const raw of data.nodes) {
      if (!isRecord(raw)) continue;
      const level = typeof raw.depth === 'number' && Number.isFinite(raw.depth) ? Math.max(0, raw.depth) : 0;
      let line = `${'  '.repeat(level)}${textValue(raw, 'name')} [${textValue(raw, 'className')}]`;
      if (level === depth && typeof raw.childCount === 'number' && raw.childCount > 0) line += ` (+${raw.childCount} children)`;
      lines.push(line);
    }
  }
  if (data.truncated === true) lines.push('Listing truncated; narrow path or lower depth/className.');
  return lines.join('\n');
}

function formatFind(data: Record<string, unknown>): string {
  const lines: string[] = [];
  if (Array.isArray(data.matches)) for (const raw of data.matches) {
    if (isRecord(raw)) lines.push(`${textValue(raw, 'path')} [${textValue(raw, 'className')}]`);
  }
  if (!lines.length) lines.push('No matches.');
  if (data.truncated === true) lines.push('Results truncated.');
  return lines.join('\n');
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function codeArg(args: Record<string, unknown>): string {
  const code = stringArg(args, 'code', true) as string;
  if (code.trim().length === 0) throw new Error('code must be a nonblank string.');
  if (Buffer.byteLength(code, 'utf8') > 200_000) throw new Error('code must be at most 200000 UTF-8 bytes.');
  return code;
}

function formatExecute(data: Record<string, unknown>): string {
  const logs = stringArray(data.logs);
  const returns = stringArray(data.returns);
  if (!logs.length && !returns.length) return 'Code executed successfully.';
  const sections: string[] = [];
  if (logs.length) sections.push(`Output:\n${logs.join('\n')}`);
  if (returns.length) sections.push(`Returns:\n${returns.join('\n')}`);
  return sections.join('\n\n');
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) result[key] = typeof item === 'string' ? item : JSON.stringify(item);
  return result;
}

function formatProperties(data: Record<string, unknown>): string {
  const count = typeof data.childCount === 'number' ? data.childCount : 0;
  const lines = [`${textValue(data, 'path')} [${textValue(data, 'className')}] (${count} children)`, 'Properties:'];
  const properties = stringMap(data.properties);
  for (const key of Object.keys(properties).sort((a, b) => a.localeCompare(b))) lines.push(`  ${key} = ${properties[key]}`);
  const attributes = stringMap(data.attributes);
  if (Object.keys(attributes).length) {
    lines.push('Attributes:');
    for (const key of Object.keys(attributes).sort((a, b) => a.localeCompare(b))) lines.push(`  ${key} = ${attributes[key]}`);
  }
  if (Array.isArray(data.tags) && data.tags.length) lines.push(`Tags: ${data.tags.filter((tag): tag is string => typeof tag === 'string').join(', ')}`);
  return lines.join('\n');
}

function formatSource(data: Record<string, unknown>): string {
  const lines = [`${textValue(data, 'path')} [${textValue(data, 'className')}] ${typeof data.lineCount === 'number' ? data.lineCount : 0} lines`];
  if (typeof data.runContext === 'string' && data.runContext) lines[0] += ` (${data.runContext})`;
  lines.push('```lua', textValue(data, 'source'), '```');
  if (data.truncated === true) lines.push('Source truncated.');
  return lines.join('\n');
}

const pathDescription = 'Paths look like "ReplicatedStorage/Shared" or "Workspace.Map" (either "/" or "." separators, optional leading "game"); omit path to use the whole game.';

const pack: ToolpackDefinition = {
  name: 'roblox',
  description: 'Inspect and run Luau, read output logs and selection, and control playtests across multiple Roblox Studio places through the paired DSH Bridge plugin.',
  async setup(ctx) {
    state.ctx = ctx;
    state.port = Number(process.env.DSH_ROBLOX_PORT) || 34872;
    const codePath = join(ctx.dataDir, 'pairing-code.txt');
    await mkdir(ctx.dataDir, { recursive: true });
    try {
      const stored = (await readFile(codePath, 'utf8')).trim().toUpperCase();
      if (/^[A-Z2-9]{8}$/.test(stored) && !/[01OI]/.test(stored)) state.code = stored;
    } catch { /* Generate the code below when there is no saved code. */ }
    if (!state.code) {
      state.code = Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
      await writeFile(codePath, state.code, 'utf8');
    }
    state.lastStatus = '';
    updateStatus();
    const server = createServer((req, res) => {
      void handle(req, res).catch((error: unknown) => {
        ctx.log(`Roblox bridge request failed: ${error instanceof Error ? error.message : String(error)}`);
        json(res, 500, { error: 'internal server error' });
      });
    });
    state.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.removeListener('listening', onListening);
        reject(new Error(`Could not start Roblox bridge on port ${state.port}: ${error.message}`));
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(state.port, '127.0.0.1');
    });
    state.statusTimer = setInterval(updateStatus, 5_000);
    state.statusTimer.unref();
  },
  async teardown() {
    if (state.statusTimer) clearInterval(state.statusTimer);
    state.statusTimer = undefined;
    for (const place of state.places.values()) for (const waiter of place.waiters.splice(0)) {
      waiter.closed = true;
      clearTimeout(waiter.timer);
      if (!waiter.res.destroyed && !waiter.res.writableEnded) { waiter.res.writeHead(204); waiter.res.end(); }
    }
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Roblox bridge shut down.'));
    }
    state.pending.clear();
    state.places.clear();
    const server = state.server;
    state.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    state.ctx = undefined;
    state.lastStatus = '';
  },
  tools: [
    {
      name: 'tree',
      description: `List the Roblox instance hierarchy. ${pathDescription}`,
      inputSchema: { type: 'object', properties: { place: placeSchema(), path: { type: 'string' }, depth: { type: 'integer', default: 3 }, maxNodes: { type: 'integer', default: 300 }, className: { type: 'string' } } },
      async run(args) {
        const path = stringArg(args, 'path');
        const depth = numberArg(args, 'depth', 3);
        const maxNodes = numberArg(args, 'maxNodes', 300);
        const className = stringArg(args, 'className');
        const sent: Record<string, unknown> = { depth, maxNodes };
        if (path !== undefined) sent.path = path;
        if (className !== undefined) sent.className = className;
        return formatTree(dataRecord(await commandFor(args, 'tree', sent)), depth);
      },
    },
    {
      name: 'find',
      description: `Find instances by name and/or className. ${pathDescription}`,
      inputSchema: { type: 'object', properties: { place: placeSchema(), path: { type: 'string' }, name: { type: 'string' }, className: { type: 'string' }, limit: { type: 'integer', default: 50 } } },
      async run(args) {
        const path = stringArg(args, 'path');
        const name = stringArg(args, 'name');
        const className = stringArg(args, 'className');
        if (name === undefined && className === undefined) throw new Error('Provide name or className to search.');
        const sent: Record<string, unknown> = { limit: numberArg(args, 'limit', 50) };
        if (path !== undefined) sent.path = path;
        if (name !== undefined) sent.name = name;
        if (className !== undefined) sent.className = className;
        return formatFind(dataRecord(await commandFor(args, 'find', sent)));
      },
    },
    {
      name: 'properties',
      description: 'Read an instance’s properties, attributes, and tags. Paths look like "ReplicatedStorage/Shared/Config" ("/" or "." separators). Optionally pass `properties` to read specific property names.',
      inputSchema: { type: 'object', required: ['path'], properties: { place: placeSchema(), path: { type: 'string' }, properties: { type: 'array', items: { type: 'string' } } } },
      async run(args) {
        const path = stringArg(args, 'path', true) as string;
        const sent: Record<string, unknown> = { path };
        if (args.properties !== undefined) {
          if (!Array.isArray(args.properties) || args.properties.some(item => typeof item !== 'string')) throw new Error('properties must be an array of strings.');
          sent.properties = args.properties;
        }
        return formatProperties(dataRecord(await commandFor(args, 'properties', sent)));
      },
    },
    {
      name: 'source',
      description: 'Read a script’s source code. Paths look like "ServerScriptService/Main" ("/" or "." separators).',
      inputSchema: { type: 'object', required: ['path'], properties: { place: placeSchema(), path: { type: 'string' }, maxChars: { type: 'integer', default: 20000 } } },
      async run(args) {
        const path = stringArg(args, 'path', true) as string;
        return formatSource(dataRecord(await commandFor(args, 'source', { path, maxChars: numberArg(args, 'maxChars', 20_000) })));
      },
    },
    {
      name: 'execute',
      description: 'Run Luau in the paired Studio place to create instances, change properties, or inspect values. Output is captured. The 20s limit only interrupts snippets that yield (task.wait etc.); a non-yielding infinite loop cannot be interrupted and can freeze Studio, so always put task.wait() in loops.',
      inputSchema: { type: 'object', required: ['code'], properties: { place: placeSchema(), code: { type: 'string', description: 'Luau source to execute in Studio (max 200000 UTF-8 bytes).' } } },
      async run(args) {
        const code = codeArg(args);
        return formatExecute(dataRecord(await commandFor(args, 'execute', { code })));
      },
    },
    {
      name: 'places', description: 'List connected Roblox Studio places.', inputSchema: { type: 'object', properties: {} },
      run() { prunePlaces(); const places = connectedPlaces(); return places.length ? places.map(place => `${place.name} | placeId: ${place.placeId} | session: ${place.session} | last seen: ${Math.floor((Date.now() - place.lastSeen) / 1000)}s ago`).join('\n') : `No Roblox Studio places connected. Pairing code: ${state.code}`; },
    },
    {
      name: 'output_log', description: 'Read captured Studio output logs, optionally filtered by level, text, or timestamp.',
      inputSchema: { type: 'object', properties: { place: placeSchema(), limit: { type: 'integer' }, level: { type: 'string', enum: ['all', 'output', 'info', 'warning', 'error'] }, contains: { type: 'string' }, sinceTimestamp: { type: 'number' }, clear: { type: 'boolean' } } },
      async run(args) {
        const sent: Record<string, unknown> = {};
        if (args.limit !== undefined) { if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000) throw new Error('limit must be an integer from 1 to 1000.'); sent.limit = args.limit; }
        const level = stringArg(args, 'level'); if (level !== undefined) { if (!['all', 'output', 'info', 'warning', 'error'].includes(level)) throw new Error('level must be all, output, info, warning, or error.'); sent.level = level; }
        const contains = stringArg(args, 'contains'); if (contains !== undefined) sent.contains = contains;
        if (args.sinceTimestamp !== undefined) { if (typeof args.sinceTimestamp !== 'number' || !Number.isFinite(args.sinceTimestamp)) throw new Error('sinceTimestamp must be a number.'); sent.sinceTimestamp = args.sinceTimestamp; }
        if (args.clear !== undefined) { if (typeof args.clear !== 'boolean') throw new Error('clear must be a boolean.'); sent.clear = args.clear; }
        const data = dataRecord(await commandFor(args, 'output_log', sent));
        const lines: string[] = [];
        if (Array.isArray(data.entries)) for (const entry of data.entries) if (isRecord(entry)) {
          const stamp = typeof entry.timestamp === 'number' && Number.isFinite(entry.timestamp) ? new Date(entry.timestamp * 1000).toISOString().slice(11, 19) : '??:??:??';
          lines.push(`[${stamp}] ${textValue(entry, 'level').toUpperCase()} ${textValue(entry, 'message')}`);
        }
        if (!lines.length) lines.push('No log entries.');
        if (data.truncated === true) lines.push('Log results truncated.');
        return lines.join('\n');
      },
    },
    {
      name: 'selection', description: 'Read or set the current Studio selection by instance paths.',
      inputSchema: { type: 'object', properties: { place: placeSchema(), action: { type: 'string', enum: ['get', 'set'] }, paths: { type: 'array', items: { type: 'string' } } } },
      async run(args) {
        const action = stringArg(args, 'action');
        if (action !== undefined && action !== 'get' && action !== 'set') throw new Error('action must be get or set.');
        const sent: Record<string, unknown> = {}; if (action !== undefined) sent.action = action;
        if (action === 'set' && (!Array.isArray(args.paths) || args.paths.some(path => typeof path !== 'string'))) throw new Error('paths must be an array of strings when action is set.');
        if (args.paths !== undefined) { if (!Array.isArray(args.paths) || args.paths.some(path => typeof path !== 'string')) throw new Error('paths must be an array of strings.'); sent.paths = args.paths; }
        const data = dataRecord(await commandFor(args, 'selection', sent));
        const lines: string[] = [];
        if (Array.isArray(data.selection)) for (const item of data.selection) if (isRecord(item)) lines.push(`${textValue(item, 'path')} [${textValue(item, 'className')}]`);
        if (Array.isArray(data.missing) && data.missing.length) lines.push(`Missing: ${stringArray(data.missing).join(', ')}`);
        return lines.length ? lines.join('\n') : 'Selection is empty.';
      },
    },
    {
      name: 'playtest', description: 'Control Studio playtests through the paired plugin. Run mode simulates without a character; play mode starts Play Solo.',
      inputSchema: { type: 'object', required: ['action'], properties: { place: placeSchema(), action: { type: 'string', enum: ['status', 'start', 'stop'] }, mode: { type: 'string', enum: ['run', 'play'] } } },
      async run(args) {
        const action = stringArg(args, 'action', true) as string;
        if (!['status', 'start', 'stop'].includes(action)) throw new Error('action must be status, start, or stop.');
        const sent: Record<string, unknown> = { action };
        const mode = stringArg(args, 'mode'); if (mode !== undefined) { if (mode !== 'run' && mode !== 'play') throw new Error('mode must be run or play.'); sent.mode = mode; }
        const data = dataRecord(await commandFor(args, 'playtest', sent));
        return `${textValue(data, 'message')}\nstate: ${textValue(data, 'state')}`;
      },
    },
  ],
};

export default pack;
