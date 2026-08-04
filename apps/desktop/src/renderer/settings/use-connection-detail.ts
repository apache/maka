import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type ConnectionTestResult,
  type LlmConnection,
  type ModelInfo,
  type ProviderType,
} from '@maka/core';
import { PROVIDER_DEFAULTS, connectionEnabledModelIds } from '@maka/core/llm-connections';
import { buildConnectionModelCatalogEntries } from '@maka/core/model-catalog';
import { isWiredOAuthProvider } from '@maka/core/provider-registry';
import {
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  providerSupportsModelDiscovery,
} from '@maka/core/llm-connections';
import { useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import { connectionChipStatus } from './provider-connection-status';
import { useKeyedActionGuard } from './use-action-guard';
import type { OAuthLoginFlowBridge } from './use-oauth-login-flow';
import {
  connectionLastTestMessageDisplay,
  connectionTestFailureMessage,
  providerPanelActionErrorMessage,
  type ConnectionsBridge,
  type CredentialPresenceStatus,
} from './provider-panel-shared';

// Maps an OAuth model-connection provider type to the browser-assisted login
// service that can re-run its authorization from inside the connection dialog. Only
// the loopback / polling services (Codex, Antigravity) are one-button-drivable
// here; Claude's paste-code flow and plain API-key providers return null so the
// notice falls back to prose instead of rendering a dead button.
export interface OAuthLoginService {
  bridge: OAuthLoginFlowBridge;
  display: { name: string; shortName: string };
}

export function oauthLoginServiceFor(providerType: ProviderType): OAuthLoginService | null {
  switch (providerType) {
    case 'openai-codex':
      return {
        bridge: window.maka.openAiCodex as unknown as OAuthLoginFlowBridge,
        display: { name: 'OpenAI Codex', shortName: 'Codex' },
      };
    case 'xai-oauth':
      return {
        bridge: window.maka.xaiOAuth as unknown as OAuthLoginFlowBridge,
        display: { name: 'xAI Grok', shortName: 'SuperGrok / X Premium' },
      };
    case 'gemini-cli':
      return {
        bridge: window.maka.antigravitySubscription as unknown as OAuthLoginFlowBridge,
        display: { name: 'Google Antigravity', shortName: 'Antigravity' },
      };
    default:
      return null;
  }
}

export interface ConnectionDetailProps {
  bridge: ConnectionsBridge;
  connection: LlmConnection;
  isDefault: boolean;
  onChanged(): Promise<void>;
  onDeleted(): Promise<void>;
}

// Controller for the API/OAuth model connection detail sheet. Owns the whole
// mutually-exclusive action state machine (save / test / fetch-models /
// save-enabled-models / delete, all gated through one keyed
// action guard) plus the credential-presence probe and the prop-sync effects.
// The sheet view (provider-connection-detail.tsx) is a thin render over this
// return; extracting it kept the 12 useState + 4 refs + 4 effects together so
// the guard, lifecycle gate, and cross-calls (save auto-fetches models) stay in
// one place with zero behavior change.
export function useConnectionDetail(props: ConnectionDetailProps) {
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).detail;
  const { connection } = props;
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const [apiKey, setApiKey] = useState('');
  const [hasSecret, setHasSecret] = useState<CredentialPresenceStatus>(
    defaults.authKind === 'none' ? true : 'loading',
  );
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? defaults.baseUrl ?? '');
  const [models, setModels] = useState<ModelInfo[]>(connection.models ?? []);
  const [enabledModelIds, setEnabledModelIds] = useState(() => connectionEnabledModelIds(connection));
  // Backend persists the model-list source alongside the model cache, so a
  // Settings restart no longer has to infer "fetched" from a non-empty array.
  // Discovery rejects empty catalogs before persistence, while source remains
  // explicit for compatibility with already-persisted connection records.
  const [modelSource, setModelSource] = useState<'fetched' | 'fallback'>(
    connection.modelSource ?? 'fallback',
  );
  const syncedConnectionSnapshotRef = useRef(connectionDetailSnapshot(connection, defaults.baseUrl));
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [savingEnabledModels, setSavingEnabledModels] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const connectionDetailActionGuard = useKeyedActionGuard<
    'save' | 'test' | 'fetch-models' | 'save-enabled-models' | 'delete'
  >();
  const connectionDetailMountedRef = useMountedRef();
  const connectionDetailLifecycleRef = useRef(0);
  const toast = useToast();
  const supportsApiKey = providerAuthSupportsApiKey(connection.providerType);
  const needsOAuth = defaults.authKind === 'oauth_token';
  const oauthLoginService = needsOAuth ? oauthLoginServiceFor(connection.providerType) : null;
  const usesGitHubCopilotLogin = connection.providerType === 'github-copilot';
  const supportsRemoteDiscovery = providerSupportsModelDiscovery(connection.providerType);
  const requiresCredential = providerAuthRequiresSecret(connection.providerType);
  const probesCredential = supportsApiKey || needsOAuth;
  const credentialProbePending = requiresCredential && (hasSecret === 'loading' || hasSecret === 'error');
  const hasUsableCredential = !requiresCredential || hasSecret === true;
  const credentialTroubleshootingCopy = needsOAuth
    ? copy.oauthTroubleshooting
    : supportsApiKey
      ? copy.keyTroubleshooting
      : copy.endpointTroubleshooting;
  // `?? ''` to match the `baseUrl` draft's own initializer: a provider with
  // neither a saved nor a default endpoint compared '' against undefined, so
  // `hasBaseUrlChange` was permanently true and its save button never rested.
  const savedBaseUrl = connection.baseUrl ?? defaults.baseUrl ?? '';
  const draftBaseUrl = baseUrl;
  const hasApiKeyChange = apiKey.length > 0;
  const hasBaseUrlChange = draftBaseUrl !== savedBaseUrl;
  // Persistent single-line credential hint. Rendered in every hasSecret state
  // (including `false`) so the description row never adds or drops a line as the
  // async secret probe resolves — the dialog height stays constant.
  const apiKeyStatusHint =
    hasSecret === true
      ? copy.keySet
      : hasSecret === 'loading'
        ? copy.statusLoading
        : hasSecret === 'error'
          ? copy.credentialUnknown
          : copy.keyMissing;
  const detailActionBusy =
    busy ||
    testing ||
    fetchingModels ||
    savingEnabledModels ||
    deleting;
  const issue = connectionChipStatus(connection, locale);
  const lastTestMessage = connectionLastTestMessageDisplay(connection.lastTestMessage, locale);
  const lastTestAtMs = connection.lastTestAt ? Date.parse(connection.lastTestAt) : NaN;

  useEffect(() => {
    connectionDetailLifecycleRef.current += 1;
    return () => {
      connectionDetailLifecycleRef.current += 1;
      connectionDetailActionGuard.reset();
    };
  }, [connection.slug]);

  function isConnectionDetailCurrent(lifecycle: number): boolean {
    return connectionDetailMountedRef.current && connectionDetailLifecycleRef.current === lifecycle;
  }

  useEffect(() => {
    const lifecycle = connectionDetailLifecycleRef.current;
    if (!probesCredential) {
      if (isConnectionDetailCurrent(lifecycle)) setHasSecret(true);
      return;
    }
    setHasSecret('loading');
    void props.bridge
      .hasSecret(connection.slug)
      .then((next) => {
        if (isConnectionDetailCurrent(lifecycle)) setHasSecret(next);
      })
      .catch((error) => {
        if (!isConnectionDetailCurrent(lifecycle)) return;
        setHasSecret('error');
        toast.error(copy.credentialReadFailed, providerPanelActionErrorMessage(error, locale));
      });
  }, [props.bridge, connection.slug, probesCredential, toast]);

  useEffect(() => {
    const nextSnapshot = connectionDetailSnapshot(connection, defaults.baseUrl);
    const previousSnapshot = syncedConnectionSnapshotRef.current;
    const localStillSynced = connectionDetailDraftMatchesSnapshot(
      { baseUrl, models, modelSource },
      previousSnapshot,
    );
    const localAlreadyMatchesNext = connectionDetailDraftMatchesSnapshot(
      { baseUrl, models, modelSource },
      nextSnapshot,
    );

    if (connection.slug !== previousSnapshot.slug || (apiKey.length === 0 && localStillSynced)) {
      // Only when the draft actually differs. `connectionDetailSnapshot` builds
      // `connection.models ?? []` fresh every call, so for a connection with no
      // models array this wrote a new-but-equal array on every pass — a new
      // identity for the `models` dep, which re-ran the effect, which wrote
      // another one. The page never settled; React cut it off at the update
      // depth limit and the whole panel unmounted.
      if (!localAlreadyMatchesNext) {
        setBaseUrl(nextSnapshot.baseUrl);
        setModels(nextSnapshot.models);
        setModelSource(nextSnapshot.modelSource);
      }
      syncedConnectionSnapshotRef.current = nextSnapshot;
      return;
    }

    if (localAlreadyMatchesNext) {
      syncedConnectionSnapshotRef.current = nextSnapshot;
    }
  }, [
    apiKey.length,
    baseUrl,
    connection,
    defaults.baseUrl,
    modelSource,
    models,
  ]);

  useEffect(() => {
    setEnabledModelIds(connectionEnabledModelIds(connection));
  }, [connection.defaultModel, connection.enabledModelIds, connection.slug]);

  // Picker entries come from the same catalog merge path as Chat and Daily
  // Review, but use the local unsaved editor draft for model/default changes.
  const modelChoices = buildConnectionModelCatalogEntries({
    connection: {
      slug: connection.slug,
      providerType: connection.providerType,
      defaultModel: connection.defaultModel,
      models: modelSource === 'fetched' || models.length > 0 ? models : undefined,
      modelSource,
      modelsFetchedAt: connection.modelsFetchedAt,
    },
  });

  /**
   * Save ONE row. The patch used to carry both fields whichever row asked for
   * it, so an abandoned endpoint draft rode along with the next key save — the
   * user typed an address, changed their mind without cancelling, replaced the
   * key, and the address they never confirmed was written. A row owns its own
   * field; nothing else travels with it.
   *
   * Returns whether the write landed, so a failed save keeps the row open with
   * the draft intact instead of collapsing as if it had succeeded.
   */
  async function save(field: 'key' | 'endpoint'): Promise<boolean> {
    const releaseSave = connectionDetailActionGuard.beginExclusive('save');
    if (!releaseSave) return false;
    const lifecycle = connectionDetailLifecycleRef.current;
    setBusy(true);
    let saved = false;
    try {
      await props.bridge.update(
        connection.slug,
        field === 'key' ? { apiKey } : { baseUrl },
      );
      saved = true;
      if (!isConnectionDetailCurrent(lifecycle)) return true;
      const wroteNewKey = field === 'key' && apiKey.length > 0;
      if (wroteNewKey) setApiKey('');
      const nextHasSecret = probesCredential ? await props.bridge.hasSecret(connection.slug) : true;
      if (!isConnectionDetailCurrent(lifecycle)) return true;
      setHasSecret(nextHasSecret);
      await props.onChanged();
      if (!isConnectionDetailCurrent(lifecycle)) return true;
      // Auto-fetch live model list as soon as the secret is in place. Without
      // this, the user lands on a Settings · 模型 row whose `defaultModel`
      // dropdown only contains the static fallback list (e.g. Z.ai → just
      // glm-4.7 / 4.6 / 4.5), which looks like Maka doesn't support newer
      // models. Auto-fetch on save closes that gap.
      if (
        supportsRemoteDiscovery &&
        (!requiresCredential || nextHasSecret) &&
        (wroteNewKey || field === 'endpoint' || models.length === 0)
      ) {
        void refreshModels({ silent: true });
      }
      return true;
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return saved;
      if (saved && probesCredential) {
        setHasSecret('error');
      }
      toast.error(
        saved ? copy.refreshFailed : copy.saveFailed,
        providerPanelActionErrorMessage(error, locale),
      );
      return saved;
    } finally {
      releaseSave();
      if (isConnectionDetailCurrent(lifecycle)) setBusy(false);
    }
  }

  async function updateEnabledModels(nextIds: string[]) {
    if (connectionDetailActionGuard.has('save-enabled-models') || detailActionBusy) return;
    // The selection is passed through as stated. Merging the default back in
    // here made unchecking it a silent no-op: the recomputed list equalled the
    // current one, `modelIdListsEqual` short-circuited, and nothing was ever
    // written. The store owns what follows from the selection.
    const next = [...new Set(nextIds.map((id) => id.trim()).filter(Boolean))];
    if (modelIdListsEqual(next, enabledModelIds)) return;
    const previous = enabledModelIds;
    const lifecycle = connectionDetailLifecycleRef.current;
    const releaseSaveModels = connectionDetailActionGuard.begin('save-enabled-models');
    if (!releaseSaveModels) return;
    setSavingEnabledModels(true);
    setEnabledModelIds(next);
    let saved = false;
    try {
      await props.bridge.update(connection.slug, { enabledModelIds: next });
      saved = true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      await props.onChanged();
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (!saved) setEnabledModelIds(previous);
      toast.error(
        saved ? copy.refreshFailed : copy.saveModelsFailed,
        providerPanelActionErrorMessage(error, locale),
      );
    } finally {
      releaseSaveModels();
      if (isConnectionDetailCurrent(lifecycle)) setSavingEnabledModels(false);
    }
  }

  async function runTest() {
    const releaseTest = connectionDetailActionGuard.beginExclusive('test');
    if (!releaseTest) return;
    const lifecycle = connectionDetailLifecycleRef.current;
    setTesting(true);
    try {
      // No model argument: `resolveConnectionTestModel` already picks one from
      // the enabled ids, then the provider fallbacks, and drops any candidate
      // the fetched inventory doesn't list. Naming `connection.defaultModel`
      // here handed that choice to the layer with the least information — and
      // to a field this page no longer owns, which is '' once the user enables
      // no models. Left unset, a zero-model connection still verifies its
      // credential against a fallback instead of failing with 'No model to test'.
      const result: ConnectionTestResult = await props.bridge.test(connection.slug);
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (result.ok) {
        toast.success(
          copy.connectionSuccess(connection.name),
          `${result.modelTested} · ${result.latencyMs} ms`,
        );
      } else {
        toast.error(
          copy.connectionFailed(connection.name),
          connectionTestFailureMessage(result, {
            auth: copy.authTroubleshooting(credentialTroubleshootingCopy),
            recheck: copy.recheckTroubleshooting(credentialTroubleshootingCopy),
          }, locale),
        );
      }
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      const message = providerPanelActionErrorMessage(error, locale);
      toast.error(copy.connectionTestError(connection.name), message);
    } finally {
      releaseTest();
      if (isConnectionDetailCurrent(lifecycle)) setTesting(false);
    }
  }

  async function refreshModels(opts: { silent?: boolean } = {}) {
    // A silent refresh (the post-save auto-fetch) may overlap other actions;
    // a manual one is gated on the whole sheet like the other buttons.
    const releaseFetch = opts.silent
      ? connectionDetailActionGuard.begin('fetch-models')
      : connectionDetailActionGuard.beginExclusive('fetch-models');
    if (!releaseFetch) return;
    const lifecycle = connectionDetailLifecycleRef.current;
    setFetchingModels(true);
    let fetched = false;
    try {
      // Backend returns a `ModelDiscoveryResult` envelope and rejects empty or
      // malformed catalogs before persistence. Trust its explicit source
      // instead of reconstructing cache provenance in the renderer.
      const result = await props.bridge.fetchModels(connection.slug);
      fetched = true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      setModels(result.models);
      setModelSource(result.source);
      await props.onChanged();
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (!opts.silent) {
        toast.success(copy.modelsFetched(result.models.length, connection.name));
      }
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      const message = providerPanelActionErrorMessage(error, locale);
      // Leave the previously-known source / models intact (so the dropdown
      // doesn't suddenly empty out), but downgrade the source label back to
      // 'fallback' if we have nothing fresh to show — the failed fetch
      // means whatever's on screen is not from the latest probe.
      if (!fetched && models.length === 0) setModelSource('fallback');
      if (fetched) {
        toast.error(copy.refreshFailed, message);
      } else {
        toast.error(
          copy.modelsFetchFailed(connection.name),
          copy.modelsFetchFailedDetail(message, credentialTroubleshootingCopy),
        );
      }
    } finally {
      releaseFetch();
      if (isConnectionDetailCurrent(lifecycle)) setFetchingModels(false);
    }
  }

  async function remove() {
    const releaseDelete = connectionDetailActionGuard.beginExclusive('delete');
    if (!releaseDelete) return;
    const lifecycle = connectionDetailLifecycleRef.current;
    setDeleting(true);
    const ok = await toast.confirm({
      title: copy.deleteConnectionTitle(connection.name),
      description: copy.deleteDescription(
        props.isDefault,
        isWiredOAuthProvider(connection.providerType),
      ),
      confirmLabel: isWiredOAuthProvider(connection.providerType)
        ? copy.disconnectAndDelete
        : copy.delete,
      cancelLabel: copy.cancel,
      destructive: true,
    });
    if (!isConnectionDetailCurrent(lifecycle)) return;
    if (!ok) {
      releaseDelete();
      setDeleting(false);
      return;
    }
    let deleted = false;
    try {
      await props.bridge.delete(connection.slug);
      deleted = true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      await props.onDeleted();
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      toast.error(
        deleted ? copy.refreshFailed : copy.deleteFailed,
        providerPanelActionErrorMessage(error, locale),
      );
    } finally {
      releaseDelete();
      if (isConnectionDetailCurrent(lifecycle)) setDeleting(false);
    }
  }

  // After a successful in-dialog OAuth re-login, re-probe the credential
  // presence (an expired token still read hasSecret===true, so we must
  // refresh it) and reload the connection so its status leaves 需要重新登录.
  async function refreshAfterRelogin() {
    const lifecycle = connectionDetailLifecycleRef.current;
    try {
      const nextHasSecret = await props.bridge.hasSecret(connection.slug);
      if (!isConnectionDetailCurrent(lifecycle)) return;
      setHasSecret(nextHasSecret);
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      setHasSecret('error');
      toast.error(copy.credentialReadFailed, providerPanelActionErrorMessage(error, locale));
    }
    await props.onChanged();
  }

  return {
    apiKey,
    setApiKey,
    hasSecret,
    baseUrl,
    setBaseUrl,
    enabledModelIds,
    modelChoices,
    busy,
    testing,
    fetchingModels,
    deleting,
    detailActionBusy,
    supportsApiKey,
    needsOAuth,
    usesGitHubCopilotLogin,
    oauthLoginService,
    supportsRemoteDiscovery,
    credentialProbePending,
    hasUsableCredential,
    apiKeyStatusHint,
    hasApiKeyChange,
    hasBaseUrlChange,
    savedBaseUrl,
    issue,
    lastTestMessage,
    lastTestAtMs,
    save,
    updateEnabledModels,
    runTest,
    refreshModels,
    remove,
    refreshAfterRelogin,
  };
}

type ConnectionDetailSnapshot = {
  slug: string;
  baseUrl: string;
  models: ModelInfo[];
  modelSource: 'fetched' | 'fallback';
};

function connectionDetailSnapshot(
  connection: LlmConnection,
  defaultBaseUrl: string | undefined,
): ConnectionDetailSnapshot {
  return {
    slug: connection.slug,
    baseUrl: connection.baseUrl ?? defaultBaseUrl ?? '',
    models: connection.models ?? [],
    modelSource: connection.modelSource ?? 'fallback',
  };
}

function connectionDetailDraftMatchesSnapshot(
  draft: {
    baseUrl: string;
    models: ModelInfo[];
    modelSource: 'fetched' | 'fallback';
  },
  snapshot: ConnectionDetailSnapshot,
): boolean {
  return draft.baseUrl === snapshot.baseUrl &&
    draft.modelSource === snapshot.modelSource &&
    modelListsEqual(draft.models, snapshot.models);
}

function modelListsEqual(left: ModelInfo[], right: ModelInfo[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftModel = left[index];
    const rightModel = right[index];
    if (leftModel.id !== rightModel.id) return false;
    if (leftModel.contextWindow !== rightModel.contextWindow) return false;
    if (leftModel.maxOutputTokens !== rightModel.maxOutputTokens) return false;
    if (leftModel.capabilities?.chat !== rightModel.capabilities?.chat) return false;
    if (leftModel.capabilities?.vision !== rightModel.capabilities?.vision) return false;
    if (leftModel.capabilities?.reasoning !== rightModel.capabilities?.reasoning) return false;
    if (leftModel.capabilities?.functionCalling !== rightModel.capabilities?.functionCalling) return false;
    if (leftModel.capabilities?.imageGeneration !== rightModel.capabilities?.imageGeneration) return false;
  }
  return true;
}

function modelIdListsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
