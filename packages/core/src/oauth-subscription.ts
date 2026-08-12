/**
 * OAuth subscription contract — core types + pure helpers.
 *
 * Scope: Claude subscription types and pure helpers.
 *
 * This module is `@maka/core` so it is consumable from both main
 * and renderer. The types here MUST NOT include any token-shaped
 * field (no `accessToken`, no `refreshToken`, no `idToken`). Secret-bearing
 * main-process and runtime services own those values; the renderer consumes
 * the state enum, profile slice, and quota snapshot only.
 */

/**
 * Subscription provider kind. This contract currently contains
 * `claude-subscription` only. The discriminated union keeps provider nuances
 * (Anthropic PKCE vs Codex potentially loopback vs Copilot
 * device-flow) typed separately.
 */
export type OAuthSubscriptionProvider = 'claude-subscription';

/**
 * Runtime state for an OAuth subscription connection.
 *
 * kenji `cf41871b` requires the 4-state minimum (`not_logged_in` /
 * `refresh_failed` / `quota_unavailable` / `provider_rejected`);
 * xuan `2c5aa125` G-X5 requires that we distinguish credential
 * validity from operational readiness. We extend the minimum with
 * `authorizing` / `authenticated` / `refreshing` so the UI can
 * render lifecycle progress, but we do NOT include `operational`
 * here — operational status comes from a successful send and lives
 * outside the auth state (per xuan G-X5, until a real subscription
 * send path lands the runtime never reports `operational`).
 *
 * Closed union; future provider variants extend independently.
 */
export type OAuthSubscriptionRuntimeState =
  | 'not_logged_in' // no token file present
  | 'authorizing' // user clicked "登录", browser open, awaiting paste-code
  | 'authenticated' // tokens valid; not yet proven operational
  | 'refreshing' // refresh attempt in flight
  | 'refresh_failed' // refresh errored; user must re-login (token file NOT auto-deleted per kenji)
  | 'storage_failed' // shared credential store read failed; do not present as logged out
  | 'quota_unavailable' // tokens valid but /oauth/usage failed
  | 'provider_rejected'; // last send rejected by provider (likely policy / cloak needed)

/**
 * User profile slice exposed to the renderer.
 *
 * Note: `account_uuid` is intentionally exposed — it's part of the
 * OAuth scope grant and appears in `body.metadata.user_id` of every
 * inference request (per the upstream pattern). Email and display name
 * come from the `/api/oauth/profile` endpoint.
 *
 * No token-shaped fields. xuan G-X3 contract test enforces this.
 */
export interface SubscriptionAccountProfile {
  email?: string;
  displayName?: string;
  accountUuid: string;
}

/**
 * Quota snapshot from Anthropic `/api/oauth/usage` endpoint.
 *
 * v1 mirrors the upstream normalization: percentage utilization for the
 * 5-hour rolling window and 7-day rolling window. We do NOT
 * fabricate `tokens used` / `window size` numbers since the
 * endpoint doesn't return them — kenji `cf41871b` decision #4.
 *
 * `fetchedAt` is included so the UI can render staleness ("配额
 * 数据 5 分钟前更新").
 */
export interface QuotaWindow {
  /** Utilization 0-100 (percentage). */
  utilization: number;
  /** ISO 8601 reset timestamp, empty if endpoint didn't return one. */
  resetsAt: string;
}

export interface QuotaSnapshot {
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
  /** Epoch ms when this snapshot was fetched. */
  fetchedAt: number;
}

/**
 * Full subscription account state — the renderer-facing surface.
 *
 * This is what `claude-subscription:get-account-state` IPC returns.
 * The renderer consumes this directly; no token-shaped data ever
 * crosses the IPC boundary.
 */
export interface SubscriptionAccountState {
  provider: OAuthSubscriptionProvider;
  runtimeState: OAuthSubscriptionRuntimeState;
  /** Present when state is `authenticated` or later. */
  profile?: SubscriptionAccountProfile;
  /** Present when quota fetch succeeded; absent when `quota_unavailable`. */
  quota?: QuotaSnapshot;
  /** Optional human-readable error message for `refresh_failed` /
   *  `storage_failed` / `provider_rejected` / `quota_unavailable` states. */
  errorMessage?: string;
}

/**
 * Action result envelope returned from mutating IPC handlers
 * (start authorization, complete authorization, refresh, logout).
 *
 * Renderer never sees raw error stacks; we return a closed reason
 * enum + a generalized message that's safe to surface to users.
 */
export type SubscriptionActionResult =
  | { ok: true }
  | { ok: false; reason: SubscriptionActionFailureReason; message: string };

export type SubscriptionActionFailureReason =
  | 'invalid_paste_code' // user pasted malformed code or wrong state
  | 'authorization_pending' // no startAuthorization called yet
  | 'authorization_expired' // verifier TTL passed before paste
  | 'authorization_denied' // provider account owner rejected device authorization
  | 'authorization_cancelled' // caller cancelled an in-flight authorization
  | 'token_exchange_failed' // /oauth/token returned non-200
  | 'refresh_failed' // refresh attempt errored
  | 'storage_failed' // shared credential store write failed
  // PR-OAUTH-SUBSCRIPTION-0 (kenji `45b31e16`): the experimental
  // env flag is OFF. Distinct from `provider_rejected` so the user
  // doesn't think Anthropic rejected their account — this is
  // Maka's own kill-switch (legal / product gate) per kenji
  // `1da909d5`. UI copy must reflect "Maka has not enabled this
  // feature", NOT "Anthropic refused".
  | 'experimental_disabled'
  | 'unknown';

/**
 * Authorization URL payload returned by `claude-subscription:get-auth-url`.
 *
 * The renderer gets ONLY an opaque request id + a short state hint —
 * **never the URL itself** (kenji `027c93c0`). The URL stays in the
 * main process's pending state map and is opened via the
 * separate `claude-subscription:open-auth-url` IPC, which looks
 * the URL up by the same request id. This way a malicious or
 * compromised renderer cannot ask main to open an arbitrary URL.
 *
 * `stateHint` is the first 8 chars of the OAuth state. The
 * renderer surfaces it so the user knows which paste-code modal
 * belongs to which authorization attempt (the redirect page on
 * console.anthropic.com displays the matching state alongside the
 * authorization code).
 *
 * No token-shaped fields. No URL field.
 */
export interface AuthorizationUrlPayload {
  /** First 8 chars of state, shown as a hint in the paste modal. */
  stateHint: string;
  /** Authorization request ID, opaque to the renderer; used to scope
   *  the eventual openAuthUrl / completeAuthorization / cancel calls. */
  authRequestId: string;
}

/** 32 random bytes encode to the RFC 7636 minimum 43-character verifier. */
export const PKCE_VERIFIER_LENGTH_BYTES = 32;

/** Base64url-encode bytes per RFC 4648 §5. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  // btoa is universal (Node 16+ and browsers).
  const standard =
    typeof btoa === 'function'
      ? btoa(binary)
      : // Node-only fallback if btoa is missing in some embed; never
        // hit in supported runtimes.
        Buffer.from(binary, 'binary').toString('base64');
  return standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Injected digest keeps PKCE derivation platform-independent. */
export interface Sha256Digest {
  digest(input: string): Uint8Array;
}

export function pkceCodeChallenge(verifier: string, sha256: Sha256Digest): string {
  return base64urlEncode(sha256.digest(verifier));
}

/** Build a Claude subscription authorization URL, rejecting incomplete inputs. */
export interface ClaudeAuthorizationConfig {
  /** Anthropic-registered OAuth client_id. */
  clientId: string;
  /** Authorization endpoint (e.g. https://claude.com/cai/oauth/authorize). */
  authorizeEndpoint: string;
  /** Redirect URI registered with the client_id. */
  redirectUri: string;
  /** Space-separated scope string. */
  scope: string;
}

export function buildClaudeAuthorizationUrl(
  config: ClaudeAuthorizationConfig,
  verifier: string,
  state: string,
  sha256: Sha256Digest,
): string {
  if (!config.clientId) throw new Error('OAuth config missing clientId');
  if (!config.authorizeEndpoint) throw new Error('OAuth config missing authorizeEndpoint');
  if (!config.redirectUri) throw new Error('OAuth config missing redirectUri');
  if (!verifier) throw new Error('PKCE verifier must be non-empty');
  if (!state) throw new Error('OAuth state must be non-empty');

  const challenge = pkceCodeChallenge(verifier, sha256);
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', config.scope);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return url.toString();
}

/** Parse the strict base64url-safe `<code>#<state>` callback payload. */
export interface PastedAuthorization {
  code: string;
  state: string;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function parsePastedAuthorization(raw: unknown): PastedAuthorization | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx <= 0 || hashIdx === trimmed.length - 1) return null;
  const code = trimmed.slice(0, hashIdx);
  const state = trimmed.slice(hashIdx + 1);
  if (!BASE64URL_RE.test(code)) return null;
  if (!BASE64URL_RE.test(state)) return null;
  return { code, state };
}

/** Constant-time comparison for equal-length OAuth state values. */
export function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Default TTL for a pending PKCE authorization (10 minutes). The
 * user has to:
 *   1. Click `登录订阅`.
 *   2. Sign in on claude.ai.
 *   3. Copy the redirect code.
 *   4. Paste it back into Maka.
 * 10 minutes is generous but not so long that an abandoned attempt
 * stays valid forever.
 *
 * Tests pin this; if a future PR adjusts it, the change should be
 * explicit in PR description.
 */
export const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

/**
 * Token-refresh skew. We refresh when `expires_at - now <= 5min`
 * so an in-flight request doesn't race a token expiry.
 *
 * This is a renderer-visible constant via the runtime state's
 * `refreshing` transition; main-side code uses it to decide when
 * to refresh.
 */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Quota cache TTL. We refetch /api/oauth/usage every 5 minutes
 * when the renderer is reading the state, but never block a send
 * on the quota fetch.
 */
export const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
