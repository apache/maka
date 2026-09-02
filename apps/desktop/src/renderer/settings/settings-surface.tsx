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

import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import {
  Badge,
  Button,
  IconButton,
  Layout,
  LayoutContent,
  LayoutHeader,
  LayoutPanel,
  SideNav,
  SideNavItem,
  SideNavSection,
  useMediaQuery,
} from '@astryxdesign/core';
import { ICON_SIZE, ArrowLeft } from '@maka/ui/icons';
import type {
  AppSettings,
  RuntimeHostAppSettings,
  ChatDefaultPermissionMode,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UpdateAppSettingsResult,
  UsageRange,
  UsageStats,
} from '@maka/core/settings';
import type {
  IdentifiedLlmConnection,
  ProjectedLlmConnection,
  ProviderType,
} from '@maka/core/llm-connections';
import type {
  DesktopRuntimeHostProfileChangedEvent,
  DesktopRuntimeHostProfileSnapshot,
  DesktopRuntimeHostRef,
  DesktopSessionSummary,
} from '../../preload/bridge-contract.js';
import type { UiLocalePreference } from '@maka/core/ui-locale';
import { createDefaultSettings, DEFAULT_APP_ICON } from '@maka/core/settings';
import { Banner, Selector, useMountedRef, useToast, useUiLocale } from '@maka/ui';
import { ProvidersPanel } from './providers-panel';
import { SubagentSettingsPage } from './subagent-settings-page';
import { safeLocalStorageSet } from '../browser-storage';
import { ProjectsSettingsPage } from './projects-settings-page';
import { AboutSettingsPage } from './about-settings-page';
import { AppearanceSettingsPage } from './appearance-settings-page';
import { BotChatSettingsPage } from './bot-chat-settings-page';
import { DailyReviewSettingsPage } from './daily-review-settings-page';
import { DataSettingsPage } from './data-settings-page';
import { GeneralSettingsPage } from './general-settings-page';
import { HealthCenterPage } from './health-center-page';
import { MemorySettingsPage } from './memory-settings-page';
import { PermissionCenterPage } from './permission-center-page';
import { SettingsSkeleton } from './settings-skeleton';
import {
  SETTINGS_NAV,
  groupedNav,
  navLabel,
  readLastSettingsSection,
  settingsSectionScope,
} from './settings-nav';
import { getSettingsNavigationCopy } from '../locales/settings-navigation-copy.js';
import { SettingRow } from './settings-rows';
import { SettingsPage } from './settings-section';
import { settingsActionErrorMessage } from './settings-error-copy';
import { ImportTasksSettingsPage } from './import-tasks-settings-page';
import { TasksSettingsPage, type ArchivedTasksBridge } from './tasks-settings-page';
import { UsageSettingsPage } from './usage-settings-page';
import { WebSearchSettingsPage } from './web-search-settings-page';
import type { UiLocaleUpdateGate } from './ui-locale-update-gate';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';
import {
  ConnectionSettingsServicesConsumer,
  type ConnectionSettingsServices,
  type RuntimeHostSettingsConnectionsBridge,
} from '../features/connection-settings';
import {
  hasRuntimeHostSettingsPatch,
  projectClientOwnedSettings,
} from '../../shared/settings-ownership.js';
import { RuntimeHostSettingsTarget } from './runtime-host-settings-target.js';
import {
  beginSettingsResourceLoad,
  completeSettingsResourceLoad,
  createSettingsResourceState,
  failSettingsResourceLoad,
  invalidateSettingsResourceGeneration,
  reconcileRuntimeHostProfileSelection,
  settingsResourceSnapshot,
  settingsResourceStatus,
  type SettingsResourceState,
  type SettingsResourceStatus,
} from './settings-resource-state.js';
import {
  runtimeHostSettingsKey,
  settingsSnapshotCacheFor,
  type RuntimeHostConnectionsSnapshot,
  type SettingsSnapshotCache,
} from './settings-snapshot-cache.js';
import { RuntimeHostInteractionBoundary } from './runtime-host-interaction-boundary.js';
import { createSettingsRequestAuthority } from './settings-request-authority.js';

const NARROW_SETTINGS_QUERY = '(max-width: 760px)';
const RUNTIME_HOST_CATALOG_KEY = 'runtime-host-catalog';

type RuntimeHostAvailabilityStatus = 'loading' | 'ready' | 'unavailable' | 'error';

function readyRuntimeHost(
  snapshot: DesktopRuntimeHostProfileSnapshot | undefined,
  profileId: string | undefined,
  lifecycle?: DesktopRuntimeHostProfileChangedEvent,
): DesktopRuntimeHostRef | undefined {
  const entry = snapshot?.entries.find((candidate) => candidate.profile.id === profileId);
  if (entry?.readiness !== 'ready' || !entry.hostId) return undefined;
  if (
    lifecycle &&
    (
      lifecycle.removed === true ||
      lifecycle.readiness !== 'ready' ||
      !lifecycle.hostId ||
      lifecycle.hostId !== entry.hostId
    )
  ) return undefined;
  return { profileId: entry.profile.id, hostId: entry.hostId };
}

type SettingsSurfaceProps = {
  onClose(): void;
  themePref: ThemePreference;
  onThemeChange(pref: ThemePreference): void;
  themePalette: ThemePalette;
  onThemePaletteChange(palette: ThemePalette): void;
  onUiLocalePreferenceChange(preference: UiLocalePreference): void;
  uiLocaleUpdateGate: UiLocaleUpdateGate;
  onUserLabelChange?(label: string): void;
  onDefaultPermissionModeChange(mode: ChatDefaultPermissionMode): void;
  request?: { readonly section?: SettingsSection; readonly profileId?: string };
  openProviderCatalog?: boolean;
  initialConnectionSlug?: string;
  initialCreateProviderType?: ProviderType;
  initialFocusRef: RefObject<HTMLButtonElement | null>;
  onOpenDailyReview?(): void;
  onOpenKeyboardHelp?(): void;
  onOpenSession?(sessionId: string): void;
  archivedTasks: ArchivedTasksBridge;
  onTaskImported(session: DesktopSessionSummary): void;
  onRemoteHostAdded(profileId: string): void;
  onSelectedRuntimeHostProfileIdChange(profileId: string | undefined): void;
  snapshotCache?: SettingsSnapshotCache;
};

export function SettingsSurface(props: SettingsSurfaceProps) {
  return (
    <ConnectionSettingsServicesConsumer>
      {(connectionSettingsServices) => (
        <SettingsSurfaceContent
          {...props}
          connectionSettingsServices={connectionSettingsServices}
        />
      )}
    </ConnectionSettingsServicesConsumer>
  );
}

function SettingsSurfaceContent(
  props: SettingsSurfaceProps & {
    readonly connectionSettingsServices: ConnectionSettingsServices;
  },
) {
  const locale = useUiLocale();
  const copy = getSettingsSharedCopy(locale);
  const localizedNav = groupedNav(locale);
  const isNarrowSettings = useMediaQuery(NARROW_SETTINGS_QUERY);
  const [section, setSection] = useState<SettingsSection>(() => props.request?.section ?? readLastSettingsSection());
  const [providerCatalogRequested, setProviderCatalogRequested] = useState(props.openProviderCatalog === true);
  // One-shot landing intent, mirroring providerCatalogRequested above: the
  // request retires once ProvidersPanel consumes it, so remounting the panel
  // (switching sections away and back) does not resurrect the create dialog.
  const [createProviderRequest, setCreateProviderRequest] = useState(props.initialCreateProviderType);

  // Keep the pending intent in sync with the hook-level request: a newer
  // opener (e.g. a ⌘K section jump while Settings is still loading) clears
  // or replaces the prop, and the pending intent must follow — otherwise a
  // stale copy raises the create dialog after the user already navigated
  // away (GPT 5.6 Sol review, PR #1402). Keyed on prop CHANGE only, so an
  // already-consumed request (cleared below) is not resurrected while the
  // hook value is unchanged.
  useEffect(() => {
    setCreateProviderRequest(props.initialCreateProviderType);
  }, [props.initialCreateProviderType]);

  // When the parent updates the navigation request (e.g. the palette opens
  // Settings with a different section while it's already mounted), reflect
  // its section into the local state.
  useEffect(() => {
    if (props.request?.section && props.request.section !== section) {
      setSection(props.request.section);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.request?.section]);

  // Focus follows the active section's nav button: on mount, and whenever
  // `section` changes (nav click — a native-focus no-op — or a ⌘K palette
  // jump while the modal is already open, where nothing else moves focus).
  // Keyed on `section`, NOT on any parent callback prop: parent callbacks
  // (e.g. onClose) are recreated on every AppShell render — which happens
  // per streamed token — and keying a focus side effect on one yanks focus
  // away from anything the user opened inside Settings dozens of times a
  // second while a session streams.
  useEffect(() => {
    props.initialFocusRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ref identity is stable; re-run only on section change.
  }, [section]);

  // PR-MODEL-OAUTH-SECTION-0: ProvidersPanel's OAuth cards dispatch a
  // `maka:jumpToSettingsSection` window event to navigate between
  // Settings sections without threading another prop through. The event
  // payload is the destination SettingsSection id.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ section?: SettingsSection }>).detail;
      // PR-OAUTH-CARD-LIVE-STATE-0: validate against SETTINGS_NAV so
      // a dispatched section id that doesn't match any nav item falls
      // through to the default fallback page silently. Previously
      // any truthy string was accepted; a typo would land the user
      // on "该设置页已纳入 Maka 设置树…" with no clear cause.
      if (
        detail?.section &&
        SETTINGS_NAV.some((item) => item.id === detail.section)
      ) {
        setSection(detail.section);
      }
    };
    window.addEventListener('maka:jumpToSettingsSection', handler);
    return () => window.removeEventListener('maka:jumpToSettingsSection', handler);
  }, []);

  useEffect(() => {
    safeLocalStorageSet('maka-settings-section-v1', section);
  }, [section]);
  const defaultSettings = useMemo(() => createDefaultSettings(), []);
  const snapshotCache = useMemo(
    () => props.snapshotCache ?? settingsSnapshotCacheFor(window.maka),
    [props.snapshotCache],
  );
  const initialClientSettings = useMemo(
    () => snapshotCache.readClient(),
    [snapshotCache],
  );
  const initialRuntimeHostCatalog = useMemo(
    () => snapshotCache.readRuntimeHostCatalog(),
    [snapshotCache],
  );
  const initialSelectedProfileId =
    props.request?.profileId ?? initialRuntimeHostCatalog?.defaultProfileId;
  const initialRuntimeHost = useMemo(
    () => readyRuntimeHost(
      initialRuntimeHostCatalog,
      initialSelectedProfileId,
    ),
    [initialRuntimeHostCatalog, initialSelectedProfileId],
  );
  const initialRuntimeHostKey = initialRuntimeHost
    ? runtimeHostSettingsKey(initialRuntimeHost)
    : undefined;
  const [clientSettings, setClientSettings] = useState(
    initialClientSettings ?? defaultSettings,
  );
  const [runtimeHostSettings, setRuntimeHostSettings] = useState<
    SettingsResourceState<RuntimeHostAppSettings>
  >(() => createSettingsResourceState(
    initialRuntimeHostKey,
    initialRuntimeHostKey
      ? snapshotCache.readRuntimeHostSettings(initialRuntimeHostKey)
      : undefined,
  ));
  const [runtimeHostConnections, setRuntimeHostConnections] = useState<
    SettingsResourceState<RuntimeHostConnectionsSnapshot>
  >(() => createSettingsResourceState(
    initialRuntimeHostKey,
    initialRuntimeHostKey
      ? snapshotCache.readRuntimeHostConnections(initialRuntimeHostKey)
      : undefined,
  ));
  const [runtimeHostCatalog, setRuntimeHostCatalog] = useState<
    SettingsResourceState<DesktopRuntimeHostProfileSnapshot>
  >(() => createSettingsResourceState(
    RUNTIME_HOST_CATALOG_KEY,
    initialRuntimeHostCatalog,
  ));
  const [selectedProfileId, setSelectedProfileId] = useState<string | undefined>(
    initialSelectedProfileId,
  );
  const selectedProfileIdRef = useRef(selectedProfileId);
  const defaultRuntimeHostProfileIdRef = useRef(
    initialRuntimeHostCatalog?.defaultProfileId,
  );
  const [usageStats, setUsageStats] = useState<{
    hostKey: string;
    epoch: string | undefined;
    range: UsageRange;
    value: UsageStats;
  } | null>(null);
  const [clientLoading, setClientLoading] = useState(initialClientSettings === undefined);
  const settingsModalMountedRef = useMountedRef();
  const clientSettingsTicketRef = useRef(0);
  const [runtimeHostRequestAuthority] = useState(
    () => createSettingsRequestAuthority(initialRuntimeHostKey),
  );
  const usageReloadTicketRef = useRef(0);
  const runtimeHostReloadTicketRef = useRef(0);
  const runtimeHostCatalogHydratedRef = useRef(false);
  const selectedProfileChangedByUserRef = useRef(
    props.request?.profileId !== undefined,
  );
  const runtimeHostLifecycleByProfileRef = useRef(
    new Map<string, DesktopRuntimeHostProfileChangedEvent>(),
  );
  const [runtimeHostLifecycleByProfile, setRuntimeHostLifecycleByProfile] = useState(
    runtimeHostLifecycleByProfileRef.current,
  );
  const toast = useToast();

  const runtimeHosts = settingsResourceSnapshot(
    runtimeHostCatalog,
    RUNTIME_HOST_CATALOG_KEY,
  );
  const runtimeHostCatalogStatus = settingsResourceStatus(
    runtimeHostCatalog,
    RUNTIME_HOST_CATALOG_KEY,
  );

  const selectedRuntimeHostEntry = runtimeHosts?.entries.find(
    (entry) => entry.profile.id === selectedProfileId,
  );
  const selectedRuntimeHost = useMemo(
    () => readyRuntimeHost(
      runtimeHosts,
      selectedProfileId,
      selectedProfileId
        ? runtimeHostLifecycleByProfile.get(selectedProfileId)
        : undefined,
    ),
    [runtimeHostLifecycleByProfile, runtimeHosts, selectedProfileId],
  );
  const connectionBridges = useMemo(
    () => selectedRuntimeHost
      ? props.connectionSettingsServices.forHost(selectedRuntimeHost)
      : undefined,
    [props.connectionSettingsServices, selectedRuntimeHost],
  );
  const connectionsBridge = connectionBridges?.connections;
  const apiKeyOnboardingBridge = connectionBridges?.apiKeyOnboarding;
  const selectedRuntimeHostKey = selectedRuntimeHost
    ? runtimeHostSettingsKey(selectedRuntimeHost)
    : undefined;
  const selectedRuntimeHostKeyRef = useRef(selectedRuntimeHostKey);
  selectedRuntimeHostKeyRef.current = selectedRuntimeHostKey;
  // A same-key Host can be replaced in place (hostId stable, epoch bumped) on
  // reconnect. `runtimeHostSettingsKey` is epoch-free, so usage must key on the
  // epoch too — otherwise a reconnect clears the page but never refetches.
  const selectedRuntimeHostEpoch = selectedProfileId
    ? runtimeHostLifecycleByProfile.get(selectedProfileId)?.epoch
    : undefined;
  const selectedRuntimeHostEpochRef = useRef(selectedRuntimeHostEpoch);
  selectedRuntimeHostEpochRef.current = selectedRuntimeHostEpoch;
  function commitSelectedRuntimeHostProfile(
    profileId: string,
    snapshot = runtimeHosts,
  ): void {
    const lifecycle = runtimeHostLifecycleByProfileRef.current.get(profileId);
    const nextHost = readyRuntimeHost(snapshot, profileId, lifecycle);
    const nextKey = nextHost ? runtimeHostSettingsKey(nextHost) : undefined;
    // Reject old-Host reads and writes synchronously with the authority
    // change, before React renders the newly selected profile.
    const targetChanged = runtimeHostRequestAuthority.selectTarget(
      nextKey,
      lifecycle?.epoch,
    );
    if (targetChanged) {
      usageReloadTicketRef.current += 1;
      setUsageStats(null);
    }
    selectedProfileIdRef.current = profileId;
    setSelectedProfileId(profileId);
  }
  const selectedRuntimeHostSettings = settingsResourceSnapshot(
    runtimeHostSettings,
    selectedRuntimeHostKey,
  );
  const selectedConnections = settingsResourceSnapshot(
    runtimeHostConnections,
    selectedRuntimeHostKey,
  );
  const selectedRuntimeHostSettingsStatus = settingsResourceStatus(
    runtimeHostSettings,
    selectedRuntimeHostKey,
  );
  const selectedRuntimeHostConnectionsStatus = settingsResourceStatus(
    runtimeHostConnections,
    selectedRuntimeHostKey,
  );
  const settings = useMemo(
    () => projectClientOwnedSettings(
      selectedRuntimeHostSettings ?? defaultSettings,
      clientSettings,
    ),
    [clientSettings, defaultSettings, selectedRuntimeHostSettings],
  );
  const connections = selectedConnections?.connections ?? [];
  const defaultSlug = selectedConnections?.defaultSlug ?? null;
  const sectionScope = settingsSectionScope(section);
  const showsRuntimeHost = sectionScope !== 'client';
  const requiresRuntimeHost = sectionScope === 'runtime-host';
  useEffect(() => {
    props.onSelectedRuntimeHostProfileIdChange(
      showsRuntimeHost ? selectedProfileId : undefined,
    );
    return () => props.onSelectedRuntimeHostProfileIdChange(undefined);
  }, [props.onSelectedRuntimeHostProfileIdChange, selectedProfileId, showsRuntimeHost]);
  const sectionNeedsSettings = ['general', 'subagents', 'memory', 'search'].includes(section);
  const sectionNeedsConnections = ['general', 'models', 'subagents', 'daily-review'].includes(section);
  const runtimeHostAvailabilityStatus: RuntimeHostAvailabilityStatus =
    selectedRuntimeHost
      ? 'ready'
      : runtimeHostCatalogStatus.phase === 'error'
        ? 'error'
        : runtimeHostCatalogStatus.phase === 'idle' ||
            runtimeHostCatalogStatus.phase === 'loading' ||
            selectedRuntimeHostEntry?.readiness === 'connecting' ||
            selectedRuntimeHostEntry?.readiness === 'reconnecting'
          ? 'loading'
          : 'unavailable';
  const runtimeHostDataLoading =
    (sectionNeedsSettings && !selectedRuntimeHostSettingsStatus.hasSnapshot) ||
    (sectionNeedsConnections && !selectedRuntimeHostConnectionsStatus.hasSnapshot);
  const runtimeHostDataFailed =
    (sectionNeedsSettings && selectedRuntimeHostSettingsStatus.phase === 'error') ||
    (sectionNeedsConnections && selectedRuntimeHostConnectionsStatus.phase === 'error');
  const runtimeHostContentReady = Boolean(
    selectedRuntimeHost &&
    (!sectionNeedsSettings || selectedRuntimeHostSettings) &&
    (!sectionNeedsConnections || selectedConnections),
  );
  const runtimeHostContentStatus: 'loading' | 'ready' | 'unavailable' | 'error' =
    runtimeHostCatalogStatus.phase === 'error' || runtimeHostDataFailed
      ? 'error'
      : runtimeHostAvailabilityStatus !== 'ready'
        ? runtimeHostAvailabilityStatus
        : runtimeHostDataLoading || !runtimeHostContentReady
          ? 'loading'
          : 'ready';
  const runtimeHostContentVerified =
    runtimeHostCatalogStatus.isVerified &&
    (!sectionNeedsSettings || selectedRuntimeHostSettingsStatus.isVerified) &&
    (!sectionNeedsConnections || selectedRuntimeHostConnectionsStatus.isVerified);
  const runtimeHostTargetVerified = Boolean(
    selectedRuntimeHost && runtimeHostCatalogStatus.isVerified,
  );
  const runtimeHostTargetStatus: RuntimeHostAvailabilityStatus =
    runtimeHostCatalogStatus.phase === 'error'
      ? 'error'
      : !selectedRuntimeHost
        ? runtimeHostAvailabilityStatus
        : runtimeHostTargetVerified
          ? 'ready'
          : 'loading';
  const runtimeHostErrorMessage =
    runtimeHostCatalogStatus.message ??
    selectedRuntimeHostSettingsStatus.message ??
    selectedRuntimeHostConnectionsStatus.message;
  const loading =
    clientLoading ||
    (requiresRuntimeHost &&
      !runtimeHostContentReady &&
      runtimeHostContentStatus === 'loading');

  async function reloadRuntimeHostSettings(host = selectedRuntimeHost) {
    if (!host) return;
    const key = runtimeHostSettingsKey(host);
    const ticket = runtimeHostRequestAuthority.beginSettingsRead(key);
    if (!ticket) return;
    setRuntimeHostSettings((current) => beginSettingsResourceLoad(
      current,
      key,
      snapshotCache.readRuntimeHostSettings(key),
    ));
    try {
      const next = await window.maka.settings.get(host);
      if (
        settingsModalMountedRef.current &&
        runtimeHostRequestAuthority.acceptsSettingsRead(ticket)
      ) {
        snapshotCache.commitRuntimeHostSettingsRead(key, next);
        setRuntimeHostSettings(completeSettingsResourceLoad(key, next));
      }
    } catch (error) {
      if (
        settingsModalMountedRef.current &&
        runtimeHostRequestAuthority.acceptsSettingsRead(ticket)
      ) {
        const message = settingsActionErrorMessage(error, locale);
        setRuntimeHostSettings((current) => failSettingsResourceLoad(
          current,
          key,
          message,
          snapshotCache.readRuntimeHostSettings(key),
        ));
      }
    }
  }

  async function reloadClientSettings(): Promise<void> {
    const ticket = ++clientSettingsTicketRef.current;
    try {
      const next = await window.maka.settings.getClient();
      if (!settingsModalMountedRef.current || ticket !== clientSettingsTicketRef.current) return;
      snapshotCache.commitClientRead(next);
      setClientSettings(next);
    } finally {
      if (settingsModalMountedRef.current && ticket === clientSettingsTicketRef.current) {
        setClientLoading(false);
      }
    }
  }

  async function reloadConnections(
    bridge = connectionsBridge,
    host = selectedRuntimeHost,
  ): Promise<void> {
    if (!bridge || !host) return;
    const key = runtimeHostSettingsKey(host);
    const ticket = runtimeHostRequestAuthority.beginConnectionsRead(key);
    if (!ticket) return;
    setRuntimeHostConnections((current) => beginSettingsResourceLoad(
      current,
      key,
      snapshotCache.readRuntimeHostConnections(key),
    ));
    try {
      const snapshot = await bridge.getSnapshot();
      if (
        !settingsModalMountedRef.current ||
        !runtimeHostRequestAuthority.acceptsConnectionsRead(ticket)
      ) return;
      const next = {
        connections: snapshot.connections,
        defaultSlug: snapshot.defaultConnection,
      };
      snapshotCache.commitRuntimeHostConnectionsRead(key, next);
      setRuntimeHostConnections(completeSettingsResourceLoad(key, next));
    } catch (error) {
      if (
        settingsModalMountedRef.current &&
        runtimeHostRequestAuthority.acceptsConnectionsRead(ticket)
      ) {
        const message = settingsActionErrorMessage(error, locale);
        setRuntimeHostConnections((current) => failSettingsResourceLoad(
          current,
          key,
          message,
          snapshotCache.readRuntimeHostConnections(key),
        ));
      }
    }
  }

  async function updateSettings(patch: Parameters<typeof window.maka.settings.update>[0]) {
    const uiLocaleTicket = props.uiLocaleUpdateGate.begin(
      patch.personalization?.uiLocale !== undefined,
    );
    try {
      const updatesRuntimeHost = hasRuntimeHostSettingsPatch(patch);
      if (updatesRuntimeHost && !selectedRuntimeHost) {
        throw new Error(copy.runtimeHostUnavailable);
      }
      const host = updatesRuntimeHost ? selectedRuntimeHost : undefined;
      const hostKey = host ? runtimeHostSettingsKey(host) : undefined;
      const hostTicket = hostKey
        ? runtimeHostRequestAuthority.beginSettingsWrite(hostKey)
        : undefined;
      if (hostKey && !hostTicket) {
        throw new Error(copy.runtimeHostUnavailable);
      }
      const clientTicket = updatesRuntimeHost
        ? undefined
        : ++clientSettingsTicketRef.current;
      const result = host
        ? await window.maka.settings.update(patch, host)
        : await window.maka.settings.updateClient(patch);
      if (hostTicket && !runtimeHostRequestAuthority.isCurrentTarget(hostTicket)) {
        throw new Error(copy.runtimeHostUnavailable);
      }
      props.uiLocaleUpdateGate.commit(
        uiLocaleTicket,
        result.settings.personalization.uiLocale,
        props.onUiLocalePreferenceChange,
      );
      const acceptedHostUpdate = Boolean(
        hostTicket &&
        runtimeHostRequestAuthority.acceptsSettingsWrite(hostTicket),
      );
      if (acceptedHostUpdate && host?.profileId === defaultRuntimeHostProfileIdRef.current) {
        if (patch.chatDefaults?.permissionMode !== undefined) {
          props.onDefaultPermissionModeChange(result.settings.chatDefaults.permissionMode);
        }
        props.onUserLabelChange?.(result.settings.personalization.displayName);
      }
      if (!settingsModalMountedRef.current) {
        return result;
      }
      if (acceptedHostUpdate && hostKey) {
        setRuntimeHostSettings(completeSettingsResourceLoad(
          hostKey,
          result.settings as RuntimeHostAppSettings,
        ));
        void reloadRuntimeHostSettings(host);
      } else if (
        clientTicket !== undefined &&
        clientTicket === clientSettingsTicketRef.current
      ) {
        setClientSettings(result.settings);
        void reloadClientSettings();
      }
      return result;
    } catch (error) {
      props.uiLocaleUpdateGate.cancel(uiLocaleTicket);
      throw error;
    }
  }

  async function reloadUsage(range: UsageRange = settings.usage.range) {
    const host = selectedRuntimeHost;
    if (!host) {
      usageReloadTicketRef.current += 1;
      setUsageStats(null);
      return;
    }
    const hostKey = runtimeHostSettingsKey(host);
    const epoch = selectedRuntimeHostEpochRef.current;
    const ticket = usageReloadTicketRef.current + 1;
    usageReloadTicketRef.current = ticket;
    try {
      const next = await window.maka.settings.usageStats(range, host);
      if (
        settingsModalMountedRef.current &&
        ticket === usageReloadTicketRef.current &&
        selectedRuntimeHostKeyRef.current === hostKey &&
        selectedRuntimeHostEpochRef.current === epoch
      ) {
        setUsageStats({ hostKey, epoch, range, value: next });
      }
    } catch (error) {
      if (
        settingsModalMountedRef.current &&
        ticket === usageReloadTicketRef.current &&
        selectedRuntimeHostKeyRef.current === hostKey &&
        selectedRuntimeHostEpochRef.current === epoch
      ) {
        toast.error(copy.usageLoadFailed, settingsActionErrorMessage(error, locale));
      }
    }
  }

  async function reloadRuntimeHosts(): Promise<void> {
    const ticket = ++runtimeHostReloadTicketRef.current;
    setRuntimeHostCatalog((current) => beginSettingsResourceLoad(
      current,
      RUNTIME_HOST_CATALOG_KEY,
      snapshotCache.readRuntimeHostCatalog(),
    ));
    try {
      const next = await window.maka.runtimeHostProfiles.getSnapshot();
      if (!settingsModalMountedRef.current || ticket !== runtimeHostReloadTicketRef.current) {
        return;
      }
      // A catalog snapshot is the authority for Host identity. Invalidate any
      // reads started against the previous catalog before pruning its epochs;
      // otherwise a late response could repopulate a key that was just removed.
      runtimeHostRequestAuthority.invalidateReads();
      snapshotCache.commitRuntimeHostCatalogRead(next);
      defaultRuntimeHostProfileIdRef.current = next.defaultProfileId;
      setRuntimeHostCatalog(completeSettingsResourceLoad(RUNTIME_HOST_CATALOG_KEY, next));
      const preserveCurrentSelection =
        runtimeHostCatalogHydratedRef.current || selectedProfileChangedByUserRef.current;
      runtimeHostCatalogHydratedRef.current = true;
      const nextProfileId = reconcileRuntimeHostProfileSelection({
        currentProfileId: selectedProfileIdRef.current,
        defaultProfileId: next.defaultProfileId,
        enabledProfileIds: next.entries
          .filter((entry) => entry.enabled)
          .map((entry) => entry.profile.id),
        preserveCurrentSelection,
      });
      commitSelectedRuntimeHostProfile(nextProfileId, next);
    } catch (error) {
      if (settingsModalMountedRef.current && ticket === runtimeHostReloadTicketRef.current) {
        setRuntimeHostCatalog((current) => failSettingsResourceLoad(
          current,
          RUNTIME_HOST_CATALOG_KEY,
          settingsActionErrorMessage(error, locale),
          snapshotCache.readRuntimeHostCatalog(),
        ));
      }
      throw error;
    }
  }

  const handleRuntimeHostProfileChange = useEffectEvent(
    (event: DesktopRuntimeHostProfileChangedEvent) => {
      // Retain removed/unavailable events as tombstones until a newer event for
      // the profile arrives. Otherwise selecting that profile while the
      // catalog refresh is pending could revive its last-ready snapshot.
      const nextLifecycleByProfile = new Map(
        runtimeHostLifecycleByProfileRef.current,
      );
      nextLifecycleByProfile.set(event.profileId, event);
      runtimeHostLifecycleByProfileRef.current = nextLifecycleByProfile;
      setRuntimeHostLifecycleByProfile(nextLifecycleByProfile);
      if (selectedProfileIdRef.current === event.profileId) {
        const nextHost = readyRuntimeHost(runtimeHosts, event.profileId, event);
        const targetChanged = runtimeHostRequestAuthority.selectTarget(
          nextHost ? runtimeHostSettingsKey(nextHost) : undefined,
          event.epoch,
        );
        if (targetChanged) {
          // Fence synchronously, before the catalog refresh can resolve. The
          // previous generation's snapshots stay visible but no Host-backed
          // control may treat them as current write authority.
          usageReloadTicketRef.current += 1;
          setUsageStats(null);
          setRuntimeHostCatalog(invalidateSettingsResourceGeneration);
          setRuntimeHostSettings(invalidateSettingsResourceGeneration);
          setRuntimeHostConnections(invalidateSettingsResourceGeneration);
        }
      }
      void reloadRuntimeHosts().catch(() => undefined);
    },
  );

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.maka.runtimeHostProfiles.subscribeChanges(
      handleRuntimeHostProfileChange,
    );
    void reloadRuntimeHosts().catch((error) => {
      if (!disposed) {
        toast.error(copy.settingsLoadFailed, settingsActionErrorMessage(error, locale));
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [copy.settingsLoadFailed, locale, toast]);

  useEffect(() => {
    void reloadClientSettings().catch((error) => {
      if (!settingsModalMountedRef.current) return;
      setClientLoading(false);
      toast.error(copy.settingsLoadFailed, settingsActionErrorMessage(error, locale));
    });
    return window.maka.settings.subscribeClientChanged(() => {
      void reloadClientSettings().catch((error) => {
        if (settingsModalMountedRef.current) {
          toast.error(copy.settingsLoadFailed, settingsActionErrorMessage(error, locale));
        }
      });
    });
  }, [copy.settingsLoadFailed, locale, toast]);

  useEffect(() => {
    runtimeHostRequestAuthority.invalidateReads();
    if (!selectedRuntimeHost || !connectionsBridge) {
      setRuntimeHostSettings(createSettingsResourceState());
      setRuntimeHostConnections(createSettingsResourceState());
      return;
    }
    void Promise.all([
      reloadRuntimeHostSettings(selectedRuntimeHost),
      reloadConnections(connectionsBridge, selectedRuntimeHost),
    ]);
    const unsubscribeSettings = window.maka.settings.subscribeExternalChanged(
      () => void reloadRuntimeHostSettings(selectedRuntimeHost),
      selectedRuntimeHost,
    );
    const unsubscribeConnections = connectionsBridge.subscribeEvents?.(() => {
      void reloadConnections(connectionsBridge, selectedRuntimeHost);
    });
    return () => {
      unsubscribeSettings();
      unsubscribeConnections?.();
    };
  }, [connectionsBridge, selectedRuntimeHost]);

  useEffect(() => {
    // Usage records are Host-owned while the display preferences remain
    // client-owned. Refetch when the persisted range arrives, the selected Host
    // changes, or the selected Host is replaced in place (epoch bump) so labels
    // and numbers always describe one live Host generation.
    if (section === 'usage') void reloadUsage(settings.usage.range);
  }, [section, settings.usage.range, selectedRuntimeHostKey, selectedRuntimeHostEpoch]);

  // PR-SETTINGS-HEADER-COPY-MAP-0 (U1): the page header derives its title
  // and description from the section→copy map keyed by the active section,
  // never from a `nav[0]` fallback. A section that is routable but missing
  // from the nav copy is a type error at the `Record<SettingsSection>`
  // boundary — so an unrouted section fails loudly at build time instead of
  // silently rendering 通用 copy over a different page's body. The nav
  // highlight below still keys off `section === item.id` independently.
  const headerCopy = getSettingsNavigationCopy(locale).sections[section];
  const runtimeHostOptions = (runtimeHosts?.entries ?? [])
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      value: entry.profile.id,
      label: entry.profile.name,
      disabled: entry.readiness !== 'ready' || !entry.hostId,
    }));

  async function retryRuntimeHostContent(): Promise<void> {
    let diagnosticTarget: { profileId: string } | undefined;
    try {
      if (runtimeHostCatalogStatus.phase === 'error') {
        await reloadRuntimeHosts();
        return;
      }
      if (!selectedRuntimeHost || !connectionsBridge) return;
      diagnosticTarget = { profileId: selectedRuntimeHost.profileId };
      await Promise.all([
        reloadRuntimeHostSettings(selectedRuntimeHost),
        reloadConnections(connectionsBridge, selectedRuntimeHost),
      ]);
    } catch (error) {
      if (settingsModalMountedRef.current) {
        toast.error(
          copy.settingsLoadFailed,
          settingsActionErrorMessage(error, locale),
          undefined,
          diagnosticTarget,
        );
      }
    }
  }

  return (
    <div className="settingsSurface" data-modal="true">
      <Layout
        height="fill"
        padding={0}
        start={(
          <LayoutPanel
            width={isNarrowSettings ? 48 : 260}
            padding={0}
            isScrollable={false}
          >
            <SideNav
              className="settingsSidebar"
              collapsible={{ isCollapsed: isNarrowSettings, hasButton: false }}
              data-maka-contract="settings-sidebar"
              data-settings-nav-column
              aria-label={copy.navigationLabel}
              topContent={(
                isNarrowSettings
                  ? <IconButton
                      variant="ghost"
                      label={copy.backToApp}
                      tooltip={copy.backToApp}
                      icon={<ArrowLeft size={ICON_SIZE.chrome} aria-hidden="true" />}
                      onClick={props.onClose}
                    />
                  : <Button
                      className="settingsBackButton"
                      variant="ghost"
                      width="100%"
                      label={copy.backToApp}
                      icon={<ArrowLeft size={ICON_SIZE.chrome} aria-hidden="true" />}
                      onClick={props.onClose}
                    />
              )}
            >
              {localizedNav.map(({ group, label, items }) => (
                <SideNavSection key={group} title={label}>
                  {items.map((item) => (
                    <SideNavItem
                      key={item.id}
                      label={item.label}
                      icon={<item.Icon size={ICON_SIZE.chrome} aria-hidden="true" />}
                      isSelected={section === item.id}
                      isDisabled={!item.enabled}
                      ref={section === item.id
                        ? (element) => {
                            props.initialFocusRef.current = element instanceof HTMLButtonElement
                              ? element
                              : null;
                          }
                        : undefined}
                      endContent={item.badge ? <Badge variant="neutral" label={item.badge} /> : undefined}
                      onClick={() => setSection(item.id)}
                    />
                  ))}
                </SideNavSection>
              ))}
            </SideNav>
          </LayoutPanel>
        )}
        content={(
          <section
            className="settingsMainPane"
            data-agents-view="settings"
            role="main"
            aria-label={copy.contentLabel}
          >
            <Layout
              /* The rounded main pane owns page scrolling. Keeping scroll on
                 the centered LayoutContent made the wide gutters inert and
                 parked the scrollbar beside the 920px content column. */
              height="auto"
              padding={0}
              /* One column width for EVERY section. Usage used to get 920
                 while the rest sat in a 640 column, so switching pages
                 visibly shifted the left edge — the title jumped ~120px
                 between 使用统计 and any other page. A settings surface is
                 one place; its margins must not depend on which page is
                 open. */
              contentWidth={920}
              header={(
                <LayoutHeader padding={6}>
                  <div className="settingsPageHeader">
                    <div className="settingsPageHeaderTitleStack">
                      <h2>{headerCopy.label}</h2>
                      {headerCopy.description && (
                        <p className="settingsPageHeaderDescription">{headerCopy.description}</p>
                      )}
                    </div>
                    {showsRuntimeHost && runtimeHostOptions.length > 1 ? (
                      <div className="settingsRuntimeHostSelector">
                        <Selector
                          label={copy.runtimeHost}
                          isLabelHidden
                          value={selectedProfileId ?? runtimeHosts?.defaultProfileId ?? 'local'}
                          options={runtimeHostOptions}
                          isDisabled={!runtimeHosts}
                          width={220}
                          onChange={(profileId) => {
                            selectedProfileChangedByUserRef.current = true;
                            commitSelectedRuntimeHostProfile(profileId);
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                </LayoutHeader>
              )}
              content={(
                <LayoutContent padding={6} isScrollable={false}>
                  {loading ? (
                    <SettingsSkeleton />
                  ) : requiresRuntimeHost &&
                    !runtimeHostContentReady &&
                    runtimeHostContentStatus === 'error' ? (
                    <Banner
                      status="error"
                      title={copy.settingsLoadFailed}
                      description={runtimeHostErrorMessage}
                      endContent={(
                        <Button
                          variant="secondary"
                          size="sm"
                          label={copy.retry}
                          onClick={() => void retryRuntimeHostContent()}
                        />
                      )}
                    />
                  ) : requiresRuntimeHost && !runtimeHostContentReady ? (
                    <Banner status="warning" title={copy.runtimeHostUnavailable} />
                  ) : (
                    <>
                      {requiresRuntimeHost && runtimeHostContentStatus === 'error' ? (
                        <Banner
                          status="error"
                          title={copy.settingsLoadFailed}
                          description={runtimeHostErrorMessage}
                          endContent={(
                            <Button
                              variant="secondary"
                              size="sm"
                              label={copy.retry}
                              onClick={() => void retryRuntimeHostContent()}
                            />
                          )}
                        />
                      ) : null}
                      <RuntimeHostSettingsTarget
                        key={selectedRuntimeHost
                          ? `${selectedRuntimeHost.profileId}:${selectedRuntimeHost.hostId}`
                          : 'client'}
                        host={selectedRuntimeHost}
                        generation={selectedProfileId
                          ? runtimeHostLifecycleByProfile.get(selectedProfileId)?.epoch
                          : undefined}
                      >
                        <RuntimeHostInteractionBoundary
                          isInteractive={!requiresRuntimeHost || runtimeHostContentVerified}
                        >
                          <SettingsPageBody
                            section={section}
                            settings={settings}
                            usageStats={
                              usageStats &&
                              usageStats.hostKey === selectedRuntimeHostKey &&
                              usageStats.epoch === selectedRuntimeHostEpoch &&
                              usageStats.range === settings.usage.range
                                ? usageStats.value
                                : null
                            }
                            connections={connections}
                            connectionsBridge={connectionsBridge}
                            apiKeyOnboardingBridge={apiKeyOnboardingBridge}
                            defaultSlug={defaultSlug}
                            runtimeHost={selectedRuntimeHost}
                            runtimeHostAvailabilityStatus={runtimeHostAvailabilityStatus}
                            runtimeHostCatalogStatus={runtimeHostCatalogStatus}
                            runtimeHostSettingsStatus={selectedRuntimeHostSettingsStatus}
                            runtimeHostConnectionsStatus={selectedRuntimeHostConnectionsStatus}
                            runtimeHostTargetVerified={runtimeHostTargetVerified}
                            runtimeHostTargetStatus={runtimeHostTargetStatus}
                            runtimeHostErrorMessage={runtimeHostErrorMessage}
                            themePref={props.themePref}
                            themePalette={props.themePalette}
                            onRefreshConnections={reloadConnections}
                            onUpdateSettings={updateSettings}
                            onReloadSettings={reloadRuntimeHostSettings}
                            onReloadClientSettings={reloadClientSettings}
                            onRetryRuntimeHost={retryRuntimeHostContent}
                            onReloadUsage={reloadUsage}
                            onThemeChange={props.onThemeChange}
                            onThemePaletteChange={props.onThemePaletteChange}
                            onOpenDailyReview={props.onOpenDailyReview}
                            onOpenKeyboardHelp={props.onOpenKeyboardHelp}
                            onOpenSession={props.onOpenSession}
                            archivedTasks={props.archivedTasks}
                            onTaskImported={props.onTaskImported}
                            onRemoteHostAdded={props.onRemoteHostAdded}
                            openProviderCatalog={providerCatalogRequested}
                            initialConnectionSlug={props.initialConnectionSlug}
                            initialCreateProviderType={createProviderRequest}
                            onInitialCreateProviderConsumed={() => {
                              setCreateProviderRequest(undefined);
                            }}
                            onInitialProviderCatalogConsumed={() => {
                              setProviderCatalogRequested(false);
                            }}
                          />
                        </RuntimeHostInteractionBoundary>
                      </RuntimeHostSettingsTarget>
                    </>
                  )}
                </LayoutContent>
              )}
            />
          </section>
        )}
      />
    </div>
  );
}

function SettingsPageBody(props: {
  section: SettingsSection;
  settings: AppSettings;
  usageStats: UsageStats | null;
  connections: ProjectedLlmConnection[];
  connectionsBridge: RuntimeHostSettingsConnectionsBridge | undefined;
  apiKeyOnboardingBridge:
    | ReturnType<ConnectionSettingsServices['forHost']>['apiKeyOnboarding']
    | undefined;
  defaultSlug: string | null;
  runtimeHost: DesktopRuntimeHostRef | undefined;
  runtimeHostAvailabilityStatus: RuntimeHostAvailabilityStatus;
  runtimeHostCatalogStatus: SettingsResourceStatus;
  runtimeHostSettingsStatus: SettingsResourceStatus;
  runtimeHostConnectionsStatus: SettingsResourceStatus;
  runtimeHostTargetVerified: boolean;
  runtimeHostTargetStatus: RuntimeHostAvailabilityStatus;
  runtimeHostErrorMessage?: string;
  themePref: ThemePreference;
  themePalette: ThemePalette;
  onRefreshConnections(): Promise<void>;
  onUpdateSettings(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
  onReloadClientSettings(): Promise<void>;
  onRetryRuntimeHost(): Promise<void>;
  onReloadUsage(range?: UsageRange): Promise<void>;
  onThemeChange(pref: ThemePreference): void;
  onThemePaletteChange(palette: ThemePalette): void;
  onOpenDailyReview?(): void;
  onOpenKeyboardHelp?(): void;
  onOpenSession?(sessionId: string): void;
  archivedTasks: ArchivedTasksBridge;
  onTaskImported(session: DesktopSessionSummary): void;
  onRemoteHostAdded(profileId: string): void;
  openProviderCatalog?: boolean;
  initialConnectionSlug?: string;
  initialCreateProviderType?: ProviderType;
  onInitialCreateProviderConsumed?(): void;
  onInitialProviderCatalogConsumed?(): void;
}) {
  const locale = useUiLocale();
  const copy = getSettingsSharedCopy(locale);
  // PR-FE-BUG-HUNT-0 (kenji bug-hunt 2026-06-24): the inline `void
  // props.onUpdateSettings(...)` at the privacy toggle below
  // discarded rejection promises, so an IPC failure became an
  // Unhandled Promise Rejection at the renderer level with no user
  // feedback. Toast surface mirrors the rest of the file's catch
  // pattern (PR-STOP-ERROR-SURFACE-0 / PR-BOT-RESTART-RACE-0).
    switch (props.section) {
    case 'models':
      if (!props.connectionsBridge) return null;
      return (
        <SettingsPage className="settingsModelsPage">
          <ProvidersPanel
            bridge={props.connectionsBridge}
            apiKeyOnboardingBridge={props.apiKeyOnboardingBridge}
            initialPage={props.openProviderCatalog ? 'catalog' : 'connections'}
            initialConnectionSlug={props.initialConnectionSlug}
            initialCreateProviderType={props.initialCreateProviderType}
            onInitialCreateProviderConsumed={props.onInitialCreateProviderConsumed}
            onInitialCatalogConsumed={props.onInitialProviderCatalogConsumed}
          />
        </SettingsPage>
      );
    case 'subagents':
      return (
        <SubagentSettingsPage
          settings={props.settings}
          connections={props.connections}
          onUpdate={props.onUpdateSettings}
        />
      );
    case 'usage':
      return (
        <UsageSettingsPage
          settings={props.settings}
          stats={props.usageStats}
          onUpdate={props.onUpdateSettings}
          onReload={props.onReloadUsage}
          onOpenSession={props.onOpenSession}
        />
      );
    case 'bot-chat':
      return (
        <BotChatSettingsPage
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
          onReload={props.onReloadClientSettings}
        />
      );
    case 'about':
      return <AboutSettingsPage onOpenKeyboardHelp={props.onOpenKeyboardHelp} />;
    case 'general':
      return (
        <GeneralSettingsPage
          settings={props.settings}
          connections={props.connections}
          defaultSlug={props.defaultSlug}
          connectionsBridge={props.connectionsBridge}
          runtimeHostAvailabilityStatus={props.runtimeHostAvailabilityStatus}
          runtimeHostCatalogStatus={props.runtimeHostCatalogStatus}
          runtimeHostSettingsStatus={props.runtimeHostSettingsStatus}
          runtimeHostConnectionsStatus={props.runtimeHostConnectionsStatus}
          runtimeHostErrorMessage={props.runtimeHostErrorMessage}
          testNetworkProxy={props.runtimeHost
            ? (input) => window.maka.settings.testNetworkProxy(input, props.runtimeHost)
            : undefined}
          onUpdate={props.onUpdateSettings}
          onRefreshConnections={props.onRefreshConnections}
          onRetryRuntimeHost={props.onRetryRuntimeHost}
        />
      );
    case 'projects':
      return (
        <ProjectsSettingsPage
          settings={props.settings}
          runtimeHostStatus={props.runtimeHostTargetStatus}
          runtimeHostTargetVerified={props.runtimeHostTargetVerified}
          runtimeHostErrorMessage={props.runtimeHostErrorMessage}
          onUpdate={props.onUpdateSettings}
          onRetryRuntimeHost={props.onRetryRuntimeHost}
          onRemoteHostAdded={props.onRemoteHostAdded}
        />
      );
    case 'appearance':
      return (
        <AppearanceSettingsPage
          themePref={props.themePref}
          themePalette={props.themePalette}
          appIcon={props.settings.appearance.appIcon ?? DEFAULT_APP_ICON}
          appIconDark={props.settings.appearance.appIconDark}
          onUpdate={props.onUpdateSettings}
          onThemeChange={props.onThemeChange}
          onThemePaletteChange={props.onThemePaletteChange}
        />
      );
    case 'archived-tasks':
      return <TasksSettingsPage {...props.archivedTasks} />;
    case 'import-tasks':
      return (
        <ImportTasksSettingsPage
          onImported={props.onTaskImported}
          onOpenImported={props.onOpenSession}
        />
      );
    case 'data':
      return (
        <DataSettingsPage
          runtimeHostStatus={props.runtimeHostTargetStatus}
          runtimeHostTargetVerified={props.runtimeHostTargetVerified}
          runtimeHostErrorMessage={props.runtimeHostErrorMessage}
          onRetryRuntimeHost={props.onRetryRuntimeHost}
        />
      );
    case 'permissions':
      return <PermissionCenterPage />;
    case 'health':
      return <HealthCenterPage />;
    case 'memory':
      // PR-SETTINGS-REVIEW-0 (WAWQAQ msg `886f6406`): the merged
      // memory-review page was too dense; 记忆 is its own page again.
      return (
        <MemorySettingsPage
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
          onReloadSettings={props.onReloadSettings}
        />
      );
    case 'daily-review':
      return <DailyReviewSettingsPage connections={props.connections} />;
    case 'search':
      return (
        <WebSearchSettingsPage
          settings={props.settings}
          onUpdate={props.onUpdateSettings}
        />
      );
    default:
      return (
        <div className="settingsRows">
          <SettingRow title={navLabel(props.section, locale)} detail={copy.unavailablePage} value={copy.ready} />
        </div>
      );
  }
}
