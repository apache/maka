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

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  connectionNameDraftChanged,
  connectionNameDraftReseed,
  connectionNameToSave,
  shouldRefreshModelsAfterSave,
} from './connection-name-draft.js';
import {
  type ConnectionTestResult,
  type LlmConnection,
  type ModelInfo,
  type ProviderType,
} from '@maka/core/llm-connections';
import { PROVIDER_DEFAULTS, connectionEnabledModelIds } from '@maka/core/llm-connections';
import { buildConnectionModelCatalogEntries } from '@maka/core/model-catalog';
import { isRetiredProvider } from '@maka/core/provider-registry';
import {
  normalizeRelayModelProfiles,
  pruneRelayModelProfiles,
  type RelayModelProfile,
  type ThinkingLevel,
} from '@maka/core/model-thinking';
import {
  providerAuthRequiresSecret,
  providerAuthSupportsApiKey,
  providerSupportsModelDiscovery,
} from '@maka/core/llm-connections';
import { useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { getProviderSettingsCopy } from '../locales/settings-provider-copy';
import { connectionChipStatus } from './provider-connection-status';
import { relayProfileDraftReseedPlan, relayProfileDraftSeed } from './relay-profile-draft';
import { applyBulkThinkingLevel, relayProfileWithThinkingLevels } from './relay-thinking-bulk';
import { useKeyedActionGuard } from './use-action-guard';
import type { OAuthLoginFlowBridge } from './use-oauth-login-flow';
import {
  connectionLastTestMessageDisplay,
  connectionTestFailureMessage,
  providerPanelActionErrorMessage,
  type ConnectionsBridge,
  type CredentialPresenceStatus,
} from './provider-panel-shared';
import {
  useRuntimeHostSettingsErrorReporter,
  useRuntimeHostSettingsTarget,
} from './runtime-host-settings-target.js';
import { runtimeHostOAuthLoginBridge } from './runtime-host-settings-bridge.js';

// Maps an OAuth model-connection provider type to the browser-assisted login
// service that can re-run its authorization from inside the connection dialog. Only
// the browser-assisted services (Codex and xAI) are one-button-drivable
// here; plain API-key providers return null so the notice falls back to
// prose instead of rendering a dead button.
export interface OAuthLoginService {
  bridge: OAuthLoginFlowBridge;
  display: { name: string; shortName: string };
}

export function oauthLoginServiceFor(
  providerType: ProviderType,
  host: import('../../preload/bridge-contract.js').DesktopRuntimeHostRef,
): OAuthLoginService | null {
  switch (providerType) {
    case 'openai-codex':
      return {
        bridge: runtimeHostOAuthLoginBridge(window.maka.openAiCodex, host),
        display: { name: 'OpenAI Codex', shortName: 'Codex' },
      };
    case 'xai-oauth':
      return {
        bridge: runtimeHostOAuthLoginBridge(window.maka.xaiOAuth, host),
        display: { name: 'xAI Grok', shortName: 'SuperGrok / X Premium' },
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
  const host = useRuntimeHostSettingsTarget();
  const locale = useUiLocale();
  const copy = getProviderSettingsCopy(locale).detail;
  const { connection } = props;
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  const [apiKey, setApiKey] = useState('');
  const [hasSecret, setHasSecret] = useState<CredentialPresenceStatus>(
    defaults.authKind === 'none' ? true : 'loading',
  );
  const [name, setName] = useState(connection.name);
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
    'save' | 'test' | 'fetch-models' | 'save-enabled-models' | 'save-relay-profiles' | 'delete'
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
  const oauthLoginService = needsOAuth && !retired
    ? oauthLoginServiceFor(connection.providerType, host)
    : null;
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
        reportHostError(
          copy.credentialReadFailed,
          providerPanelActionErrorMessage(error, locale),
        );
      });
  }, [props.bridge, connection.slug, probesCredential, reportHostError]);

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
      enabledModelIds,
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
  async function save(field: 'key' | 'endpoint' | 'name'): Promise<boolean> {
    const releaseSave = connectionDetailActionGuard.beginExclusive('save');
    if (!releaseSave) return false;
    const lifecycle = connectionDetailLifecycleRef.current;
    setBusy(true);
    let saved = false;
    try {
      await props.bridge.update(
        connection.slug,
        field === 'key' ? { apiKey } : field === 'name' ? { name: draftName } : { baseUrl },
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
      await props.bridge.update(connection.slug, { enabledModelIds: next });
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

  // Per-model profile declarations for custom OpenAI relays, edited as a
  // LOCAL DRAFT and committed by an explicit 保存 button — never keystroke by
  // keystroke. A draft is `Record<modelId, RelayModelProfile>` seeded from the
  // saved table; entries a user empties fully drop out of the map, and the
  // ≥1-enabled-model invariant is honored live: the draft is pruned against
  // `enabledModelIds` on every read, so disabling a model in the section above
  // removes its unsaved declaration too (the store prunes the SAVED table the
  // same way on write).
  const [relayProfileDrafts, setRelayProfileDrafts] = useState<Record<string, RelayModelProfile>>(
    () => relayProfileDraftSeed(connection.relayModelProfiles),
  );
  const [relayProfilesDirty, setRelayProfilesDirty] = useState(false);
  // The dirty flag names a slug: the same instance continues across the
  // connection switcher, and draft state is owned by one connection at a
  // time (see relayProfileDraftReseedPlan).
  const relayProfileDraftOwnerRef = useRef(connection.slug);

  function updateRelayProfileDraft(
    modelId: string,
    next: (current: RelayModelProfile | undefined) => RelayModelProfile | undefined,
  ): void {
    setRelayProfilesDirty(true);
    setRelayProfileDrafts((current) => {
      const updated = next(current[modelId]);
      if (updated === undefined) {
        if (!(modelId in current)) return current;
        const { [modelId]: _dropped, ...rest } = current;
        return rest;
      }
      return { ...current, [modelId]: updated };
    });
  }

  // One shape for all three fields: the field setter pins or removes its key,
  // and an entry with no keys left IS the undeclared state — storing it would
  // keep the row looking edited after the user emptied every field. The rule
  // lives in relay-thinking-bulk so the row setter and the bulk control
  // cannot drift on what an emptied declaration collapses to.
  function setDraftThinkingLevels(modelId: string, levels: ThinkingLevel[] | undefined): void {
    updateRelayProfileDraft(modelId, (current) => relayProfileWithThinkingLevels(current, levels));
  }

  // The same edit across every enabled model, as ONE state update rather than
  // a loop of per-model setters: a bulk tick is a single user gesture, and
  // committing it in N steps would let a re-render land mid-way and paint a
  // half-applied table.
  function setDraftThinkingLevelForAll(
    modelIds: readonly string[],
    level: ThinkingLevel,
    checked: boolean,
  ): void {
    setRelayProfilesDirty(true);
    setRelayProfileDrafts((current) => applyBulkThinkingLevel(modelIds, current, level, checked));
  }

  // Tri-state vision: undefined = Auto (relay/metadata decides), true/false
  // pin the declaration. The Selector's three options map straight onto this.
  function setDraftVision(modelId: string, vision: boolean | undefined): void {
    updateRelayProfileDraft(modelId, (current) => {
      if (vision === undefined) {
        if (!current) return current;
        const { vision: _dropped, ...rest } = current;
        return Object.keys(rest).length > 0 ? rest : undefined;
      }
      return { ...(current ?? {}), vision };
    });
  }

  function setDraftContextWindow(modelId: string, contextWindow: number | undefined): void {
    updateRelayProfileDraft(modelId, (current) => {
      if (contextWindow === undefined) {
        if (!current) return current;
        const { contextWindow: _dropped, ...rest } = current;
        return Object.keys(rest).length > 0 ? rest : undefined;
      }
      return { ...(current ?? {}), contextWindow };
    });
  }

  function setDraftServiceTier(modelId: string, serviceTier: 'fast' | undefined): void {
    updateRelayProfileDraft(modelId, (current) => {
      if (serviceTier === undefined) {
        if (!current) return current;
        const { serviceTier: _dropped, ...rest } = current;
        return Object.keys(rest).length > 0 ? rest : undefined;
      }
      return { ...(current ?? {}), serviceTier };
    });
  }

  // Compare against what persistence would store: drafts pruned to the
  // current selection and order-normalized by the same sanitizer the write
  // path applies, so a reordered-but-equal draft doesn't keep 保存 lit.
  const savedRelayProfiles = normalizeRelayModelProfiles(
    pruneRelayModelProfiles(connection.relayModelProfiles, enabledModelIds) ?? {},
  );
  const draftedRelayProfiles = normalizeRelayModelProfiles(
    pruneRelayModelProfiles(relayProfileDrafts, enabledModelIds) ?? {},
  );
  const hasRelayProfileChanges = !relayProfilesEqual(draftedRelayProfiles, savedRelayProfiles);

  useEffect(() => {
    // Slug switch always reseeds AND clears dirty — carrying A's unsaved
    // declarations onto B would let one save write them into B's document.
    // A same-slug reload reseeds only while the draft is clean: mid-edit
    // reloads (another action's props.onChanged) keep the user's typed work.
    const plan = relayProfileDraftReseedPlan(
      { slug: relayProfileDraftOwnerRef.current, dirty: relayProfilesDirty },
      connection.slug,
    );
    relayProfileDraftOwnerRef.current = connection.slug;
    if (plan.reseed) {
      setRelayProfileDrafts(relayProfileDraftSeed(connection.relayModelProfiles));
    }
    if (plan.clearDirty) {
      setRelayProfilesDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.slug, connection.relayModelProfiles, relayProfilesDirty]);

  // The name draft is reseeded on its own rather than through
  // `connectionDetailSnapshot`: that snapshot's dependency identity is
  // load-bearing (see the update-depth note above), and a name needs none of
  // its machinery.
  //
  // A slug switch always reseeds — carrying A's typed name onto B would let
  // one save rename the wrong connection. A same-slug change reseeds only
  // while the draft still matches what was saved, so a rename landing from
  // this page (or another client) does not overwrite work in progress.
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

  async function saveRelayProfiles(): Promise<boolean> {
    // Refuse while the draft still belongs to the previous connection: in the
    // window between the slug switch rendering and the reseed effect
    // flushing, 保存 must not hand B this draft.
    if (relayProfileDraftOwnerRef.current !== connection.slug) return false;
    const releaseSave = connectionDetailActionGuard.beginExclusive('save-relay-profiles');
    if (!releaseSave) return false;
    const lifecycle = connectionDetailLifecycleRef.current;
    setBusy(true);
    try {
      // Send the whole table — the update contract is whole-table replace —
      // after the write-path sanitizer so a hand-assembled draft degrades the
      // same way a saved document would.
      await props.bridge.update(connection.slug, {
        relayModelProfiles: draftedRelayProfiles ?? null,
      });
      if (!isConnectionDetailCurrent(lifecycle)) return true;
      setRelayProfilesDirty(false);
      await props.onChanged();
      return true;
    } catch (error) {
      if (!isConnectionDetailCurrent(lifecycle)) return false;
      reportHostError(
        copy.saveFailed,
        providerPanelActionErrorMessage(error, locale),
      );
      return false;
    } finally {
      releaseSave();
      if (isConnectionDetailCurrent(lifecycle)) setBusy(false);
    }
  }

  /**
   * Introduce a model the provider's catalog does not list.
   *
   * Only offered where refresh cannot help: a provider with no model-list
   * endpoint replays the array this build shipped, so a model the user's plan
   * serves but Maka has never heard of has no other way in (#1584).
   *
   * The id enters `enabledModelIds` — the same user-selection authority a
   * catalogued model uses, so nothing here pretends the provider advertised
   * it — and the context window enters `relayModelProfiles`, which is where a
   * user states a fact no other source knows. Both go in ONE write: the store
   * requires every declaration to key an enabled model, so a table written
   * ahead of its id would be rejected.
   *
   * The saved table is the base, not the unsaved draft: adding a model must
   * not silently commit edits the user has open in the capability section.
   * The draft is then caught up by hand, because a dirty draft deliberately
   * does not reseed from props — see `relayProfileDraftReseedPlan`.
   */
  async function addDeclaredModel(id: string, contextWindow: number): Promise<boolean> {
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
      await props.bridge.update(connection.slug, {
        enabledModelIds: next,
        relayModelProfiles: { ...(savedRelayProfiles ?? {}), [modelId]: { contextWindow } },
      });
      saved = true;
      if (!isConnectionDetailCurrent(lifecycle)) return saved;
      // The editor's draft is a second copy of this table, and while it is
      // dirty it does not reseed from props — that is what keeps an unrelated
      // reload from discarding typed work. So the declaration just written has
      // to be merged in here. Without it the draft is a table that no longer
      // contains this model, the capability-save button lights up on that
      // difference, and its whole-table replace drops the context window the
      // user just declared — silently, back to the unknown-model default.
      setRelayProfileDrafts((current) => ({ ...current, [modelId]: { contextWindow } }));
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
      const result: ConnectionTestResult = await props.bridge.test(connection.slug);
      if (!isConnectionDetailCurrent(lifecycle)) return;
      if (result.ok) {
        toast.success(
          copy.connectionSuccess(connection.name),
          `${result.modelTested} · ${result.latencyMs} ms`,
        );
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
    const usesOAuth = PROVIDER_DEFAULTS[connection.providerType].authKind === 'oauth_token';
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
      await props.bridge.delete(connection.slug);
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
      const nextHasSecret = await props.bridge.hasSecret(connection.slug);
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
    usesGitHubCopilotLogin,
    oauthLoginService,
    supportsRemoteDiscovery,
    credentialProbePending,
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
    relayProfileDraft: relayProfileDrafts,
    relayProfilesDirty,
    hasRelayProfileChanges,
    setDraftThinkingLevels,
    setDraftThinkingLevelForAll,
    setDraftVision,
    setDraftContextWindow,
    setDraftServiceTier,
    saveRelayProfiles,
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
    if (leftModel.capabilities?.parallelToolCalls !== rightModel.capabilities?.parallelToolCalls) return false;
    if (leftModel.capabilities?.imageGeneration !== rightModel.capabilities?.imageGeneration) return false;
  }
  return true;
}

function modelIdListsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function relayProfilesEqual(
  left: ReturnType<typeof normalizeRelayModelProfiles>,
  right: ReturnType<typeof normalizeRelayModelProfiles>,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  if (leftIds.length !== rightIds.length) return false;
  for (const id of leftIds) {
    const a = left[id];
    const b = right[id];
    if (!a || !b) return false;
    if (a.vision !== b.vision || a.contextWindow !== b.contextWindow) return false;
    const al = a.thinkingLevels ?? [];
    const bl = b.thinkingLevels ?? [];
    if (al.length !== bl.length || al.some((level, index) => level !== bl[index])) return false;
  }
  return true;
}
