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

import type { BotOnboardingProvider } from './bot-onboarding.js';
import type { SettingsSection } from './settings.js';
import type { UiLocale } from './ui-locale.js';

/** Scenarios that are consumed by a current E2E, audit, or smoke entry point. */
export type E2eFixtureScenario =
  | 'settings-models'
  | 'turn-narrative'
  | 'turn-narrative-browser'
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
