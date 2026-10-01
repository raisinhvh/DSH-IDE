import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import * as vscode from 'vscode';

export type OAuthCliProvider = 'codex-cli' | 'claude-cli';
export interface OAuthCliAccount {
  id: string;
  provider: OAuthCliProvider;
  label: string;
  email?: string;
  directory: string;
}

const KEY = 'dsh.oauthCliAccounts.v1';
const DEFAULTS = 'dsh.oauthCliDefaults.v1';
const detectedCommands = new Map<string, string>();

export function setDetectedCliCommand(provider: string, command: string): void {
  detectedCommands.set(provider, command);
}

export function cliCommand(provider: OAuthCliProvider): string {
  const setting = vscode.workspace.getConfiguration('dsh').get<string>(provider === 'codex-cli' ? 'runtime.codexPath' : 'runtime.claudePath')?.trim();
  if (setting) return setting;
  const detected = detectedCommands.get(provider);
  if (detected) return detected;
  if (provider === 'claude-cli' && process.platform === 'win32') {
    const installed = join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(installed)) return installed;
  }
  return provider === 'codex-cli' ? 'codex' : 'claude';
}

export function cliEnv(account: OAuthCliAccount): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (account.provider === 'codex-cli') {
    env.CODEX_HOME = account.directory;
    delete env.OPENAI_API_KEY;
    delete env.CODEX_ACCESS_TOKEN;
    delete env.CODEX_API_KEY;
    delete env.OPENAI_BASE_URL;
  } else {
    env.CLAUDE_CONFIG_DIR = account.directory;
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    delete env.CLAUDE_CODE_USE_FOUNDRY;
  }
  return env;
}

function execute(account: OAuthCliAccount, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    let done = false;
    const child = spawn(cliCommand(account.provider), args, { env: cliEnv(account), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); finish(new Error('Browser sign-in timed out.')); }, timeoutMs);
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(output);
    };
    const read = (data: Buffer): void => { output = (output + data.toString('utf8')).slice(-32768); };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', () => finish(new Error(`${account.provider === 'codex-cli' ? 'Codex' : 'Claude Code'} CLI could not start. Check its path in Settings.`)));
    child.on('close', code => finish(code === 0 ? undefined : new Error(`Sign-in command failed. Check the ${account.provider === 'codex-cli' ? 'Codex' : 'Claude Code'} login in a terminal.`)));
  });
}

/** OAuth credentials remain in isolated directories owned by the official CLIs. */
export class OAuthCliAccounts {
  constructor(private readonly context: vscode.ExtensionContext) {}

  list(provider?: OAuthCliProvider): OAuthCliAccount[] {
    const value = this.context.globalState.get<OAuthCliAccount[]>(KEY, []);
    return (provider ? value.filter(item => item.provider === provider) : value).filter(item =>
      item && typeof item.id === 'string' && typeof item.directory === 'string');
  }

  get(id: string): OAuthCliAccount | undefined { return this.list().find(item => item.id === id); }

  getDefault(provider: OAuthCliProvider): OAuthCliAccount | undefined {
    const defaults = this.context.globalState.get<Record<string, string>>(DEFAULTS, {});
    return this.get(defaults[provider]) || this.list(provider)[0];
  }

  async add(provider: OAuthCliProvider, label: string, email?: string): Promise<OAuthCliAccount> {
    const cleanLabel = label.trim();
    if (!cleanLabel) throw new Error('Account name is required.');
    const account: OAuthCliAccount = {
      id: `${provider}:${randomUUID()}`, provider, label: cleanLabel, email: email?.trim() || undefined,
      directory: join(this.context.globalStorageUri.fsPath, 'oauth', provider, randomUUID()),
    };
    await mkdir(account.directory, { recursive: true });
    try {
      await execute(account, provider === 'codex-cli' ? ['login'] : ['auth', 'login', '--claudeai', ...(account.email ? ['--email', account.email] : [])], 300000);
      const status = await execute(account, provider === 'codex-cli' ? ['login', 'status'] : ['auth', 'status', '--json'], 15000);
      if (provider === 'codex-cli') {
        if (!/logged in.*chatgpt|chatgpt.*logged in/i.test(status)) throw new Error('Codex did not report a ChatGPT sign-in.');
      } else {
        const info = JSON.parse(status) as { loggedIn?: boolean; email?: string; authMethod?: string };
        if (!info.loggedIn || info.authMethod !== 'claude.ai') throw new Error('Claude Code did not report a subscription sign-in.');
        account.email = info.email || account.email;
      }
    } catch (error) {
      await rm(account.directory, { recursive: true, force: true });
      throw error;
    }
    await this.context.globalState.update(KEY, [...this.list(), account]);
    if (!this.getDefault(provider)) await this.setDefault(provider, account.id);
    return account;
  }

  async setDefault(provider: OAuthCliProvider, id: string): Promise<void> {
    if (this.get(id)?.provider !== provider) throw new Error('Account does not belong to this provider.');
    const defaults = this.context.globalState.get<Record<string, string>>(DEFAULTS, {});
    await this.context.globalState.update(DEFAULTS, { ...defaults, [provider]: id });
  }

  async remove(id: string): Promise<void> {
    const account = this.get(id);
    if (!account) return;
    const base = resolve(this.context.globalStorageUri.fsPath, 'oauth', account.provider);
    const child = relative(base, resolve(account.directory));
    if (!child || child.startsWith('..') || child.includes(':')) throw new Error('Account storage path is invalid.');
    await execute(account, account.provider === 'codex-cli' ? ['logout'] : ['auth', 'logout'], 15000).catch(() => undefined);
    await rm(account.directory, { recursive: true, force: true });
    const remaining = this.list().filter(item => item.id !== id);
    await this.context.globalState.update(KEY, remaining);
    const defaults = this.context.globalState.get<Record<string, string>>(DEFAULTS, {});
    if (defaults[account.provider] === id) {
      const next = remaining.find(item => item.provider === account.provider);
      if (next) defaults[account.provider] = next.id; else delete defaults[account.provider];
      await this.context.globalState.update(DEFAULTS, defaults);
    }
  }
}
