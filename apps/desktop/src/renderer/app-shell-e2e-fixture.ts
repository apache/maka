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

import type { Dispatch, SetStateAction } from 'react';
import type { SettingsSection, ThemePreference } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import type { NavSelection } from '@maka/ui';
import { applyTheme } from './theme';
import type { SessionWorkbarTabKind } from './features/workbar';
import {
  waitForCatalogSession,
  type SessionCatalogController,
} from './application/contracts/session-catalog/session-catalog-state.js';

export interface AppShellE2eFixtureActions {
  applyE2eFixture(): Promise<void>;
}

export function createAppShellE2eFixtureActions(options: {
  openSettingsSection: (section: SettingsSection) => void;
  refreshSessions: () => Promise<unknown>;
  sessionCatalog: SessionCatalogController;
  setActiveId: (sessionId: string | undefined) => void;
  setNavSelection: Dispatch<SetStateAction<NavSelection>>;
  openSearchModal(): void;
  setSessionListCollapsed(collapsed: boolean): void;
  workbar: {
    setWorkbarCollapsed(collapsed: boolean): void;
    openTool(
      kind: SessionWorkbarTabKind,
      placement?: 'right' | 'bottom',
    ): void;
  };
  setThemePref: Dispatch<SetStateAction<ThemePreference>>;
  setUiLocaleOverride: Dispatch<SetStateAction<UiLocale | null>>;
}): AppShellE2eFixtureActions {
  const {
    openSettingsSection,
    refreshSessions,
    sessionCatalog,
    setActiveId,
    setNavSelection,
    openSearchModal,
    setSessionListCollapsed,
    workbar,
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
    if (state.activeSessionId) {
      // A runtime-host-profiles change triggers a retire sweep that drops an
      // active Session missing from the committed catalog. With the Host
      // still starting, that sweep can land before the seeded row reaches the
      // catalog — activate only once the catalog has observed it.
      await waitForCatalogSession(sessionCatalog, state.activeSessionId);
      setActiveId(state.activeSessionId);
    }
    // Workbar collapse state is keyed per Session and drops writes issued
    // before the reducer has activated that Session — the IPC round trip
    // inside refreshSessions lets the selection commit render first.
    await refreshSessions();
    if (state.sidebarCollapsed !== undefined) {
      setSessionListCollapsed(state.sidebarCollapsed);
    }
    if (state.workbarCollapsed !== undefined) {
      workbar.setWorkbarCollapsed(state.workbarCollapsed);
    }
    if (state.workbarTab && state.workbarTab !== 'tasks') {
      workbar.openTool(state.workbarTab, 'right');
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
      openSearchModal();
    }
    if (state.sidebarSection) {
      const navForSidebarSection: Record<
        NonNullable<typeof state.sidebarSection>,
        NavSelection
      > = {
        automations: { section: 'automations', module: 'scheduled-tasks' },
        skills: { section: 'extensions', module: 'skills' },
        mcp: { section: 'extensions', module: 'mcp' },
        'daily-review': { section: 'automations', module: 'daily-review' },
        sessions: { section: 'sessions' },
      };
      setNavSelection(navForSidebarSection[state.sidebarSection]);
    }
  }

  return { applyE2eFixture };
}
