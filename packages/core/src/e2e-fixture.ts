import type { BotOnboardingProvider } from './bot-onboarding.js';
import type { SettingsSection } from './settings.js';
import type { UiLocale } from './ui-locale.js';

/** Scenarios that are consumed by a current E2E, audit, or smoke entry point. */
export type E2eFixtureScenario =
  | 'fetched-empty'
  | 'turn-narrative'
  | 'chat-prompt-rail'
  | 'settings-data'
  | 'settings-bots-onboarding'
  | 'settings-general'
  | 'settings-permissions'
  | 'settings-usage'
  | 'module-skills'
  | 'module-mcp'
  | 'module-daily-review'
  | 'scheduled-tasks'
  | 'sidebar-search-modal-open';

export interface E2eFixtureState {
  enabled: true;
  now?: number;
  activeSessionId?: string;
  openSettingsSection?: SettingsSection;
  reducedMotion?: boolean;
  /**
   * Opt a fixture back into animated scrolling. Captures collapse scroll
   * motion so a screenshot never depends on when it settles, which also means
   * no fixture can exercise a scroll that is still in flight — and that is
   * precisely what the prompt rail's jump has to survive.
   */
  scrollMotion?: 'auto' | 'smooth';
  theme?: 'light' | 'dark' | 'auto';
  locale?: UiLocale;
  timezone?: string;
  searchModalOpen?: boolean;
  sidebarSection?: 'sessions' | 'automations' | 'skills' | 'mcp' | 'daily-review';
  sidebarCollapsed?: boolean;
  workbarCollapsed?: boolean;
  workbarTab?: 'review' | 'terminal' | 'tasks' | 'browser' | 'files' | 'inspector';
  botOnboardingProvider?: BotOnboardingProvider;
}
