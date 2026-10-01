import { randomUUID } from 'node:crypto';
import { ChildProcess, fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { HostToWorker, ToolDescriptor, ToolpackManifest, WorkerToHost, ToolpackResult } from './types';
import { truncateToolpackResult } from './result';

export interface ToolpackInfo {
    id: string;
    description: string;
    enabled: boolean;
    state: 'starting' | 'running' | 'stopped' | 'error';
    status: string;
    error?: string;
    tools: { name: string; description: string }[];
    logs: string[];
}

export interface ToolpackRegistryOptions {
    dir: string;
    workerPath: string;
    /** Node binary to run packs with. Defaults to the current executable (as Node when under Electron). */
    nodePath?: () => string | undefined;
    /** Turns the uploaded TypeScript into CommonJS JavaScript. */
    compile(source: string): Promise<string>;
    callTimeoutMs?: number;
    maxOutputChars?: number;
}

interface Entry {
    info: ToolpackInfo;
    descriptors: ToolDescriptor[];
    child?: ChildProcess;
    pending: Map<number, { resolve(result: ToolpackResult): void; timer: NodeJS.Timeout }>;
    stopping?: boolean;
}

interface Meta { description: string; enabled: boolean }

const LOG_LIMIT = 50;

export class ToolpackRegistry {
    private readonly entries = new Map<string, Entry>();
    private readonly listeners = new Set<() => void>();
    private nextCall = 1;

    public constructor(private readonly options: ToolpackRegistryOptions) { }

    public onChange(listener: () => void): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    public list(): ToolpackInfo[] { return [...this.entries.values()].map(entry => ({ ...entry.info, tools: [...entry.info.tools], logs: [...entry.info.logs] })); }

    /** Agent-facing tools of every running pack, named `<pack>_<tool>`. */
    public descriptors(): ToolDescriptor[] {
        return [...this.entries.values()].filter(entry => entry.info.state === 'running').flatMap(entry => entry.descriptors);
    }

    public owns(tool: string): boolean { return !!this.find(tool); }

    public async start(): Promise<void> {
        await fs.mkdir(this.options.dir, { recursive: true });
        for (const item of await fs.readdir(this.options.dir, { withFileTypes: true })) {
            if (!item.isDirectory() || item.name.startsWith('.')) continue;
            const meta = await this.readMeta(item.name);
            if (!meta) continue;
            const entry = this.newEntry(item.name, meta);
            this.entries.set(item.name, entry);
            if (meta.enabled) void this.launch(item.name);
        }
        this.emit();
    }

    public async add(sourcePath: string): Promise<ToolpackInfo> {
        const source = await fs.readFile(sourcePath, 'utf8');
        const javascript = await this.options.compile(source);
        const staging = join(this.options.dir, `.staging-${randomUUID()}`);
        await fs.mkdir(staging, { recursive: true });
        try {
            await fs.writeFile(join(staging, 'pack.js'), javascript);
            const manifest = await this.probe(join(staging, 'pack.js'), join(staging, 'data'));
            const id = manifest.name;
            const previous = this.entries.get(id);
            if (previous) await this.halt(id);
            const folder = join(this.options.dir, id);
            await fs.mkdir(folder, { recursive: true });
            await fs.writeFile(join(folder, 'pack.ts'), source);
            await fs.writeFile(join(folder, 'pack.js'), javascript);
            const meta: Meta = { description: manifest.description, enabled: previous ? previous.info.enabled : true };
            await fs.writeFile(join(folder, 'meta.json'), JSON.stringify(meta));
            const entry = this.newEntry(id, meta);
            this.entries.set(id, entry);
            this.emit();
            if (meta.enabled) await this.launch(id);
            return this.snapshot(id);
        } finally {
            await fs.rm(staging, { recursive: true, force: true });
        }
    }

    public async remove(id: string): Promise<void> {
        if (!this.entries.has(id)) return;
        await this.halt(id);
        this.entries.delete(id);
        await fs.rm(join(this.options.dir, basename(id)), { recursive: true, force: true });
        this.emit();
    }

    public async setEnabled(id: string, enabled: boolean): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry) return;
        entry.info.enabled = enabled;
        await this.writeMeta(id, { description: entry.info.description, enabled });
        if (enabled) await this.reload(id);
        else { await this.halt(id); this.emit(); }
    }

    public async reload(id: string): Promise<void> {
        if (!this.entries.has(id)) return;
        await this.halt(id);
        await this.launch(id);
    }

    public async call(tool: string, args: Record<string, unknown>): Promise<ToolpackResult> {
        const found = this.find(tool);
        if (!found) return { text: `Unknown tool "${tool}".`, isError: true };
        const { entry, name } = found;
        if (entry.info.state !== 'running' || !entry.child) return { text: `Toolpack "${entry.info.id}" is not running${entry.info.error ? `: ${entry.info.error}` : ''}.`, isError: true };
        const id = this.nextCall++;
        const timeout = this.options.callTimeoutMs ?? 60_000;
        const result = await new Promise<ToolpackResult>(resolve => {
            const timer = setTimeout(() => { entry.pending.delete(id); resolve({ text: `Tool "${tool}" timed out after ${Math.round(timeout / 1000)}s.`, isError: true }); }, timeout);
            entry.pending.set(id, { resolve, timer });
            this.post(entry.child!, { type: 'call', id, tool: name, args });
        });
        const max = this.options.maxOutputChars ?? 60_000;
        return truncateToolpackResult(result, max);
    }

    public async dispose(): Promise<void> {
        await Promise.all([...this.entries.keys()].map(id => this.halt(id)));
        this.listeners.clear();
    }

    private find(tool: string): { entry: Entry; name: string } | undefined {
        for (const entry of this.entries.values()) {
            const prefix = `${entry.info.id}_`;
            if (tool.startsWith(prefix) && entry.info.tools.some(item => item.name === tool.slice(prefix.length))) return { entry, name: tool.slice(prefix.length) };
        }
        return undefined;
    }

    private newEntry(id: string, meta: Meta): Entry {
        return { info: { id, description: meta.description, enabled: meta.enabled, state: 'stopped', status: '', tools: [], logs: [] }, descriptors: [], pending: new Map() };
    }

    private snapshot(id: string): ToolpackInfo { return this.list().find(item => item.id === id)!; }

    private emit(): void { for (const listener of this.listeners) listener(); }

    private post(child: ChildProcess, message: HostToWorker): void {
        if (child.connected) child.send(message);
    }

    private async readMeta(id: string): Promise<Meta | undefined> {
        try {
            await fs.access(join(this.options.dir, id, 'pack.js'));
            const meta = JSON.parse(await fs.readFile(join(this.options.dir, id, 'meta.json'), 'utf8')) as Partial<Meta>;
            return { description: typeof meta.description === 'string' ? meta.description : '', enabled: meta.enabled !== false };
        } catch { return undefined; }
    }

    private writeMeta(id: string, meta: Meta): Promise<void> {
        return fs.writeFile(join(this.options.dir, basename(id), 'meta.json'), JSON.stringify(meta));
    }

    private spawn(): ChildProcess {
        const nodePath = this.options.nodePath?.() || undefined;
        return fork(this.options.workerPath, [], {
            execPath: nodePath || process.execPath,
            env: { ...process.env, ...(nodePath ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
            windowsHide: true,
        });
    }

    /** Loads a pack in a throwaway process, without running its setup, to read its manifest. */
    private probe(file: string, dataDir: string): Promise<ToolpackManifest> {
        return new Promise((resolve, reject) => {
            const child = this.spawn();
            const finish = (action: () => void): void => { clearTimeout(timer); child.removeAllListeners(); child.on('error', () => undefined); child.kill(); action(); };
            const timer = setTimeout(() => finish(() => reject(new Error('The toolpack took too long to load.'))), 15_000);
            child.on('message', (message: WorkerToHost) => {
                if (message.type === 'loaded') finish(() => resolve(message.manifest));
                else if (message.type === 'failed') finish(() => reject(new Error(message.error)));
            });
            child.on('error', error => finish(() => reject(error)));
            child.on('exit', code => finish(() => reject(new Error(`The toolpack process exited with code ${code}.`))));
            this.post(child, { type: 'load', file, dataDir });
        });
    }

    private launch(id: string): Promise<void> {
        const entry = this.entries.get(id);
        if (!entry) return Promise.resolve();
        entry.stopping = false;
        entry.info.state = 'starting';
        entry.info.error = undefined;
        entry.info.status = '';
        this.emit();
        const child = this.spawn();
        entry.child = child;
        const fail = (error: string): void => {
            entry.info.state = 'error';
            entry.info.error = error;
            entry.descriptors = [];
            this.emit();
        };
        return new Promise<void>(resolve => {
            child.on('message', (message: WorkerToHost) => {
                if (entry.child !== child) return;
                if (message.type === 'loaded') {
                    entry.info.description = message.manifest.description;
                    entry.info.tools = message.manifest.tools.map(tool => ({ name: tool.name, description: tool.description }));
                    entry.descriptors = message.manifest.tools.map(tool => ({ name: `${id}_${tool.name}`, description: tool.description, inputSchema: tool.inputSchema }));
                    this.post(child, { type: 'start' });
                } else if (message.type === 'started') {
                    entry.info.state = 'running';
                    this.emit();
                    resolve();
                } else if (message.type === 'failed') {
                    fail(message.error);
                    child.kill();
                    resolve();
                } else if (message.type === 'result') {
                    const pending = entry.pending.get(message.id);
                    if (!pending) return;
                    clearTimeout(pending.timer);
                    entry.pending.delete(message.id);
                    pending.resolve({ text: message.text, content: message.content, isError: message.isError });
                } else if (message.type === 'status') {
                    entry.info.status = message.text;
                    this.emit();
                } else if (message.type === 'log') {
                    entry.info.logs.push(message.text);
                    if (entry.info.logs.length > LOG_LIMIT) entry.info.logs.splice(0, entry.info.logs.length - LOG_LIMIT);
                    this.emit();
                }
            });
            child.on('error', error => { if (entry.child === child) fail(error.message); resolve(); });
            child.on('exit', code => {
                if (entry.child !== child) return;
                entry.child = undefined;
                for (const [callId, pending] of entry.pending) { clearTimeout(pending.timer); pending.resolve({ text: `Toolpack "${id}" stopped.`, isError: true }); entry.pending.delete(callId); }
                if (!entry.stopping && entry.info.state !== 'error') fail(`The toolpack process exited unexpectedly (code ${code}).`);
                else if (entry.stopping) { entry.info.state = 'stopped'; entry.descriptors = []; this.emit(); }
                resolve();
            });
            this.post(child, { type: 'load', file: join(this.options.dir, id, 'pack.js'), dataDir: join(this.options.dir, id, 'data') });
        });
    }

    private async halt(id: string): Promise<void> {
        const entry = this.entries.get(id);
        const child = entry?.child;
        if (!entry || !child) { if (entry && entry.info.state !== 'error') entry.info.state = 'stopped'; return; }
        entry.stopping = true;
        await new Promise<void>(resolve => {
            const timer = setTimeout(() => child.kill(), 1500);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            this.post(child, { type: 'stop' });
        });
    }
}
