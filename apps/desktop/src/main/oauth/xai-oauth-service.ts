import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  PENDING_AUTHORIZATION_TTL_MS,
  PKCE_VERIFIER_LENGTH_BYTES,
  base64urlEncode,
  constantTimeStringEqual,
  type AuthorizationUrlPayload,
  type SubscriptionActionResult,
} from '@maka/core';
import {
  OAUTH_LOGIN_PROVIDER_CONFIG,
  OAuthTokenEndpointError,
  buildOAuthLoginAuthorization,
  exchangeOAuthAuthorizationCode,
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

const XAI_CONNECTION_SLUG = 'xai-oauth';
const XAI_REDIRECT_URI = OAUTH_LOGIN_PROVIDER_CONFIG['xai-oauth'].redirectUri;
const XAI_CALLBACK_HOST = '127.0.0.1';
const XAI_CALLBACK_PORT = 56121;
const XAI_CALLBACK_PATH = '/callback';
const XAI_REFRESH_SKEW_MS = 60 * 60 * 1_000;
const XAI_MIN_REFRESH_SKEW_MS = 5 * 60 * 1_000;

interface PendingAuthorization {
  verifier: string;
  state: string;
  url: string;
  createdAt: number;
  controller: AbortController;
  codePromise: Promise<{ code: string; state: string }>;
  rejectCode: (error: Error) => void;
  server: Server;
}

export interface XaiOAuthServiceDeps {
  credentialStore: SharedOAuthCredentialStore;
  openExternal: (url: string) => Promise<void>;
  now?: () => number;
  fetchFn?: typeof fetch;
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
  }

  async getAuthorizationUrl(): Promise<AuthorizationUrlPayload | SubscriptionActionResult> {
    this.pruneExpiredPending();
    const verifier = base64urlEncode(randomBytes(PKCE_VERIFIER_LENGTH_BYTES));
    const state = base64urlEncode(randomBytes(32));
    const authRequestId = randomUUID();
    const authorization = buildOAuthLoginAuthorization({
      provider: 'xai-oauth',
      verifier,
      state,
      redirectUri: XAI_REDIRECT_URI,
    });

    let resolveCode!: (value: { code: string; state: string }) => void;
    let rejectCode!: (error: Error) => void;
    const codePromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    void codePromise.catch(() => undefined);

    let server: Server;
    try {
      server = await this.startCallbackServer(state, resolveCode, rejectCode);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : `xAI OAuth 回调端口 ${XAI_CALLBACK_PORT} 启动失败。`;
      return { ok: false, reason: 'unknown', message };
    }

    this.pending.set(authRequestId, {
      verifier,
      state,
      url: authorization.authorizationUrl,
      createdAt: this.now(),
      controller: new AbortController(),
      codePromise,
      rejectCode,
      server,
    });
    return { authRequestId, stateHint: state.slice(0, 8) };
  }

  async openAuthorizationUrl(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      return { ok: false, reason: 'authorization_pending', message: 'xAI 授权会话不存在，请重新登录。' };
    }
    if (this.isExpired(pending)) {
      this.disposePending(authRequestId);
      return { ok: false, reason: 'authorization_expired', message: 'xAI 授权请求已过期，请重新登录。' };
    }
    try {
      await this.openExternal(pending.url);
      if (this.pending.get(authRequestId) !== pending || pending.controller.signal.aborted) {
        return { ok: false, reason: 'authorization_cancelled', message: 'xAI 授权已取消。' };
      }
      this.authorizing = true;
      return { ok: true };
    } catch {
      return { ok: false, reason: 'unknown', message: '无法打开 xAI 登录页面，请重试。' };
    }
  }

  async completeAuthorization(authRequestId: string): Promise<SubscriptionActionResult> {
    const pending = this.pending.get(authRequestId);
    if (!pending) {
      return { ok: false, reason: 'authorization_pending', message: '请先打开 xAI 登录页面完成授权。' };
    }
    if (this.isExpired(pending)) {
      this.disposePending(authRequestId);
      return { ok: false, reason: 'authorization_expired', message: 'xAI 授权请求已过期，请重新登录。' };
    }
    try {
      const { code, state } = await pending.codePromise;
      if (!constantTimeStringEqual(state, pending.state)) {
        return { ok: false, reason: 'invalid_paste_code', message: 'xAI OAuth state 校验失败，请重新登录。' };
      }
      const tokens = await exchangeOAuthAuthorizationCode({
        provider: 'xai-oauth',
        code,
        verifier: pending.verifier,
        state: pending.state,
        redirectUri: XAI_REDIRECT_URI,
        signal: pending.controller.signal,
        fetchFn: this.fetchFn,
        now: this.now,
      });
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
      if (pending.controller.signal.aborted) {
        return { ok: false, reason: 'authorization_cancelled', message: 'xAI 授权已取消。' };
      }
      if (error instanceof XaiAuthorizationDeniedError) {
        return { ok: false, reason: 'authorization_denied', message: 'xAI 授权被拒绝，请重新登录并允许访问。' };
      }
      if (error instanceof XaiAuthorizationCancelledError) {
        return { ok: false, reason: 'authorization_cancelled', message: 'xAI 授权已取消。' };
      }
      if (error instanceof OAuthTokenEndpointError && error.category === 'aborted') {
        return { ok: false, reason: 'authorization_cancelled', message: 'xAI 授权已取消。' };
      }
      return { ok: false, reason: 'token_exchange_failed', message: 'xAI 授权未完成，请检查账号权限或网络后重试。' };
    } finally {
      this.disposePending(authRequestId);
      this.authorizing = false;
    }
  }

  cancelAuthorization(authRequestId?: string): void {
    if (authRequestId !== undefined) this.disposePending(authRequestId);
    else for (const id of [...this.pending.keys()]) this.disposePending(id);
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
      return { provider: 'xai-oauth', runtimeState: 'storage_failed', errorMessage: this.lastStorageError };
    }
    if (loaded.status !== 'ok') {
      return { provider: 'xai-oauth', runtimeState: this.authorizing ? 'authorizing' : 'not_logged_in' };
    }
    if (this.refreshing) return { provider: 'xai-oauth', runtimeState: 'refreshing' };
    if (this.lastRefreshError) {
      return { provider: 'xai-oauth', runtimeState: 'refresh_failed', errorMessage: this.lastRefreshError };
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

  async getAccessTokenInternal(options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    if (options.forceRefresh) {
      const refreshed = await this.refreshTokens();
      if (!refreshed.ok) return null;
      const loaded = await loadSharedOAuthTokens(this.credentialStore, XAI_CONNECTION_SLUG);
      return loaded.status === 'ok' ? loaded.tokens.access_token : null;
    }
    this.refreshing = true;
    try {
      let refreshSkewMs = XAI_MIN_REFRESH_SKEW_MS;
      try {
        const loaded = await loadSharedOAuthTokens(this.credentialStore, XAI_CONNECTION_SLUG);
        if (loaded.status === 'ok') {
          refreshSkewMs = Math.min(
            XAI_REFRESH_SKEW_MS,
            Math.max(
              XAI_MIN_REFRESH_SKEW_MS,
              Math.floor((loaded.tokens.expires_at - this.now()) / 6),
            ),
          );
        }
      } catch {
        // The authoritative resolver below maps the same read failure to storage-failed.
      }
      const result = await resolveAndPersistOAuthSubscriptionTokens({
        providerType: 'xai-oauth',
        slug: XAI_CONNECTION_SLUG,
        credentialStore: this.credentialStore,
        now: this.now,
        fetchFn: this.fetchFn,
        refreshSkewMs,
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
      return { ok: false, reason: 'storage_failed', message: '删除 xAI OAuth 共享凭据失败。' };
    }
  }

  private applyRefreshOutcome(result: OAuthSubscriptionRefreshAndPersistOutcome): SubscriptionActionResult {
    switch (result.outcome) {
      case 'refreshed':
      case 'superseded':
        this.lastRefreshError = null;
        this.lastStorageError = null;
        return { ok: true };
      case 'logged-out':
        this.lastRefreshError = 'xAI OAuth 未登录。';
        return { ok: false, reason: 'refresh_failed', message: this.lastRefreshError };
      case 'refresh-failed': {
        const detail = result.error instanceof Error ? result.error.message : '';
        this.lastRefreshError = /\(403\)/.test(detail)
          ? '当前 SuperGrok 订阅等级无权访问 xAI API；重新登录无法解决，请升级订阅或改用 API key。'
          : 'xAI OAuth 凭据刷新失败，请重新登录。';
        return { ok: false, reason: 'refresh_failed', message: this.lastRefreshError };
      }
      case 'storage-failed':
        this.lastStorageError = 'xAI OAuth 本地凭据读写失败。';
        return { ok: false, reason: 'storage_failed', message: this.lastStorageError };
    }
  }

  private async startCallbackServer(
    expectedState: string,
    resolveCode: (value: { code: string; state: string }) => void,
    rejectCode: (error: Error) => void,
  ): Promise<Server> {
    // The port is fixed, and the previous login's server releases it
    // asynchronously (disposePending cannot await inside a finally). A
    // fresh login racing that close sees EADDRINUSE for a few milliseconds,
    // so retry briefly instead of failing the whole flow (#2197).
    let lastError: unknown;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        return await this.listenOnce(expectedState, resolveCode, rejectCode);
      } catch (error) {
        lastError = error;
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }
    throw lastError;
  }

  private async listenOnce(
    expectedState: string,
    resolveCode: (value: { code: string; state: string }) => void,
    rejectCode: (error: Error) => void,
  ): Promise<Server> {
    return await new Promise<Server>((resolve, reject) => {
      const server = createServer((request, response) =>
        this.handleCallback(request, response, expectedState, resolveCode, rejectCode),
      );
      server.setTimeout(10_000, (socket) => socket.destroy());
      server.once('error', reject);
      server.listen(XAI_CALLBACK_PORT, XAI_CALLBACK_HOST, () => {
        server.removeListener('error', reject);
        server.on('error', rejectCode);
        resolve(server);
      });
    });
  }

  private handleCallback(
    request: IncomingMessage,
    response: ServerResponse,
    expectedState: string,
    resolveCode: (value: { code: string; state: string }) => void,
    rejectCode: (error: Error) => void,
  ): void {
    // One callback is this server's whole life; a kept-alive socket only
    // outlives it into disposePending's closeAllConnections, and that
    // destroy is an RST a pooled client can trip over on its next request
    // to the same port (#2197: the next login's fetch died on it). Close
    // the connection with the response instead.
    response.setHeader('Connection', 'close');
    let url: URL;
    try {
      url = new URL(request.url ?? '', XAI_REDIRECT_URI);
    } catch {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid callback URL.');
      return;
    }
    if (url.pathname !== XAI_CALLBACK_PATH) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found.');
      return;
    }
    const state = url.searchParams.get('state');
    if (!state || !constantTimeStringEqual(state, expectedState)) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('State mismatch.');
      return;
    }
    const error = url.searchParams.get('error');
    if (error) {
      response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(callbackHtml(false));
      rejectCode(new XaiAuthorizationDeniedError());
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Missing authorization code.');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(callbackHtml(true));
    resolveCode({ code, state });
  }

  private disposePending(authRequestId: string): void {
    const pending = this.pending.get(authRequestId);
    if (!pending) return;
    this.pending.delete(authRequestId);
    pending.controller.abort();
    pending.server.closeAllConnections?.();
    pending.server.close();
    pending.rejectCode(new XaiAuthorizationCancelledError());
  }

  private pruneExpiredPending(): void {
    for (const [id, pending] of this.pending) {
      if (this.isExpired(pending)) this.disposePending(id);
    }
  }

  private isExpired(pending: PendingAuthorization): boolean {
    return this.now() - pending.createdAt > PENDING_AUTHORIZATION_TTL_MS;
  }
}

class XaiAuthorizationDeniedError extends Error {}
class XaiAuthorizationCancelledError extends Error {}

function callbackHtml(success: boolean): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${success ? '登录成功' : '登录失败'}</title></head><body><h1>${success ? '登录成功' : '登录失败'}</h1><p>${success ? 'xAI Grok 授权已完成，可以关闭此标签页并回到 Maka。' : 'xAI Grok 授权未完成，请关闭此标签页并在 Maka 重试。'}</p></body></html>`;
}
