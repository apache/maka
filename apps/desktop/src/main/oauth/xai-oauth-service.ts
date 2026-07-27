import { randomUUID } from 'node:crypto';

import {
  type AuthorizationUrlPayload,
  type SubscriptionActionResult,
} from '@maka/core';
import {
  proxiedFetch,
  refreshAndPersistOAuthSubscriptionTokens,
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

const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_DEVICE_ENDPOINT = 'https://auth.x.ai/oauth2/device/code';
const XAI_TOKEN_ENDPOINT = 'https://auth.x.ai/oauth2/token';
const XAI_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_CONNECTION_SLUG = 'xai-oauth';
const XAI_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface PendingAuthorization {
  deviceCode: string;
  url: string;
  expiresAt: number;
  intervalMs: number;
  controller: AbortController;
  pollPromise?: Promise<OAuthSubscriptionTokens>;
}

export interface XaiOAuthServiceDeps {
  credentialStore: SharedOAuthCredentialStore;
  openExternal: (url: string) => Promise<void>;
  now?: () => number;
  fetchFn?: typeof fetch;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface XaiOAuthAccountStateSnapshot {
  provider: 'xai-oauth';
  runtimeState:
    | 'not_logged_in'
    | 'authorizing'
    | 'authenticated'
    | 'refreshing'
    | 'refresh_failed'
    | 'storage_failed';
  errorMessage?: string;
}

export class XaiOAuthService {
  private readonly credentialStore: SharedOAuthCredentialStore;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;
  private readonly pending = new Map<string, PendingAuthorization>();
  private authorizing = false;
  private refreshing = false;
  private lastRefreshError: string | null = null;
  private lastStorageError: string | null = null;

  constructor(deps: XaiOAuthServiceDeps) {
    this.credentialStore = deps.credentialStore;
    this.openExternal = deps.openExternal;
    this.now = deps.now ?? (() => Date.now());
    this.fetchFn = deps.fetchFn ?? (proxiedFetch as unknown as typeof fetch);
    this.sleep = deps.sleep ?? abortableSleep;
  }

  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
    this.pruneExpiredPending();
    const response = await this.fetchFn(XAI_DEVICE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        scope: XAI_SCOPE,
        referrer: 'maka',
      }).toString(),
    });
    if (!response.ok) {
      return {
        ok: false,
        reason: 'token_exchange_failed',
        message: `xAI 设备授权启动失败（HTTP ${response.status}）。`,
      };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const deviceCode = nonEmptyString(payload.device_code);
    const userCode = nonEmptyString(payload.user_code);
    const verificationUrl =
      nonEmptyString(payload.verification_uri_complete) ??
      nonEmptyString(payload.verification_uri);
    const expiresIn = positiveNumber(payload.expires_in);
    const interval = positiveNumber(payload.interval) ?? 5;
    if (!deviceCode || !userCode || !verificationUrl || !expiresIn) {
      return {
        ok: false,
        reason: 'token_exchange_failed',
        message: 'xAI 设备授权响应无效，请稍后重试。',
      };
    }
    if (!isAllowedVerificationUrl(verificationUrl)) {
      return {
        ok: false,
        reason: 'token_exchange_failed',
        message: 'xAI 返回了不受信任的授权地址。',
      };
    }

    const authRequestId = randomUUID();
    this.pending.set(authRequestId, {
      deviceCode,
      url: verificationUrl,
      expiresAt: this.now() + expiresIn * 1_000,
      intervalMs: interval * 1_000,
      controller: new AbortController(),
    });
    return { authRequestId, stateHint: userCode };
  }

  async openAuthorizationUrl(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      return {
        ok: false,
        reason: 'authorization_pending',
        message: 'xAI 授权会话不存在，请重新登录。',
      };
    }
    if (pending.expiresAt <= this.now()) {
      this.disposePending(authRequestId);
      return {
        ok: false,
        reason: 'authorization_expired',
        message: 'xAI 授权请求已过期，请重新登录。',
      };
    }
    try {
      await this.openExternal(pending.url);
      if (
        this.pending.get(authRequestId) !== pending ||
        pending.controller.signal.aborted
      ) {
        return {
          ok: false,
          reason: 'authorization_cancelled',
          message: 'xAI 授权已取消。',
        };
      }
      this.authorizing = true;
      pending.pollPromise ??= this.pollForTokens(pending);
      void pending.pollPromise.catch(() => undefined);
      return { ok: true };
    } catch {
      return { ok: false, reason: 'unknown', message: '无法打开 xAI 登录页面，请重试。' };
    }
  }

  async completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending?.pollPromise) {
      return {
        ok: false,
        reason: 'authorization_pending',
        message: '请先打开 xAI 登录页面完成授权。',
      };
    }
    try {
      const tokens = await pending.pollPromise;
      try {
        await saveSharedOAuthTokens(this.credentialStore, XAI_CONNECTION_SLUG, tokens);
        this.lastStorageError = null;
      } catch {
        this.lastStorageError = '写入 xAI OAuth 共享凭据失败。';
        return { ok: false, reason: 'storage_failed', message: this.lastStorageError };
      }
      this.lastRefreshError = null;
      return { ok: true };
    } catch (error) {
      if (error instanceof XaiAuthorizationExpiredError) {
        return {
          ok: false,
          reason: 'authorization_expired',
          message: 'xAI 授权请求已过期，请重新登录。',
        };
      }
      if (error instanceof XaiAuthorizationDeniedError) {
        return {
          ok: false,
          reason: 'authorization_denied',
          message: 'xAI 授权被拒绝，请重新登录并允许访问。',
        };
      }
      if (error instanceof XaiAuthorizationCancelledError) {
        return {
          ok: false,
          reason: 'authorization_cancelled',
          message: 'xAI 授权已取消。',
        };
      }
      return {
        ok: false,
        reason: 'token_exchange_failed',
        message: 'xAI 授权未完成，请检查网络后重试。',
      };
    } finally {
      this.disposePending(authRequestId);
      this.authorizing = false;
    }
  }

  cancelAuthorization(authRequestId?: string): void {
    if (authRequestId !== undefined) {
      this.disposePending(authRequestId);
    } else {
      for (const id of [...this.pending.keys()]) this.disposePending(id);
    }
    this.authorizing = false;
  }

  async getAccountState(): Promise<XaiOAuthAccountStateSnapshot> {
    let loaded: Awaited<ReturnType<typeof loadSharedOAuthTokens>>;
    try {
      loaded = await loadSharedOAuthTokens(this.credentialStore, XAI_CONNECTION_SLUG);
      this.lastStorageError = loaded.status === 'corrupt' ? 'xAI OAuth 本地凭据格式无效。' : null;
    } catch {
      this.lastStorageError = 'xAI OAuth 本地凭据读取失败。';
      loaded = { status: 'missing' };
    }
    if (this.lastStorageError) {
      return {
        provider: 'xai-oauth',
        runtimeState: 'storage_failed',
        errorMessage: this.lastStorageError,
      };
    }
    if (loaded.status !== 'ok') {
      return {
        provider: 'xai-oauth',
        runtimeState: this.authorizing ? 'authorizing' : 'not_logged_in',
      };
    }
    if (this.refreshing) return { provider: 'xai-oauth', runtimeState: 'refreshing' };
    if (this.lastRefreshError) {
      return {
        provider: 'xai-oauth',
        runtimeState: 'refresh_failed',
        errorMessage: this.lastRefreshError,
      };
    }
    return { provider: 'xai-oauth', runtimeState: 'authenticated' };
  }

  async refreshTokens(): Promise<SubscriptionActionResult> {
    this.refreshing = true;
    try {
      const result = await refreshAndPersistOAuthSubscriptionTokens({
        providerType: 'xai-oauth',
        slug: XAI_CONNECTION_SLUG,
        credentialStore: this.credentialStore,
        now: this.now,
        fetchFn: this.fetchFn,
      });
      return this.applyRefreshOutcome(result);
    } finally {
      this.refreshing = false;
    }
  }

  async getAccessTokenInternal(): Promise<string | null> {
    this.refreshing = true;
    try {
      const result = await resolveAndPersistOAuthSubscriptionTokens({
        providerType: 'xai-oauth',
        slug: XAI_CONNECTION_SLUG,
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

  async hasStoredCredential(): Promise<boolean> {
    try {
      return (await loadSharedOAuthTokens(this.credentialStore, XAI_CONNECTION_SLUG)).status === 'ok';
    } catch {
      return false;
    }
  }

  async logout(): Promise<SubscriptionActionResult> {
    this.cancelAuthorization();
    this.lastRefreshError = null;
    this.lastStorageError = null;
    try {
      await deleteSharedOAuthTokens(this.credentialStore, XAI_CONNECTION_SLUG);
      return { ok: true };
    } catch {
      return {
        ok: false,
        reason: 'storage_failed',
        message: '删除 xAI OAuth 共享凭据失败。',
      };
    }
  }

  private async pollForTokens(pending: PendingAuthorization): Promise<OAuthSubscriptionTokens> {
    let intervalMs = pending.intervalMs;
    for (;;) {
      if (pending.expiresAt <= this.now()) throw new XaiAuthorizationExpiredError();
      try {
        await this.sleep(intervalMs, pending.controller.signal);
      } catch (error) {
        if (pending.controller.signal.aborted) throw new XaiAuthorizationCancelledError();
        throw error;
      }
      let response: Response;
      try {
        response = await this.fetchFn(XAI_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: XAI_DEVICE_GRANT,
            client_id: XAI_CLIENT_ID,
            device_code: pending.deviceCode,
          }).toString(),
          signal: pending.controller.signal,
        });
      } catch (error) {
        if (pending.controller.signal.aborted) throw new XaiAuthorizationCancelledError();
        throw error;
      }
      const payload = (await response.json()) as Record<string, unknown>;
      if (response.ok) return tokensFromDeviceResponse(payload, this.now());

      const code = nonEmptyString(payload.error);
      if (code === 'authorization_pending') continue;
      if (code === 'slow_down') {
        intervalMs += 5_000;
        continue;
      }
      if (code === 'access_denied' || code === 'authorization_denied') {
        throw new XaiAuthorizationDeniedError();
      }
      if (code === 'expired_token') throw new XaiAuthorizationExpiredError();
      throw new Error('xAI device token exchange failed.');
    }
  }

  private applyRefreshOutcome(
    result: OAuthSubscriptionRefreshAndPersistOutcome,
  ): SubscriptionActionResult {
    switch (result.outcome) {
      case 'refreshed':
      case 'superseded':
        this.lastRefreshError = null;
        this.lastStorageError = null;
        return { ok: true };
      case 'logged-out':
        this.lastRefreshError = 'xAI OAuth 未登录。';
        return { ok: false, reason: 'refresh_failed', message: this.lastRefreshError };
      case 'refresh-failed':
        this.lastRefreshError = 'xAI OAuth 凭据刷新失败，请重新登录。';
        return { ok: false, reason: 'refresh_failed', message: this.lastRefreshError };
      case 'storage-failed':
        this.lastStorageError = 'xAI OAuth 本地凭据读写失败。';
        return { ok: false, reason: 'storage_failed', message: this.lastStorageError };
    }
  }

  private disposePending(authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (!pending) return;
    pending.controller.abort();
    this.pending.delete(authRequestId);
  }

  private pruneExpiredPending(): void {
    for (const [id, pending] of this.pending) {
      if (pending.expiresAt <= this.now()) {
        pending.controller.abort();
        this.pending.delete(id);
      }
    }
  }
}

class XaiAuthorizationDeniedError extends Error {}
class XaiAuthorizationExpiredError extends Error {}
class XaiAuthorizationCancelledError extends Error {}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function isAllowedVerificationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai'))
    );
  } catch {
    return false;
  }
}

function tokensFromDeviceResponse(
  payload: Record<string, unknown>,
  now: number,
): OAuthSubscriptionTokens {
  const accessToken = nonEmptyString(payload.access_token);
  const refreshToken = nonEmptyString(payload.refresh_token);
  const expiresIn = positiveNumber(payload.expires_in) ?? 3_600;
  if (!accessToken || !refreshToken) {
    throw new Error('xAI device token response is invalid.');
  }
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: now + expiresIn * 1_000,
    ...(nonEmptyString(payload.token_type) ? { token_type: String(payload.token_type) } : {}),
    ...(nonEmptyString(payload.scope) ? { scope: String(payload.scope) } : {}),
  };
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new XaiAuthorizationCancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new XaiAuthorizationCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
