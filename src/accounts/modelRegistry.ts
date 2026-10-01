import * as vscode from "vscode";
import { AccountRegistry } from "./accountRegistry";
import { ModelEntry, ResolvedModel } from "./types";

const MODELS_KEY = "dsh.models.v1";
export const DEFAULT_MODEL: ModelEntry = {
  name: "DeepSeek V4 Flash",
  provider: "deepseek-official",
  backend: "deepseek-v4-flash",
  account: "default",
  enabled: true,
};

/** Friendly model names and their provider/backend routes. */
export class ModelRegistry {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly accounts: AccountRegistry,
  ) {}

  public list(enabledOnly = false): ModelEntry[] {
    const models = this.read();
    return enabledOnly ? models.filter((model) => model.enabled) : models;
  }

  public get(name: string): ModelEntry | undefined {
    return this.read().find((model) => model.name === name);
  }

  public async set(entry: ModelEntry, originalName?: string): Promise<void> {
    const name = entry.name.trim();
    const provider = entry.provider.trim();
    const backend = entry.backend.trim();
    if (!name || !provider || !backend) throw new Error("Model name, provider, and backend are required");
    const normalized = { ...entry, name, provider, backend, account: entry.account || "default" };
    const models = this.read().filter((model) => model.name !== name && model.name !== originalName);
    await vscode.workspace.getConfiguration('dsh').update('models', [...models, normalized], vscode.ConfigurationTarget.Global);
  }

  public async remove(name: string): Promise<void> {
    await vscode.workspace.getConfiguration('dsh').update('models', this.read().filter((model) => model.name !== name), vscode.ConfigurationTarget.Global);
  }

  public async resolve(name: string): Promise<ResolvedModel> {
    const model = this.get(name);
    if (!model) throw new Error(`Unknown model '${name}'`);
    if (!model.enabled) throw new Error(`Model '${name}' is disabled`);
    const account = model.account && model.account !== "default"
      ? this.accounts.get(model.account)
      : this.accounts.getDefault(model.provider);
    if (!account) throw new Error(`No account configured for provider '${model.provider}'`);
    if (account.provider !== model.provider) {
      throw new Error(`Account '${account.id}' does not belong to provider '${model.provider}'`);
    }
    const secret = await this.accounts.getSecret(account.id);
    if (!secret) throw new Error(`No credential stored for account '${account.id}'`);
    return { model, account, secret };
  }

  public async pick(): Promise<ModelEntry | undefined> {
    const models = this.list(true);
    const selected = await vscode.window.showQuickPick(models.map((model) => ({
      label: model.name,
      description: `${model.provider} · ${model.backend}`,
      model,
    })), { placeHolder: "Select a model" });
    return selected?.model;
  }

  private read(): ModelEntry[] {
    const configured = vscode.workspace.getConfiguration('dsh').get<unknown>('models');
    if (Array.isArray(configured)) return configured.filter((item): item is ModelEntry =>
      !!item && typeof item === 'object' && typeof item.name === 'string' && typeof item.provider === 'string' && typeof item.backend === 'string')
      .map(item => ({ ...item, enabled: item.enabled !== false, account: item.account || 'default' }));
    const value = this.context.globalState.get<unknown>(MODELS_KEY, []);
    if (Array.isArray(value) && value.length) return value as ModelEntry[];
    return [DEFAULT_MODEL];
  }
}

export { MODELS_KEY };
