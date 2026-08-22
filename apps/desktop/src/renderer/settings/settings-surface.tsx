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

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
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
  ChatDefaultPermissionMode,
  SettingsSection,
  ThemePalette,
  ThemePreference,
  UpdateAppSettingsResult,
  UsageRange,
  UsageStats,
} from '@maka/core/settings';
import type { LlmConnection, ProviderType } from '@maka/core/llm-connections';
import type {
  DesktopRuntimeHostProfileSnapshot,
  DesktopRuntimeHostRef,
  DesktopSessionSummary,
} from '../../preload/bridge-contract.js';
import type { UiLocalePreference } from '@maka/core/ui-locale';
import { createDefaultSettings } from '@maka/core/settings';
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
  runtimeHostConnectionsBridge,
  type RuntimeHostSettingsConnectionsBridge,
} from './runtime-host-settings-bridge.js';
import {
  hasRuntimeHostSettingsPatch,
  projectClientOwnedSettings,
} from '../../shared/settings-ownership.js';
import { RuntimeHostSettingsTarget } from './runtime-host-settings-target.js';

const NARROW_SETTINGS_QUERY = '(max-width: 760px)';

type ResourceState<T> =
  | { status: 'idle' }
  | { status: 'loading'; key: string }
  | { status: 'ready'; key: string; value: T }
  | { status: 'error'; key: string; message: string };

type RuntimeHostCatalogState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: DesktopRuntimeHostProfileSnapshot }
  | { status: 'error'; message: string };

function beginResourceLoad<T>(current: ResourceState<T>, key: string): ResourceState<T> {
  return current.status === 'ready' && current.key === key
    ? current
    : { status: 'loading', key };
}

function failResourceLoad<T>(
  current: ResourceState<T>,
  key: string,
  message: string,
): ResourceState<T> {
  return current.status === 'ready' && current.key === key
    ? current
    : { status: 'error', key, message };
}

function runtimeHostKey(host: DesktopRuntimeHostRef): string {
  return `${host.profileId}:${host.hostId}`;
}

export function SettingsSurface(props: {
  onClose(): void;
  themePref: ThemePreference;
  onThemeChange(pref: ThemePreference): void;
  themePalette: ThemePalette;
  onThemePaletteChange(palette: ThemePalette): void;
  onUiLocalePreferenceChange(preference: UiLocalePreference): void;
  uiLocaleUpdateGate: UiLocaleUpdateGate;
  onUserLabelChange?(label: string): void;
  onDefaultPermissionModeChange(mode: ChatDefaultPermissionMode): void;
  requestedSection?: SettingsSection;
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
}) {
  const locale = useUiLocale();
  const copy = getSettingsSharedCopy(locale);
  const localizedNav = groupedNav(locale);
  const isNarrowSettings = useMediaQuery(NARROW_SETTINGS_QUERY);
  const [section, setSection] = useState<SettingsSection>(() => props.requestedSection ?? readLastSettingsSection());
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

  // When the parent updates requestedSection (e.g. the palette opens
  // Settings with a different section while it's already mounted), reflect
  // that into the local state.
  useEffect(() => {
    if (props.requestedSection && props.requestedSection !== section) {
      setSection(props.requestedSection);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.requestedSection]);

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
  const [clientSettings, setClientSettings] = useState(defaultSettings);
  const [runtimeHostSettings, setRuntimeHostSettings] = useState<ResourceState<AppSettings>>({
    status: 'idle',
  });
  const [runtimeHostConnections, setRuntimeHostConnections] = useState<
    ResourceState<{ connections: LlmConnection[]; defaultSlug: string | null }>
  >({ status: 'idle' });
  const [runtimeHostCatalog, setRuntimeHostCatalog] = useState<RuntimeHostCatalogState>({
    status: 'loading',
  });
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [clientLoading, setClientLoading] = useState(true);
  const settingsModalMountedRef = useMountedRef();
  const clientSettingsTicketRef = useRef(0);
  const runtimeHostSettingsTicketRef = useRef(0);
  const runtimeHostConnectionsTicketRef = useRef(0);
  const usageReloadTicketRef = useRef(0);
  const runtimeHostReloadTicketRef = useRef(0);
  const toast = useToast();

  const runtimeHosts = runtimeHostCatalog.status === 'ready'
    ? runtimeHostCatalog.snapshot
    : undefined;

  const selectedRuntimeHostEntry = runtimeHosts?.entries.find(
    (entry) => entry.profile.id === selectedProfileId,
  );
  const selectedRuntimeHost = useMemo<DesktopRuntimeHostRef | undefined>(() => {
    if (
      selectedRuntimeHostEntry?.readiness !== 'ready' ||
      !selectedRuntimeHostEntry.hostId
    ) return undefined;
    return {
      profileId: selectedRuntimeHostEntry.profile.id,
      hostId: selectedRuntimeHostEntry.hostId,
    };
  }, [
    selectedRuntimeHostEntry?.hostId,
    selectedRuntimeHostEntry?.profile.id,
    selectedRuntimeHostEntry?.readiness,
  ]);
  const connectionsBridge = useMemo(
    () => selectedRuntimeHost
      ? runtimeHostConnectionsBridge(selectedRuntimeHost)
      : undefined,
    [selectedRuntimeHost],
  );
  const selectedRuntimeHostKey = selectedRuntimeHost
    ? runtimeHostKey(selectedRuntimeHost)
    : undefined;
  const selectedRuntimeHostKeyRef = useRef(selectedRuntimeHostKey);
  selectedRuntimeHostKeyRef.current = selectedRuntimeHostKey;
  const selectedRuntimeHostSettings =
    selectedRuntimeHostKey &&
    runtimeHostSettings.status === 'ready' &&
    runtimeHostSettings.key === selectedRuntimeHostKey
      ? runtimeHostSettings.value
      : undefined;
  const selectedConnections =
    selectedRuntimeHostKey &&
    runtimeHostConnections.status === 'ready' &&
    runtimeHostConnections.key === selectedRuntimeHostKey
      ? runtimeHostConnections.value
      : undefined;
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
  const runtimeHostCatalogFailed = runtimeHostCatalog.status === 'error';
  const runtimeHostSettingsLoading = Boolean(
    selectedRuntimeHostKey &&
    !(
      (runtimeHostSettings.status === 'ready' || runtimeHostSettings.status === 'error') &&
      runtimeHostSettings.key === selectedRuntimeHostKey
    ),
  );
  const runtimeHostConnectionsLoading = Boolean(
    selectedRuntimeHostKey &&
    !(
      (runtimeHostConnections.status === 'ready' ||
        runtimeHostConnections.status === 'error') &&
      runtimeHostConnections.key === selectedRuntimeHostKey
    ),
  );
  const sectionNeedsSettings = ['general', 'subagents', 'memory', 'search'].includes(section);
  const sectionNeedsConnections = ['general', 'subagents', 'daily-review'].includes(section);
  const runtimeHostDataLoading =
    (sectionNeedsSettings && runtimeHostSettingsLoading) ||
    (sectionNeedsConnections && runtimeHostConnectionsLoading);
  const runtimeHostDataFailed = Boolean(
    selectedRuntimeHostKey &&
    ((sectionNeedsSettings &&
      runtimeHostSettings.status === 'error' &&
      runtimeHostSettings.key === selectedRuntimeHostKey) ||
      (sectionNeedsConnections &&
        runtimeHostConnections.status === 'error' &&
        runtimeHostConnections.key === selectedRuntimeHostKey)),
  );
  const runtimeHostContentReady = Boolean(
    selectedRuntimeHost &&
    (!sectionNeedsSettings || selectedRuntimeHostSettings) &&
    (!sectionNeedsConnections || selectedConnections),
  );
  const runtimeHostContentStatus: 'loading' | 'ready' | 'unavailable' | 'error' =
    runtimeHostCatalog.status === 'loading'
      ? 'loading'
      : runtimeHostCatalogFailed || runtimeHostDataFailed
      ? 'error'
      : !selectedRuntimeHost
        ? selectedRuntimeHostEntry?.readiness === 'connecting' ||
          selectedRuntimeHostEntry?.readiness === 'reconnecting'
          ? 'loading'
          : 'unavailable'
        : runtimeHostDataLoading || !runtimeHostContentReady
          ? 'loading'
          : 'ready';
  const loading =
    clientLoading ||
    (requiresRuntimeHost && runtimeHostContentStatus === 'loading');

  useEffect(() => {
    if (!loading && section === 'models' && providerCatalogRequested) {
      setProviderCatalogRequested(false);
    }
  }, [loading, providerCatalogRequested, section]);

  async function reloadRuntimeHostSettings(host = selectedRuntimeHost) {
    if (!host) return;
    const key = runtimeHostKey(host);
    const ticket = ++runtimeHostSettingsTicketRef.current;
    setRuntimeHostSettings((current) => beginResourceLoad(current, key));
    try {
      const next = await window.maka.settings.get(host);
      if (
        settingsModalMountedRef.current &&
        ticket === runtimeHostSettingsTicketRef.current &&
        selectedRuntimeHostKeyRef.current === key
      ) {
        setRuntimeHostSettings({ status: 'ready', key, value: next });
      }
    } catch (error) {
      if (
        settingsModalMountedRef.current &&
        ticket === runtimeHostSettingsTicketRef.current &&
        selectedRuntimeHostKeyRef.current === key
      ) {
        const message = settingsActionErrorMessage(error, locale);
        setRuntimeHostSettings((current) => failResourceLoad(current, key, message));
      }
    }
  }

  async function reloadClientSettings(): Promise<void> {
    const ticket = ++clientSettingsTicketRef.current;
    try {
      const next = await window.maka.settings.getClient();
      if (!settingsModalMountedRef.current || ticket !== clientSettingsTicketRef.current) return;
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
    const key = runtimeHostKey(host);
    const ticket = ++runtimeHostConnectionsTicketRef.current;
    setRuntimeHostConnections((current) => beginResourceLoad(current, key));
    try {
      const snapshot = await bridge.getSnapshot();
      if (
        !settingsModalMountedRef.current ||
        ticket !== runtimeHostConnectionsTicketRef.current ||
        selectedRuntimeHostKeyRef.current !== key
      ) return;
      setRuntimeHostConnections({
        status: 'ready',
        key,
        value: {
          connections: snapshot.connections,
          defaultSlug: snapshot.defaultConnection,
        },
      });
    } catch (error) {
      if (
        settingsModalMountedRef.current &&
        ticket === runtimeHostConnectionsTicketRef.current &&
        selectedRuntimeHostKeyRef.current === key
      ) {
        const message = settingsActionErrorMessage(error, locale);
        setRuntimeHostConnections((current) => failResourceLoad(current, key, message));
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
      const hostKey = host ? runtimeHostKey(host) : undefined;
      const hostTicket = host
        ? ++runtimeHostSettingsTicketRef.current
        : undefined;
      const clientTicket = updatesRuntimeHost
        ? undefined
        : ++clientSettingsTicketRef.current;
      const result = host
        ? await window.maka.settings.update(patch, host)
        : await window.maka.settings.updateClient(patch);
      props.uiLocaleUpdateGate.commit(
        uiLocaleTicket,
        result.settings.personalization.uiLocale,
        props.onUiLocalePreferenceChange,
      );
      const acceptedHostUpdate = Boolean(
        hostKey &&
        hostTicket === runtimeHostSettingsTicketRef.current &&
        selectedRuntimeHostKeyRef.current === hostKey,
      );
      if (acceptedHostUpdate && selectedProfileId === runtimeHosts?.defaultProfileId) {
        if (patch.chatDefaults?.permissionMode !== undefined) {
          props.onDefaultPermissionModeChange(result.settings.chatDefaults.permissionMode);
        }
        props.onUserLabelChange?.(result.settings.personalization.displayName);
      }
      if (!settingsModalMountedRef.current) {
        return result;
      }
      if (acceptedHostUpdate && hostKey) {
        setRuntimeHostSettings({ status: 'ready', key: hostKey, value: result.settings });
      } else if (
        clientTicket !== undefined &&
        clientTicket === clientSettingsTicketRef.current
      ) {
        setClientSettings(result.settings);
      }
      return result;
    } catch (error) {
      props.uiLocaleUpdateGate.cancel(uiLocaleTicket);
      throw error;
    }
  }

  async function reloadUsage(range: UsageRange = settings.usage.range) {
    const ticket = usageReloadTicketRef.current + 1;
    usageReloadTicketRef.current = ticket;
    try {
      const next = await window.maka.settings.usageStats(range);
      if (settingsModalMountedRef.current && ticket === usageReloadTicketRef.current) {
        setUsageStats(next);
      }
    } catch (error) {
      if (settingsModalMountedRef.current && ticket === usageReloadTicketRef.current) {
        toast.error(copy.usageLoadFailed, settingsActionErrorMessage(error, locale));
      }
    }
  }

  async function reloadRuntimeHosts(): Promise<void> {
    const ticket = ++runtimeHostReloadTicketRef.current;
    setRuntimeHostCatalog((current) =>
      current.status === 'ready' ? current : { status: 'loading' });
    try {
      const next = await window.maka.runtimeHostProfiles.getSnapshot();
      if (!settingsModalMountedRef.current || ticket !== runtimeHostReloadTicketRef.current) {
        return;
      }
      setRuntimeHostCatalog({ status: 'ready', snapshot: next });
      setSelectedProfileId((current) => {
        if (
          current &&
          next.entries.some((entry) => entry.profile.id === current && entry.enabled)
        ) {
          return current;
        }
        return next.defaultProfileId;
      });
    } catch (error) {
      if (settingsModalMountedRef.current && ticket === runtimeHostReloadTicketRef.current) {
        setRuntimeHostCatalog((current) =>
          current.status === 'ready'
            ? current
            : {
                status: 'error',
                message: settingsActionErrorMessage(error, locale),
              });
      }
      throw error;
    }
  }

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.maka.runtimeHostProfiles.subscribeChanges(() => {
      void reloadRuntimeHosts().catch(() => undefined);
    });
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
    runtimeHostSettingsTicketRef.current += 1;
    runtimeHostConnectionsTicketRef.current += 1;
    if (!selectedRuntimeHost || !connectionsBridge) {
      setRuntimeHostSettings({ status: 'idle' });
      setRuntimeHostConnections({ status: 'idle' });
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
    // Keyed on the EFFECTIVE range, not just the section: usage is
    // client-owned (settings-ownership.ts), and the persisted range rides
    // in with the async getClient() load — which lands after this effect
    // first fires when a Settings window is restored directly onto
    // 使用统计. The initial fetch then used the '24h' default while the
    // chip showed the persisted range, and nothing refetched — every
    // metric read 0 until a manual refresh or a tab round-trip. With the
    // range in the deps, the truth's arrival (or any later range change,
    // including the page's own persisted range clicks) is the trigger, and
    // this effect is the single owner of range-driven fetches.
    if (section === 'usage') void reloadUsage(settings.usage.range);
  }, [section, settings.usage.range]);

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
      if (runtimeHostCatalog.status === 'error') {
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
                    {showsRuntimeHost && runtimeHostOptions.length > 0 ? (
                      <div className="settingsRuntimeHostSelector">
                        <Selector
                          label={copy.runtimeHost}
                          isLabelHidden
                          value={selectedProfileId ?? runtimeHosts?.defaultProfileId ?? 'local'}
                          options={runtimeHostOptions}
                          isDisabled={!runtimeHosts}
                          width={220}
                          onChange={setSelectedProfileId}
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
                  ) : requiresRuntimeHost && runtimeHostContentStatus === 'error' ? (
                    <Banner
                      status="error"
                      title={copy.settingsLoadFailed}
                      description={
                        runtimeHostCatalog.status === 'error'
                          ? runtimeHostCatalog.message
                          : runtimeHostSettings.status === 'error'
                            ? runtimeHostSettings.message
                            : runtimeHostConnections.status === 'error'
                              ? runtimeHostConnections.message
                              : undefined
                      }
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
                    <RuntimeHostSettingsTarget
                      key={selectedRuntimeHost
                        ? `${selectedRuntimeHost.profileId}:${selectedRuntimeHost.hostId}`
                        : 'client'}
                      host={selectedRuntimeHost}
                    >
                      <SettingsPageBody
                        section={section}
                        settings={settings}
                        usageStats={usageStats}
                        connections={connections}
                        connectionsBridge={connectionsBridge}
                        defaultSlug={defaultSlug}
                        runtimeHost={selectedRuntimeHost}
                        runtimeHostStatus={runtimeHostContentStatus}
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
                        onInitialCreateProviderConsumed={() => setCreateProviderRequest(undefined)}
                      />
                    </RuntimeHostSettingsTarget>
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
  connections: LlmConnection[];
  connectionsBridge: RuntimeHostSettingsConnectionsBridge | undefined;
  defaultSlug: string | null;
  runtimeHost: DesktopRuntimeHostRef | undefined;
  runtimeHostStatus: 'loading' | 'ready' | 'unavailable' | 'error';
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
            initialPage={props.openProviderCatalog ? 'catalog' : 'connections'}
            initialConnectionSlug={props.initialConnectionSlug}
            initialCreateProviderType={props.initialCreateProviderType}
            onInitialCreateProviderConsumed={props.onInitialCreateProviderConsumed}
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
          runtimeHostStatus={props.runtimeHostStatus}
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
          runtimeHostStatus={props.runtimeHostStatus}
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
          runtimeHostStatus={props.runtimeHostStatus}
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
