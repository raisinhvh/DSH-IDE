/**
 * ChatGPT (Codex) sign-in without the Codex CLI.
 *
 * Each account keeps its directory (OAuthCliAccount.directory) and its `auth.json` in the Codex CLI's own format, so
 * accounts signed in through the old CLI route keep working with no migration:
 *   { "OPENAI_API_KEY": null, "tokens": { "id_token"?, "access_token", "refresh_token", "account_id" }, "last_refresh": ISO }
 * The PKCE flow mirrors pi-ai's openai-codex OAuth (same client id, issuer, redirect URI and scope). pi-ai's flow is
 * not importable here: its package only exposes it through a runtime-relative dynamic import that breaks in the
 * bundled CommonJS extension, and it drops the id_token. This module is the only writer of auth.json.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { arch, release, type } from 'node:os';
import { join, resolve } from 'node:path';

type Json = Record<string, unknown>;

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const SCOPE = 'openid profile email offline_access';
const AUTH_CLAIMS = 'https://api.openai.com/auth';
const PROFILE_CLAIMS = 'https://api.openai.com/profile';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const TOKEN_TIMEOUT_MS = 30 * 1000;
const ORIGINATOR = 'codex_cli_rs';
/** The Codex CLI version DSH identifies as in User-Agent and `version` headers. */
export const CODEX_CLIENT_VERSION = '0.169.0';

export interface CodexTokens {
  access: string;
  refresh: string;
  /** chatgpt_account_id, from tokens.account_id or the token's JWT claims. */
  accountId: string;
  /** Access-token expiry, epoch milliseconds (from the JWT `exp`). */
  expires: number;
  fedramp: boolean;
  email?: string;
  /** ChatGPT plan type from the JWT claims (plus, pro, team…), when present. */
  plan?: string;
}

interface IssuedTokens {
  id_token?: string;
  access_token: string;
  refresh_token: string;
}

const refreshing = new Map<string, Promise<CodexTokens>>();

/** Reads auth.json in `home`. Throws a user-facing error ("Sign in again in Accounts.") when absent or unusable. */
export async function readCodexTokens(home: string): Promise<CodexTokens> {
  let text: string;
  try {
    text = await readFile(authPath(home), 'utf8');
  } catch {
    throw new Error('This Codex account has no ChatGPT sign-in. Sign in again in Accounts.');
  }
  const unusable = new Error("This Codex account's ChatGPT sign-in is unusable. Sign in again in Accounts.");
  let auth: Json;
  try {
    auth = JSON.parse(text) as Json;
  } catch {
    throw unusable;
  }
  const tokens = isObject(auth.tokens) ? auth.tokens : {};
  const access = typeof tokens.access_token === 'string' ? tokens.access_token : '';
  const refresh = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '';
  if (!access || !refresh) throw unusable;
  const parsed = tokensFromClaims(access, typeof tokens.id_token === 'string' ? tokens.id_token : undefined);
  const accountId = typeof tokens.account_id === 'string' && tokens.account_id ? tokens.account_id : parsed.accountId;
  if (!accountId) throw unusable;
  return { ...parsed, access, refresh, accountId };
}

/**
 * Tokens valid for at least `minValidityMs` (default 10 minutes), refreshing and rewriting auth.json first when needed.
 * Concurrent calls for one `home` share a single refresh. `force` refreshes regardless (after an HTTP 401).
 */
export async function freshCodexTokens(home: string, options: { minValidityMs?: number; force?: boolean } = {}): Promise<CodexTokens> {
  const key = resolve(home);
  const pending = refreshing.get(key);
  if (pending) return pending;
  const tokens = await readCodexTokens(home);
  if (!options.force && tokens.expires - Date.now() > (options.minValidityMs ?? 10 * 60 * 1000)) return tokens;
  const again = refreshing.get(key);
  if (again) return again;
  const refresh = (async () => {
    const issued = await requestTokens({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: CLIENT_ID }, 'refresh');
    await writeAuth(home, issued);
    return readCodexTokens(home);
  })();
  refreshing.set(key, refresh);
  try {
    return await refresh;
  } finally {
    refreshing.delete(key);
  }
}

/**
 * Browser sign-in (PKCE, localhost callback) that writes auth.json into `home`. `openUrl` opens the authorize URL
 * (the extension passes vscode.env.openExternal). Rejects on cancel, timeout (5 minutes) or a non-ChatGPT sign-in.
 */
export async function loginCodex(home: string, options: { openUrl(url: string): Promise<void>; signal?: AbortSignal }): Promise<CodexTokens> {
  if (options.signal?.aborted) throw new Error('Codex sign-in was cancelled.');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const url = new URL(AUTHORIZE_URL);
  for (const [name, value] of Object.entries({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: ORIGINATOR,
  })) url.searchParams.set(name, value);

  const code = await waitForCallback(state, url.toString(), options);
  const issued = await requestTokens({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
  }, 'sign-in', options.signal);
  if (!tokensFromClaims(issued.access_token, issued.id_token).accountId) {
    throw new Error('That sign-in is not a ChatGPT account. Sign in with the ChatGPT account that has your subscription.');
  }
  await mkdir(home, { recursive: true });
  await writeAuth(home, issued);
  return readCodexTokens(home);
}

/** Headers every direct chatgpt.com/backend-api call sends (Authorization, ChatGPT-Account-ID, originator, User-Agent, FedRAMP). */
export function codexHeaders(tokens: CodexTokens): Record<string, string> {
  return {
    Authorization: `Bearer ${tokens.access}`,
    'ChatGPT-Account-ID': tokens.accountId,
    originator: ORIGINATOR,
    'User-Agent': `${ORIGINATOR}/${CODEX_CLIENT_VERSION} (${type()} ${release()}; ${arch()}) dsh-ide`,
    ...(tokens.fedramp ? { 'X-OpenAI-Fedramp': 'true' } : {}),
  };
}

function authPath(home: string): string {
  return join(home, 'auth.json');
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function jwtClaims(token: string | undefined): Json {
  if (!token) return {};
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')) as unknown;
    return isObject(claims) ? claims : {};
  } catch {
    return {};
  }
}

/** Account id, expiry, email, plan and FedRAMP flag from the access token, falling back to the id token. */
function tokensFromClaims(access: string, idToken: string | undefined): Omit<CodexTokens, 'access' | 'refresh'> {
  const accessClaims = jwtClaims(access);
  const idClaims = jwtClaims(idToken);
  const auth = (claims: Json): Json => isObject(claims[AUTH_CLAIMS]) ? claims[AUTH_CLAIMS] : {};
  const text = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === 'string' && !!value);
  const profile = isObject(accessClaims[PROFILE_CLAIMS]) ? accessClaims[PROFILE_CLAIMS] : {};
  const email = text(idClaims.email, profile.email);
  const plan = text(auth(accessClaims).chatgpt_plan_type, auth(idClaims).chatgpt_plan_type);
  return {
    accountId: text(auth(accessClaims).chatgpt_account_id, auth(idClaims).chatgpt_account_id) ?? '',
    expires: typeof accessClaims.exp === 'number' ? accessClaims.exp * 1000 : 0,
    fedramp: auth(accessClaims).chatgpt_account_is_fedramp === true || auth(idClaims).chatgpt_account_is_fedramp === true,
    ...(email ? { email } : {}),
    ...(plan ? { plan } : {}),
  };
}

async function requestTokens(form: Record<string, string>, operation: 'refresh' | 'sign-in', signal?: AbortSignal): Promise<IssuedTokens> {
  const timeout = AbortSignal.timeout(TOKEN_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    if (signal?.aborted) throw new Error('Codex sign-in was cancelled.');
    throw new Error(`Could not reach OpenAI to ${operation === 'refresh' ? 'refresh the Codex sign-in' : 'finish signing in'}. Check your connection and try again.`);
  }
  const body = await response.text().catch(() => '');
  let json: Json = {};
  try {
    json = JSON.parse(body) as Json;
  } catch { /* not JSON */ }
  if (!response.ok) {
    if (operation === 'refresh' && (response.status === 400 || response.status === 401)) {
      throw new Error('The Codex sign-in has expired (HTTP 401). Sign in again in Accounts.');
    }
    throw new Error(`OpenAI rejected the Codex ${operation} (HTTP ${response.status}). Try again.`);
  }
  if (typeof json.access_token !== 'string' || !json.access_token) throw new Error(`OpenAI's Codex ${operation} response had no access token. Try again.`);
  const refresh = typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : form.refresh_token;
  if (!refresh) throw new Error(`OpenAI's Codex ${operation} response had no refresh token. Try again.`);
  return {
    access_token: json.access_token,
    refresh_token: refresh,
    ...(typeof json.id_token === 'string' && json.id_token ? { id_token: json.id_token } : {}),
  };
}

/** Rewrites auth.json atomically in the Codex CLI format, keeping fields DSH does not know about. */
async function writeAuth(home: string, issued: IssuedTokens): Promise<void> {
  const path = authPath(home);
  let existing: Json = {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (isObject(parsed)) existing = parsed;
  } catch { /* first sign-in or unreadable file */ }
  const previous = isObject(existing.tokens) ? existing.tokens : {};
  const idToken = issued.id_token ?? (typeof previous.id_token === 'string' ? previous.id_token : undefined);
  const accountId = tokensFromClaims(issued.access_token, idToken).accountId
    || (typeof previous.account_id === 'string' ? previous.account_id : '');
  const auth: Json = {
    ...existing,
    OPENAI_API_KEY: existing.OPENAI_API_KEY ?? null,
    tokens: {
      ...previous,
      ...(idToken ? { id_token: idToken } : {}),
      access_token: issued.access_token,
      refresh_token: issued.refresh_token,
      account_id: accountId,
    },
    last_refresh: new Date().toISOString(),
  };
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(auth, null, 2), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      // Windows refuses the rename while another process briefly holds auth.json open.
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await rm(temp, { force: true });
        throw new Error('Could not save the Codex sign-in. Try again.');
      }
      await new Promise(done => setTimeout(done, 100 * (attempt + 1)));
    }
  }
}

/** Serves the localhost callback, opens the browser, and resolves with the authorization code. */
function waitForCallback(state: string, authorizeUrl: string, options: { openUrl(url: string): Promise<void>; signal?: AbortSignal }): Promise<string> {
  return new Promise((resolveCode, reject) => {
    const page = (message: string): string => `<!doctype html><meta charset="utf-8"><title>DSH</title><body style="font:16px system-ui;margin:3em">${message}</body>`;
    let settled = false;
    const finish = (error: Error | undefined, code?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      server.close();
      server.closeAllConnections();
      if (error) reject(error);
      else resolveCode(code!);
    };
    const onAbort = (): void => finish(new Error('Codex sign-in was cancelled.'));
    const timer = setTimeout(() => finish(new Error('Codex sign-in timed out after 5 minutes. Try again.')), LOGIN_TIMEOUT_MS);
    const server = createServer((request, response) => {
      const url = new URL(request.url || '/', `http://localhost:${CALLBACK_PORT}`);
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Connection', 'close');
      if (url.pathname !== '/auth/callback') {
        response.statusCode = 404;
        response.end(page('Not found.'));
        return;
      }
      if (url.searchParams.get('state') !== state) {
        response.statusCode = 400;
        response.end(page('This sign-in link is out of date. Start the sign-in again from DSH.'));
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error || !code) {
        response.statusCode = 400;
        response.end(page('Sign-in did not complete. You can close this window.'));
        const description = url.searchParams.get('error_description');
        finish(new Error(`Codex sign-in failed${description ? `: ${description.slice(0, 200)}` : error ? ` (${error.slice(0, 80)})` : '.'}`));
        return;
      }
      response.end(page('Signed in to ChatGPT. You can close this window and return to DSH.'));
      finish(undefined, code);
    });
    server.on('error', error => {
      finish(new Error((error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `Port ${CALLBACK_PORT} is in use, probably by another sign-in window. Close it and try again.`
        : 'Could not start the local sign-in server. Try again.'));
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
      options.openUrl(authorizeUrl).catch(() => finish(new Error('Could not open the browser for Codex sign-in.')));
    });
  });
}
