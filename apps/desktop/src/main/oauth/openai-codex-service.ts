/**
 * OpenAI Codex subscription OAuth service (main-process only).
 *
 * Authorization uses the ChatGPT device-code flow (`deviceauth/*` on
 * auth.openai.com/api/accounts) — the same flow the official Codex CLI
 * uses (codex-rs login/src/device_code_auth.rs). There is no local
 * loopback listener and no fixed callback port, so the whole class of
 * localhost/IPv6/port-collision/state-hang failures is gone:
 *   - `getAuthorizationUrl` requests a one-time `user_code`.
 *   - The user opens `auth.openai.com/codex/device` in their browser
 *     and enters the code (the renderer shows it via `stateHint`).
 *   - `openAuthorizationUrl` starts polling; `completeAuthorization`
 *     exchanges the resulting authorization code for tokens.
 *
 * The device-auth protocol itself (usercode / poll / exchange / boundary
 * validation) is owned by `@maka/runtime`'s codex-oauth-enrollment — the
 * single protocol authority for both desktop and runtime-host. This
 * service owns only the product lifecycle: authRequestId + pending state,
 * browser opening, account-state snapshots, and shared-credential
 * persistence (#1125).
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
  exchangeCodexDeviceAuthorizationCode,
  extractCodexAccountClaims,
  isOAuthEnrollmentProviderEnabled,
  OAuthDeviceAuthorizationExpiredError,
  OAuthTokenEndpointError,
  pollCodexDeviceAuthorization,
  proxiedFetch,
  refreshAndPersistOAuthSubscriptionTokens,
  refreshOAuthSubscriptionTokens,
  resolveAndPersistOAuthSubscriptionTokens,
  startCodexDeviceAuthorization,
  type CodexDeviceAuthorization,
  type CodexDeviceAuthorizationGrant,
  type OAuthSubscriptionRefreshAndPersistOutcome,
  type OAuthSubscriptionTokens,
} from '@maka/runtime';
import {
  deleteSharedOAuthTokens,
  loadSharedOAuthTokens,
  saveSharedOAuthTokens,
  type SharedOAuthCredentialStore,
} from './shared-credential-bridge.js';

// =============================================================
// Persisted tokens — the runtime `OAuthSubscriptionTokens` shape is the
// single token authority; this module decorates it with `account_id`.
// Never crosses IPC.
// =============================================================

interface PendingAuthorization {
  /** Server-issued device authorization (user code, verify URL, window). */
  authorization: CodexDeviceAuthorization;
  controller: AbortController;
  /**
   * Promise that resolves with the authorization-code exchange inputs
   * once the device-auth poll succeeds, or rejects on timeout /
   * shutdown. Started by `openAuthorizationUrl`, awaited by
   * `completeAuthorization`.
   */
  pollPromise?: Promise<CodexDeviceAuthorizationGrant>;
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
   * Start the ChatGPT device-code flow: request a one-time user code.
   * The returned `authRequestId` scopes the eventual openAuthUrl /
   * completeAuthorization / cancelAuthorization calls; `stateHint`
   * carries the `user_code` the user must enter at
   * auth.openai.com/codex/device.
   */
  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
    this.pruneExpiredPending();
    const controller = new AbortController();
    let authorization: CodexDeviceAuthorization;
    try {
      authorization = await startCodexDeviceAuthorization({
        fetchFn: this.fetchFn,
        signal: controller.signal,
        now: this.now,
      });
    } catch (err) {
      if (err instanceof OAuthTokenEndpointError) {
        return {
          ok: false,
          reason: 'token_exchange_failed',
          message: `Codex 设备授权启动失败（HTTP ${err.status ?? '未知'}）。`,
        };
      }
      return this.failureFromError('unknown', err);
    }

    const authRequestId = randomUUID();
    this.pending.set(authRequestId, { authorization, controller });
    return { authRequestId, stateHint: authorization.userCode };
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
    if (pending.authorization.expiresAt <= this.now()) {
      this.disposePending(authRequestId);
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录 Codex”。' };
    }
    try {
      await this.openExternal(pending.authorization.verificationUrl);
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
      const grant = await pending.pollPromise;
      // The poll has already consumed the one-time device authorization
      // code: the exchange + persistence must complete even if the user
      // cancelled while the poll was in flight, otherwise the code is
      // burned and the login is lost. Use an independent signal.
      const tokens = await this.exchangeGrantForTokens(grant, new AbortController().signal);
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
      if (err instanceof CodexAuthorizationCancelledError) {
        return { ok: false, reason: 'authorization_cancelled', message: 'Codex 授权已取消。' };
      }
      if (err instanceof OAuthDeviceAuthorizationExpiredError) {
        return { ok: false, reason: 'authorization_expired', message: 'Codex 授权已过期，请重新登录。' };
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
    const claims = extractCodexAccountClaims(tokens.access_token, tokens.id_token);
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
    const claims = extractCodexAccountClaims(next.access_token, next.id_token);
    return { ...next, account_id: claims?.accountId || tokens.account_id };
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
      if (pending.authorization.expiresAt <= this.now()) {
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
   * Poll `deviceauth/token` through the runtime enrollment. Caller
   * cancellation aborts the poll between requests; the poll stops with
   * `OAuthDeviceAuthorizationExpiredError` once the window elapses.
   */
  private async pollForTokens(pending: PendingAuthorization): Promise<CodexDeviceAuthorizationGrant> {
    try {
      return await pollCodexDeviceAuthorization({
        authorization: pending.authorization,
        fetchFn: this.fetchFn,
        signal: pending.controller.signal,
        now: this.now,
        sleep: this.sleep,
      });
    } catch (err) {
      if (pending.controller.signal.aborted) throw new CodexAuthorizationCancelledError();
      throw err;
    }
  }

  /**
   * Exchange the device-auth authorization code at the token endpoint
   * through the runtime enrollment (strict response validation), then
   * decorate with the ChatGPT account id for backend routing.
   */
  private async exchangeGrantForTokens(
    grant: CodexDeviceAuthorizationGrant,
    signal: AbortSignal,
  ): Promise<OAuthSubscriptionTokens> {
    const tokens = await exchangeCodexDeviceAuthorizationCode({
      grant,
      fetchFn: this.fetchFn,
      signal,
      now: this.now,
    });
    const claims = extractCodexAccountClaims(tokens.access_token, tokens.id_token);
    return { ...tokens, account_id: claims?.accountId || tokens.account_id || '' };
  }

  private async saveTokens(tokens: OAuthSubscriptionTokens): Promise<void> {
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
  private async loadTokens(): Promise<OAuthSubscriptionTokens | null> {
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
    return result.tokens;
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
/**
 * Whether the Codex subscription card is enabled at all in this build.
 * Same opt-out shape as the Claude service, driven by the runtime
 * enrollment gate.
 */
export function isOpenAiCodexExperimentalEnabled(): boolean {
  return isOAuthEnrollmentProviderEnabled('openai-codex');
}

class CodexAuthorizationCancelledError extends Error {}

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
