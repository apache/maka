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

import { randomUUID } from 'node:crypto';

import type { ProviderType } from '@maka/core/llm-connections';
import { TOKEN_REFRESH_SKEW_MS } from '@maka/core/oauth-subscription';
import {
  OAUTH_MAX_TOKEN_CHARS,
  OAUTH_PROVIDER_CONTRACTS,
  oauthExpiresAt,
  optionalOAuthBoundedString,
  requireOAuthBoundedString,
  requireOAuthDataRecord,
  requireOAuthPositiveInteger,
} from './oauth-provider-contracts.js';

export type OAuthSubscriptionProvider = Extract<
  ProviderType,
  'openai-codex' | 'github-copilot' | 'xai-oauth'
>;

export interface OAuthSubscriptionTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type?: string;
  scope?: string;
  account_uuid?: string;
  id_token?: string;
  account_id?: string;
  base_url?: string;
}

export function isOAuthSubscriptionProvider(
  providerType: ProviderType,
): providerType is OAuthSubscriptionProvider {
  return (
    providerType === 'openai-codex' ||
    providerType === 'github-copilot' ||
    providerType === 'xai-oauth'
  );
}

export function parseOAuthSubscriptionTokens(raw: string): OAuthSubscriptionTokens | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.access_token !== 'string' || record.access_token.length === 0) return null;
    if (typeof record.refresh_token !== 'string' || record.refresh_token.length === 0) return null;
    if (typeof record.expires_at !== 'number' || !Number.isFinite(record.expires_at)) return null;
    return {
      access_token: record.access_token,
      refresh_token: record.refresh_token,
      expires_at: record.expires_at,
      ...(typeof record.token_type === 'string' ? { token_type: record.token_type } : {}),
      ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
      ...(typeof record.account_uuid === 'string' ? { account_uuid: record.account_uuid } : {}),
      ...(typeof record.id_token === 'string' ? { id_token: record.id_token } : {}),
      ...(typeof record.account_id === 'string' ? { account_id: record.account_id } : {}),
      ...(typeof record.base_url === 'string' ? { base_url: record.base_url } : {}),
    };
  } catch {
    return null;
  }
}

export function serializeOAuthSubscriptionTokens(tokens: OAuthSubscriptionTokens): string {
  return JSON.stringify(tokens);
}

export function extractOAuthSubscriptionAccessToken(raw: string): string | null {
  return parseOAuthSubscriptionTokens(raw)?.access_token ?? null;
}

export interface OAuthSubscriptionCredentialStore {
  getSecret(slug: string, kind: 'oauth_token'): Promise<string | null>;
  setSecret?(slug: string, kind: 'oauth_token', value: string): Promise<void>;
  compareAndSetSecret?(
    slug: string,
    kind: 'oauth_token',
    expected: string | null,
    value: string,
  ): Promise<{ committed: true } | { committed: false; current: string | null }>;
}

export interface ResolveOAuthSubscriptionAccessTokenInput {
  providerType: OAuthSubscriptionProvider;
  slug: string;
  credentialStore: OAuthSubscriptionCredentialStore;
  now?: () => number;
  fetchFn?: typeof fetch;
}

export type OAuthSubscriptionRefreshAndPersistOutcome =
  | { outcome: 'refreshed'; tokens: OAuthSubscriptionTokens }
  | { outcome: 'superseded'; tokens: OAuthSubscriptionTokens }
  | { outcome: 'logged-out' }
  | { outcome: 'refresh-failed'; error: unknown }
  | { outcome: 'storage-failed'; error: unknown };

export type OAuthSubscriptionResolveAndPersistOutcome =
  | { outcome: 'current'; tokens: OAuthSubscriptionTokens }
  | OAuthSubscriptionRefreshAndPersistOutcome;

export type RefreshAndPersistOAuthSubscriptionTokensInput = {
  slug: string;
  credentialStore: OAuthSubscriptionCredentialStore;
  now?: () => number;
  fetchFn?: typeof fetch;
} & (
  | { providerType: OAuthSubscriptionProvider; refreshTokens?: never }
  | {
      providerType?: never;
      refreshTokens: (
        tokens: OAuthSubscriptionTokens,
        signal: AbortSignal,
      ) => Promise<OAuthSubscriptionTokens>;
    }
);

export type ResolveAndPersistOAuthSubscriptionTokensInput =
  RefreshAndPersistOAuthSubscriptionTokensInput & { refreshSkewMs?: number };

const CODEX = OAUTH_PROVIDER_CONTRACTS['openai-codex'];
const XAI = OAUTH_PROVIDER_CONTRACTS['xai-oauth'];

const OAUTH_REFRESH_LEASE_MS = 30_000;
const OAUTH_REFRESH_REQUEST_TIMEOUT_MS = 20_000;
const OAUTH_REFRESH_FINALIZE_BUDGET_MS = 10_000;
const OAUTH_REFRESH_LEASE_POLL_MS = 25;
const OAUTH_REFRESH_LEASE_FIELD = '_refresh_lock';

interface OAuthRefreshLease {
  id: string;
  expires_at: number;
}

export async function resolveOAuthSubscriptionAccessToken(
  input: ResolveOAuthSubscriptionAccessTokenInput,
): Promise<string | null> {
  const tokens = await resolveOAuthSubscriptionTokens(input);
  return tokens?.access_token ?? null;
}

export async function resolveOAuthSubscriptionTokens(
  input: ResolveOAuthSubscriptionAccessTokenInput,
): Promise<OAuthSubscriptionTokens | null> {
  const result = await resolveAndPersistOAuthSubscriptionTokens(input);
  return result.outcome === 'current' ||
    result.outcome === 'refreshed' ||
    result.outcome === 'superseded'
    ? result.tokens
    : null;
}

export async function resolveAndPersistOAuthSubscriptionTokens(
  input: ResolveAndPersistOAuthSubscriptionTokensInput,
): Promise<OAuthSubscriptionResolveAndPersistOutcome> {
  let raw: string | null;
  try {
    raw = await input.credentialStore.getSecret(input.slug, 'oauth_token');
  } catch (error) {
    return { outcome: 'storage-failed', error };
  }
  if (raw === null) return { outcome: 'logged-out' };

  const tokens = parseOAuthSubscriptionTokens(raw);
  if (!tokens) {
    return { outcome: 'storage-failed', error: new Error('Stored OAuth token is invalid.') };
  }
  const now = input.now ?? (() => Date.now());
  if (tokens.expires_at - now() > (input.refreshSkewMs ?? TOKEN_REFRESH_SKEW_MS)) {
    return { outcome: 'current', tokens };
  }

  return refreshAndPersistOAuthSubscriptionTokensFromRaw(input, raw);
}

export async function refreshAndPersistOAuthSubscriptionTokens(
  input: RefreshAndPersistOAuthSubscriptionTokensInput,
): Promise<OAuthSubscriptionRefreshAndPersistOutcome> {
  let raw: string | null;
  try {
    raw = await input.credentialStore.getSecret(input.slug, 'oauth_token');
  } catch (error) {
    return { outcome: 'storage-failed', error };
  }
  if (raw === null) return { outcome: 'logged-out' };

  return refreshAndPersistOAuthSubscriptionTokensFromRaw(input, raw);
}

async function refreshAndPersistOAuthSubscriptionTokensFromRaw(
  input: RefreshAndPersistOAuthSubscriptionTokensInput,
  raw: string,
): Promise<OAuthSubscriptionRefreshAndPersistOutcome> {
  const tokens = parseOAuthSubscriptionTokens(raw);
  if (!tokens) {
    return { outcome: 'storage-failed', error: new Error('Stored OAuth token is invalid.') };
  }
  if (!input.credentialStore.compareAndSetSecret && !input.credentialStore.setSecret) {
    return { outcome: 'storage-failed', error: new Error('Credential store is read-only.') };
  }

  if (input.credentialStore.compareAndSetSecret) {
    return refreshAndPersistWithLease(input, raw);
  }

  let refreshed: OAuthSubscriptionTokens;
  try {
    refreshed = await refreshTokensForInput(input, tokens);
  } catch (error) {
    return { outcome: 'refresh-failed', error };
  }

  const serialized = serializeOAuthSubscriptionTokens(refreshed);
  try {
    await input.credentialStore.setSecret!(input.slug, 'oauth_token', serialized);
  } catch (error) {
    return { outcome: 'storage-failed', error };
  }

  return { outcome: 'refreshed', tokens: refreshed };
}

async function refreshAndPersistWithLease(
  input: RefreshAndPersistOAuthSubscriptionTokensInput,
  initialRaw: string,
): Promise<OAuthSubscriptionRefreshAndPersistOutcome> {
  const compareAndSet = input.credentialStore.compareAndSetSecret!.bind(input.credentialStore);
  let raw = initialRaw;

  for (;;) {
    const tokens = parseOAuthSubscriptionTokens(raw);
    if (!tokens) {
      return { outcome: 'storage-failed', error: new Error('Stored OAuth token is invalid.') };
    }

    const lease = parseOAuthRefreshLease(raw);
    if (lease && lease.expires_at > Date.now()) {
      let current: string | null;
      try {
        current = await waitForOAuthCredentialChange(
          input.credentialStore,
          input.slug,
          raw,
          lease.expires_at,
        );
      } catch (error) {
        return { outcome: 'storage-failed', error };
      }
      if (current === null) return { outcome: 'logged-out' };
      if (current === raw) continue;

      const currentTokens = parseOAuthSubscriptionTokens(current);
      if (!currentTokens) {
        return { outcome: 'storage-failed', error: new Error('Stored OAuth token is invalid.') };
      }
      if (parseOAuthRefreshLease(current)) {
        raw = current;
        continue;
      }
      if (
        serializeOAuthSubscriptionTokens(currentTokens) === serializeOAuthSubscriptionTokens(tokens)
      ) {
        raw = current;
        continue;
      }
      return { outcome: 'superseded', tokens: currentTokens };
    }

    const refreshLease = {
      id: randomUUID(),
      expires_at: Date.now() + OAUTH_REFRESH_LEASE_MS,
    };
    const claimedRaw = serializeOAuthSubscriptionTokensWithLease(tokens, refreshLease);
    let claim: { committed: true } | { committed: false; current: string | null };
    try {
      claim = await compareAndSet(input.slug, 'oauth_token', raw, claimedRaw);
    } catch (error) {
      return { outcome: 'storage-failed', error };
    }
    if (!claim.committed) {
      if (claim.current === null) return { outcome: 'logged-out' };
      const currentTokens = parseOAuthSubscriptionTokens(claim.current);
      if (!currentTokens) {
        return { outcome: 'storage-failed', error: new Error('Stored OAuth token is invalid.') };
      }
      if (parseOAuthRefreshLease(claim.current)) {
        raw = claim.current;
        continue;
      }
      return { outcome: 'superseded', tokens: currentTokens };
    }

    let refreshed: OAuthSubscriptionTokens;
    try {
      refreshed = await refreshTokensForInput(input, tokens, refreshLease.expires_at);
    } catch (error) {
      try {
        const released = await compareAndSet(input.slug, 'oauth_token', claimedRaw, raw);
        if (!released.committed) {
          if (released.current === null) return { outcome: 'logged-out' };
          const current = parseOAuthSubscriptionTokens(released.current);
          if (!current) {
            return {
              outcome: 'storage-failed',
              error: new Error('Stored OAuth token is invalid.'),
            };
          }
          if (parseOAuthRefreshLease(released.current)) {
            raw = released.current;
            continue;
          }
          return { outcome: 'superseded', tokens: current };
        }
      } catch (storageError) {
        return { outcome: 'storage-failed', error: storageError };
      }
      return { outcome: 'refresh-failed', error };
    }

    try {
      const committed = await compareAndSet(
        input.slug,
        'oauth_token',
        claimedRaw,
        serializeOAuthSubscriptionTokens(refreshed),
      );
      if (!committed.committed) {
        if (committed.current === null) return { outcome: 'logged-out' };
        const current = parseOAuthSubscriptionTokens(committed.current);
        if (!current) {
          return { outcome: 'storage-failed', error: new Error('Stored OAuth token is invalid.') };
        }
        if (parseOAuthRefreshLease(committed.current)) {
          raw = committed.current;
          continue;
        }
        return { outcome: 'superseded', tokens: current };
      }
    } catch (error) {
      return { outcome: 'storage-failed', error };
    }

    return { outcome: 'refreshed', tokens: refreshed };
  }
}

async function refreshTokensForInput(
  input: RefreshAndPersistOAuthSubscriptionTokensInput,
  tokens: OAuthSubscriptionTokens,
  leaseExpiresAt?: number,
): Promise<OAuthSubscriptionTokens> {
  const controller = new AbortController();
  const timeoutError = new Error('OAuth token refresh timed out.');
  const timeoutMs =
    leaseExpiresAt === undefined
      ? OAUTH_REFRESH_REQUEST_TIMEOUT_MS
      : Math.min(
          OAUTH_REFRESH_REQUEST_TIMEOUT_MS,
          Math.max(0, leaseExpiresAt - Date.now() - OAUTH_REFRESH_FINALIZE_BUDGET_MS),
        );
  if (timeoutMs === 0) throw timeoutError;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    const refresh = input.refreshTokens
      ? input.refreshTokens(tokens, controller.signal)
      : refreshOAuthSubscriptionTokens({
          providerType: input.providerType,
          tokens,
          now: input.now,
          fetchFn: input.fetchFn,
          signal: controller.signal,
        });
    return await Promise.race([refresh, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseOAuthRefreshLease(raw: string): OAuthRefreshLease | null {
  try {
    const record = JSON.parse(raw) as Record<string, unknown>;
    const candidate = record[OAUTH_REFRESH_LEASE_FIELD];
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      return null;
    const lease = candidate as Record<string, unknown>;
    return typeof lease.id === 'string' &&
      lease.id.length > 0 &&
      typeof lease.expires_at === 'number' &&
      Number.isFinite(lease.expires_at)
      ? { id: lease.id, expires_at: lease.expires_at }
      : null;
  } catch {
    return null;
  }
}

function serializeOAuthSubscriptionTokensWithLease(
  tokens: OAuthSubscriptionTokens,
  lease: OAuthRefreshLease,
): string {
  return JSON.stringify({ ...tokens, [OAUTH_REFRESH_LEASE_FIELD]: lease });
}

async function waitForOAuthCredentialChange(
  store: OAuthSubscriptionCredentialStore,
  slug: string,
  expected: string,
  leaseExpiresAt: number,
): Promise<string | null> {
  for (;;) {
    const remaining = leaseExpiresAt - Date.now();
    if (remaining <= 0) return store.getSecret(slug, 'oauth_token');
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(OAUTH_REFRESH_LEASE_POLL_MS, remaining)),
    );
    const current = await store.getSecret(slug, 'oauth_token');
    if (current !== expected) return current;
  }
}

/**
 * Provider-specific refresh request. Exported so the desktop services
 * force-refresh through the same HTTP contract the pure-Node resolve
 * path uses — one refresh implementation per provider, not two.
 * Throws on a failed refresh; persistence is the caller's concern.
 */
export async function refreshOAuthSubscriptionTokens(input: {
  providerType: OAuthSubscriptionProvider;
  tokens: OAuthSubscriptionTokens;
  now?: () => number;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}): Promise<OAuthSubscriptionTokens> {
  const now = input.now ?? (() => Date.now());
  const fetchFn = input.fetchFn ?? fetch;
  switch (input.providerType) {
    case 'openai-codex':
      return refreshOpenAiCodexTokens(input.tokens, now, fetchFn, input.signal);
    case 'github-copilot':
      return input.tokens;
    case 'xai-oauth':
      return refreshXaiOAuthTokens(input.tokens, now, fetchFn, input.signal);
  }
}

export const GITHUB_COPILOT_DEFAULT_API_ENDPOINT = 'https://api.githubcopilot.com';
export const GITHUB_COPILOT_API_VERSION = '2026-06-01';
export const GITHUB_COPILOT_COMPAT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

export function createGitHubCopilotAccountTokens(githubToken: string): OAuthSubscriptionTokens {
  return {
    access_token: githubToken,
    refresh_token: githubToken,
    expires_at: Number.MAX_SAFE_INTEGER,
    token_type: 'Bearer',
    base_url: GITHUB_COPILOT_DEFAULT_API_ENDPOINT,
  };
}

export function isSupportedGitHubCopilotAccountToken(token: string): boolean {
  return token.startsWith('gho_') || token.startsWith('ghu_') || token.startsWith('github_pat_');
}

/**
 * Guard a refresh response before it may replace the stored authority:
 * a 200 with a missing/empty access token or a non-positive expiry must
 * surface as a refresh failure, never overwrite a still-working record
 * with garbage. Returns the validated required fields.
 */
function requireRefreshedTokenFields(payload: unknown): {
  record: Record<string, unknown>;
  accessToken: string;
  expiresInSeconds: number;
} {
  const record = requireOAuthDataRecord(payload);
  return {
    record,
    accessToken: requireOAuthBoundedString(record.access_token, OAUTH_MAX_TOKEN_CHARS),
    expiresInSeconds: requireOAuthPositiveInteger(record.expires_in, 366 * 24 * 60 * 60),
  };
}

/** A rotated refresh token must be a non-empty string; otherwise keep the previous one. */
function nextRefreshToken(candidate: unknown, previous: string): string {
  if (candidate === undefined || candidate === '') return previous;
  return requireOAuthBoundedString(candidate, OAUTH_MAX_TOKEN_CHARS);
}

async function refreshOpenAiCodexTokens(
  tokens: OAuthSubscriptionTokens,
  now: () => number,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<OAuthSubscriptionTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CODEX.clientId,
    refresh_token: tokens.refresh_token,
  });
  const response = await fetchFn(CODEX.tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': CODEX.tokenUserAgent,
    },
    body: body.toString(),
    signal,
  });
  if (!response.ok) throw new Error(`Codex OAuth token refresh failed (${response.status}).`);
  const {
    record: payload,
    accessToken,
    expiresInSeconds,
  } = requireRefreshedTokenFields(await response.json());
  return {
    access_token: accessToken,
    refresh_token: nextRefreshToken(payload.refresh_token, tokens.refresh_token),
    id_token:
      optionalOAuthBoundedString(payload.id_token, OAUTH_MAX_TOKEN_CHARS) ?? tokens.id_token,
    expires_at: oauthExpiresAt(now(), expiresInSeconds),
    account_id: tokens.account_id,
  };
}

async function refreshXaiOAuthTokens(
  tokens: OAuthSubscriptionTokens,
  now: () => number,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<OAuthSubscriptionTokens> {
  const response = await fetchFn(XAI.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI.clientId,
      refresh_token: tokens.refresh_token,
    }).toString(),
    signal,
  });
  if (!response.ok) throw new Error(`xAI OAuth token refresh failed (${response.status}).`);
  const payload = requireOAuthDataRecord(await response.json());
  const { record, accessToken, expiresInSeconds } = requireRefreshedTokenFields({
    ...payload,
    expires_in:
      payload.expires_in === undefined ? XAI.defaultTokenLifetimeSeconds : payload.expires_in,
  });
  return {
    access_token: accessToken,
    refresh_token: nextRefreshToken(record.refresh_token, tokens.refresh_token),
    expires_at: oauthExpiresAt(now(), expiresInSeconds),
    token_type: optionalOAuthBoundedString(record.token_type, 256) ?? tokens.token_type,
    scope: optionalOAuthBoundedString(record.scope, 4 * 1024) ?? tokens.scope,
  };
}
