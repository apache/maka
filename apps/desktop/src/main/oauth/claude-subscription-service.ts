/**
 * Claude subscription OAuth service (main-process only).
 *
 * Responsibilities:
 *   1. PKCE authorize URL generation + pending state (G-X1).
 *   2. Paste-code parsing + state validation (G-X2).
 *   3. Token exchange + refresh + persistence via the shared
 *      CredentialStore (workspace credentials.json) — the single
 *      cross-surface token authority (#1125). Refresh goes through
 *      the runtime's provider refresher so desktop and pure-Node
 *      surfaces share one refresh implementation.
 *   4. Usage quota fetch (caches with QUOTA_CACHE_TTL_MS).
 *   5. Logout: clears in-memory + deletes token file.
 *   6. Account state snapshot for renderer (no token-shaped fields).
 *
 * Hard gates enforced:
 *   - Renderer NEVER sees access_token / refresh_token. The state
 *     snapshot omits them; this module's public methods return
 *     either `SubscriptionAccountState` or `SubscriptionActionResult`.
 *   - Cloaked headers are loaded ONLY via dynamic import inside the
 *     env-flag-gated branch (xuan G-X4). Tests verify this.
 *   - Refresh failure does NOT auto-logout (kenji `cf41871b`).
 *   - PKCE state matched with constant-time equality (G-X1).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  PENDING_AUTHORIZATION_TTL_MS,
  PKCE_VERIFIER_LENGTH_BYTES,
  QUOTA_CACHE_TTL_MS,
  TOKEN_REFRESH_SKEW_MS,
  base64urlEncode,
  buildClaudeAuthorizationUrl,
  constantTimeStringEqual,
  parsePastedAuthorization,
  type AuthorizationUrlPayload,
  type QuotaSnapshot,
  type Sha256Digest,
  type SubscriptionAccountProfile,
  type SubscriptionAccountState,
  type SubscriptionActionFailureReason,
  type SubscriptionActionResult,
} from '@maka/core';
import {
  fetchClaudeSubscriptionUsage,
  refreshAndPersistOAuthSubscriptionTokens,
  resolveAndPersistOAuthSubscriptionTokens,
  type OAuthSubscriptionRefreshAndPersistOutcome,
} from '@maka/runtime';
import {
  deleteSharedOAuthTokens,
  loadSharedOAuthTokens,
  saveSharedOAuthTokens,
  type SharedOAuthCredentialStore,
} from './shared-credential-bridge.js';

// =============================================================
// Endpoints + client id — mirror Claude Code's current OAuth
// login flow. Verified against the installed Claude Code 2.1.153
// binary constants (`CLAUDE_AI_AUTHORIZE_URL`, `TOKEN_URL`) after
// the older Claude.ai / console.anthropic.com OAuth route started
// rejecting new auth attempts.
// =============================================================
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AUTHORIZE_ENDPOINT = 'https://claude.com/cai/oauth/authorize';
const CLAUDE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const CLAUDE_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile';
const CLAUDE_SCOPE = 'user:sessions:claude_code user:mcp_servers user:file_upload';

// Anthropic's OAuth token endpoint rejects requests whose
// User-Agent does not match the `claude-cli/X.Y.Z (external, cli)`
// shape (verified against Claude Code 2.1.153).
// WAWQAQ msg a62a4c1c reported "Invalid request format" after
// login; the symptom was the OAuth endpoint rejecting our previous
// `maka-desktop/0.1.0 (oauth-subscription)` UA. The cloak path is a
// SEPARATE concern (system prefix + metadata on the SEND path) and
// now defaults on for the visible OAuth model path. WAWQAQ
// already accepted the ToS implication of the OAuth flow at all
// (msg `fd421634`, baked into `isSubscriptionExperimentalEnabled`).
export const CLAUDE_SUBSCRIPTION_PRODUCT_VERSION = '2.1.153';
const OAUTH_USER_AGENT = `claude-cli/${CLAUDE_SUBSCRIPTION_PRODUCT_VERSION} (external, cli)`;

// =============================================================
// Token storage — shared CredentialStore (workspace
// credentials.json), the cross-surface authority (#1125).
// =============================================================

/**
 * Tokens persisted to the shared store. INTERNAL TO THIS MODULE —
 * never crosses the IPC boundary. The renderer only sees the public
 * `SubscriptionAccountState` shape, which omits these fields.
 *
 * Field names use snake_case to match Anthropic's token response;
 * we don't re-key on save.
 *
 * NOTE: this interface intentionally uses string literal property
 * names below to keep the contract-test scan (which forbids
 * `accessToken:` and `refreshToken:` as object-literal keys in
 * preload / renderer code) ergonomic. This file lives in `main/`
 * which is OFF the scan path, and the property names are explicit
 * snake_case OAuth protocol names — not engineering identifiers.
 */
interface PersistedTokens {
  /* eslint-disable @typescript-eslint/naming-convention -- OAuth protocol field names */
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  scope: string;
  account_uuid: string;
  /* eslint-enable */
}

// =============================================================
// Pending authorization map (PKCE state).
// =============================================================

interface PendingAuthorization {
  verifier: string;
  state: string;
  createdAt: number;
  /**
   * The authorization URL we generated. Cached here so
   * `openAuthorizationUrl(authRequestId)` opens the URL we built
   * — the renderer never gets to pick which URL to open
   * externally. kenji `1da909d5` non-blocking hardening: don't let
   * a malicious renderer hand `shell.openExternal` an arbitrary URL.
   */
  url: string;
}

class ClaudeTokenExchangeError extends Error {
  // PR-CLAUDE-OAUTH-TOKEN-EXCHANGE-BODY-0: also carry Anthropic's
  // response body so the user can see WHY the exchange failed
  // (`invalid_grant: code already used`, `expired_token`, etc.)
  // instead of the catch-all "授权码已过期、已使用或与本次登录不匹配"
  // fallback. The body is best-effort: if reading it throws, we keep
  // the original status-only error semantics.
  constructor(readonly status: number, readonly body?: string) {
    super(`Claude OAuth token endpoint returned ${status}.${body ? ` ${body}` : ''}`);
    this.name = 'ClaudeTokenExchangeError';
  }
}

// =============================================================
// Node SHA-256 implementation, injected into core's pure helpers.
// =============================================================

const nodeSha256: Sha256Digest = {
  digest(input: string): Uint8Array {
    return new Uint8Array(createHash('sha256').update(input, 'utf8').digest());
  },
};

// =============================================================
// Service class.
// =============================================================

export interface ClaudeSubscriptionServiceDeps {
  /** Absolute path to userData dir; e.g. app.getPath('userData'). */
  userDataDir: string;
  /** Opens the provider authorization URL in the system browser. */
  openExternal: (url: string) => Promise<void>;
  /** Function returning current epoch ms. Injectable for tests. */
  now?: () => number;
  /** fetch implementation. Defaults to global fetch (Node 18+). */
  fetchFn?: typeof fetch;
  /** Shared workspace credential store — the authoritative token store for every surface (#1125). */
  credentialStore: SharedOAuthCredentialStore;
}

export class ClaudeSubscriptionService {
  /** Pre-#1125 safeStorage-encrypted token file. Never written or read
   *  anymore; unlinked on logout in case the startup import could not
   *  run (e.g. keychain unavailable) so logout still means "no
   *  credential survives anywhere". */
  private readonly legacyTokenFilePath: string;
  private readonly deviceIdFilePath: string;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly credentialStore: SharedOAuthCredentialStore;

  private cachedQuota: QuotaSnapshot | null = null;
  private cachedProfile: SubscriptionAccountProfile | null = null;
  private pending: Map<string, PendingAuthorization> = new Map();

  // Runtime state diagnostics. Used by the snapshot getter.
  private lastRefreshFailedMessage: string | null = null;
  private lastRejectionMessage: string | null = null;
  private quotaFetchFailedMessage: string | null = null;
  private lastStorageFailedMessage: string | null = null;
  private authorizing = false;
  private refreshing = false;

  constructor(deps: ClaudeSubscriptionServiceDeps) {
    this.legacyTokenFilePath = join(deps.userDataDir, '.claude_subscription_token');
    this.deviceIdFilePath = join(deps.userDataDir, '.claude_subscription_device_id');
    this.openExternal = deps.openExternal;
    this.now = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? (globalThis.fetch as typeof fetch);
    this.credentialStore = deps.credentialStore;
  }

  // -----------------------------------------------------------
  // PUBLIC API — these are what the IPC handlers call.
  // -----------------------------------------------------------

  /**
   * Start an authorization attempt: returns the URL the renderer
   * should open externally, plus an opaque `authRequestId` that's
   * required when the user pastes the redirect code back.
   *
   * The verifier + state are persisted in the in-memory pending
   * map ONLY — never on disk, never to the renderer.
   */
  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload> {
    this.pruneExpiredPending();
    // PR-CLAUDE-OAUTH-SINGLE-PENDING-0 (WAWQAQ msg b481e9db):
    // clear any non-expired prior pending before generating a new one
    // so the renderer only ever holds ONE valid authRequestId at a
    // time. Otherwise: user clicks "登录" twice within the 10-min TTL,
    // both pendings stay in the map, the modal shows the LATEST
    // state hint, but the user's browser may still have the older
    // Anthropic tab open and paste back a code whose state matches
    // the OLDER pending — state validation against the latest
    // pending fails and the user is stuck in an undebuggable loop.
    // Claude OAuth is single-user / single-flow; there is no
    // legitimate reason for multiple concurrent pendings.
    this.pending.clear();
    const verifier = base64urlEncode(randomBytes(PKCE_VERIFIER_LENGTH_BYTES));
    // Upstream Claude Code uses the PKCE verifier as the OAuth state
    // value. Anthropic's authorize page rejects shorter, unrelated
    // state strings with "Invalid request format", so keep this flow
    // source-compatible while still validating the pasted state strictly.
    const state = verifier;
    const authRequestId = randomUUID();
    const url = buildClaudeAuthorizationUrl(
      {
        clientId: CLAUDE_CLIENT_ID,
        authorizeEndpoint: CLAUDE_AUTHORIZE_ENDPOINT,
        redirectUri: CLAUDE_REDIRECT_URI,
        scope: CLAUDE_SCOPE,
      },
      verifier,
      state,
      nodeSha256,
    );
    this.pending.set(authRequestId, {
      verifier,
      state,
      createdAt: this.now(),
      url,
    });
    // kenji `027c93c0`: do NOT return `url` to the renderer. The
    // URL is stored in `pending.url` and opened by main when the
    // renderer calls `openAuthorizationUrl(authRequestId)`. This
    // keeps the URL surface narrow: renderer never holds or
    // transmits it.
    return {
      stateHint: state.slice(0, 8),
      authRequestId,
    };
  }

  /**
   * Open the authorization URL we generated for a pending request.
   *
   * kenji `1da909d5` non-blocking hardening: renderer hands us
   * an opaque `authRequestId`, NOT a URL. We look up the URL
   * from our own pending map. The renderer never gets to call
   * `shell.openExternal` with a renderer-controlled URL.
   */
  async openAuthorizationUrl(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      return { ok: false, reason: 'authorization_pending', message: '授权会话不存在，请重新点击“登录订阅”。' };
    }
    if (this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS) {
      this.pending.delete(authRequestId);
      return { ok: false, reason: 'authorization_expired', message: '授权请求已过期，请重新点击“登录订阅”。' };
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
   * Validate the pasted code, then exchange for tokens.
   *
   * Upstream Claude Code uses the PKCE verifier itself as OAuth state.
   * That means the pasted `code#state` contains the verifier needed
   * for token exchange. We still validate against pending state when
   * pending exists, but if the in-memory pending map was lost
   * (renderer reload, modal unmount, main-process restart) we can
   * recover from the pasted state instead of forcing the user into a
   * dead "authorization_pending" path.
   */
  async completeAuthorization(
    authRequestId: string,
    rawPasted: unknown,
  ): Promise<SubscriptionActionResult> {
    const parsed = parsePastedAuthorization(rawPasted);
    if (!parsed) {
      return {
        ok: false,
        reason: 'invalid_paste_code',
        message: '授权码格式不正确，请粘贴完整字符串（包含 `#` 分隔符）。',
      };
    }
    const pending = this.pending.get(authRequestId);
    const pendingExpired = pending ? this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS : false;
    if (pending && !constantTimeStringEqual(parsed.state, pending.state)) {
      if (pendingExpired) this.pending.delete(authRequestId);
      return { ok: false, reason: 'invalid_paste_code', message: '授权码 state 校验失败，请重新登录。' };
    }
    if (pendingExpired) this.pending.delete(authRequestId);
    const recoverFromPastedState = !pending || pendingExpired;
    if (recoverFromPastedState && !looksLikeClaudePkceVerifier(parsed.state)) {
      this.authorizing = false;
      return { ok: false, reason: 'authorization_pending', message: '请重新点击“登录订阅”获取新的授权码。' };
    }
    const verifier = recoverFromPastedState ? parsed.state : pending!.verifier;

    try {
      const tokens = await this.exchangeCodeForTokens(parsed.code, verifier, parsed.state);
      // Storage failures are not exchange failures: the one-time code
      // was consumed successfully, so tell the user to fix the store
      // instead of implying the code was bad.
      try {
        await this.saveTokens(tokens);
      } catch {
        this.authorizing = false;
        return { ok: false, reason: 'storage_failed', message: this.lastStorageFailedMessage ?? '写入共享凭据失败，请检查 credentials.json 权限后重试。' };
      }
      this.pending.delete(authRequestId);
      this.authorizing = false;
      // Kick a profile fetch in the background; failure is non-fatal
      // (the user is authenticated regardless of profile success).
      void this.refreshProfile();
      return { ok: true };
    } catch (err) {
      this.authorizing = false;
      return this.failureFromError('token_exchange_failed', err, '授权码已过期、已使用或与本次登录不匹配，请重新点击“登录订阅”获取新的授权码。');
    }
  }

  /**
   * Cancel a pending authorization (user closed the modal).
   */
  cancelAuthorization(authRequestId?: string): void {
    if (authRequestId !== undefined) {
      this.pending.delete(authRequestId);
    } else {
      this.pending.clear();
    }
    this.authorizing = false;
  }

  /**
   * Snapshot of the current account state for the renderer.
   * NO token-shaped fields exposed (xuan G-X3).
   */
  async getAccountState(): Promise<SubscriptionAccountState> {
    const tokens = await this.loadTokens();
    if (!tokens) {
      if (this.lastStorageFailedMessage) {
        return {
          provider: 'claude-subscription',
          runtimeState: 'storage_failed',
          errorMessage: this.lastStorageFailedMessage,
        };
      }
      return {
        provider: 'claude-subscription',
        runtimeState: this.authorizing ? 'authorizing' : 'not_logged_in',
      };
    }
    const runtimeState = this.deriveRuntimeState(tokens);
    return {
      provider: 'claude-subscription',
      runtimeState,
      // The cached profile is only valid for the account the shared
      // store currently holds — another surface may have re-logged in
      // with a different account since the profile was fetched.
      profile: this.cachedProfile?.accountUuid === tokens.account_uuid
        ? this.cachedProfile
        : { accountUuid: tokens.account_uuid },
      quota: this.cachedQuota ?? undefined,
      errorMessage: this.errorForState(runtimeState),
    };
  }

  /**
   * Force a token refresh.
   *
   * kenji `cf41871b`: refresh FAILURE does NOT auto-delete the
   * token file. The user sees `refresh_failed` and must click
   * "重新登录".
   */
  async refreshTokens(): Promise<SubscriptionActionResult> {
    this.refreshing = true;
    try {
      const result = await refreshAndPersistOAuthSubscriptionTokens({
        providerType: 'claude-subscription',
        slug: 'claude-subscription',
        credentialStore: this.credentialStore,
        now: this.now,
        fetchFn: this.fetchFn,
      });
      return this.applyRefreshOutcome(result);
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Refresh the cached quota snapshot. Caller can call this on
   * Settings page mount or after a refresh.
   */
  async refreshQuota(): Promise<SubscriptionActionResult> {
    const accessToken = await this.getAccessTokenInternal();
    if (!accessToken) {
      return { ok: false, reason: 'unknown', message: '当前未登录。' };
    }
    try {
      const snapshot = await fetchClaudeSubscriptionUsage({
        accessToken,
        fetchFn: this.fetchFn,
        now: this.now,
      });
      this.cachedQuota = snapshot;
      this.quotaFetchFailedMessage = null;
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Quota request failed.';
      this.quotaFetchFailedMessage = message;
      return { ok: false, reason: 'unknown', message };
    }
  }

  /**
   * Logout: clear in-memory + delete token file.
   *
   * **Local clear only** — remote OAuth revocation is NOT performed.
   * Anthropic does not publicly expose an RFC 7009 revocation
   * endpoint as of 2026-05-28; the upstream Claude.ai client logout
   * (verified against the external reference at main.js:16280-16295)
   * also only unlinks the local token file. Access tokens remain server-valid
   * until natural expiry (~1 hour); refresh tokens remain valid
   * until their TTL or until the user explicitly revokes them via
   * the claude.ai account-side UI.
   *
   * What this method DOES:
   *   - Delete the shared-store token (the authority) and any legacy
   *     safeStorage token file the startup import could not process.
   *   - Clear `cachedProfile`, `cachedQuota`.
   *   - Clear in-flight pending authorizations.
   *   - Clear runtime diagnostic flags.
   */
  async logout(): Promise<SubscriptionActionResult> {
    this.cachedQuota = null;
    this.cachedProfile = null;
    this.lastRefreshFailedMessage = null;
    this.lastRejectionMessage = null;
    this.quotaFetchFailedMessage = null;
    this.lastStorageFailedMessage = null;
    this.pending.clear();
    this.authorizing = false;
    let legacyDeleteFailed = false;
    try {
      await fs.unlink(this.legacyTokenFilePath);
    } catch (err) {
      // ENOENT is fine; anything else is suspicious but not fatal.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        legacyDeleteFailed = true;
      }
    }
    try {
      await deleteSharedOAuthTokens(this.credentialStore, 'claude-subscription');
    } catch {
      return { ok: false, reason: 'storage_failed', message: '删除共享凭据失败，请手动清理。' };
    }
    if (legacyDeleteFailed) return { ok: false, reason: 'storage_failed', message: '删除本地遗留凭据失败，请手动清理。' };
    return { ok: true };
  }

  /**
   * Get an access token (refreshing if needed). Caller is
   * responsible for keeping the returned token inside the main
   * process — never IPC it out (G-X3).
   *
   * Used by the future subscription send-path (PR-OAUTH-SUBSCRIPTION-1).
   */
  async getAccessTokenInternal(): Promise<string | null> {
    this.refreshing = true;
    try {
      const result = await resolveAndPersistOAuthSubscriptionTokens({
        providerType: 'claude-subscription',
        slug: 'claude-subscription',
        credentialStore: this.credentialStore,
        now: this.now,
        fetchFn: this.fetchFn,
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
   * triggering `getAccessTokenInternal()`'s near-expiry refresh.
   *
   * Read-only status paths (onboarding's `getSnapshot`) must be able
   * to answer "is this connection credentialed?" without the side
   * effect of a network refresh — refreshing on every onboarding read
   * would let simply opening the app hit the network and mutate local
   * token state, and would misreport an otherwise-valid login as
   * missing credentials if that incidental refresh happened to fail.
   */
  async hasStoredCredential(): Promise<boolean> {
    const tokens = await this.loadTokens();
    return tokens !== null;
  }

  // -----------------------------------------------------------
  // INTERNALS
  // -----------------------------------------------------------

  private applyRefreshOutcome(result: OAuthSubscriptionRefreshAndPersistOutcome): SubscriptionActionResult {
    if (result.outcome === 'refreshed' || result.outcome === 'superseded') {
      this.lastRefreshFailedMessage = null;
      this.lastStorageFailedMessage = null;
      return { ok: true };
    }
    if (result.outcome === 'storage-failed') {
      const message = '访问 Claude OAuth 共享凭据失败，请检查 credentials.json 权限后重试。';
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

  private deriveRuntimeState(
    tokens: PersistedTokens,
  ): import('@maka/core').OAuthSubscriptionRuntimeState {
    if (this.refreshing) return 'refreshing';
    if (this.lastRefreshFailedMessage) return 'refresh_failed';
    if (this.lastStorageFailedMessage) return 'storage_failed';
    if (this.lastRejectionMessage) return 'provider_rejected';
    if (this.quotaFetchFailedMessage) return 'quota_unavailable';
    if (tokens.expires_at - this.now() <= TOKEN_REFRESH_SKEW_MS) return 'authenticated';
    return 'authenticated';
  }

  private errorForState(
    state: import('@maka/core').OAuthSubscriptionRuntimeState,
  ): string | undefined {
    switch (state) {
      case 'refresh_failed':
        return this.lastRefreshFailedMessage ?? undefined;
      case 'storage_failed':
        return this.lastStorageFailedMessage ?? undefined;
      case 'provider_rejected':
        return this.lastRejectionMessage ?? undefined;
      case 'quota_unavailable':
        return this.quotaFetchFailedMessage ?? undefined;
      default:
        return undefined;
    }
  }

  private pruneExpiredPending(): void {
    const cutoff = this.now() - PENDING_AUTHORIZATION_TTL_MS;
    for (const [id, p] of this.pending) {
      if (p.createdAt < cutoff) this.pending.delete(id);
    }
  }

  private async exchangeCodeForTokens(code: string, verifier: string, state: string): Promise<PersistedTokens> {
    const response = await this.fetchFn(CLAUDE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': OAUTH_USER_AGENT,
      },
      body: JSON.stringify({
        code,
        state,
        grant_type: 'authorization_code',
        client_id: CLAUDE_CLIENT_ID,
        redirect_uri: CLAUDE_REDIRECT_URI,
        code_verifier: verifier,
      }),
    });
    if (!response.ok) {
      // Read the body (best-effort, never throw) so the user can
      // see Anthropic's actual reject reason — `invalid_grant: code
      // already used`, `expired_token`, etc. Without this Maka has
      // been falling back to a generic "授权码已过期、已使用或与本次
      // 登录不匹配" message that hides whether the failure is on
      // Anthropic's side, the user's side, or our request shape.
      const raw = await response.text().catch(() => '');
      const compact = raw.replace(/\s+/g, ' ').slice(0, 280);
      throw new ClaudeTokenExchangeError(response.status, compact || undefined);
    }
    const payload = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      token_type: string;
      scope: string;
      account?: { uuid?: string };
    };
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_at: this.now() + 1000 * payload.expires_in,
      token_type: payload.token_type,
      scope: payload.scope,
      account_uuid: payload.account?.uuid ?? '',
    };
  }

  private async saveTokens(tokens: PersistedTokens): Promise<void> {
    try {
      await saveSharedOAuthTokens(this.credentialStore, 'claude-subscription', tokens);
    } catch (err) {
      // Fail closed: a token we cannot persist for every surface is a
      // storage failure, not a partial success.
      this.lastStorageFailedMessage = '写入 Claude OAuth 共享凭据失败，请检查 credentials.json 权限后重试。';
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
      result = await loadSharedOAuthTokens(this.credentialStore, 'claude-subscription');
    } catch {
      this.lastStorageFailedMessage = '读取 Claude OAuth 共享凭据失败，请检查 credentials.json 或重新登录。';
      return null;
    }
    if (result.status === 'corrupt') {
      // Entry exists but is not a token payload; it is kept as-is
      // (reads never destroy secrets) and a fresh login overwrites it.
      this.lastStorageFailedMessage = 'Claude OAuth 共享凭据无法解析，请重新登录。';
      return null;
    }
    if (result.status === 'missing') return null;
    this.lastStorageFailedMessage = null;
    const tokens = result.tokens;
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      token_type: tokens.token_type ?? 'Bearer',
      scope: tokens.scope ?? '',
      account_uuid: tokens.account_uuid ?? '',
    };
  }

  private async refreshProfile(): Promise<void> {
    const accessToken = await this.getAccessTokenInternal();
    if (!accessToken) return;
    try {
      const response = await this.fetchFn(CLAUDE_PROFILE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': OAUTH_USER_AGENT,
        },
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        account?: { uuid?: string; email?: string; email_address?: string; display_name?: string };
      };
      if (data.account) {
        this.cachedProfile = {
          accountUuid: data.account.uuid ?? ((await this.loadTokens())?.account_uuid ?? ''),
          email: data.account.email ?? data.account.email_address,
          displayName: data.account.display_name,
        };
      }
    } catch {
      // non-fatal
    }
  }

  private failureFromError(
    fallbackReason: SubscriptionActionFailureReason,
    err: unknown,
    fallbackMessage = '操作失败。',
  ): SubscriptionActionResult {
    if (err instanceof ClaudeTokenExchangeError) {
      if (err.status === 429) {
        return { ok: false, reason: fallbackReason, message: 'Claude OAuth 请求过于频繁，请稍后重新登录。' };
      }
      if (err.status >= 500) {
        return { ok: false, reason: fallbackReason, message: 'Claude OAuth 服务暂时不可用，请稍后重新登录。' };
      }
      // 4xx: append Anthropic's actual reject reason when we have it
      // so the user sees `invalid_grant` / `expired_token` / etc.
      // and can tell whether the code was already used vs the
      // request shape is still wrong.
      const detail = err.body ? ` Anthropic 返回 ${err.status}: ${err.body}` : '';
      return { ok: false, reason: fallbackReason, message: `${fallbackMessage}${detail}` };
    }
    const message = err instanceof Error ? err.message : '操作失败。';
    return { ok: false, reason: fallbackReason, message };
  }

  /**
   * Quota cache is fresh if fetched within QUOTA_CACHE_TTL_MS.
   */
  isQuotaCacheFresh(): boolean {
    if (!this.cachedQuota) return false;
    return this.now() - this.cachedQuota.fetchedAt < QUOTA_CACHE_TTL_MS;
  }

  /**
   * Read or create the persistent device ID. 32 hex chars,
   * mode 0o600. Exposed so the future subscription send-path can
   * include it in the cloaked metadata block.
   */
  async getOrCreateDeviceId(): Promise<string> {
    try {
      const existing = (await fs.readFile(this.deviceIdFilePath, 'utf8')).trim();
      if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    } catch {
      // fall through to create
    }
    const next = randomBytes(32).toString('hex');
    try {
      await fs.mkdir(dirname(this.deviceIdFilePath), { recursive: true });
      await fs.writeFile(this.deviceIdFilePath, next, { mode: 0o600 });
      await fs.chmod(this.deviceIdFilePath, 0o600);
    } catch {
      // best-effort persistence; in-memory only if disk failed
    }
    return next;
  }
}

/**
 * Resolve whether the cloak path is enabled. Used by the future
 * subscription send-path to decide whether to delegate to the runtime
 * cloaked request builder. Centralized here so the contract test
 * has a single anchor.
 */
export function isCloakEnabled(): boolean {
  return process.env.MAKA_CLAUDE_SUBSCRIPTION_CLOAK !== '0';
}

function looksLikeClaudePkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

/**
 * Whether Claude subscription is enabled at all in this build.
 *
 * kenji `1da909d5` blocking concern: Anthropic's legal docs
 * (https://code.claude.com/docs/en/legal-and-compliance) say
 * third-party developers should use API key auth and do NOT
 * permit third-party developers to offer Claude.ai login or
 * route Free/Pro/Max credentials on behalf of users.
 *
 * WAWQAQ msg `fd421634` on 2026-05-29 explicitly accepted the
 * ToS risk and asked why the OAuth card was missing from
 * Settings · 账号. The kill-switch now defaults to ON; setting
 * `MAKA_CLAUDE_SUBSCRIPTION_EXPERIMENTAL=0` explicitly disables
 * it for users who need to opt out (e.g. corp deployments with
 * tighter compliance requirements).
 *
 * The cloak flag (`isCloakEnabled`) is a separate, finer-grained
 * switch inside the subscription send path. It defaults ON because
 * the visible Claude OAuth card promises a usable model after login;
 * `MAKA_CLAUDE_SUBSCRIPTION_CLOAK=0` remains as an emergency opt-out.
 */
// Re-exported from claude-subscription-helpers.ts so unit tests can import
// the gate without dragging in the `electron` ESM module.
