import { ipcMain } from 'electron';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { ConnectionStore } from '@maka/storage';
import {
  type ClaudeSubscriptionService,
  isSubscriptionExperimentalEnabled,
} from './oauth/claude-subscription-service.js';
import {
  type OpenAiCodexService,
  isOpenAiCodexExperimentalEnabled,
} from './oauth/openai-codex-service.js';
import {
  type CursorSubscriptionService,
  isCursorSubscriptionExperimentalEnabled,
} from './oauth/cursor-subscription-service.js';
import {
  type AntigravitySubscriptionService,
  isAntigravitySubscriptionExperimentalEnabled,
} from './oauth/antigravity-subscription-service.js';
import {
  CLAUDE_SUBSCRIPTION_CONNECTION_SLUG,
  CODEX_SUBSCRIPTION_CONNECTION_SLUG,
  GITHUB_COPILOT_CONNECTION_SLUG,
  XAI_OAUTH_CONNECTION_SLUG,
} from './oauth-model-connections-main.js';
import type { GitHubCopilotSubscriptionService } from './oauth/github-copilot-subscription-service.js';
import type { XaiOAuthService } from './oauth/xai-oauth-service.js';

interface SubscriptionIpcDeps {
  connectionStore: ConnectionStore;
  claudeSubscription: ClaudeSubscriptionService;
  openAiCodex: OpenAiCodexService;
  githubCopilotSubscription: GitHubCopilotSubscriptionService;
  xaiOAuth: XaiOAuthService;
  cursorSubscription: CursorSubscriptionService;
  antigravitySubscription: AntigravitySubscriptionService;
  isClaudeSubscriptionAuthenticatedState(
    state: Awaited<ReturnType<ClaudeSubscriptionService['getAccountState']>>,
  ): boolean;
  syncClaudeSubscriptionConnection(): Promise<LlmConnection | null>;
  activateOpenAiCodexConnection(): Promise<LlmConnection | null>;
  syncOpenAiCodexConnection(): Promise<LlmConnection | null>;
  syncGitHubCopilotConnection(models?: NonNullable<LlmConnection['models']>): Promise<LlmConnection | null>;
  activateXaiOAuthConnection(): Promise<LlmConnection | null>;
  syncXaiOAuthConnection(): Promise<LlmConnection | null>;
  emitConnectionListChanged(): void;
}

export function registerSubscriptionIpc(deps: SubscriptionIpcDeps): void {
  async function rollbackFailedGitHubCopilotConnect() {
    await deps.githubCopilotSubscription.logout().catch(() => undefined);
    const existing = await deps.connectionStore.get(GITHUB_COPILOT_CONNECTION_SLUG).catch(() => null);
    if (existing) {
      await deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'GitHub Copilot 连接未能保存，请重新导入登录。',
      }).catch(() => undefined);
    }
    return { ok: false as const, reason: 'storage_failed' as const, message: 'GitHub Copilot 连接未能保存，请重试。' };
  }

  ipcMain.handle('github-copilot:connect-existing-login', async () => {
    const result = await deps.githubCopilotSubscription.connectExistingLogin();
    if (result.ok) {
      try {
        const connection = await deps.syncGitHubCopilotConnection(result.models);
        if (!connection) {
          return rollbackFailedGitHubCopilotConnect();
        }
        deps.emitConnectionListChanged();
        return { ok: true as const };
      } catch {
        return rollbackFailedGitHubCopilotConnect();
      }
    }
    return result;
  });
  ipcMain.handle('github-copilot:get-account-state', async () => {
    return deps.githubCopilotSubscription.getAccountState();
  });
  ipcMain.handle('github-copilot:refresh-tokens', async () => {
    const result = await deps.githubCopilotSubscription.refreshTokens();
    if (result.ok) {
      try {
        const connection = await deps.syncGitHubCopilotConnection(result.models);
        if (!connection) return { ok: false as const, reason: 'storage_failed' as const, message: 'GitHub Copilot 连接未能更新，请重试。' };
        deps.emitConnectionListChanged();
        return { ok: true as const };
      } catch {
        return { ok: false as const, reason: 'storage_failed' as const, message: 'GitHub Copilot 连接未能更新，请重试。' };
      }
    }
    return result;
  });
  ipcMain.handle('github-copilot:logout', async () => {
    const result = await deps.githubCopilotSubscription.logout();
    const existing = await deps.connectionStore.get(GITHUB_COPILOT_CONNECTION_SLUG);
    if (existing) {
      await deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'GitHub Copilot 已移除本地登录。',
      });
      deps.emitConnectionListChanged();
    }
    return result;
  });

  ipcMain.handle('xai-oauth:get-auth-url', async () => deps.xaiOAuth.getAuthorizationUrl());
  ipcMain.handle('xai-oauth:open-auth-url', async (_event, authRequestId: unknown) => {
    if (typeof authRequestId !== 'string') {
      return {
        ok: false as const,
        reason: 'authorization_pending' as const,
        message: 'xAI 授权会话不存在。',
      };
    }
    return deps.xaiOAuth.openAuthorizationUrl(authRequestId);
  });
  ipcMain.handle('xai-oauth:complete-authorization', async (_event, authRequestId: unknown) => {
    if (typeof authRequestId !== 'string') {
      return {
        ok: false as const,
        reason: 'authorization_pending' as const,
        message: 'xAI 授权会话不存在。',
      };
    }
    const result = await deps.xaiOAuth.completeAuthorization(authRequestId);
    if (result.ok) {
      await deps.activateXaiOAuthConnection();
      deps.emitConnectionListChanged();
      void deps
        .syncXaiOAuthConnection()
        .then(() => deps.emitConnectionListChanged())
        .catch((error: unknown) => {
          console.warn('[maka] xAI OAuth model discovery failed', error);
        });
    }
    return result;
  });
  ipcMain.handle('xai-oauth:cancel-authorization', async (_event, authRequestId: unknown) => {
    deps.xaiOAuth.cancelAuthorization(
      typeof authRequestId === 'string' ? authRequestId : undefined,
    );
    return { ok: true as const };
  });
  ipcMain.handle('xai-oauth:get-account-state', async () => deps.xaiOAuth.getAccountState());
  ipcMain.handle('xai-oauth:refresh-tokens', async () => {
    const result = await deps.xaiOAuth.refreshTokens();
    if (result.ok) {
      await deps.syncXaiOAuthConnection();
      deps.emitConnectionListChanged();
    }
    return result;
  });
  ipcMain.handle('xai-oauth:logout', async () => {
    const result = await deps.xaiOAuth.logout();
    const existing = await deps.connectionStore.get(XAI_OAUTH_CONNECTION_SLUG);
    if (existing) {
      await deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'xAI OAuth 已退出登录。',
      });
      deps.emitConnectionListChanged();
    }
    return result;
  });

  const experimentalDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'Claude 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('claude-subscription:get-auth-url', async () => {
    if (!isSubscriptionExperimentalEnabled()) {
      return experimentalDisabledResponse;
    }
    return deps.claudeSubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'claude-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.claudeSubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'claude-subscription:complete-authorization',
    async (_event, authRequestId: unknown, pasted: unknown) => {
      if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      const result = await deps.claudeSubscription.completeAuthorization(authRequestId, pasted);
      if (result.ok) {
        await deps.syncClaudeSubscriptionConnection();
        deps.emitConnectionListChanged();
      }
      return result;
    },
  );
  ipcMain.handle(
    'claude-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isSubscriptionExperimentalEnabled()) return { ok: true as const };
      deps.claudeSubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('claude-subscription:get-account-state', async () => {
    if (!isSubscriptionExperimentalEnabled()) {
      return {
        provider: 'claude-subscription' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    const state = await deps.claudeSubscription.getAccountState();
    if (deps.isClaudeSubscriptionAuthenticatedState(state)) {
      await deps.syncClaudeSubscriptionConnection();
    }
    return state;
  });
  ipcMain.handle('claude-subscription:refresh-quota', async () => {
    if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
    return deps.claudeSubscription.refreshQuota();
  });
  ipcMain.handle('claude-subscription:refresh-tokens', async () => {
    if (!isSubscriptionExperimentalEnabled()) return experimentalDisabledResponse;
    const result = await deps.claudeSubscription.refreshTokens();
    if (result.ok) {
      await deps.syncClaudeSubscriptionConnection();
      deps.emitConnectionListChanged();
    }
    return result;
  });
  ipcMain.handle('claude-subscription:logout', async () => {
    const result = await deps.claudeSubscription.logout();
    const existing = await deps.connectionStore.get(CLAUDE_SUBSCRIPTION_CONNECTION_SLUG);
    if (existing) {
      await deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'Claude OAuth 已退出登录。',
      });
      deps.emitConnectionListChanged();
    }
    return result;
  });
  ipcMain.handle('claude-subscription:is-experimental-enabled', async () =>
    isSubscriptionExperimentalEnabled(),
  );

  const codexDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'OpenAI Codex 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('openai-codex:is-experimental-enabled', async () =>
    isOpenAiCodexExperimentalEnabled(),
  );
  ipcMain.handle('openai-codex:get-auth-url', async () => {
    if (!isOpenAiCodexExperimentalEnabled()) return codexDisabledResponse;
    return deps.openAiCodex.getAuthorizationUrl();
  });
  ipcMain.handle(
    'openai-codex:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isOpenAiCodexExperimentalEnabled()) return codexDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.openAiCodex.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'openai-codex:complete-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isOpenAiCodexExperimentalEnabled()) return codexDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      const result = await deps.openAiCodex.completeAuthorization(authRequestId);
      if (result.ok) {
        // OAuth success is authoritative as soon as the credential is stored.
        // Publish a usable connection immediately; live model discovery can
        // take up to its network timeout and must not hold the login UI on the
        // stale `needs_reauth` state.
        await deps.activateOpenAiCodexConnection();
        deps.emitConnectionListChanged();
        void deps.syncOpenAiCodexConnection()
          .then(() => deps.emitConnectionListChanged())
          .catch((error: unknown) => {
            console.warn('[maka] Codex model discovery after OAuth failed', error);
          });
      }
      return result;
    },
  );
  ipcMain.handle(
    'openai-codex:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isOpenAiCodexExperimentalEnabled()) return { ok: true as const };
      deps.openAiCodex.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('openai-codex:get-account-state', async () => {
    if (!isOpenAiCodexExperimentalEnabled()) {
      return {
        provider: 'openai-codex' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    // Status reads stay read-only and fast. Connection synchronization is
    // driven by OAuth completion, explicit token refresh, and startup.
    return deps.openAiCodex.getAccountState();
  });
  ipcMain.handle('openai-codex:refresh-tokens', async () => {
    if (!isOpenAiCodexExperimentalEnabled()) return codexDisabledResponse;
    const result = await deps.openAiCodex.refreshTokens();
    if (result.ok) {
      await deps.syncOpenAiCodexConnection();
      deps.emitConnectionListChanged();
    }
    return result;
  });
  ipcMain.handle('openai-codex:logout', async () => {
    const result = await deps.openAiCodex.logout();
    const existing = await deps.connectionStore.get(CODEX_SUBSCRIPTION_CONNECTION_SLUG);
    if (existing) {
      await deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'Codex OAuth 已退出登录。',
      });
      deps.emitConnectionListChanged();
    }
    return result;
  });

  const cursorDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'Cursor 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('cursor-subscription:is-experimental-enabled', async () =>
    isCursorSubscriptionExperimentalEnabled(),
  );
  ipcMain.handle('cursor-subscription:get-auth-url', async () => {
    if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
    return deps.cursorSubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'cursor-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.cursorSubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'cursor-subscription:complete-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.cursorSubscription.completeAuthorization(authRequestId);
    },
  );
  ipcMain.handle(
    'cursor-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isCursorSubscriptionExperimentalEnabled()) return { ok: true as const };
      deps.cursorSubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('cursor-subscription:get-account-state', async () => {
    if (!isCursorSubscriptionExperimentalEnabled()) {
      return {
        provider: 'cursor-subscription' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    return deps.cursorSubscription.getAccountState();
  });
  ipcMain.handle('cursor-subscription:refresh-tokens', async () => {
    if (!isCursorSubscriptionExperimentalEnabled()) return cursorDisabledResponse;
    return deps.cursorSubscription.refreshTokens();
  });
  ipcMain.handle('cursor-subscription:logout', async () => {
    return deps.cursorSubscription.logout();
  });

  const antigravityDisabledResponse = {
    ok: false as const,
    reason: 'experimental_disabled' as const,
    message: 'Google Antigravity 订阅账号为内部实验，当前未开启。',
  };
  ipcMain.handle('antigravity-subscription:is-experimental-enabled', async () =>
    isAntigravitySubscriptionExperimentalEnabled(),
  );
  ipcMain.handle('antigravity-subscription:get-auth-url', async () => {
    if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
    return deps.antigravitySubscription.getAuthorizationUrl();
  });
  ipcMain.handle(
    'antigravity-subscription:open-auth-url',
    async (_event, authRequestId: unknown) => {
      if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.antigravitySubscription.openAuthorizationUrl(authRequestId);
    },
  );
  ipcMain.handle(
    'antigravity-subscription:complete-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
      if (typeof authRequestId !== 'string') {
        return { ok: false as const, reason: 'authorization_pending' as const, message: '授权会话不存在。' };
      }
      return deps.antigravitySubscription.completeAuthorization(authRequestId);
    },
  );
  ipcMain.handle(
    'antigravity-subscription:cancel-authorization',
    async (_event, authRequestId: unknown) => {
      if (!isAntigravitySubscriptionExperimentalEnabled()) return { ok: true as const };
      deps.antigravitySubscription.cancelAuthorization(
        typeof authRequestId === 'string' ? authRequestId : undefined,
      );
      return { ok: true as const };
    },
  );
  ipcMain.handle('antigravity-subscription:get-account-state', async () => {
    if (!isAntigravitySubscriptionExperimentalEnabled()) {
      return {
        provider: 'antigravity-subscription' as const,
        status: 'preview' as const,
        runtimeState: 'not_logged_in' as const,
      };
    }
    return deps.antigravitySubscription.getAccountState();
  });
  ipcMain.handle('antigravity-subscription:refresh-tokens', async () => {
    if (!isAntigravitySubscriptionExperimentalEnabled()) return antigravityDisabledResponse;
    return deps.antigravitySubscription.refreshTokens();
  });
  ipcMain.handle('antigravity-subscription:logout', async () => {
    return deps.antigravitySubscription.logout();
  });
}
