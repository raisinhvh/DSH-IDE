import { randomBytes } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';

export interface DelegateAgentInfo { name: string; description?: string; mode: 'read-only' | 'edit'; model: string }
export interface DelegateResult { text: string; isError?: boolean }
export interface DelegateToolInfo { name: string; description: string; inputSchema: Record<string, unknown> }

export interface DelegateHandlers {
  describe(owner: string): DelegateAgentInfo[];
  /** Extra tools from enabled custom toolpacks. */
  tools(owner: string): DelegateToolInfo[];
  call(owner: string, tool: string, args: Record<string, unknown>): Promise<DelegateResult>;
}

/** Loopback HTTP bridge between the stdio MCP server that agents spawn and the extension host. */
export class DelegateHost {
  public readonly token = randomBytes(24).toString('hex');
  private server?: Server;
  private port = 0;

  public get url(): string | undefined { return this.port ? `http://127.0.0.1:${this.port}` : undefined; }

  public start(handlers: DelegateHandlers): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(handlers, req, res); });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as { port: number }).port;
        this.server = server;
        resolve();
      });
    });
  }

  public dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }

  private async handle(handlers: DelegateHandlers, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST' || req.headers['x-dsh-token'] !== this.token) { send(403, { error: 'forbidden' }); return; }
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) { send(413, { error: 'too large' }); return; }
    }
    let body: { owner?: string; tool?: string; args?: Record<string, unknown> };
    try { body = JSON.parse(raw) as typeof body; } catch { send(400, { error: 'bad json' }); return; }
    const owner = typeof body.owner === 'string' ? body.owner : '';
    try {
      if (req.url === '/describe') send(200, { agents: handlers.describe(owner), tools: handlers.tools(owner) });
      else if (req.url === '/call' && typeof body.tool === 'string') {
        // Subagents can run for minutes; whitespace keeps the client's fetch from hitting its header/body timeouts.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.flushHeaders();
        const keepAlive = setInterval(() => res.write(' '), 20_000);
        try { res.end(JSON.stringify(await handlers.call(owner, body.tool, body.args && typeof body.args === 'object' ? body.args : {}))); }
        catch (error) { res.end(JSON.stringify({ text: error instanceof Error ? error.message : String(error), isError: true })); }
        finally { clearInterval(keepAlive); }
      }
      else send(404, { error: 'not found' });
    } catch (error) {
      send(200, { text: error instanceof Error ? error.message : String(error), isError: true });
    }
  }
}
