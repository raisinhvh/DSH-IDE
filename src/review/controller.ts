import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { applySelectedHunks, computeHunks, DiffHunk } from './hunks';
import { assertApplyPrecondition } from './guards';
import { pairExactRenames } from './renames';
import type { MirrorChange } from '../runtime/shadow';

export type ProposalState = 'pending' | 'applied' | 'rejected';
export interface ReviewProposal {
  id: string;
  path: string;
  fromPath?: string;
  base?: string;
  proposed?: string;
  state: ProposalState;
  hunks: DiffHunk[];
}

const keyOf = (path: string, base?: string, proposed?: string): string => createHash('sha256').update(path).update('\0').update(base ?? '<new>').update('\0').update(proposed ?? '<deleted>').digest('hex');

/** Native virtual diff documents and guarded VS Code WorkspaceEdit application. */
export class ReviewController implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private proposals = new Map<string, ReviewProposal>();
  private settled = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private readonly proposalsChanged = new vscode.EventEmitter<ReviewProposal[]>();
  public readonly onDidChange = this.changed.event;
  public readonly onProposalsChanged = this.proposalsChanged.event;
  private readonly registration: vscode.Disposable;

  public constructor(
    private readonly root: vscode.Uri,
    private readonly acknowledge: (path: string, text?: string) => Promise<void>,
    private readonly scheme = 'dsh-review',
    private readonly restore?: (path: string, text?: string) => Promise<void>,
  ) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(this.scheme, this);
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    const path = decodeURIComponent(uri.path.slice(1));
    const proposal = this.proposals.get(path);
    if (!proposal) return '';
    return uri.query === 'base' ? proposal.base ?? '' : proposal.proposed ?? '';
  }

  public list(): ReviewProposal[] { return [...this.proposals.values()]; }
  public pending(): ReviewProposal[] { return this.list().filter(item => item.state === 'pending'); }
  public get(id: string): ReviewProposal | undefined { return this.list().find(item => item.id === id); }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  public update(changes: MirrorChange[]): void {
    void this.enqueue(async () => {
      const modified = this.mergeChanges(changes);
      if (!modified) return;
      this.proposalsChanged.fire(this.list());
      for (const proposal of this.pending()) {
        try { await this.applyBatch([proposal]); }
        catch (error) { void vscode.window.showWarningMessage(`DSH could not auto-apply ${proposal.path}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    });
  }

  private rebaseSnapshot(path: string, base: string | undefined): string | undefined {
    const existing = this.proposals.get(path);
    if (existing?.state === 'applied' && base !== undefined && base === existing.base) return existing.proposed ?? base;
    return base;
  }

  private mergeChanges(changes: MirrorChange[]): boolean {
    let modified = false;
    const handled = new Set<string>();
    for (const rename of pairExactRenames(changes)) {
      const fromPath = this.validatePath(rename.fromPath);
      const path = this.validatePath(rename.path);
      handled.add(fromPath); handled.add(path);
      const base = this.rebaseSnapshot(fromPath, rename.text);
      if (this.proposals.delete(fromPath)) modified = true;
      const id = keyOf(`${fromPath}->${path}`, base, base);
      if (this.settled.has(id)) continue;
      const existing = this.proposals.get(path);
      if (existing?.id === id) continue;
      this.proposals.set(path, { id, path, fromPath, base, proposed: base, state: 'pending', hunks: [] });
      this.fireDocs(path);
      modified = true;
    }
    for (const change of changes) {
      if (handled.has(change.path)) continue;
      const path = this.validatePath(change.path);
      const rebased = { ...change, base: this.rebaseSnapshot(path, change.base) };
      if (rebased.base === rebased.proposed) {
        // Acknowledgement advances the mirror baseline. Keep the applied diff
        // visible so Accept/Reject can still settle or undo it.
        if (this.proposals.get(path)?.state !== 'applied' && this.proposals.delete(path)) modified = true;
        continue;
      }
      const id = keyOf(path, rebased.base, rebased.proposed);
      if (this.settled.has(id)) continue;
      const existing = this.proposals.get(path);
      if (existing?.id === id && existing.base === rebased.base) continue;
      const hunks = rebased.base !== undefined && rebased.proposed !== undefined
        ? computeHunks(rebased.base, rebased.proposed) : [];
      this.proposals.set(path, { id, path, base: rebased.base, proposed: rebased.proposed, state: 'pending', hunks });
      this.fireDocs(path);
      modified = true;
    }
    return modified;
  }

  private async revert(proposal: ReviewProposal): Promise<void> {
    const target = await this.safeTarget(proposal.path);
    const edit = new vscode.WorkspaceEdit();
    if (proposal.fromPath) {
      edit.renameFile(target, await this.safeTarget(proposal.fromPath), { overwrite: false });
    } else if (proposal.base === undefined) {
      edit.deleteFile(target, { ignoreIfNotExists: true });
    } else if (proposal.proposed === undefined) {
      edit.createFile(target, { ignoreIfExists: true });
      edit.insert(target, new vscode.Position(0, 0), proposal.base);
    } else {
      const doc = await vscode.workspace.openTextDocument(target);
      edit.replace(target, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), proposal.base);
    }
    if (!await vscode.workspace.applyEdit(edit, { isRefactoring: false })) throw new Error(`VS Code could not undo ${proposal.path}.`);
    await this.saveDocs([proposal.fromPath ?? proposal.path]);
    if (proposal.fromPath) { await this.syncMirror(proposal.path, undefined); await this.syncMirror(proposal.fromPath, proposal.base); }
    else await this.syncMirror(proposal.path, proposal.base);
  }

  private async saveDocs(paths: string[]): Promise<void> {
    for (const path of paths) {
      const uri = vscode.Uri.file(join(this.root.fsPath, path));
      const doc = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
      if (doc?.isDirty) await doc.save();
    }
  }

  public async open(id: string): Promise<void> {
    const proposal = this.get(id);
    if (!proposal) throw new Error('Review item no longer exists.');
    const base = this.virtualUri(proposal.path, 'base');
    const proposed = this.virtualUri(proposal.path, 'proposed');
    await vscode.commands.executeCommand('vscode.diff', base, proposed, `DSH Review: ${proposal.fromPath ? `${proposal.fromPath} → ` : ''}${proposal.path}`, { preview: true });
  }

  public async openAll(): Promise<void> {
    const pending = this.pending();
    if (!pending.length) return;
    const resources = pending.map(proposal => [
      vscode.Uri.file(join(this.root.fsPath, proposal.path)),
      this.virtualUri(proposal.path, 'base'),
      this.virtualUri(proposal.path, 'proposed'),
    ] as const);
    try { await vscode.commands.executeCommand('vscode.changes', 'DSH Proposed Edits', resources); }
    catch { await this.open(pending[0].id); }
  }

  public apply(id: string): Promise<void> {
    return this.enqueue(async () => {
      const proposal = this.get(id);
      if (!proposal) return;
      if (proposal.state === 'applied') this.dismiss(proposal);
      else if (proposal.state === 'pending') await this.applyBatch([proposal]);
      this.proposalsChanged.fire(this.list());
    });
  }

  public applyAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const proposal of this.list()) {
        if (proposal.state === 'applied') this.dismiss(proposal);
      }
      await this.applyBatch(this.pending());
      this.proposalsChanged.fire(this.list());
    });
  }

  public reject(id: string): Promise<void> {
    return this.enqueue(async () => {
      const proposal = this.get(id);
      if (!proposal) return;
      if (proposal.state === 'applied') await this.revert(proposal);
      else if (proposal.state === 'pending') await this.restoreBaseline(proposal);
      this.dismiss(proposal);
      this.proposalsChanged.fire(this.list());
    });
  }

  public rejectAll(): Promise<void> {
    return this.enqueue(async () => {
      for (const proposal of [...this.list()]) {
        if (proposal.state === 'applied') await this.revert(proposal);
        else if (proposal.state === 'pending') await this.restoreBaseline(proposal);
        this.dismiss(proposal);
      }
      this.proposalsChanged.fire(this.list());
    });
  }

  private async syncMirror(path: string, text?: string): Promise<void> {
    await (this.restore ?? this.acknowledge)(path, text);
  }

  private async restoreBaseline(proposal: ReviewProposal): Promise<void> {
    this.settled.add(proposal.id);
    if (proposal.fromPath) {
      await this.syncMirror(proposal.path, undefined);
      await this.syncMirror(proposal.fromPath, proposal.base);
    } else {
      await this.syncMirror(proposal.path, proposal.base);
    }
  }

  private dismiss(proposal: ReviewProposal): void {
    this.settled.add(proposal.id);
    this.proposals.delete(proposal.path);
  }

  public async chooseHunk(action: 'apply' | 'reject'): Promise<void> {
    const file = await vscode.window.showQuickPick(this.pending().filter(item => item.hunks.length).map(item => ({
      label: item.path, description: `${item.hunks.length} hunks`, item,
    })), { placeHolder: 'Choose a file to review' });
    if (!file) return;
    const picked = await vscode.window.showQuickPick(file.item.hunks.map((hunk, index) => ({
      label: `Hunk ${index + 1}: lines ${hunk.baseStart + 1}-${Math.max(hunk.baseStart + 1, hunk.baseEnd)}`,
      description: hunk.currentLines.slice(0, 2).join('').trim().slice(0, 80), hunk,
    })), { placeHolder: `${action === 'apply' ? 'Apply' : 'Reject'} which hunk?` });
    if (!picked) return;
    if (action === 'reject') {
      const remaining = file.item.hunks.filter(hunk => hunk.id !== picked.hunk.id);
      if (!remaining.length) { await this.reject(file.item.id); return; }
      const proposed = applySelectedHunks(file.item.base!, file.item.proposed!, remaining.map(hunk => hunk.id));
      this.settled.add(file.item.id);
      this.update([{ path: file.item.path, base: file.item.base, proposed }]);
      return;
    }
    const selected = applySelectedHunks(file.item.base!, file.item.proposed!, [picked.hunk.id]);
    await this.applyBatch([{ ...file.item, proposed: selected }]);
    this.settled.add(file.item.id);
  }

  public dispose(): void {
    this.registration.dispose();
    this.changed.dispose();
    this.proposalsChanged.dispose();
  }

  private async applyBatch(proposals: ReviewProposal[]): Promise<void> {
    if (!proposals.length) return;
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before applying DSH edits.');
    const edit = new vscode.WorkspaceEdit();
    const newParents = new Set<string>();
    for (const proposal of proposals) {
      const target = await this.safeTarget(proposal.path);
      if (proposal.fromPath) {
        const source = await this.safeTarget(proposal.fromPath);
        const sourceDoc = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === source.toString());
        let sourceLive: string | undefined;
        try { sourceLive = sourceDoc?.getText() ?? (await fs.readFile(source.fsPath)).toString('utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        let targetLive: string | undefined;
        try { targetLive = (await fs.readFile(target.fsPath)).toString('utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (sourceLive === undefined && targetLive === undefined) {
          throw new Error(`Review conflict in ${proposal.fromPath}: rename source and target are both missing.`);
        }
        if (sourceLive === undefined && targetLive === proposal.proposed) continue;
        assertApplyPrecondition(proposal.fromPath, proposal.base, sourceLive, !!sourceDoc?.isDirty, true);
        let targetExists = false;
        try { await fs.lstat(target.fsPath); targetExists = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (targetExists) {
          if (targetLive === proposal.proposed) {
            if (sourceLive !== undefined) edit.deleteFile(source, { ignoreIfNotExists: true });
            continue;
          }
          throw new Error(`Review conflict in ${proposal.path}: rename target already exists.`);
        }
        if (sourceLive === undefined) {
          throw new Error(`Review conflict in ${proposal.fromPath}: rename source is missing.`);
        }
        newParents.add(dirname(target.fsPath));
        edit.renameFile(source, target, { overwrite: false });
        continue;
      }
      const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === target.toString());
      let live: string | undefined;
      try { live = document?.getText() ?? (await fs.readFile(target.fsPath)).toString('utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      assertApplyPrecondition(proposal.path, proposal.base, live, !!document?.isDirty, proposal.proposed === undefined);
      if (proposal.proposed === undefined) {
        if (live === undefined) continue;
        edit.deleteFile(target, { ignoreIfNotExists: false });
      } else if (live === undefined) {
        newParents.add(dirname(target.fsPath));
        edit.createFile(target, { ignoreIfExists: false });
        edit.insert(target, new vscode.Position(0, 0), proposal.proposed);
      } else {
        const doc = document ?? await vscode.workspace.openTextDocument(target);
        edit.replace(target, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), proposal.proposed);
      }
    }
    for (const parent of newParents) await vscode.workspace.fs.createDirectory(vscode.Uri.file(parent));
    const applied = await vscode.workspace.applyEdit(edit, { isRefactoring: false });
    if (!applied) throw new Error('VS Code could not apply the review. No item was marked applied; inspect the workspace before retrying.');
    await this.saveDocs(proposals.map(proposal => proposal.path));
    for (const proposal of proposals) {
      proposal.state = 'applied';
      this.settled.add(proposal.id);
      if (proposal.fromPath) await this.acknowledge(proposal.fromPath, undefined);
      await this.acknowledge(proposal.path, proposal.proposed);
    }
    this.proposalsChanged.fire(this.list());
  }

  private virtualUri(path: string, role: 'base' | 'proposed'): vscode.Uri {
    return vscode.Uri.parse(`${this.scheme}:/${encodeURIComponent(path)}?${role}`);
  }

  private fireDocs(path: string): void {
    this.changed.fire(this.virtualUri(path, 'base'));
    this.changed.fire(this.virtualUri(path, 'proposed'));
  }

  private validatePath(path: string): string {
    if (!path || path.includes('\0') || resolve(this.root.fsPath, path) === resolve(this.root.fsPath)) throw new Error('Invalid review path.');
    const rel = relative(this.root.fsPath, resolve(this.root.fsPath, path));
    if (rel === '..' || rel.startsWith('..' + sep) || rel !== path) throw new Error('Review path escapes the workspace.');
    return path;
  }

  private async safeTarget(path: string): Promise<vscode.Uri> {
    this.validatePath(path);
    let current = this.root.fsPath;
    for (const part of path.split(/[\\/]/)) {
      current = join(current, part);
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Refusing to apply through a symbolic link: ${path}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return vscode.Uri.file(current);
  }
}
