import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { AccountRecord, AddAccountInput } from "./types";

const ACCOUNTS_KEY = "dsh.accounts.v1";
const DEFAULTS_KEY = "dsh.accountDefaults.v1";
const SECRET_PREFIX = "dsh.account.secret.v1.";

type DefaultMap = Record<string, string>;

function clean(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function accountSecretKey(id: string): string {
  return SECRET_PREFIX + encodeURIComponent(id);
}

/** Stores account metadata in globalState and credentials in SecretStorage. */
export class AccountRegistry {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public list(provider?: string): AccountRecord[] {
    const records = this.readAccounts();
    return provider ? records.filter((account) => account.provider === provider) : records;
  }

  public get(id: string): AccountRecord | undefined {
    return this.readAccounts().find((account) => account.id === id);
  }

  public getDefault(provider: string): AccountRecord | undefined {
    const id = this.readDefaults()[provider];
    return (id && this.get(id)) || this.list(provider)[0];
  }

  public async getSecret(id: string): Promise<string | undefined> {
    if (!this.get(id)) return undefined;
    return this.context.secrets.get(accountSecretKey(id));
  }

  public async add(input: AddAccountInput): Promise<AccountRecord> {
    const provider = clean(input.provider, "Provider");
    const label = clean(input.label, "Account label");
    const secret = input.secret.trim();
    if (!secret) throw new Error("Account secret is required");
    const now = Date.now();
    const id = clean(input.id || `${provider}:${randomBytes(8).toString("hex")}`, "Account id");
    if (this.get(id)) throw new Error(`An account with id '${id}' already exists`);
    const account: AccountRecord = {
      id,
      provider,
      label,
      ...(input.email?.trim() ? { email: input.email.trim() } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.context.secrets.store(accountSecretKey(id), secret);
    await this.context.globalState.update(ACCOUNTS_KEY, [...this.readAccounts(), account]);
    if (!this.readDefaults()[provider]) await this.setDefault(provider, id);
    return account;
  }

  /** Named aliases make the registry convenient to bind to extension commands. */
  public addAccount(input: AddAccountInput): Promise<AccountRecord> { return this.add(input); }

  public async setDefault(provider: string, id: string): Promise<void> {
    const account = this.get(id);
    if (!account || account.provider !== provider) {
      throw new Error(`Account '${id}' does not belong to provider '${provider}'`);
    }
    await this.context.globalState.update(DEFAULTS_KEY, { ...this.readDefaults(), [provider]: id });
  }

  public switchAccount(provider: string, id: string): Promise<void> { return this.setDefault(provider, id); }

  public async remove(id: string): Promise<void> {
    const account = this.get(id);
    if (!account) return;
    await this.context.secrets.delete(accountSecretKey(id));
    const remaining = this.readAccounts().filter((item) => item.id !== id);
    await this.context.globalState.update(ACCOUNTS_KEY, remaining);
    const defaults = this.readDefaults();
    if (defaults[account.provider] === id) {
      const replacement = remaining.find((item) => item.provider === account.provider);
      if (replacement) defaults[account.provider] = replacement.id;
      else delete defaults[account.provider];
      await this.context.globalState.update(DEFAULTS_KEY, defaults);
    }
  }

  public removeAccount(id: string): Promise<void> { return this.remove(id); }

  public async addFromInput(provider?: string): Promise<AccountRecord | undefined> {
    const selectedProvider = provider || await vscode.window.showInputBox({ prompt: "Provider", value: "deepseek" });
    if (!selectedProvider) return undefined;
    const label = await vscode.window.showInputBox({ prompt: "Account label or email" });
    if (!label) return undefined;
    const secret = await vscode.window.showInputBox({ prompt: "API key", password: true, ignoreFocusOut: true });
    if (!secret) return undefined;
    return this.add({ provider: selectedProvider, label, secret });
  }

  public async pick(provider?: string): Promise<AccountRecord | undefined> {
    const accounts = this.list(provider);
    if (!accounts.length) return undefined;
    const picked = await vscode.window.showQuickPick(accounts.map((account) => ({
      label: account.label,
      description: account.email || account.provider,
      detail: account.id,
      account,
    })), { placeHolder: "Select an account" });
    if (picked) await this.setDefault(picked.account.provider, picked.account.id);
    return picked?.account;
  }

  public async removeFromInput(provider?: string): Promise<boolean> {
    const account = await this.pickWithoutSwitch(provider);
    if (!account) return false;
    const answer = await vscode.window.showWarningMessage(
      `Remove account '${account.label}'?`, { modal: true }, "Remove",
    );
    if (answer !== "Remove") return false;
    await this.remove(account.id);
    return true;
  }

  private async pickWithoutSwitch(provider?: string): Promise<AccountRecord | undefined> {
    const accounts = this.list(provider);
    if (!accounts.length) return undefined;
    const picked = await vscode.window.showQuickPick(accounts.map((account) => ({
      label: account.label,
      description: account.email || account.provider,
      detail: account.id,
      account,
    })), { placeHolder: "Select an account" });
    return picked?.account;
  }

  private readAccounts(): AccountRecord[] {
    const value = this.context.globalState.get<unknown>(ACCOUNTS_KEY, []);
    return Array.isArray(value) ? value as AccountRecord[] : [];
  }

  private readDefaults(): DefaultMap {
    const value = this.context.globalState.get<unknown>(DEFAULTS_KEY, {});
    return value && typeof value === "object" && !Array.isArray(value) ? value as DefaultMap : {};
  }
}

export { ACCOUNTS_KEY, DEFAULTS_KEY, SECRET_PREFIX };
