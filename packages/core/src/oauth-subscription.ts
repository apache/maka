/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * OAuth subscription contract — core types + pure helpers.
 *
 * Scope: provider-agnostic OAuth subscription types and pure helpers.
 *
 * This module is `@maka/core` so it is consumable from both main
 * and renderer. The types here MUST NOT include any token-shaped
 * field (no `accessToken`, no `refreshToken`, no `idToken`). Secret-bearing
 * main-process and runtime services own those values; the renderer consumes
 * action results and authorization payloads only.
 */

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
  | 'authorization_pending' // no startAuthorization called yet
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
 * Authorization URL payload returned by a provider's `get-auth-url` IPC.
 *
 * The renderer gets ONLY an opaque request id + a short state hint —
 * **never the URL itself** (kenji `027c93c0`). The URL stays in the
 * main process's pending state map and is opened via the
 * separate `open-auth-url` IPC, which looks
 * the URL up by the same request id. This way a malicious or
 * compromised renderer cannot ask main to open an arbitrary URL.
 *
 * `stateHint` is the short code the provider's device page asks the
 * user to confirm. The renderer surfaces it so the user knows which
 * code belongs to which authorization attempt.
 *
 * No token-shaped fields. No URL field.
 */
export interface AuthorizationUrlPayload {
  /** Short code the user must recognise on the provider page (device flows). */
  stateHint: string;
  /** Authorization request ID, opaque to the renderer; used to scope
   *  the eventual openAuthUrl / completeAuthorization / cancel calls. */
  authRequestId: string;
}

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

/** Injected digest keeps hashing platform-independent. */
export interface Sha256Digest {
  digest(input: string): Uint8Array;
}

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
