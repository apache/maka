import {
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_DEFAULTS,
  type LlmConnection,
  type ModelDiscoverySource,
} from '@maka/core/llm-connections';
import type { ConnectionStore, CredentialStore } from '@maka/storage';
import type { ClaudeSubscriptionService } from './oauth/claude-subscription-service.js';
import { isSubscriptionExperimentalEnabled } from './oauth/claude-subscription-helpers.js';
import type { OpenAiCodexService } from './oauth/openai-codex-service.js';
import { isOpenAiCodexExperimentalEnabled } from './oauth/openai-codex-helpers.js';
import {
  fetchProviderModels,
  OpenAiCodexDiscoveryError,
  ProviderModelDiscoveryHttpError,
} from '@maka/runtime';
import type { GitHubCopilotSubscriptionService } from './oauth/github-copilot-subscription-service.js';
import type { XaiOAuthService } from './oauth/xai-oauth-service.js';

export const CLAUDE_SUBSCRIPTION_CONNECTION_SLUG = 'claude-subscription';
// Persisted connection slug: stable across the providerType rename from
// `codex-subscription` to `openai-codex`. The credential store key in
// `openai-codex-service.ts` and this connection slug must stay in sync so the
// CLI (which reads OAuth tokens via `connection.slug`) can find tokens written
// by the desktop service. Do not rename this value without a persisted-state
// migration.
export const CODEX_SUBSCRIPTION_CONNECTION_SLUG = 'codex-subscription';
export const GITHUB_COPILOT_CONNECTION_SLUG = 'github-copilot';
export const XAI_OAUTH_CONNECTION_SLUG = 'xai-oauth';

interface OAuthModelConnectionsDeps {
  connectionStore: ConnectionStore;
  credentialStore: CredentialStore;
  claudeSubscription: ClaudeSubscriptionService;
  openAiCodex: OpenAiCodexService;
  githubCopilotSubscription: GitHubCopilotSubscriptionService;
  xaiOAuth: XaiOAuthService;
  fetchModels?: typeof fetchProviderModels;
}

export function createOAuthModelConnectionsMainService(deps: OAuthModelConnectionsDeps) {
  function isClaudeSubscriptionAuthenticatedState(
    state: Awaited<ReturnType<ClaudeSubscriptionService['getAccountState']>>,
  ): boolean {
    return state.runtimeState === 'authenticated' ||
      state.runtimeState === 'refreshing' ||
      state.runtimeState === 'quota_unavailable' ||
      state.runtimeState === 'provider_rejected';
  }

  async function syncClaudeSubscriptionConnection(): Promise<LlmConnection | null> {
    if (!isSubscriptionExperimentalEnabled()) return null;
    const state = await deps.claudeSubscription.getAccountState();
    const existing = await deps.connectionStore.get(CLAUDE_SUBSCRIPTION_CONNECTION_SLUG);
    if (!isClaudeSubscriptionAuthenticatedState(state)) {
      if (existing && (state.runtimeState === 'refresh_failed' || state.runtimeState === 'storage_failed' || state.runtimeState === 'not_logged_in')) {
        return deps.connectionStore.update(existing.slug, {
          enabled: false,
          lastTestStatus: 'needs_reauth',
          lastTestAt: new Date().toISOString(),
          lastTestMessage: state.errorMessage ?? (state.runtimeState === 'not_logged_in'
            ? 'Claude OAuth 未登录。'
            : state.runtimeState === 'storage_failed'
              ? 'Claude OAuth 本地凭据读取失败。'
              : 'Claude OAuth 需要重新登录。'),
        });
      }
      return existing;
    }

    const defaults = PROVIDER_DEFAULTS['claude-subscription'];
    const fallbackModels = defaults.fallbackModels.map((id) => ({ id }));
    const displayName = 'Claude OAuth';
    const now = Date.now();
    const connection: LlmConnection = {
      slug: CLAUDE_SUBSCRIPTION_CONNECTION_SLUG,
      name: existing?.name ?? displayName,
      providerType: 'claude-subscription',
      baseUrl: defaults.baseUrl,
      defaultModel: existing?.defaultModel || defaults.fallbackModels[0] || '',
      enabled: true,
      enabledModelIds: existing?.enabledModelIds,
      models: existing?.models?.length ? existing.models : fallbackModels,
      modelSource: existing?.modelSource ?? 'fallback',
      lastTestStatus: 'verified',
      lastTestAt: new Date(now).toISOString(),
      lastTestMessage: 'Claude OAuth 已登录。',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return deps.connectionStore.save(connection);
  }

  function isOpenAiCodexAuthenticatedState(
    state: Awaited<ReturnType<OpenAiCodexService['getAccountState']>>,
  ): boolean {
    return state.runtimeState === 'authenticated' || state.runtimeState === 'refreshing';
  }

  function isGitHubCopilotAuthenticatedState(
    state: Awaited<ReturnType<GitHubCopilotSubscriptionService['getAccountState']>>,
  ): boolean {
    return state.runtimeState === 'authenticated' || state.runtimeState === 'refreshing';
  }

  function isXaiOAuthAuthenticatedState(
    state: Awaited<ReturnType<XaiOAuthService['getAccountState']>>,
  ): boolean {
    return state.runtimeState === 'authenticated' || state.runtimeState === 'refreshing';
  }

  /**
   * Make a newly authenticated Codex account visible to the product without
   * waiting for live model discovery. OAuth completion has already persisted
   * the credential at this point, so the connection can immediately become
   * usable with the last fetched model list (or the curated fallback list).
   *
   * `syncOpenAiCodexConnection` still runs afterwards to replace this
   * optimistic snapshot with the account's authoritative model catalog.
   */
  async function activateOpenAiCodexConnection(): Promise<LlmConnection | null> {
    if (!isOpenAiCodexExperimentalEnabled()) return null;
    const state = await deps.openAiCodex.getAccountState();
    const existing = await deps.connectionStore.get(CODEX_SUBSCRIPTION_CONNECTION_SLUG);
    if (!isOpenAiCodexAuthenticatedState(state)) return existing;

    const defaults = PROVIDER_DEFAULTS['openai-codex'];
    const fallbackModels = defaults.fallbackModels.map((id) => ({ id }));
    const fetchedModels = existing?.modelSource === 'fetched'
      ? normalizeOpenAiCodexModels(existing.models, [])
      : [];
    const models = fetchedModels.length > 0 ? fetchedModels : fallbackModels;
    const now = Date.now();
    return deps.connectionStore.save({
      slug: CODEX_SUBSCRIPTION_CONNECTION_SLUG,
      name: existing?.name ?? 'Codex OAuth',
      providerType: 'openai-codex',
      baseUrl: defaults.baseUrl,
      defaultModel: normalizeOpenAiCodexDefaultModel(
        existing?.defaultModel,
        models.map((entry) => entry.id),
        defaults.fallbackModels[0] || '',
      ),
      enabled: true,
      enabledModelIds: existing?.enabledModelIds,
      models,
      modelSource: fetchedModels.length > 0 ? 'fetched' : 'fallback',
      modelsFetchedAt: fetchedModels.length > 0 ? existing?.modelsFetchedAt : undefined,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now).toISOString(),
      lastTestMessage: 'Codex OAuth 已登录。',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async function activateXaiOAuthConnection(): Promise<LlmConnection | null> {
    const state = await deps.xaiOAuth.getAccountState();
    const existing = await deps.connectionStore.get(XAI_OAUTH_CONNECTION_SLUG);
    if (!isXaiOAuthAuthenticatedState(state)) return existing;

    const defaults = PROVIDER_DEFAULTS['xai-oauth'];
    const cachedFetchedModels =
      existing?.modelSource === 'fetched' && existing.models?.length ? existing.models : [];
    const models = cachedFetchedModels.length
      ? cachedFetchedModels
      : defaults.fallbackModels.map((id) => ({ id }));
    const enabledIds = models.map(({ id }) => id);
    const now = Date.now();
    return deps.connectionStore.save({
      slug: XAI_OAUTH_CONNECTION_SLUG,
      name: existing?.name ?? 'xAI OAuth',
      providerType: 'xai-oauth',
      baseUrl: defaults.baseUrl,
      defaultModel: enabledIds.includes(existing?.defaultModel ?? '')
        ? existing!.defaultModel
        : (enabledIds[0] ?? ''),
      enabled: true,
      enabledModelIds: existing?.enabledModelIds,
      models,
      modelSource: cachedFetchedModels.length ? 'fetched' : 'fallback',
      modelsFetchedAt: cachedFetchedModels.length ? existing?.modelsFetchedAt : undefined,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now).toISOString(),
      lastTestMessage: 'xAI OAuth 已登录。',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async function syncXaiOAuthConnection(): Promise<LlmConnection | null> {
    const state = await deps.xaiOAuth.getAccountState();
    const existing = await deps.connectionStore.get(XAI_OAUTH_CONNECTION_SLUG);
    if (!isXaiOAuthAuthenticatedState(state)) {
      if (!existing) return null;
      return deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: state.errorMessage ?? 'xAI OAuth 需要重新登录。',
      });
    }

    const accessToken = await deps.xaiOAuth.getAccessTokenInternal();
    if (!accessToken) {
      if (!existing) return null;
      return deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'needs_reauth',
        lastTestAt: new Date().toISOString(),
        lastTestMessage: 'xAI OAuth 需要重新登录。',
      });
    }

    const defaults = PROVIDER_DEFAULTS['xai-oauth'];
    const fallbackModels = defaults.fallbackModels.map((id) => ({ id }));
    const cachedModels =
      existing?.modelSource === 'fetched' && existing.models?.length
        ? existing.models
        : fallbackModels;
    const now = Date.now();
    let models = cachedModels;
    let modelSource: ModelDiscoverySource =
      existing?.modelSource === 'fetched' && existing.models?.length ? 'fetched' : 'fallback';
    let modelsFetchedAt = existing?.modelsFetchedAt;
    try {
      const discovered = await (deps.fetchModels ?? fetchProviderModels)(
        {
          slug: XAI_OAUTH_CONNECTION_SLUG,
          name: existing?.name ?? 'xAI OAuth',
          providerType: 'xai-oauth',
          baseUrl: defaults.baseUrl,
          defaultModel: existing?.defaultModel ?? defaults.fallbackModels[0] ?? '',
          enabled: true,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        },
        accessToken,
      );
      if (discovered.length === 0) {
        if (!existing) return null;
        return deps.connectionStore.update(existing.slug, {
          enabled: false,
          models: [],
          modelSource: 'fetched',
          modelsFetchedAt: now,
          lastTestStatus: 'error',
          lastTestAt: new Date(now).toISOString(),
          lastTestMessage: '当前账号无可用 Grok 模型。',
        });
      }
      models = discovered;
      modelSource = 'fetched';
      modelsFetchedAt = now;
    } catch (error) {
      if (error instanceof ProviderModelDiscoveryHttpError) {
        if (error.status === 401 || error.status === 403) {
          if (!existing) return null;
          return deps.connectionStore.update(existing.slug, {
            enabled: false,
            lastTestStatus: 'needs_reauth',
            lastTestAt: new Date(now).toISOString(),
            lastTestMessage: 'xAI OAuth 需要重新登录。',
          });
        }
        if (error.status >= 400 && error.status < 500) {
          if (!existing) return null;
          return deps.connectionStore.update(existing.slug, {
            enabled: false,
            models: [],
            modelSource: 'fetched',
            modelsFetchedAt: now,
            lastTestStatus: 'error',
            lastTestAt: new Date(now).toISOString(),
            lastTestMessage: 'xAI 模型列表获取失败。',
          });
        }
      }
      // A transient discovery failure must not make a valid OAuth login
      // unusable; retain the last fetched snapshot or the shared fallback.
    }

    const enabledIds = models.map(({ id }) => id);
    return deps.connectionStore.save({
      slug: XAI_OAUTH_CONNECTION_SLUG,
      name: existing?.name ?? 'xAI OAuth',
      providerType: 'xai-oauth',
      baseUrl: defaults.baseUrl,
      defaultModel: enabledIds.includes(existing?.defaultModel ?? '')
        ? existing!.defaultModel
        : (enabledIds[0] ?? ''),
      enabled: true,
      enabledModelIds: existing?.enabledModelIds,
      models,
      modelSource,
      modelsFetchedAt,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now).toISOString(),
      lastTestMessage: 'xAI OAuth 已登录。',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async function syncGitHubCopilotConnection(
    discoveredModels?: Awaited<ReturnType<typeof fetchProviderModels>>,
  ): Promise<LlmConnection | null> {
    const state = await deps.githubCopilotSubscription.getAccountState();
    const existing = await deps.connectionStore.get(GITHUB_COPILOT_CONNECTION_SLUG);
    if (!isGitHubCopilotAuthenticatedState(state)) {
      if (existing) {
        return deps.connectionStore.update(existing.slug, {
          enabled: false,
          lastTestStatus: 'needs_reauth',
          lastTestAt: new Date().toISOString(),
          lastTestMessage: state.errorMessage ?? 'GitHub Copilot 需要重新导入 GitHub CLI 登录。',
        });
      }
      return null;
    }
    const tokens = await deps.githubCopilotSubscription.getTokensInternal();
    if (!tokens) return existing;
    const defaults = PROVIDER_DEFAULTS['github-copilot'];
    const baseUrl = tokens.base_url ?? defaults.baseUrl;
    const now = Date.now();
    const discoveryConnection: LlmConnection = {
      slug: GITHUB_COPILOT_CONNECTION_SLUG,
      name: existing?.name ?? 'GitHub Copilot',
      providerType: 'github-copilot',
      baseUrl,
      defaultModel: existing?.defaultModel || defaults.fallbackModels[0] || '',
      enabled: true,
      enabledModelIds: existing?.enabledModelIds,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const failDiscovery = () => {
      if (!existing) return null;
      return deps.connectionStore.update(existing.slug, {
        enabled: false,
        lastTestStatus: 'error',
        lastTestAt: new Date(now).toISOString(),
        lastTestMessage: 'GitHub Copilot 无法读取当前账号可用模型，请重新验证登录。',
      });
    };
    let models = discoveredModels;
    if (!models) {
      try {
        models = await (deps.fetchModels ?? fetchProviderModels)(discoveryConnection, tokens.access_token);
      } catch {
        return failDiscovery();
      }
    }
    if (models.length === 0) return failDiscovery();
    const enabledIds = models.map((model) => model.id);
    const defaultModel = enabledIds.includes(existing?.defaultModel ?? '')
      ? existing!.defaultModel
      : enabledIds[0] ?? '';
    return deps.connectionStore.save({
      ...discoveryConnection,
      defaultModel,
      models,
      modelSource: 'fetched',
      modelsFetchedAt: now,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now).toISOString(),
      lastTestMessage: 'GitHub Copilot 登录已导入。',
    });
  }

  async function syncOpenAiCodexConnection(): Promise<LlmConnection | null> {
    if (!isOpenAiCodexExperimentalEnabled()) return null;
    const state = await deps.openAiCodex.getAccountState();
    const existing = await deps.connectionStore.get(CODEX_SUBSCRIPTION_CONNECTION_SLUG);
    if (!isOpenAiCodexAuthenticatedState(state)) {
      if (existing && (state.runtimeState === 'refresh_failed' || state.runtimeState === 'storage_failed' || state.runtimeState === 'not_logged_in')) {
        return deps.connectionStore.update(existing.slug, {
          enabled: false,
          lastTestStatus: 'needs_reauth',
          lastTestAt: new Date().toISOString(),
          lastTestMessage: state.errorMessage ?? (state.runtimeState === 'not_logged_in'
            ? 'Codex OAuth 未登录。'
            : state.runtimeState === 'storage_failed'
              ? 'Codex OAuth 本地凭据读取失败。'
              : 'Codex OAuth 需要重新登录。'),
        });
      }
      return existing;
    }

    const defaults = PROVIDER_DEFAULTS['openai-codex'];
    const fallbackModels = defaults.fallbackModels.map((id) => ({ id }));
    const displayName = 'Codex OAuth';
    const now = Date.now();

    // Only a previously fetched list is worth caching; a persisted fallback
    // snapshot is rebuilt from the current registry so renamed/added models
    // (e.g. gpt-5.6-sol) reach existing users instead of being shadowed by a
    // stale copy on disk.
    const hasFetchedSnapshot =
      existing?.modelSource === 'fetched' && Array.isArray(existing.models);
    const cachedFetchedModels = hasFetchedSnapshot
      ? normalizeOpenAiCodexModels(existing.models ?? [], [])
      : fallbackModels;

    let models: NonNullable<LlmConnection['models']> = cachedFetchedModels;
    let modelSource: ModelDiscoverySource = hasFetchedSnapshot ? 'fetched' : 'fallback';
    let modelsFetchedAt = existing?.modelsFetchedAt;
    try {
      const accessToken = await deps.openAiCodex.getAccessTokenInternal();
      if (!accessToken) {
        // OAuth credentials unavailable (no stored token or refresh rejected).
        // Surface as needs_reauth instead of masking as verified, so the user
        // is prompted to re-login rather than hitting a guaranteed refresh
        // failure on the next send.
        if (!existing) return null;
        return deps.connectionStore.update(existing.slug, {
          enabled: false,
          lastTestStatus: 'needs_reauth',
          lastTestAt: new Date(now).toISOString(),
          lastTestMessage: 'Codex OAuth 需要重新登录。',
        });
      }
      const discovered = await (deps.fetchModels ?? fetchProviderModels)(
        {
          slug: CODEX_SUBSCRIPTION_CONNECTION_SLUG,
          name: existing?.name ?? displayName,
          providerType: 'openai-codex',
          baseUrl: defaults.baseUrl,
          defaultModel: existing?.defaultModel || defaults.fallbackModels[0] || '',
          enabled: true,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        },
        accessToken,
      );
      // Normalize before the empty check so a list that is non-empty but
      // entirely filtered as unsupported (e.g. only gpt-5-codex) is also
      // treated as "no usable models", not as fetched+fallback.
      const normalized = normalizeOpenAiCodexModels(discovered, []);
      if (normalized.length === 0) {
        // /models returned no usable models (empty, or all filtered). Persist
        // the empty fetched result so a later transient failure doesn't
        // revive a stale cached list; mirror GitHub Copilot's failDiscovery.
        if (!existing) return null;
        return deps.connectionStore.update(existing.slug, {
          enabled: false,
          lastTestStatus: 'error',
          models: [],
          modelSource: 'fetched',
          modelsFetchedAt: now,
          lastTestAt: new Date(now).toISOString(),
          lastTestMessage: '当前账号无可用 Codex 模型。',
        });
      }
      models = normalized;
      modelSource = 'fetched';
      modelsFetchedAt = now;
    } catch (error) {
      if (error instanceof OpenAiCodexDiscoveryError) {
        if (error.status === 401 || error.status === 403) {
          // Auth rejected at /models - the token is unusable for this account.
          if (!existing) return null;
          return deps.connectionStore.update(existing.slug, {
            enabled: false,
            lastTestStatus: 'needs_reauth',
            lastTestAt: new Date(now).toISOString(),
            lastTestMessage: 'Codex OAuth 需要重新登录。',
          });
        }
        if (error.status >= 400 && error.status < 500) {
          // Deterministic protocol error (4xx) - won't fix itself on retry.
          if (!existing) return null;
          return deps.connectionStore.update(existing.slug, {
            enabled: false,
            lastTestStatus: 'error',
            models: [],
            modelSource: 'fetched',
            modelsFetchedAt: now,
            lastTestAt: new Date(now).toISOString(),
            lastTestMessage: 'Codex 模型列表获取失败。',
          });
        }
      }
      // Transient network failure / 5xx / unknown - keep the cached fetched
      // list or the curated fallback so the connection stays usable. An
      // authoritative fetched-empty snapshot remains disabled/error; reviving
      // fallback ids here would make an account with no usable models appear
      // verified after a temporary outage.
      if (hasFetchedSnapshot && cachedFetchedModels.length === 0 && existing) {
        return deps.connectionStore.update(existing.slug, {
          enabled: false,
          lastTestStatus: 'error',
          models: [],
          modelSource: 'fetched',
          modelsFetchedAt,
          lastTestAt: new Date(now).toISOString(),
          lastTestMessage: '当前账号无可用 Codex 模型。',
        });
      }
    }

    const normalizedDefaultModel = normalizeOpenAiCodexDefaultModel(
      existing?.defaultModel,
      models.map((entry) => entry.id),
      defaults.fallbackModels[0] || '',
    );
    const connection: LlmConnection = {
      slug: CODEX_SUBSCRIPTION_CONNECTION_SLUG,
      name: existing?.name ?? displayName,
      providerType: 'openai-codex',
      baseUrl: defaults.baseUrl,
      defaultModel: normalizedDefaultModel,
      enabled: true,
      enabledModelIds: existing?.enabledModelIds,
      models,
      modelSource,
      modelsFetchedAt,
      lastTestStatus: 'verified',
      lastTestAt: new Date(now).toISOString(),
      lastTestMessage: 'Codex OAuth 已登录。',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return deps.connectionStore.save(connection);
  }

  async function syncOAuthModelConnections(): Promise<void> {
    const results = await Promise.allSettled([
      syncClaudeSubscriptionConnection(),
      syncOpenAiCodexConnection(),
      syncGitHubCopilotConnection(),
      syncXaiOAuthConnection(),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn('[maka] OAuth model connection sync failed', result.reason);
      }
    }
  }

  async function resolveConnectionSecret(slug: string): Promise<string | null> {
    const connection = await deps.connectionStore.get(slug);
    if (connection?.providerType === 'claude-subscription') {
      return deps.claudeSubscription.getAccessTokenInternal();
    }
    if (connection?.providerType === 'openai-codex') {
      return deps.openAiCodex.getAccessTokenInternal();
    }
    if (connection?.providerType === 'github-copilot') {
      return deps.githubCopilotSubscription.getAccessTokenInternal();
    }
    if (connection?.providerType === 'xai-oauth') {
      return deps.xaiOAuth.getAccessTokenInternal();
    }
    return deps.credentialStore.getSecret(slug, 'api_key');
  }

  /**
   * Read-only credential-presence check for status paths (onboarding's
   * `getSnapshot`) that must not trigger `resolveConnectionSecret`'s
   * OAuth near-expiry refresh — that refresh hits the network and
   * mutates local token state, which a read-only status read must
   * never do just by being observed. Send/test/fetch-models paths
   * keep using `resolveConnectionSecret` so they still benefit from
   * the refresh.
   *
   * Takes the `LlmConnection` directly rather than a slug: callers
   * that already hold the connection list (onboarding does) skip the
   * extra `connectionStore.get()` round trip and derive state from
   * one consistent snapshot.
   */
  async function hasConnectionSecret(connection: LlmConnection): Promise<boolean> {
    if (connection.providerType === 'claude-subscription') {
      return deps.claudeSubscription.hasStoredCredential();
    }
    if (connection.providerType === 'openai-codex') {
      return deps.openAiCodex.hasStoredCredential();
    }
    if (connection.providerType === 'github-copilot') {
      return deps.githubCopilotSubscription.hasStoredCredential();
    }
    if (connection.providerType === 'xai-oauth') {
      return deps.xaiOAuth.hasStoredCredential();
    }
    const key = await deps.credentialStore.getSecret(connection.slug, 'api_key');
    return typeof key === 'string' && key.length > 0;
  }

  return {
    isClaudeSubscriptionAuthenticatedState,
    isOpenAiCodexAuthenticatedState,
    isGitHubCopilotAuthenticatedState,
    isXaiOAuthAuthenticatedState,
    resolveConnectionSecret,
    hasConnectionSecret,
    syncClaudeSubscriptionConnection,
    activateOpenAiCodexConnection,
    syncOpenAiCodexConnection,
    syncGitHubCopilotConnection,
    activateXaiOAuthConnection,
    syncXaiOAuthConnection,
    syncOAuthModelConnections,
  };
}

function normalizeOpenAiCodexModels(
  existingModels: LlmConnection['models'] | undefined,
  fallbackModels: NonNullable<LlmConnection['models']>,
): NonNullable<LlmConnection['models']> {
  const safeExisting = (existingModels ?? []).filter(
    (entry) => entry.id && !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(entry.id),
  );
  return safeExisting.length ? safeExisting : fallbackModels;
}

function normalizeOpenAiCodexDefaultModel(
  existingDefaultModel: string | undefined,
  enabledModelIds: string[],
  fallbackModel: string,
): string {
  if (
    existingDefaultModel &&
    !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(existingDefaultModel) &&
    enabledModelIds.includes(existingDefaultModel)
  ) {
    return existingDefaultModel;
  }
  return enabledModelIds[0] || fallbackModel;
}
