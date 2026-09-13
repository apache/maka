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

import { useEffect, useRef, useState } from 'react';
import {
  connectionNameDraftChanged,
  connectionNameDraftReseed,
  connectionNameToSave,
  shouldRefreshModelsAfterSave,
} from './connection-name-draft.js';
import {
  type ConnectionTestResult,
  type ProjectedLlmConnection,
  type ProviderType,
} from '@maka/core/llm-connections';
import { PROVIDER_REGISTRY, connectionEnabledModelIds } from '@maka/core/llm-connections';
import { isRetiredProvider } from '@maka/core/provider-registry';
import {
  normalizeModelOverrides,
  type ModelOverride,
} from '@maka/core/model-thinking';
import {
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  providerSupportsModelDiscovery,
} from '@maka/core/llm-connections';
import { useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { connectionChipStatus } from './provider-connection-status';
import { useKeyedActionGuard } from './use-action-guard';
import type {
  OAuthAccountFlowBridge,
  OAuthAuthorizationFlowBridge,
} from './use-oauth-login-flow';
import {
  connectionLastTestMessageDisplay,
  connectionTestFailureMessage,
  getProviderSettingsCopy,
  providerPanelActionErrorMessage,
  type ConnectionOAuthBridge,
  type ConnectionOAuthProviderBridge,
  type ConnectionsBridge,
  type CredentialPresenceStatus,
} from '../features/connection-settings';
import { useRuntimeHostSettingsErrorReporter } from './runtime-host-settings-target.js';

// Maps an OAuth model-connection provider type to the browser-assisted login
// service that can re-run its authorization from inside the connection dialog. Only
// the browser-assisted services (Codex and xAI) are one-button-drivable
// here; plain API-key providers return null so the notice falls back to
// prose instead of rendering a dead button.
export interface OAuthLoginService {
  authorizationBridge: OAuthAuthorizationFlowBridge;
  accountBridge: OAuthAccountFlowBridge;
  display: { name: string; shortName: string };
  // OAuth device pages that require manual code entry expose it as stateHint.
  showsDeviceCode: boolean;
}

export function oauthLoginServiceFor(
  providerType: ProviderType,
  oauth: ConnectionOAuthBridge,
  connectionId: string,
  connectionLabel?: string,
): OAuthLoginService | null {
  switch (providerType) {
    case 'openai-codex':
      return oauthLoginService(
        oauth.openAiCodex,
        connectionId,
        { name: connectionLabel ?? 'OpenAI Codex', shortName: 'Codex' },
        true,
      );
    case 'xai-oauth':
      return oauthLoginService(
        oauth.xaiOAuth,
        connectionId,
        { name: connectionLabel ?? 'xAI Grok', shortName: 'SuperGrok / X Premium' },
        false,
      );
    // Copilot re-login is the same Host-owned device grant the catalog drives;
    // importing a local `gh` credential stays a catalog action, so an expired
    // connection is re-authorized here exactly like every other OAuth account.
    case 'github-copilot':
      return oauthLoginService(
        oauth.githubCopilotSubscription,
        connectionId,
        { name: connectionLabel ?? 'GitHub Copilot', shortName: 'GitHub Copilot' },
        true,
      );
    default:
      return null;
  }
}

function oauthLoginService(
  provider: ConnectionOAuthProviderBridge,
  connectionId: string,
  display: OAuthLoginService['display'],
  showsDeviceCode: boolean,
): OAuthLoginService {
  return {
    authorizationBridge: {
      getAuthUrl: () => provider.getAuthUrl({ kind: 'existing', connectionId }),
      openAuthUrl: (authRequestId) => provider.openAuthUrl(authRequestId),
      completeAuthorization: (authRequestId) => provider.completeAuthorization(authRequestId),
      cancelAuthorization: (authRequestId) => provider.cancelAuthorization(authRequestId),
      getEnrollmentState: () => provider.getEnrollmentState(),
    },
    accountBridge: {
      getAccountState: () => provider.getAccountState(connectionId),
      logout: () => provider.logout(connectionId),
    },
    display,
    showsDeviceCode,
  };
}

export interface ConnectionDetailProps {
  bridge: ConnectionsBridge;
  connection: ProjectedLlmConnection;
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
  const connectionIdentity = {
    connectionId: connection.connectionId,
    slug: connection.slug,
  } as const;
  const defaults = PROVIDER_REGISTRY[connection.providerType];
  const [apiKey, setApiKey] = useState('');
  const [hasSecret, setHasSecret] = useState<CredentialPresenceStatus>(
    defaults.authKind === 'none' ? true : 'loading',
  );
  const [name, setName] = useState(connection.name);
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? defaults.baseUrl ?? '');
  const models = connection.models ?? [];
  const [enabledModelIds, setEnabledModelIds] = useState(() => connectionEnabledModelIds(connection));
  const endpointOwnerRef = useRef({ connectionId: connection.connectionId, saved: baseUrl });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [savingEnabledModels, setSavingEnabledModels] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const connectionDetailActionGuard = useKeyedActionGuard<
    'save' | 'test' | 'fetch-models' | 'save-enabled-models' | 'save-model-parameters' | 'delete'
  >();
  const connectionDetailMountedRef = useMountedRef();
  const connectionDetailLifecycleRef = useRef(0);
  const toast = useToast();
  const reportHostError = useRuntimeHostSettingsErrorReporter();
  const supportsApiKey = providerAuthSupportsApiKey(connection.providerType);
  const needsOAuth = defaults.authKind === 'oauth_token';
  // A retired provider still has its credential on disk, so `hasSecret` is true
  // and the generic notice told these users to "reauthorize under account
  // connections" — an instruction whose only destination is the retirement
  // notice itself.
  const retired = isRetiredProvider(connection.providerType);
  const oauthLoginService = needsOAuth && !retired && connection.connectionId
    ? oauthLoginServiceFor(
        connection.providerType,
        props.bridge.oauth,
        connection.connectionId,
        `${connection.name} · ${connection.slug}`,
      )
    : null;
  const supportsRemoteDiscovery = providerSupportsModelDiscovery(connection.providerType);
  const requiresCredential = providerAuthRequiresSecret(connection.providerType);
  const probesCredential = supportsApiKey || needsOAuth;
  // `loading` is the normal first-frame state while the local credential
  // vault answers. Rendering it as a full-width warning made every successful
  // detail open flash the banner for one paint. Keep the durable warning for
  // a read failure; the key row already carries the quiet loading hint and the
  // action buttons remain gated by `hasUsableCredential` until the read lands.
  const credentialProbeFailed = requiresCredential && hasSecret === 'error';
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
  const savedName = connection.name;
  const draftName = connectionNameToSave(name);
  const hasNameChange = connectionNameDraftChanged(name, savedName);
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
  }, [connection.connectionId]);

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
      .hasSecret(connectionIdentity)
      .then((next) => {
        if (isConnectionDetailCurrent(lifecycle)) setHasSecret(next);
      })
      .catch((error) => {
        if (!isConnectionDetailCurrent(lifecycle)) return;
        setHasSecret('error');
        reportHostError(
          copy.credentialReadFailed,
          providerPanelActionErrorMessage(error, locale),
        );
      });
  }, [props.bridge, connection.connectionId, connection.slug, probesCredential, reportHostError]);

  useEffect(() => {
    const previous = endpointOwnerRef.current;
    if (previous.connectionId !== connection.connectionId || baseUrl === previous.saved) {
      setBaseUrl(savedBaseUrl);
    }
    endpointOwnerRef.current = { connectionId: connection.connectionId, saved: savedBaseUrl };
  }, [connection.connectionId, savedBaseUrl]);

  useEffect(() => {
    setEnabledModelIds(connectionEnabledModelIds(connection));
  }, [connection.defaultModel, connection.enabledModelIds, connection.connectionId]);

  const modelChoices = connection.catalogEntries;

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
  async function save(field: 'key' | 'endpoint' | 'name'): Promise<boolean> {
    const releaseSave = connectionDetailActionGuard.beginExclusive('save');
    if (!releaseSave) return false;
    const lifecycle = connectionDetailLifecycleRef.current;
    setBusy(true);
    let saved = false;
    try {
      await props.bridge.update(
        connectionIdentity,
        field === 'key' ? { apiKey } : field === 'name' ? { name: draftName } : { baseUrl },
      );
      saved = true;
      if (!isConnectionDetailCurrent(lifecycle)) return true;
      const wroteNewKey = field === 'key' && apiKey.length > 0;
      if (wroteNewKey) setApiKey('');
      const nextHasSecret = probesCredential ? await props.bridge.hasSecret(connectionIdentity) : true;
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
        shouldRefreshModelsAfterSave({
          field,
          wroteNewKey,
          hasCachedModels: models.length > 0,
        })
      ) {
        void refreshModels({ silent: true });
      }
      return true;
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return saved;
      if (saved && probesCredential) {
        setHasSecret('error');
      }
      reportHostError(
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
      await props.bridge.update(connectionIdentity, { enabledModelIds: next });
      saved = true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      await props.onChanged();
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (!saved) setEnabledModelIds(previous);
      reportHostError(
        saved ? copy.refreshFailed : copy.saveModelsFailed,
        providerPanelActionErrorMessage(error, locale),
      );
    } finally {
      releaseSaveModels();
      if (isConnectionDetailCurrent(lifecycle)) setSavingEnabledModels(false);
    }
  }

  const [modelDraft, setModelDraft] = useState<{
    connectionId: string;
    modelId: string;
    expected: ModelOverride | null;
    value: ModelOverride;
  } | null>(null);
  const activeDraft = modelDraft?.connectionId === connection.connectionId ? modelDraft : null;
  const modelParameters = {
    ...connection.modelOverrides,
    ...(activeDraft ? { [activeDraft.modelId]: activeDraft.value } : {}),
  };

  function updateModelDraft(
    modelId: string,
    next: (current: ModelOverride | undefined) => ModelOverride | undefined,
  ): void {
    setModelDraft((current) => {
      const previous = current?.connectionId === connection.connectionId && current.modelId === modelId ? current : null;
      return {
      connectionId: connection.connectionId,
      modelId,
      expected: previous ? previous.expected : connection.modelOverrides?.[modelId] ?? null,
      value: next(previous ? previous.value : connection.modelOverrides?.[modelId]) ?? {},
      };
    });
  }

  function resetDraftProfile(_modelId: string): void {
    setModelDraft(null);
  }

  function setDraftParameters(modelId: string, patch: Partial<ModelOverride>): void {
    updateModelDraft(modelId, (current) => ({ ...current, ...patch }));
  }

  const savedModelOverrides = normalizeModelOverrides(connection.modelOverrides ?? {});
  const hasModelChanges = activeDraft !== null && JSON.stringify(normalizeModelOverrides({ model: activeDraft.value })?.model) !==
    JSON.stringify(savedModelOverrides?.[activeDraft.modelId] ?? {});

  const nameDraftOwnerRef = useRef<{ slug: string; savedName: string }>({
    slug: connection.slug,
    savedName: connection.name,
  });
  useEffect(() => {
    const previous = nameDraftOwnerRef.current;
    const reseed = connectionNameDraftReseed(previous, connection, name);
    nameDraftOwnerRef.current = { slug: connection.slug, savedName: connection.name };
    if (reseed) setName(connection.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.slug, connection.name]);

  async function saveModelParameters(): Promise<boolean> {
    if (!activeDraft) return false;
    const releaseSave = connectionDetailActionGuard.beginExclusive('save-model-parameters');
    if (!releaseSave) return false;
    const lifecycle = connectionDetailLifecycleRef.current;
    setBusy(true);
    let saved = false;
    try {
      await props.bridge.update(connectionIdentity, {
        modelOverride: { modelId: activeDraft.modelId, expected: activeDraft.expected, value: activeDraft.value },
      });
      saved = true;
      if (!isConnectionDetailCurrent(lifecycle)) return true;
      setModelDraft(null);
      await props.onChanged();
      return true;
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return saved;
      reportHostError(
        saved ? copy.refreshFailed : copy.saveFailed,
        providerPanelActionErrorMessage(error, locale),
      );
      return saved;
    } finally {
      releaseSave();
      if (isConnectionDetailCurrent(lifecycle)) setBusy(false);
    }
  }

  // Add the selection and parameters together, without saving another row's draft.
  async function addDeclaredModel(id: string, profile: ModelOverride): Promise<boolean> {
    const modelId = id.trim();
    if (!modelId || enabledModelIds.includes(modelId)) return false;
    if (connectionDetailActionGuard.has('save-enabled-models') || detailActionBusy) return false;
    const next = [...enabledModelIds, modelId];
    const previous = enabledModelIds;
    const lifecycle = connectionDetailLifecycleRef.current;
    const releaseSaveModels = connectionDetailActionGuard.begin('save-enabled-models');
    if (!releaseSaveModels) return false;
    setSavingEnabledModels(true);
    setEnabledModelIds(next);
    let saved = false;
    try {
      await props.bridge.update(connectionIdentity, {
        modelOverride: { modelId, expected: null, value: profile, enable: true },
      });
      saved = true;
      if (!isConnectionDetailCurrent(lifecycle)) return saved;
      await props.onChanged();
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return saved;
      if (!saved) setEnabledModelIds(previous);
      reportHostError(
        saved ? copy.refreshFailed : copy.saveModelsFailed,
        providerPanelActionErrorMessage(error, locale),
      );
    } finally {
      releaseSaveModels();
      if (isConnectionDetailCurrent(lifecycle)) setSavingEnabledModels(false);
    }
    // Whether the write landed. The dialog holds the typed id and context
    // window until it did: a rejected write leaves nothing to retype from, and
    // an exact model id is not something a user can reproduce from memory.
    return saved;
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
      const result: ConnectionTestResult = await props.bridge.test(connectionIdentity);
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (result.ok) {
        // The backend probes the enabled models first, then the provider
        // fallbacks (opencode-free tries each in turn until one answers). When
        // the model that actually answered isn't one the user enabled, a plain
        // "connection succeeded · <model>" reads as if their selection never
        // took — and hides that their chosen model is currently down. Name both
        // facts instead.
        const testedId = result.modelTested;
        // The resolved entries, not the draft rows: a provider with no
        // model-list endpoint stores bare ids, so naming the tested model from
        // `models` printed a raw id next to the picker's resolved name.
        const modelLabel = (id: string): string =>
          modelChoices.find((entry) => entry.id === id)?.displayName?.trim() || id;
        // Inline the `testedId !== undefined` check so it narrows `testedId` to
        // string for `modelLabel(testedId)` below.
        if (
          testedId !== undefined &&
          enabledModelIds.length > 0 &&
          !enabledModelIds.includes(testedId)
        ) {
          toast.warning(
            copy.connectionFallbackTitle(connection.name),
            copy.connectionFallbackDetail(enabledModelIds.map(modelLabel), modelLabel(testedId)),
          );
        } else {
          toast.success(
            copy.connectionSuccess(connection.name),
            `${result.modelTested} · ${result.latencyMs} ms`,
          );
        }
      } else {
        reportHostError(
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
      reportHostError(
        copy.connectionTestError(connection.name),
        message,
      );
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
      const result = await props.bridge.fetchModels(connectionIdentity);
      fetched = true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      await props.onChanged();
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (!opts.silent) {
        toast.success(copy.modelsFetched(result.models.length, connection.name));
      }
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      const message = providerPanelActionErrorMessage(error, locale);
      if (fetched) {
        reportHostError(
          copy.refreshFailed,
          message,
        );
      } else {
        reportHostError(
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
    const usesOAuth = PROVIDER_REGISTRY[connection.providerType].authKind === 'oauth_token';
    const ok = await toast.confirm({
      title: copy.deleteConnectionTitle(connection.name),
      description: copy.deleteDescription(props.isDefault, usesOAuth),
      confirmLabel: usesOAuth ? copy.disconnectAndDelete : copy.delete,
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
      await props.bridge.delete(connectionIdentity);
      deleted = true;
      if (!isConnectionDetailCurrent(lifecycle)) return;
      await props.onDeleted();
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      reportHostError(
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
      const nextHasSecret = await props.bridge.hasSecret(connectionIdentity);
      if (!isConnectionDetailCurrent(lifecycle)) return;
      setHasSecret(nextHasSecret);
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return;
      setHasSecret('error');
      reportHostError(
        copy.credentialReadFailed,
        providerPanelActionErrorMessage(error, locale),
      );
    }
    await props.onChanged();
  }

  return {
    apiKey,
    setApiKey,
    hasSecret,
    name,
    setName,
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
    retired,
    oauthLoginService,
    supportsRemoteDiscovery,
    credentialProbeFailed,
    hasUsableCredential,
    apiKeyStatusHint,
    hasApiKeyChange,
    hasBaseUrlChange,
    savedBaseUrl,
    hasNameChange,
    savedName,
    issue,
    lastTestMessage,
    lastTestAtMs,
    save,
    updateEnabledModels,
    addDeclaredModel,
    modelParameters,
    hasModelChanges,
    resetDraftProfile,
    setDraftParameters,
    saveModelParameters,
    runTest,
    refreshModels,
    remove,
    refreshAfterRelogin,
  };
}

function modelIdListsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
