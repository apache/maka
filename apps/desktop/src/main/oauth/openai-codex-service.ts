/**
 * OpenAI Codex subscription OAuth service (main-process only).
 *
 * Authorization uses the ChatGPT device-code flow (`deviceauth/*` on
 * auth.openai.com/api/accounts) — the same flow the official Codex CLI
 * uses (codex-rs login/src/device_code_auth.rs). There is no local
 * loopback listener and no fixed callback port, so the whole class of
 * localhost/IPv6/port-collision/state-hang failures is gone:
 *   - `getAuthorizationUrl` POSTs `{client_id}` to
 *     `/api/accounts/deviceauth/usercode` and receives a one-time
 *     `user_code` + `device_auth_id`.
 *   - The user opens `auth.openai.com/codex/device` in their browser
 *     and enters the code (the renderer shows it via `stateHint`).
 *   - `openAuthorizationUrl` starts a poll of
 *     `/api/accounts/deviceauth/token`; 403/404 means "still pending",
 *     200 returns `{authorization_code, code_challenge, code_verifier}`.
 *   - `completeAuthorization` exchanges the authorization code at
 *     `/oauth/token` with `redirect_uri=auth.openai.com/deviceauth/callback`.
 *
 * Token refresh + persistence are unchanged and shared with the
 * pure-Node surfaces (#1125): desktop, TUI, and headless all read and
 * write the same workspace credential store.
 *
 * Hard gates (shared with the Claude / xAI services):
 *   - Renderer NEVER sees access_token / refresh_token / id_token.
 *     IPC payloads are `CodexAccountStateSnapshot`-shaped only.
 *   - Refresh failure does NOT auto-logout — user must click 重新登录.
 *   - The device-auth URL is fixed (server-owned); the renderer only
 *     receives an opaque `authRequestId` plus the `user_code` as
 *     `stateHint`.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  type AuthorizationUrlPayload,
  type SubscriptionActionFailureReason,
  type SubscriptionActionResult,
} from '@maka/core';
import {
  proxiedFetch,
  refreshAndPersistOAuthSubscriptionTokens,
  refreshOAuthSubscriptionTokens,
  resolveAndPersistOAuthSubscriptionTokens,
  type OAuthSubscriptionRefreshAndPersistOutcome,
  type OAuthSubscriptionTokens,
} from '@maka/runtime';
import {
  deleteSharedOAuthTokens,
  loadSharedOAuthTokens,
  saveSharedOAuthTokens,
  type SharedOAuthCredentialStore,
} from './shared-credential-bridge.js';
import {
  CODEX_OAUTH_CONFIG,
  extractAccountClaims,
  safeExtractAccountClaims,
} from './openai-codex-helpers.js';

// Endpoint shortcuts so the existing class body keeps reading
// like the xAI service (constants at the top, lookups inline).
const CODEX_CLIENT_ID = CODEX_OAUTH_CONFIG.clientId;
const CODEX_TOKEN_ENDPOINT = CODEX_OAUTH_CONFIG.tokenEndpoint;
const CODEX_DEVICE_USERCODE_ENDPOINT = `${CODEX_OAUTH_CONFIG.deviceAuthBaseUrl}/deviceauth/usercode`;
const CODEX_DEVICE_TOKEN_ENDPOINT = `${CODEX_OAUTH_CONFIG.deviceAuthBaseUrl}/deviceauth/token`;
const CODEX_DEVICE_VERIFY_URL = CODEX_OAUTH_CONFIG.deviceVerifyUrl;
const CODEX_DEVICE_REDIRECT_URI = CODEX_OAUTH_CONFIG.deviceRedirectUri;

// The official CLI lets a device auth poll for 15 minutes.
const CODEX_DEVICE_AUTH_TTL_MS = 15 * 60 * 1000;

// =============================================================
// Persisted tokens — INTERNAL TO THIS MODULE. Never crosses IPC.
// Snake_case field names match auth.openai.com's response body.
// =============================================================
interface PersistedTokens {
  /* eslint-disable @typescript-eslint/naming-convention -- OAuth protocol field names */
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_at: number;
  account_id: string;
  /* eslint-enable */
}

interface PendingAuthorization {
  deviceAuthId: string;
  userCode: string;
  /** Verification page the user opens in their browser. */
  url: string;
  expiresAt: number;
  intervalMs: number;
  controller: AbortController;
  /**
   * Promise that resolves with the authorization-code exchange inputs
   * once the device-auth poll succeeds, or rejects on timeout /
   * shutdown. Started by `openAuthorizationUrl`, awaited by
   * `completeAuthorization`.
   */
  pollPromise?: Promise<{ authorizationCode: string; codeVerifier: string }>;
}

// =============================================================
// Service class.
// =============================================================

export interface OpenAiCodexServiceDeps {
  /** Absolute path to userData dir; e.g. app.getPath('userData'). */
  userDataDir: string;
  /** Opens the provider verification page in the system browser. */
  openExternal: (url: string) => Promise<void>;
  /** Function returning current epoch ms. Injectable for tests. */
  now?: () => number;
  /** Fetch implementation. Defaults to Maka's active-proxy-aware fetch. */
  fetchFn?: typeof fetch;
  /** Abortable sleep used while polling; injectable for tests. */
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Shared workspace credential store — the authoritative token store for every surface (#1125). */
  credentialStore: SharedOAuthCredentialStore;
}

export class OpenAiCodexService {
  /** Pre-#1125 safeStorage-encrypted token file. Never written or read
   *  anymore; unlinked on logout in case the startup import could not
   *  run, so logout still means "no credential survives anywhere". */
  private readonly legacyTokenFilePath: string;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly credentialStore: SharedOAuthCredentialStore;

  private pending: Map<string, PendingAuthorization> = new Map();

  private lastRefreshFailedMessage: string | null = null;
  private lastStorageFailedMessage: string | null = null;
  private authorizing = false;
  private refreshing = false;

  constructor(deps: OpenAiCodexServiceDeps) {
    this.legacyTokenFilePath = join(deps.userDataDir, '.codex_subscription_token');
    this.openExternal = deps.openExternal;
    this.now = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? (proxiedFetch as unknown as typeof fetch);
    this.sleep = deps.sleep ?? abortableSleep;
    this.credentialStore = deps.credentialStore;
  }

  // -----------------------------------------------------------
  // PUBLIC API
  // -----------------------------------------------------------

  /**
   * Start the ChatGPT device-code flow: request a one-time user code
   * from `deviceauth/usercode`. The returned `authRequestId` scopes
   * the eventual openAuthUrl / completeAuthorization /
   * cancelAuthorization calls; `stateHint` carries the `user_code`
   * the user must enter at auth.openai.com/codex/device.
   */
  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
    this.pruneExpiredPending();
    let response: Response;
    try {
      response = await this.fetchFn(CODEX_DEVICE_USERCODE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
      });
    } catch (err) {
      return this.failureFromError('unknown', err);
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: 'token_exchange_failed',
        message: `Codex 设备授权启动失败（HTTP ${response.status}）。`,
      };
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const deviceAuthId = nonEmptyString(payload.device_auth_id);
    const userCode = nonEmptyString(payload.user_code);
    const interval = positiveNumber(payload.interval) ?? 5;
    const expiresAt = deviceAuthExpiry(payload.expires_at, this.now());
    if (!deviceAuthId || !userCode) {
      return {
        ok: false,
        reason: 'token_exchange_failed',
        message: 'Codex 设备授权响应无效，请稍后重试。',
      };
    }

    const authRequestId = randomUUID();
    this.pending.set(authRequestId, {
      deviceAuthId,
      userCode,
      url: CODEX_DEVICE_VERIFY_URL,
      expiresAt,
      intervalMs: interval * 1_000,
      controller: new AbortController(),
    });
    return { authRequestId, stateHint: userCode };
  }

  /**
   * Open the verification page and start polling `deviceauth/token`.
   * The user enters the one-time code shown as `stateHint`; the poll
   * resolves once the browser approval completes.
   */
  async openAuthorizationUrl(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      return { ok: false, reason: 'authorization_pending', message: '授权会话不存在，请重新点击“登录 Codex”。' };
    }
    if (pending.expiresAt <= this.now()) {
      this.disposePending(authRequestId);
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录 Codex”。' };
    }
    try {
      await this.openExternal(pending.url);
      if (this.pending.get(authRequestId) !== pending || pending.controller.signal.aborted) {
        return { ok: false, reason: 'authorization_cancelled', message: 'Codex 授权已取消。' };
      }
      this.authorizing = true;
      pending.pollPromise ??= this.pollForTokens(pending);
      void pending.pollPromise.catch(() => undefined);
      return { ok: true };
    } catch (err) {
      return this.failureFromError('unknown', err);
    }
  }

  /**
   * Await the device-auth poll, then exchange the authorization code
   * for tokens. The renderer shows the one-time code; there is nothing
   * to paste back.
   */
  async completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending?.pollPromise) {
      this.authorizing = false;
      return { ok: false, reason: 'authorization_pending', message: '请先点击“登录 Codex”再完成授权。' };
    }
    try {
      const { authorizationCode, codeVerifier } = await pending.pollPromise;
      const tokens = await this.exchangeCodeForTokens(authorizationCode, codeVerifier);
      // Storage failures are not exchange failures: the authorization
      // code was consumed successfully, so tell the user to fix the
      // store instead of implying the code was bad.
      try {
        await this.saveTokens(tokens);
      } catch {
        this.disposePending(authRequestId);
        this.authorizing = false;
        return { ok: false, reason: 'storage_failed', message: this.lastStorageFailedMessage ?? '写入共享凭据失败，请检查 credentials.json 权限后重试。' };
      }
      this.disposePending(authRequestId);
      this.authorizing = false;
      return { ok: true };
    } catch (err) {
      this.disposePending(authRequestId);
      this.authorizing = false;
      if (err instanceof CodexAuthorizationExpiredError) {
        return { ok: false, reason: 'authorization_expired', message: 'Codex 授权已过期，请重新登录。' };
      }
      if (err instanceof CodexAuthorizationCancelledError) {
        return { ok: false, reason: 'authorization_cancelled', message: 'Codex 授权已取消。' };
      }
      return this.failureFromError('token_exchange_failed', err);
    }
  }

  /**
   * Cancel a pending authorization (user closed the modal or
   * pressed Cancel). Aborts the device-auth poll.
   */
  cancelAuthorization(authRequestId?: string): void {
    if (authRequestId !== undefined) {
      this.disposePending(authRequestId);
    } else {
      for (const id of [...this.pending.keys()]) this.disposePending(id);
    }
    this.authorizing = false;
  }

  /**
   * Snapshot of the current account state for the renderer.
   * No token-shaped fields exposed.
   */
  async getAccountState(): Promise<CodexAccountStateSnapshot> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      if (this.lastStorageFailedMessage) {
        return {
          provider: 'openai-codex',
          runtimeState: 'storage_failed',
          errorMessage: this.lastStorageFailedMessage,
        };
      }
      return {
        provider: 'openai-codex',
        runtimeState: this.authorizing ? 'authorizing' : 'not_logged_in',
      };
    }
    // Claims are always derived from the CURRENT tokens rather than
    // cached: another surface may have re-logged in with a different
    // account since this process last saw a login or refresh.
    const claims = safeExtractAccountClaims(tokens.access_token, tokens.id_token);
    const runtimeState = this.deriveRuntimeState();
    return {
      provider: 'openai-codex',
      runtimeState,
      accountId: tokens.account_id || claims?.accountId,
      email: claims?.email,
      plan: claims?.plan,
      picture: claims?.picture,
      errorMessage: this.errorForState(runtimeState),
    };
  }

  /**
   * Force a token refresh. Refresh failure does NOT auto-delete
   * the token file — the user sees `refresh_failed` and must
   * click 重新登录.
   */
  async refreshTokens(): Promise<SubscriptionActionResult> {
    this.refreshing = true;
    try {
      const result = await refreshAndPersistOAuthSubscriptionTokens({
        slug: 'codex-subscription',
        credentialStore: this.credentialStore,
        now: this.now,
        fetchFn: this.fetchFn,
        refreshTokens: (tokens, signal) => this.requestTokenRefresh(tokens, signal),
      });
      return this.applyRefreshOutcome(result);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Logout: clear in-memory state, delete the shared-store token (the
   * authority) and any legacy safeStorage token file the startup
   * import could not process. Local clear only; no remote revocation
   * (auth.openai.com does not publicly expose an RFC 7009 endpoint we
   * can rely on).
   */
  async logout(): Promise<SubscriptionActionResult> {
    this.lastRefreshFailedMessage = null;
    this.lastStorageFailedMessage = null;
    this.cancelAuthorization();
    let legacyDeleteFailed = false;
    try {
      await fs.unlink(this.legacyTokenFilePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        legacyDeleteFailed = true;
      }
    }
    try {
      await deleteSharedOAuthTokens(this.credentialStore, 'codex-subscription');
    } catch {
      return { ok: false, reason: 'storage_failed', message: '删除共享凭据失败，请手动清理。' };
    }
    if (legacyDeleteFailed) return { ok: false, reason: 'storage_failed', message: '删除本地遗留凭据失败，请手动清理。' };
    return { ok: true };
  }

  /**
   * Get an access token (refreshing if needed). Caller is
   * responsible for keeping the returned token inside the main
   * process — never IPC it out.
   */
  async getAccessTokenInternal(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    if (options.forceRefresh) {
      const refreshed = await this.refreshTokens();
      if (!refreshed.ok) return null;
      const next = await this.loadTokens();
      return next?.access_token ?? null;
    }
    this.refreshing = true;
    try {
      const result = await resolveAndPersistOAuthSubscriptionTokens({
        slug: 'codex-subscription',
        credentialStore: this.credentialStore,
        now: this.now,
        fetchFn: this.fetchFn,
        refreshTokens: (tokens, signal) => this.requestTokenRefresh(tokens, signal),
      });
      if (result.outcome === 'current') return result.tokens.access_token;
      const action = this.applyRefreshOutcome(result);
      return action.ok && (result.outcome === 'refreshed' || result.outcome === 'superseded')
        ? result.tokens.access_token
        : null;
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Whether a persisted OAuth token exists locally, WITHOUT
   * triggering `getAccessTokenInternal()`'s near-expiry refresh. See
   * `ClaudeSubscriptionService.hasStoredCredential()` for the
   * rationale — read-only status paths (onboarding) must not refresh
   * or mutate token state just by being observed.
   */
  async hasStoredCredential(): Promise<boolean> {
    const tokens = await this.loadTokens();
    return tokens !== null;
  }

  // -----------------------------------------------------------
  // INTERNALS
  // -----------------------------------------------------------

  private async requestTokenRefresh(
    tokens: OAuthSubscriptionTokens,
    signal: AbortSignal,
  ): Promise<OAuthSubscriptionTokens> {
    const next = await refreshOAuthSubscriptionTokens({
      providerType: 'openai-codex',
      tokens,
      now: this.now,
      fetchFn: this.fetchFn,
      signal,
    });
    const claims = extractAccountClaims(next.access_token, next.id_token);
    return { ...next, account_id: claims.accountId || tokens.account_id };
  }

  private applyRefreshOutcome(result: OAuthSubscriptionRefreshAndPersistOutcome): SubscriptionActionResult {
    if (result.outcome === 'refreshed' || result.outcome === 'superseded') {
      this.lastRefreshFailedMessage = null;
      this.lastStorageFailedMessage = null;
      return { ok: true };
    }
    if (result.outcome === 'storage-failed') {
      const message = '访问 Codex OAuth 共享凭据失败，请检查 credentials.json 权限后重试。';
      this.lastRefreshFailedMessage = null;
      this.lastStorageFailedMessage = message;
      return { ok: false, reason: 'storage_failed', message };
    }
    this.lastStorageFailedMessage = null;
    const message = result.outcome === 'logged-out'
      ? '登录状态已变更，本次刷新结果已丢弃。'
      : result.error instanceof Error ? result.error.message : '刷新失败，请重新登录。';
    this.lastRefreshFailedMessage = message;
    return { ok: false, reason: 'refresh_failed', message };
  }

  private deriveRuntimeState(): CodexRuntimeState {
    if (this.refreshing) return 'refreshing';
    if (this.lastRefreshFailedMessage) return 'refresh_failed';
    if (this.lastStorageFailedMessage) return 'storage_failed';
    return 'authenticated';
  }

  private errorForState(state: CodexRuntimeState): string | undefined {
    if (state === 'refresh_failed') return this.lastRefreshFailedMessage ?? undefined;
    if (state === 'storage_failed') return this.lastStorageFailedMessage ?? undefined;
    return undefined;
  }

  private pruneExpiredPending(): void {
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= this.now()) {
        pending.controller.abort();
        this.pending.delete(id);
      }
    }
  }

  private disposePending(authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (!pending) return;
    pending.controller.abort();
    this.pending.delete(authRequestId);
  }

  /**
   * Poll `deviceauth/token` until the browser approval lands.
   * Mirrors the official CLI: 403/404 means still pending (retry
   * after the interval), 200 returns the authorization code + PKCE
   * verifier. Times out after `expires_at` / 15 minutes.
   */
  private async pollForTokens(pending: PendingAuthorization): Promise<{ authorizationCode: string; codeVerifier: string }> {
    for (;;) {
      if (pending.expiresAt <= this.now()) throw new CodexAuthorizationExpiredError();
      try {
        await this.sleep(pending.intervalMs, pending.controller.signal);
      } catch (error) {
        if (pending.controller.signal.aborted) throw new CodexAuthorizationCancelledError();
        throw error;
      }
      let response: Response;
      try {
        response = await this.fetchFn(CODEX_DEVICE_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_auth_id: pending.deviceAuthId,
            user_code: pending.userCode,
          }),
          signal: pending.controller.signal,
        });
      } catch (error) {
        if (pending.controller.signal.aborted) throw new CodexAuthorizationCancelledError();
        throw error;
      }
      if (response.ok) {
        const payload = (await response.json()) as Record<string, unknown>;
        const authorizationCode = nonEmptyString(payload.authorization_code);
        const codeVerifier = nonEmptyString(payload.code_verifier);
        if (!authorizationCode || !codeVerifier) {
          throw new Error('Codex 设备授权响应无效。');
        }
        return { authorizationCode, codeVerifier };
      }
      // 403/404 = still pending (per the official CLI); anything else
      // is a hard failure.
      if (response.status === 403 || response.status === 404) continue;
      throw new Error(`Codex 设备授权失败（HTTP ${response.status}）。`);
    }
  }

  private async exchangeCodeForTokens(code: string, verifier: string): Promise<PersistedTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_DEVICE_REDIRECT_URI,
    });
    const response = await this.fetchFn(CODEX_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'maka-desktop/0.1.0 (oauth-subscription)',
      },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error(`Token exchange failed (${response.status}).`);
    }
    const payload = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      id_token?: string;
      expires_in: number;
    };
    const claims = extractAccountClaims(payload.access_token, payload.id_token);
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      id_token: payload.id_token,
      expires_at: this.now() + 1000 * payload.expires_in,
      account_id: claims.accountId,
    };
  }

  private async saveTokens(tokens: PersistedTokens): Promise<void> {
    try {
      await saveSharedOAuthTokens(this.credentialStore, 'codex-subscription', tokens);
    } catch (err) {
      // Fail closed: a token we cannot persist for every surface is a
      // storage failure, not a partial success.
      this.lastStorageFailedMessage = '写入 Codex OAuth 共享凭据失败，请检查 credentials.json 权限后重试。';
      throw err;
    }
    this.lastStorageFailedMessage = null;
  }

  /**
   * Always reads the shared store — no in-memory copy. Pure-Node
   * surfaces refresh and rewrite the same entry, so caching here could
   * hold a rotated-out refresh token.
   */
  private async loadTokens(): Promise<PersistedTokens | null> {
    let result: Awaited<ReturnType<typeof loadSharedOAuthTokens>>;
    try {
      result = await loadSharedOAuthTokens(this.credentialStore, 'codex-subscription');
    } catch {
      this.lastStorageFailedMessage = '读取 Codex OAuth 共享凭据失败，请检查 credentials.json 或重新登录。';
      return null;
    }
    if (result.status === 'corrupt') {
      // Entry exists but is not a token payload; it is kept as-is
      // (reads never destroy secrets) and a fresh login overwrites it.
      this.lastStorageFailedMessage = 'Codex OAuth 共享凭据无法解析，请重新登录。';
      return null;
    }
    if (result.status === 'missing') return null;
    this.lastStorageFailedMessage = null;
    const tokens = result.tokens;
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      expires_at: tokens.expires_at,
      account_id: tokens.account_id ?? '',
    };
  }

  private failureFromError(
    fallbackReason: SubscriptionActionFailureReason,
    err: unknown,
  ): SubscriptionActionResult {
    const message = err instanceof Error ? err.message : '操作失败。';
    return { ok: false, reason: fallbackReason, message };
  }
}

// =============================================================
// Public IPC payload shape — `openai-codex:get-account-state`.
//
// Mirrors the Claude service's SubscriptionAccountState shape so
// the renderer can reuse a single presentation helper, but uses
// the OpenAI-specific provider tag and JWT claim fields. The
// renderer NEVER sees raw tokens; this is the entire surface.
// =============================================================
export type CodexRuntimeState =
  | 'not_logged_in'
  | 'authorizing'
  | 'authenticated'
  | 'refreshing'
  | 'storage_failed'
  | 'refresh_failed';

export interface CodexAccountStateSnapshot {
  provider: 'openai-codex';
  runtimeState: CodexRuntimeState;
  accountId?: string;
  email?: string;
  plan?: string;
  picture?: string;
  errorMessage?: string;
}

// =============================================================
// Re-exports for the IPC handler + focused protocol tests.
// =============================================================
export { CODEX_OAUTH_CONFIG, isOpenAiCodexExperimentalEnabled } from './openai-codex-helpers.js';

class CodexAuthorizationExpiredError extends Error {}
class CodexAuthorizationCancelledError extends Error {}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  // The deviceauth response returns `interval` as a numeric string.
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * `expires_at` arrives as an ISO-8601 UTC string. Fall back to a
 * 15-minute TTL (the official CLI's poll window) when absent.
 */
function deviceAuthExpiry(value: unknown, now: number): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > now) return parsed;
  }
  return now + CODEX_DEVICE_AUTH_TTL_MS;
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    };
    if (signal.aborted) {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
