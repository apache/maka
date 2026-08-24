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

import { type ComponentType } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Brain,
  CalendarDays,
  Cpu,
  Database,
  FolderOpen,
  Info,
  ListTodo,
  Palette,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Upload,
  Workflow,
  type LucideProps,
} from '@maka/ui/icons';
import type { SettingsSection } from '@maka/core/settings';
import type { UiLocale } from '@maka/core/ui-locale';
import { safeLocalStorageGet } from '../browser-storage.js';
import { getSettingsNavigationCopy } from '../locales/settings-navigation-copy.js';
import {
  NAV_GROUP_ORDER,
  type SettingsNavGroup,
} from './nav-group-summary.js';

type SettingsNavItem = {
  id: SettingsSection;
  Icon: ComponentType<LucideProps>;
  enabled: boolean;
  /** Group label rendered as a small uppercase divider above this item. */
  group: SettingsNavGroup;
  /**
   * PR-SETTINGS-PAGE-SUBTITLE-0 (round 4/15, WAWQAQ msg `f7e9d166`):
   * one-line description rendered below the page title (h2). Reference
   * carries this per-tab meta line; maka previously had only the bare
   * label. Helps the user understand "where am I?" at the page top.
   */
  /**
   * PR-SETTINGS-NAV-REGROUP-0 (WAWQAQ msg `a9ef0d5d`): render a small
   * "Beta" chip next to the nav label. Reference uses this for the
   * 应用快照 / 工作台 items.
   */
  badge?: 'Beta';
};

type AccountSecretProbeStatus = boolean | 'loading' | 'error';
type AccountSecretProbeResult =
  | { slug: string; status: boolean }
  | { slug: string; status: 'error'; message: string };

// `SettingsNavGroup` + `NAV_GROUP_ORDER` moved to `nav-group-summary.ts`
// (PR-HEALTH-1) so the H1/H2 group-summary assertions can be pinned with
// node:test without a DOM / React.
export type { SettingsNavGroup };

// PR-SETTINGS-IA-CONSOLIDATE-0 + PR-SETTINGS-REVIEW-0: WAWQAQ msg
// `886f6406` rolled back the 记忆+回顾 merge — the combined page was
// too dense. 记忆 and 每日回顾 are separate nav items again.
export const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'general', Icon: SettingsIcon, enabled: true, group: 'preferences' },
  { id: 'appearance', Icon: Palette, enabled: true, group: 'preferences' },
  { id: 'projects', Icon: FolderOpen, enabled: true, group: 'preferences' },
  { id: 'models', Icon: Cpu, enabled: true, group: 'capabilities' },
  { id: 'subagents', Icon: Workflow, enabled: true, group: 'capabilities' },
  { id: 'memory', Icon: Brain, enabled: true, group: 'capabilities' },
  { id: 'bot-chat', Icon: Bot, enabled: true, group: 'capabilities' },
  { id: 'search', Icon: Search, enabled: true, group: 'capabilities', badge: 'Beta' },
  { id: 'usage', Icon: BarChart3, enabled: true, group: 'activity' },
  { id: 'archived-tasks', Icon: ListTodo, enabled: true, group: 'activity' },
  { id: 'import-tasks', Icon: Upload, enabled: true, group: 'activity' },
  { id: 'daily-review', Icon: CalendarDays, enabled: true, group: 'activity' },
  { id: 'data', Icon: Database, enabled: true, group: 'system' },
  { id: 'permissions', Icon: ShieldCheck, enabled: true, group: 'system' },
  { id: 'health', Icon: Activity, enabled: true, group: 'system' },
  { id: 'about', Icon: Info, enabled: true, group: 'system' },
];

const SETTINGS_SECTION_SCOPES: Record<
  SettingsSection,
  'client' | 'mixed' | 'runtime-host'
> = {
  general: 'mixed',
  appearance: 'client',
  projects: 'mixed',
  models: 'runtime-host',
  subagents: 'runtime-host',
  memory: 'runtime-host',
  'bot-chat': 'client',
  search: 'runtime-host',
  usage: 'client',
  'archived-tasks': 'client',
  'import-tasks': 'runtime-host',
  'daily-review': 'runtime-host',
  data: 'mixed',
  permissions: 'runtime-host',
  health: 'runtime-host',
  about: 'client',
};

export type LocalizedSettingsNavItem = SettingsNavItem & { label: string; description: string };

/** Order-preserving grouping used by the nav renderer. */
export function groupedNav(locale: UiLocale): Array<{ group: SettingsNavGroup; label: string; items: LocalizedSettingsNavItem[] }> {
  const copy = getSettingsNavigationCopy(locale);
  const byGroup = new Map<SettingsNavGroup, LocalizedSettingsNavItem[]>();
  for (const item of SETTINGS_NAV) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group)!.push({ ...item, ...copy.sections[item.id] });
  }
  return NAV_GROUP_ORDER.flatMap((group) => {
    const items = byGroup.get(group);
    return items && items.length > 0 ? [{ group, label: copy.groups[group], items }] : [];
  });
}

export function readLastSettingsSection(): SettingsSection {
  const value = safeLocalStorageGet('maka-settings-section-v1');
  if (!value) return 'models';
  // Retired pages bounce to Models.
  if (value === 'mcp') return 'models';
  if (SETTINGS_NAV.some((item) => item.id === value)) {
    return value as SettingsSection;
  }
  return 'models';
}

export function navLabel(section: SettingsSection, locale: UiLocale): string {
  return getSettingsNavigationCopy(locale).sections[section].label;
}

export function settingsSectionScope(
  section: SettingsSection,
): 'client' | 'mixed' | 'runtime-host' {
  return SETTINGS_SECTION_SCOPES[section];
}
