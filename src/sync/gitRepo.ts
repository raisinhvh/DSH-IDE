import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Someone else pushed first; read the repository again and retry. */
export class PushRejected extends Error {}

export interface GitAuth { token: string; login: string }

const BRANCH = 'main';
const TIMEOUT = 120_000;

/**
 * DSH's own clone of the sync repository. DSH writes every file in it, so it never holds local edits:
 * each read resets it to the remote branch, and each write commits on top of what was read.
 */
export class SyncClone {
  public constructor(private readonly dir: string, private readonly git: string) {}

  private env(auth?: GitAuth): NodeJS.ProcessEnv {
    const config: [string, string][] = [
      // The token travels in git's environment-only config, never on a command line or in a file.
      ...(auth ? [['http.https://github.com/.extraheader', `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${auth.token}`).toString('base64')}`] as [string, string]] : []),
      // No other helper may prompt or store anything; files stay byte for byte as DSH wrote them.
      ['credential.helper', ''], ['core.autocrlf', 'false'], ['core.safecrlf', 'false'], ['core.longpaths', 'true'], ['core.quotepath', 'false'],
    ];
    const name = auth?.login || 'DSH-IDE';
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '',
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `${name}@users.noreply.github.com`, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: `${name}@users.noreply.github.com`,
      GIT_CONFIG_COUNT: String(config.length),
      ...Object.fromEntries(config.flatMap(([key, value], index) => [[`GIT_CONFIG_KEY_${index}`, key], [`GIT_CONFIG_VALUE_${index}`, value]])),
    };
  }

  private run(args: string[], auth?: GitAuth): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.git, args, { cwd: this.dir, env: this.env(auth), timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        if (!error) { resolve(stdout); return; }
        const text = `${stderr || ''}${stdout || ''}`.trim();
        if (args[0] === 'push' && /\[rejected\]|fetch first|non-fast-forward/i.test(text)) { reject(new PushRejected('The sync repository changed while uploading.')); return; }
        reject(new Error(`git ${args[0]} failed: ${(text || error.message).split('\n').slice(-4).join(' ')}`));
      });
    });
  }

  /** Creates the clone on first use and points it at `url`. */
  public async prepare(url: string): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    if (!existsSync(join(this.dir, '.git'))) {
      await this.run(['init', '-q']);
      await this.run(['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`]);
    }
    const remotes = (await this.run(['remote'])).split('\n').map(line => line.trim());
    await this.run(remotes.includes('origin') ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
  }

  /** Fetches the remote branch and makes the clone match it. Returns its files, or an empty map for an empty repository. */
  public async read(auth?: GitAuth): Promise<Map<string, Buffer>> {
    await this.run(['fetch', '-q', '--prune', 'origin'], auth);
    const head = await this.run(['rev-parse', '--verify', '-q', `refs/remotes/origin/${BRANCH}`]).then(out => out.trim(), () => '');
    if (head) {
      await this.run(['reset', '-q', '--hard', head]);
      await this.run(['clean', '-q', '-f', '-d', '-x']);
    } else {
      // Nothing pushed yet: start the branch fresh, dropping anything an earlier failed upload left.
      await this.run(['update-ref', '-d', 'HEAD']).catch(() => undefined);
      await this.run(['read-tree', '--empty']);
      await this.writeTree(new Map());
    }
    return this.readTree();
  }

  /** Commits `tree` on top of the last read and pushes it. Returns false when there was nothing to commit. */
  public async write(tree: Map<string, Buffer>, message: string, auth?: GitAuth): Promise<boolean> {
    await this.writeTree(tree);
    await this.run(['add', '-A']);
    if (!(await this.run(['status', '--porcelain'])).trim()) return false;
    await this.run(['commit', '-q', '--no-verify', '-m', message]);
    await this.run(['push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`], auth);
    return true;
  }

  private async files(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (directory === this.dir && entry.name === '.git') continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) found.push(relative(this.dir, full).split(sep).join('/'));
      }
    };
    await walk(this.dir);
    return found;
  }

  private async readTree(): Promise<Map<string, Buffer>> {
    const tree = new Map<string, Buffer>();
    for (const path of await this.files()) tree.set(path, await fs.readFile(join(this.dir, ...path.split('/'))));
    return tree;
  }

  private async writeTree(tree: Map<string, Buffer>): Promise<void> {
    for (const path of await this.files()) {
      if (tree.has(path)) continue;
      const file = join(this.dir, ...path.split('/'));
      await fs.rm(file, { force: true });
      for (let folder = dirname(file); folder !== this.dir && folder.startsWith(this.dir + sep); folder = dirname(folder)) {
        try { await fs.rmdir(folder); } catch { break; }
      }
    }
    for (const [path, data] of tree) {
      const file = join(this.dir, ...path.split('/'));
      const current = await fs.readFile(file).catch(() => undefined);
      if (current?.equals(data)) continue;
      await fs.mkdir(dirname(file), { recursive: true });
      await fs.writeFile(file, data);
    }
  }
}
