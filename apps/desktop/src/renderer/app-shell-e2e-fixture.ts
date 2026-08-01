import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { SettingsSection, ThemePreference, UiLocale } from '@maka/core';
import type { ComposerHandle, InteractionQueues, LiveTurnProjection } from '@maka/ui';
import type { NavSelection } from '@maka/ui';
import { applyTheme } from './theme';
import type { SessionWorkbarTab } from './session-workbar-layout';

type StateUpdater<T> = (updater: (current: T) => T) => void;

export interface AppShellE2eFixtureActions {
  applyE2eFixture(): Promise<void>;
}

export function createAppShellE2eFixtureActions(options: {
  openPalette: () => void;
  composerRef: RefObject<ComposerHandle | null>;
  openSettingsSection: (section: SettingsSection) => void;
  openConnectionDetail: (slug: string) => void;
  refreshSessions: () => Promise<unknown>;
  setActiveId: (sessionId: string | undefined) => void;
  setLiveBrowserSessionIds: Dispatch<SetStateAction<string[]>>;
  setLiveTurnBySession: StateUpdater<Record<string, LiveTurnProjection>>;
  setNavSelection: Dispatch<SetStateAction<NavSelection>>;
  setInteractionBySession: StateUpdater<InteractionQueues>;
  setSearchModalOpen: Dispatch<SetStateAction<boolean>>;
  setSessionListCollapsed: Dispatch<SetStateAction<boolean>>;
  setWorkbarCollapsed: Dispatch<SetStateAction<boolean>>;
  setWorkbarTab: Dispatch<SetStateAction<SessionWorkbarTab>>;
  setThemePref: Dispatch<SetStateAction<ThemePreference>>;
  setUiLocaleOverride: Dispatch<SetStateAction<UiLocale | null>>;
}): AppShellE2eFixtureActions {
  const {
    openPalette,
    composerRef,
    openSettingsSection,
    openConnectionDetail,
    refreshSessions,
    setActiveId,
    setLiveBrowserSessionIds,
    setLiveTurnBySession,
    setNavSelection,
    setInteractionBySession,
    setSearchModalOpen,
    setSessionListCollapsed,
    setWorkbarCollapsed,
    setWorkbarTab,
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
    if (state.liveTurnBySession) {
      setLiveTurnBySession((current) => ({ ...current, ...state.liveTurnBySession }));
    }
    if (state.sandboxBoundaryBySession) {
      const seeded: InteractionQueues = {};
      for (const [seedSessionId, request] of Object.entries(state.sandboxBoundaryBySession)) {
        if (request) seeded[seedSessionId] = [request];
      }
      setInteractionBySession((current) => ({ ...current, ...seeded }));
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
    // #819: seed live browser session ids so BrowserPanel mounts for the
    // active session (app-shell gates on `activeId &&
    // liveBrowserSessionIds.includes(activeId)`). Only the `browser-empty`
    // scenario sets this; real users never receive an e2e-fixture state.
    if (state.liveBrowserSessionIds) {
      setLiveBrowserSessionIds(state.liveBrowserSessionIds);
    }
    if (state.sidebarCollapsed !== undefined) {
      setSessionListCollapsed(state.sidebarCollapsed);
    }
    if (state.workbarCollapsed !== undefined) setWorkbarCollapsed(state.workbarCollapsed);
    if (state.workbarTab) setWorkbarTab(state.workbarTab);
    if (state.openConnectionDetailSlug) {
      // oauth-relogin fixture: open Settings → 模型 with the seeded
      // needs_reauth connection's detail sheet expanded so the re-login
      // affordance is exposed. Takes precedence over a bare section open.
      openConnectionDetail(state.openConnectionDetailSlug);
    } else if (state.openSettingsSection) {
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
    // PR-shared primitive-COMMAND-INPUT-0: e2e-fixture-only opener for the command
    // palette so its input shell is covered without
    // requiring Cmd/Ctrl+K.
    if (state.paletteOpen) {
      openPalette();
    }
    if (state.sidebarSection === 'automations') {
      setNavSelection({ section: 'automations', module: 'plan-reminders' });
    } else if (state.sidebarSection === 'skills') {
      setNavSelection({ section: 'extensions', module: 'skills' });
    } else if (state.sidebarSection === 'mcp') {
      setNavSelection({ section: 'extensions', module: 'mcp' });
    } else if (state.sidebarSection === 'daily-review') {
      setNavSelection({ section: 'automations', module: 'daily-review' });
    } else if (state.sidebarSection === 'sessions') {
      setNavSelection({ section: 'sessions', filter: 'chats' });
    }
    if (state.composerText !== undefined) {
      // Wait for the active session + its Skill inventory to commit, then use
      // the real Composer input path. This keeps the screenshot representative
      // of keyboard interaction instead of mounting a test-only popup.
      await nextVisualSmokeFrame();
      await nextVisualSmokeFrame();
      composerRef.current?.setText(state.composerText);
      const textarea = document.querySelector<HTMLTextAreaElement>(
        '.maka-composer textarea[name="text"]',
      );
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
      await nextVisualSmokeFrame();
    }
    if (state.composerSkills !== undefined) {
      composerRef.current?.setSkills(state.composerSkills);
      await nextVisualSmokeFrame();
    }
    // PR-SIDEBAR-IA-0 Phase 3 P0 fixup v4 (WAWQAQ msg `5dd1c348`,
    // kenji `b3d156e9`): when the fixture sets `focusActiveRow`,
    // focus the active ListItem action through Maka's stable row hook after
    // the next paint. The actionable descendant is located semantically, not
    // through Astryx implementation classes or child structure.
    // Two RAFs let React
    // commit the active selection before we query the DOM.
    if (state.focusActiveRow) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const activeRow = document.querySelector<HTMLElement>(
            '[data-maka-contract="list-row"][aria-current="true"]',
          );
          const activeRowAction = activeRow?.querySelector<HTMLElement>(
            'button, a[href], [tabindex]:not([tabindex="-1"])',
          );
          activeRowAction?.focus({ preventScroll: true });
        });
      });
    }
  }

  return { applyE2eFixture };
}

function nextVisualSmokeFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
