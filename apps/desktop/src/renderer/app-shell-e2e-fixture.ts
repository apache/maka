import type { Dispatch, SetStateAction } from 'react';
import type { SettingsSection, ThemePreference } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import type { NavSelection } from '@maka/ui';
import { applyTheme } from './theme';
import type { SessionWorkbarTabKind } from './session-workbar-tabs';

export interface AppShellE2eFixtureActions {
  applyE2eFixture(): Promise<void>;
}

export function createAppShellE2eFixtureActions(options: {
  openSettingsSection: (section: SettingsSection) => void;
  refreshSessions: () => Promise<unknown>;
  setActiveId: (sessionId: string | undefined) => void;
  setNavSelection: Dispatch<SetStateAction<NavSelection>>;
  setSearchModalOpen: Dispatch<SetStateAction<boolean>>;
  setSessionListCollapsed: Dispatch<SetStateAction<boolean>>;
  setWorkbarCollapsed: Dispatch<SetStateAction<boolean>>;
  openWorkbarTab: (
    kind: Exclude<SessionWorkbarTabKind, 'side-chat'>,
    placement?: 'right' | 'bottom',
    options?: { preview?: boolean },
  ) => void;
  setThemePref: Dispatch<SetStateAction<ThemePreference>>;
  setUiLocaleOverride: Dispatch<SetStateAction<UiLocale | null>>;
}): AppShellE2eFixtureActions {
  const {
    openSettingsSection,
    refreshSessions,
    setActiveId,
    setNavSelection,
    setSearchModalOpen,
    setSessionListCollapsed,
    setWorkbarCollapsed,
    openWorkbarTab,
    setThemePref,
    setUiLocaleOverride,
  } = options;

  async function applyE2eFixture() {
    const state = await window.maka.e2eFixture.getState();
    if (!state) return;
    if (state.now) {
      // Fixture-only clock freeze: the fixture must not drift
      // because relative timestamps or fetched-at labels crossed a minute
      // boundary between two runs. Real users never receive an
      // e2e-fixture state, so their Date API remains untouched.
      Date.now = () => state.now!;
    }
    document.documentElement.setAttribute('data-maka-e2e-fixture', 'true');
    // Read by `scroll-motion-policy`: a fixture whose subject is scrolling
    // asks for the production behavior back, since the blanket collapse would
    // finish every scroll in one frame and hide what it is testing.
    if (state.scrollMotion) {
      document.documentElement.setAttribute('data-maka-scroll-motion', state.scrollMotion);
    }
    // PR-IR-01b: theme override applied BEFORE the persisted user pref so
    // the rendered fixture matches the `<theme>-<viewport>-<motion>` variant
    // exactly. `applyTheme` writes both the React state + the `.dark` class
    // on the html element. Real users never hit this branch because
    // `state` is null without `MAKA_E2E_FIXTURE`.
    if (state.theme) {
      applyTheme(state.theme);
      setThemePref(state.theme);
    }
    // PR-IR-04: apply reduced-motion attribute when the fixture asks for it.
    // The matching CSS rule in styles.css collapses all animations to
    // ~0.01ms so a reduced-motion variant is reachable
    // without depending on the host OS accessibility setting.
    // Real users never reach this code path (e2eFixture.getState returns
    // null without MAKA_E2E_FIXTURE).
    if (state.reducedMotion) {
      document.documentElement.setAttribute('data-maka-reduced-motion', 'true');
    }
    // PR-UI-VISUAL-SMOKE-LOCALE: lock the UI locale BEFORE
    // `refreshSessions()` resolves and BEFORE any locale-dependent
    // content (EmptyChatHero / Composer / OnboardingHero)
    // enters the React tree — all of those gate on sessions /
    // connection state which load inside this same effect. The reactive
    // override reaches every consumer before the fixture's
    // session refresh exposes locale-dependent content.
    // AppShell initial mount already ran when this effect fires,
    // but that initial mount renders no locale-aware copy yet
    // (it's a loading shell), so there's no observable host-locale
    // leak in the rendered fixture. See @kenji review
    // @msg 7b96e182.
    setUiLocaleOverride(state.locale ?? null);
    // PR-UI-VISUAL-SMOKE-TIMEZONE (@kenji msg 45486cdf): mirror the
    // locale attribute pattern. When `MAKA_E2E_FIXTURE_TIMEZONE` is
    // set and validates against `Intl.DateTimeFormat`, the IANA name
    // lands on `<html>` so any date / time formatting helper can
    // opt in by reading `document.documentElement.dataset.makaE2eFixtureTz`.
    // The attribute alone is the contract; per-call timezone
    // consumption is up to individual formatters as they migrate.
    if (state.timezone) {
      document.documentElement.setAttribute('data-maka-e2e-fixture-tz', state.timezone);
    }
    await refreshSessions();
    if (state.activeSessionId) {
      setActiveId(state.activeSessionId);
    }
    if (state.sidebarCollapsed !== undefined) {
      setSessionListCollapsed(state.sidebarCollapsed);
    }
    if (state.workbarCollapsed !== undefined) setWorkbarCollapsed(state.workbarCollapsed);
    if (
      state.workbarTab === 'review' ||
      state.workbarTab === 'terminal' ||
      state.workbarTab === 'tasks' ||
      state.workbarTab === 'browser' ||
      state.workbarTab === 'files' ||
      state.workbarTab === 'inspector'
    ) {
      openWorkbarTab(state.workbarTab, 'right');
    }
    if (state.openSettingsSection) {
      openSettingsSection(state.openSettingsSection);
    }
    // PR-SIDEBAR-IA-0 Phase 2 fixup v3 (xuan msg `dce5a6fb` #2): when
    // the fixture sets `searchModalOpen`, auto-open the sidebar
    // Search modal so the modal
    // shell is on screen deterministically. Real users never reach this branch
    // (e2eFixture.getState returns null without MAKA_E2E_FIXTURE).
    if (state.searchModalOpen) {
      setSearchModalOpen(true);
    }
    if (state.sidebarSection === 'automations') {
      setNavSelection({ section: 'automations', module: 'scheduled-tasks' });
    } else if (state.sidebarSection === 'skills') {
      setNavSelection({ section: 'extensions', module: 'skills' });
    } else if (state.sidebarSection === 'mcp') {
      setNavSelection({ section: 'extensions', module: 'mcp' });
    } else if (state.sidebarSection === 'daily-review') {
      setNavSelection({ section: 'automations', module: 'daily-review' });
    } else if (state.sidebarSection === 'sessions') {
      setNavSelection({ section: 'sessions', filter: 'chats' });
    }
  }

  return { applyE2eFixture };
}
