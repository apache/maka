import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  Badge,
  Button,
  Card,
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
import type { UiLocalePreference } from '@maka/core/ui-locale';
import { createDefaultSettings } from '@maka/core/settings';
import { useMountedRef, useToast, useUiLocale } from '@maka/ui';
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
import { SETTINGS_NAV, groupedNav, navLabel, readLastSettingsSection } from './settings-nav';
import { getSettingsNavigationCopy } from '../locales/settings-navigation-copy.js';
import { SettingRow } from './settings-rows';
import { SettingsPage } from './settings-section';
import { settingsActionErrorMessage } from './settings-error-copy';
import { UsageSettingsPage } from './usage-settings-page';
import { WebSearchSettingsPage } from './web-search-settings-page';
import type { UiLocaleUpdateGate } from './ui-locale-update-gate';
import { getSettingsSharedCopy } from '../locales/settings-shared-copy.js';

const NARROW_SETTINGS_QUERY = '(max-width: 760px)';

export function SettingsSurface(props: {
  connections: LlmConnection[];
  defaultSlug: string | null;
  onRefresh(): Promise<void>;
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
  const [settings, setSettings] = useState<AppSettings>(() => createDefaultSettings());
  const [usageStats, setUsageStats] = useState<UsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const settingsModalMountedRef = useMountedRef();
  const settingsReloadTicketRef = useRef(0);
  const settingsUpdateTicketRef = useRef(0);
  const usageReloadTicketRef = useRef(0);
  const toast = useToast();

  useEffect(() => {
    if (!loading && section === 'models' && providerCatalogRequested) {
      setProviderCatalogRequested(false);
    }
  }, [loading, providerCatalogRequested, section]);

  useEffect(() => {
    return () => {
      settingsReloadTicketRef.current += 1;
      settingsUpdateTicketRef.current += 1;
      usageReloadTicketRef.current += 1;
    };
  }, []);

  async function reloadSettings() {
    const ticket = settingsReloadTicketRef.current + 1;
    settingsReloadTicketRef.current = ticket;
    try {
      const next = await window.maka.settings.get();
      if (settingsModalMountedRef.current && ticket === settingsReloadTicketRef.current) {
        setSettings(next);
      }
    } catch (error) {
      if (settingsModalMountedRef.current && ticket === settingsReloadTicketRef.current) {
        toast.error(copy.settingsLoadFailed, settingsActionErrorMessage(error, locale));
      }
    } finally {
      if (settingsModalMountedRef.current && ticket === settingsReloadTicketRef.current) {
        setLoading(false);
      }
    }
  }

  async function updateSettings(patch: Parameters<typeof window.maka.settings.update>[0]) {
    const ticket = settingsUpdateTicketRef.current + 1;
    settingsUpdateTicketRef.current = ticket;
    const uiLocaleTicket = props.uiLocaleUpdateGate.begin(
      patch.personalization?.uiLocale !== undefined,
    );
    try {
      const result = await window.maka.settings.update(patch);
      const next = result.settings;
      props.uiLocaleUpdateGate.commit(
        uiLocaleTicket,
        next.personalization.uiLocale,
        props.onUiLocalePreferenceChange,
      );
      if (patch.chatDefaults?.permissionMode !== undefined) {
        // The empty composer lives outside Settings and mirrors this value.
        // Update it from the committed result even if Settings closed while
        // the save was in flight; a close-time re-read can race the write.
        props.onDefaultPermissionModeChange(next.chatDefaults.permissionMode);
      }
      if (settingsModalMountedRef.current && ticket === settingsUpdateTicketRef.current) {
        setSettings(next);
        props.onUserLabelChange?.(next.personalization.displayName);
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

  useEffect(() => {
    void reloadSettings();
  }, []);

  useEffect(() => {
    if (section === 'usage') void reloadUsage();
  }, [section]);

  // PR-SETTINGS-HEADER-COPY-MAP-0 (U1): the page header derives its title
  // and description from the section→copy map keyed by the active section,
  // never from a `nav[0]` fallback. A section that is routable but missing
  // from the nav copy is a type error at the `Record<SettingsSection>`
  // boundary — so an unrouted section fails loudly at build time instead of
  // silently rendering 通用 copy over a different page's body. The nav
  // highlight below still keys off `section === item.id` independently.
  const headerCopy = getSettingsNavigationCopy(locale).sections[section];

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
              height="fill"
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
                  </div>
                </LayoutHeader>
              )}
              content={(
                <LayoutContent padding={6}>
                  {loading ? (
                    <SettingsSkeleton />
                  ) : (
                    <SettingsPageBody
                      section={section}
                      settings={settings}
                      usageStats={usageStats}
                      connections={props.connections}
                      defaultSlug={props.defaultSlug}
                      themePref={props.themePref}
                      themePalette={props.themePalette}
                      onRefreshConnections={props.onRefresh}
                      onUpdateSettings={updateSettings}
                      onReloadSettings={reloadSettings}
                      onReloadUsage={reloadUsage}
                      onThemeChange={props.onThemeChange}
                      onThemePaletteChange={props.onThemePaletteChange}
                      onOpenDailyReview={props.onOpenDailyReview}
                      onOpenKeyboardHelp={props.onOpenKeyboardHelp}
                      onOpenSession={props.onOpenSession}
                      openProviderCatalog={providerCatalogRequested}
                      initialConnectionSlug={props.initialConnectionSlug}
                      initialCreateProviderType={createProviderRequest}
                      onInitialCreateProviderConsumed={() => setCreateProviderRequest(undefined)}
                    />
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
  defaultSlug: string | null;
  themePref: ThemePreference;
  themePalette: ThemePalette;
  onRefreshConnections(): Promise<void>;
  onUpdateSettings(patch: Parameters<typeof window.maka.settings.update>[0]): Promise<UpdateAppSettingsResult>;
  onReloadSettings(): Promise<void>;
  onReloadUsage(range?: UsageRange): Promise<void>;
  onThemeChange(pref: ThemePreference): void;
  onThemePaletteChange(palette: ThemePalette): void;
  onOpenDailyReview?(): void;
  onOpenKeyboardHelp?(): void;
  onOpenSession?(sessionId: string): void;
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
      return (
        <SettingsPage className="settingsModelsPage">
          <ProvidersPanel
            bridge={window.maka.connections}
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
          onReload={props.onReloadSettings}
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
          onUpdate={props.onUpdateSettings}
          onRefreshConnections={props.onRefreshConnections}
        />
      );
    case 'projects':
      return (
        <ProjectsSettingsPage settings={props.settings} onUpdate={props.onUpdateSettings} />
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
    case 'data':
      return <DataSettingsPage />;
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
