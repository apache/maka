/**
 * Cursor subscription OAuth service (main-process only).
 *
 * PR-MODEL-OAUTH-ALL-0. Cursor's flow is polling-based: no
 * loopback callback server, no paste code. The renderer opens
 * cursor.com/loginDeepControl in the user's default browser; main
 * polls api2.cursor.sh/auth/poll until the user finishes the
 * login. The poll response carries access + refresh tokens
 * directly.
 *
 * Hard gates (shared with the Claude / Codex services):
 *   - Renderer NEVER sees access_token / refresh_token. IPC
 *     payloads are `CursorAccountStateSnapshot`-shaped only.
 *   - Refresh failure does NOT auto-logout.
 *   - The login URL is held in-process; the renderer only
 *     receives an opaque `authRequestId`.
 *   - Tokens persist in the shared CredentialStore (workspace
 *     credentials.json), the cross-surface authority (#1125).
 *
 * Reference: cursor-auth plugin pattern (external reference).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  PENDING_AUTHORIZATION_TTL_MS,
  PKCE_VERIFIER_LENGTH_BYTES,
  base64urlEncode,
  type AuthorizationUrlPayload,
  type SubscriptionActionFailureReason,
  type SubscriptionActionResult,
} from '@maka/core';
import {
  refreshAndPersistOAuthSubscriptionTokens,
  resolveAndPersistOAuthSubscriptionTokens,
  type OAuthSubscriptionRefreshAndPersistOutcome,
} from '@maka/runtime';
import {
  CURSOR_OAUTH_CONFIG,
  buildCursorLoginUrl,
  getTokenExpiry,
  pkceChallengeFromVerifier,
} from './cursor-subscription-helpers.js';
import {
  deleteSharedOAuthTokens,
  loadSharedOAuthTokens,
  saveSharedOAuthTokens,
  type SharedOAuthCredentialStore,
} from './shared-credential-bridge.js';

// Endpoint shortcuts so the existing class body reads like the
// Claude / Codex services (constants at the top, lookups inline).
const CURSOR_LOGIN_URL = CURSOR_OAUTH_CONFIG.loginUrl;
const CURSOR_POLL_URL = CURSOR_OAUTH_CONFIG.pollUrl;
const CURSOR_REFRESH_URL = CURSOR_OAUTH_CONFIG.refreshUrl;
const POLL_MAX_ATTEMPTS = CURSOR_OAUTH_CONFIG.pollMaxAttempts;
const POLL_BASE_DELAY_MS = CURSOR_OAUTH_CONFIG.pollBaseDelayMs;
const POLL_MAX_DELAY_MS = CURSOR_OAUTH_CONFIG.pollMaxDelayMs;
const POLL_BACKOFF_MULTIPLIER = CURSOR_OAUTH_CONFIG.pollBackoffMultiplier;
const POLL_MAX_CONSECUTIVE_ERRORS = CURSOR_OAUTH_CONFIG.pollMaxConsecutiveErrors;

const PLAIN_USER_AGENT = 'maka-desktop/0.1.0 (oauth-subscription)';

// =============================================================
// Persisted tokens — INTERNAL TO THIS MODULE. Never crosses IPC.
// =============================================================
interface PersistedTokens {
  /* eslint-disable @typescript-eslint/naming-convention -- OAuth protocol field names */
  access_token: string;
  refresh_token: string;
  expires_at: number;
  /* eslint-enable */
}

interface PendingAuthorization {
  verifier: string;
  challenge: string;
  uuid: string;
  createdAt: number;
  url: string;
  /** Set to true when cancelAuthorization is called; the poll
   *  loop checks this between attempts and exits. */
  cancelled: boolean;
  /** The in-flight poll promise. Resolved with tokens on success,
   *  or rejected on timeout / error / cancellation. */
  pollPromise: Promise<PersistedTokens>;
}

// =============================================================
// Service class.
// =============================================================

export interface CursorSubscriptionServiceDeps {
  /** Absolute path to userData dir; e.g. app.getPath('userData'). */
  userDataDir: string;
  /** Opens the provider authorization URL in the system browser. */
  openExternal: (url: string) => Promise<void>;
  /** Function returning current epoch ms. Injectable for tests. */
  now?: () => number;
  /** fetch implementation. Defaults to global fetch (Node 18+). */
  fetchFn?: typeof fetch;
  /** Sleep function. Injectable for tests so poll loops don't
   *  actually wait. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Shared workspace credential store — the authoritative token store for every surface (#1125). */
  credentialStore: SharedOAuthCredentialStore;
}

export class CursorSubscriptionService {
  /** Pre-#1125 safeStorage-encrypted token file. Never written or read
   *  anymore; unlinked on logout in case the startup import could not
   *  run, so logout still means "no credential survives anywhere". */
  private readonly legacyTokenFilePath: string;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly credentialStore: SharedOAuthCredentialStore;

  private pending: Map<string, PendingAuthorization> = new Map();

  private lastRefreshFailedMessage: string | null = null;
  private authorizing = false;
  private refreshing = false;

  constructor(deps: CursorSubscriptionServiceDeps) {
    this.legacyTokenFilePath = join(deps.userDataDir, '.cursor_subscription_token');
    this.openExternal = deps.openExternal;
    this.now = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
    this.sleepFn =
      deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.credentialStore = deps.credentialStore;
  }

  // -----------------------------------------------------------
  // PUBLIC API
  // -----------------------------------------------------------

  /**
   * Build the PKCE-protected login URL and start a background
   * poll against api2.cursor.sh. The poll resolves with tokens
   * once the user completes the in-browser flow.
   */
  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
    this.pruneExpiredPending();
    const verifier = base64urlEncode(randomBytes(PKCE_VERIFIER_LENGTH_BYTES));
    const challenge = pkceChallengeFromVerifier(verifier);
    const uuid = randomUUID();
    const authRequestId = randomUUID();
    const url = buildCursorLoginUrl({
      loginUrl: CURSOR_LOGIN_URL,
      challenge,
      uuid,
    });

    const pendingShell: PendingAuthorization = {
      verifier,
      challenge,
      uuid,
      createdAt: this.now(),
      url,
      cancelled: false,
      // Placeholder; replaced below once the closure is built.
      pollPromise: Promise.reject(new Error('not started')),
    };
    pendingShell.pollPromise.catch(() => {
      /* swallow placeholder rejection */
    });
    pendingShell.pollPromise = this.runPollLoop(pendingShell);
    // Stash a no-op handler so node doesn't unhandled-reject the
    // background poll when the user closes the modal without
    // calling completeAuthorization.
    pendingShell.pollPromise.catch(() => {
      /* surfaced via completeAuthorization */
    });
    this.pending.set(authRequestId, pendingShell);

    return {
      stateHint: uuid.slice(0, 8),
      authRequestId,
    };
  }

  /**
   * Open the authorization URL we generated for a pending request.
   * The renderer hands us only the opaque authRequestId.
   */
  async openAuthorizationUrl(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      return { ok: false, reason: 'authorization_pending', message: '授权会话不存在，请重新点击“登录 Cursor”。' };
    }
    if (this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS) {
      this.disposePending(authRequestId);
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录 Cursor”。' };
    }
    try {
      await this.openExternal(pending.url);
      this.authorizing = true;
      return { ok: true };
    } catch (err) {
      return this.failureFromError('unknown', err);
    }
  }

  /**
   * Await the background poll loop and persist the tokens it
   * returned. Renderer-side this is what's invoked after the
   * "登录 Cursor" button completes the open-external step — the
   * UI then sits on the resulting promise until the user finishes
   * the browser flow.
   */
  async completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      this.authorizing = false;
      return { ok: false, reason: 'authorization_pending', message: '请先点击“登录 Cursor”再完成授权。' };
    }
    try {
      const tokens = await pending.pollPromise;
      await this.saveTokens(tokens);
      this.disposePending(authRequestId);
      this.authorizing = false;
      return { ok: true };
    } catch (err) {
      this.disposePending(authRequestId);
      this.authorizing = false;
      return this.failureFromError('token_exchange_failed', err);
    }
  }

  /**
   * Cancel a pending authorization. Flags the poll loop so it
   * exits before its next request.
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
   * Cursor doesn't expose a public profile claim in the JWT, so
   * the snapshot is intentionally minimal — just enough for the
   * UI to render "已登录" / "未登录" + a refresh action.
   */
  async getAccountState(): Promise<CursorAccountStateSnapshot> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      return {
        provider: 'cursor-subscription',
        runtimeState: this.authorizing ? 'authorizing' : 'not_logged_in',
      };
    }
    const runtimeState = this.deriveRuntimeState();
    return {
      provider: 'cursor-subscription',
      runtimeState,
      errorMessage: this.errorForState(runtimeState),
    };
  }

  /**
   * Force a token refresh. Cursor's refresh endpoint
   * (`/auth/exchange_user_api_key`) returns a new access /
   * refresh token pair.
   */
  async refreshTokens(): Promise<SubscriptionActionResult> {
    this.refreshing = true;
    try {
      const result = await refreshAndPersistOAuthSubscriptionTokens({
        slug: 'cursor-subscription',
        credentialStore: this.credentialStore,
        refreshTokens: (tokens, signal) => this.requestRefresh(tokens.refresh_token, signal),
      });
      return this.applyRefreshOutcome(result);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Logout: clear in-memory state, delete the shared-store token (the
   * authority) and any legacy safeStorage token file the startup
   * import could not process. Local clear only.
   */
  async logout(): Promise<SubscriptionActionResult> {
    this.lastRefreshFailedMessage = null;
    for (const id of [...this.pending.keys()]) this.disposePending(id);
    this.authorizing = false;
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
      await deleteSharedOAuthTokens(this.credentialStore, 'cursor-subscription');
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
  async getAccessTokenInternal(): Promise<string | null> {
    this.refreshing = true;
    try {
      const result = await resolveAndPersistOAuthSubscriptionTokens({
        slug: 'cursor-subscription',
        credentialStore: this.credentialStore,
        now: this.now,
        refreshSkewMs: 0,
        refreshTokens: (tokens, signal) => this.requestRefresh(tokens.refresh_token, signal),
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

  // -----------------------------------------------------------
  // INTERNALS
  // -----------------------------------------------------------

  private applyRefreshOutcome(result: OAuthSubscriptionRefreshAndPersistOutcome): SubscriptionActionResult {
    if (result.outcome === 'refreshed' || result.outcome === 'superseded') {
      this.lastRefreshFailedMessage = null;
      return { ok: true };
    }
    const message = result.outcome === 'logged-out'
      ? '登录状态已变更，本次刷新结果已丢弃。'
      : result.outcome === 'storage-failed'
        ? '访问 Cursor OAuth 共享凭据失败，请检查 credentials.json 权限后重试。'
        : result.error instanceof Error ? result.error.message : '刷新失败，请重新登录。';
    this.lastRefreshFailedMessage = message;
    return {
      ok: false,
      reason: result.outcome === 'storage-failed' ? 'storage_failed' : 'refresh_failed',
      message,
    };
  }

  private deriveRuntimeState(): CursorRuntimeState {
    if (this.refreshing) return 'refreshing';
    if (this.lastRefreshFailedMessage) return 'refresh_failed';
    return 'authenticated';
  }

  private errorForState(state: CursorRuntimeState): string | undefined {
    if (state === 'refresh_failed') return this.lastRefreshFailedMessage ?? undefined;
    return undefined;
  }

  private pruneExpiredPending(): void {
    const cutoff = this.now() - PENDING_AUTHORIZATION_TTL_MS;
    for (const [id, p] of this.pending) {
      if (p.createdAt < cutoff) this.disposePending(id);
    }
  }

  private async runPollLoop(pending: PendingAuthorization): Promise<PersistedTokens> {
    let delay: number = POLL_BASE_DELAY_MS;
    let consecutiveErrors = 0;
    let lastError: string | undefined;
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      if (pending.cancelled) {
        throw new Error('Authorization cancelled.');
      }
      await this.sleepFn(delay);
      if (pending.cancelled) {
        throw new Error('Authorization cancelled.');
      }
      try {
        const response = await this.fetchFn(
          `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(pending.uuid)}&verifier=${encodeURIComponent(pending.verifier)}`,
          {
            headers: { 'User-Agent': PLAIN_USER_AGENT },
          },
        );
        if (response.status === 404) {
          // Not yet ready. Back off and retry.
          consecutiveErrors = 0;
          delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
          continue;
        }
        if (response.ok) {
          const data = (await response.json()) as {
            accessToken: string;
            refreshToken: string;
          };
          return {
            access_token: data.accessToken,
            refresh_token: data.refreshToken,
            expires_at: getTokenExpiry(data.accessToken, this.now()),
          };
        }
        // Non-404, non-200: treat as an error attempt.
        const body = await response.text().catch(() => '');
        throw new Error(`Poll failed: ${response.status}${body ? ` - ${body}` : ''}`);
      } catch (err) {
        consecutiveErrors++;
        lastError = err instanceof Error ? err.message : String(err);
        if (consecutiveErrors >= POLL_MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`Cursor auth polling failed: ${lastError}`);
        }
        delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY_MS);
      }
    }
    throw new Error(`Cursor authentication polling timeout${lastError ? `: ${lastError}` : ''}`);
  }

  private disposePending(authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (!pending) return;
    pending.cancelled = true;
    this.pending.delete(authRequestId);
  }

  private async requestRefresh(
    refreshToken: string,
    signal: AbortSignal,
  ): Promise<PersistedTokens> {
    const response = await this.fetchFn(CURSOR_REFRESH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshToken}`,
        'Content-Type': 'application/json',
        'User-Agent': PLAIN_USER_AGENT,
      },
      body: '{}',
      signal,
    });
    if (!response.ok) throw new Error(`Cursor token refresh failed (${response.status}).`);
    const data = (await response.json()) as {
      accessToken: string;
      refreshToken?: string;
    };
    return {
      access_token: data.accessToken,
      refresh_token: data.refreshToken ?? refreshToken,
      expires_at: getTokenExpiry(data.accessToken, this.now()),
    };
  }

  private async saveTokens(tokens: PersistedTokens): Promise<void> {
    // Fail closed: a store write failure propagates to the caller's
    // failure envelope instead of pretending the login stuck.
    await saveSharedOAuthTokens(this.credentialStore, 'cursor-subscription', tokens);
  }

  /**
   * Always reads the shared store — no in-memory copy; the store is
   * the cross-surface authority (#1125). A corrupt entry is preserved
   * for recovery; a fresh login can overwrite it.
   */
  private async loadTokens(): Promise<PersistedTokens | null> {
    let result: Awaited<ReturnType<typeof loadSharedOAuthTokens>>;
    try {
      result = await loadSharedOAuthTokens(this.credentialStore, 'cursor-subscription');
    } catch {
      return null;
    }
    if (result.status !== 'ok') return null;
    return {
      access_token: result.tokens.access_token,
      refresh_token: result.tokens.refresh_token,
      expires_at: result.tokens.expires_at,
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
// Public IPC payload shape — `cursor-subscription:get-account-state`.
// =============================================================
export type CursorRuntimeState =
  | 'not_logged_in'
  | 'authorizing'
  | 'authenticated'
  | 'refreshing'
  | 'refresh_failed';

export interface CursorAccountStateSnapshot {
  provider: 'cursor-subscription';
  runtimeState: CursorRuntimeState;
  errorMessage?: string;
}

// Re-exports for the IPC handler + focused protocol tests. The pure
// helpers keep URL, PKCE, and expiry logic independent of service state.
export {
  CURSOR_OAUTH_CONFIG,
  buildCursorLoginUrl,
  getTokenExpiry,
  isCursorSubscriptionExperimentalEnabled,
  pkceChallengeFromVerifier,
} from './cursor-subscription-helpers.js';
