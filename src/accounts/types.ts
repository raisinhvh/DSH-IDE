/** Public, non-secret account metadata persisted in VS Code globalState. */
export interface AccountRecord {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly email?: string;
  /** Non-secret provider state such as token expiry or refresh timestamps. */
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** A model shown to the user and the provider route it resolves to. */
export interface ModelEntry {
  readonly name: string;
  readonly provider: string;
  readonly backend: string;
  /** `default` resolves to the provider's active account. */
  readonly account?: string;
  readonly enabled: boolean;
  /** Speed presets. Codex and Claude CLI use native speed settings and keep the base backend. Other providers use backend routes. */
  readonly speedOptions?: { label: string; backend: string }[];
  /** Reasoning effort values offered for this model; the provider validates them at run time. */
  readonly effortOptions?: string[];
}

export type AccountPolicy = "default" | string;

export interface AddAccountInput {
  readonly provider: string;
  readonly label: string;
  readonly email?: string;
  /** Stored in SecretStorage under the generated account id. */
  readonly secret: string;
  /** Optional provider-specific refresh metadata; never put secrets here. */
  readonly metadata?: Record<string, unknown>;
  readonly id?: string;
}

export interface ResolvedModel {
  readonly model: ModelEntry;
  readonly account: AccountRecord;
  readonly secret: string;
}
