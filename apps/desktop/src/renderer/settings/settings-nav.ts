import { type ComponentType } from 'react';
import {
  Activity,
  BarChart3,
  Bot,
  Brain,
  CalendarDays,
  Cpu,
  Database,
  Info,
  Mic,
  Palette,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  type LucideProps,
} from '@maka/ui/icons';
import type { SettingsSection, UiLocale } from '@maka/core';
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
// PR-SETTINGS-NAV-REGROUP-0 (WAWQAQ msg `a9ef0d5d`): 5 narrow groups
// → 3 wider groups. 基础→通用, AI+集成→「AI 与集成」, 数据+其他→系统.
// Mirrors reference's tighter grouping (1 big group + a couple small
// ones) instead of 5 categories with only 1-3 items each.
export const SETTINGS_NAV: SettingsNavItem[] = [
  { id: 'general', Icon: SettingsIcon, enabled: true, group: 'general' },
  { id: 'appearance', Icon: Palette, enabled: true, group: 'general' },
  { id: 'models', Icon: Cpu, enabled: true, group: 'ai-integrations' },
  { id: 'usage', Icon: BarChart3, enabled: true, group: 'ai-integrations' },
  { id: 'memory', Icon: Brain, enabled: true, group: 'ai-integrations' },
  { id: 'daily-review', Icon: CalendarDays, enabled: true, group: 'ai-integrations' },
  { id: 'voice', Icon: Mic, enabled: true, group: 'ai-integrations' },
  { id: 'bot-chat', Icon: Bot, enabled: true, group: 'ai-integrations' },
  { id: 'search', Icon: Search, enabled: true, group: 'ai-integrations', badge: 'Beta' },
  { id: 'data', Icon: Database, enabled: true, group: 'system' },
  { id: 'permissions', Icon: ShieldCheck, enabled: true, group: 'system' },
  { id: 'health', Icon: Activity, enabled: true, group: 'system' },
  { id: 'about', Icon: Info, enabled: true, group: 'system' },
];

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
  // Anyone whose last visit was the retired combined voice page lands on
  // Voice instead of being silently bounced back to Models.
  if (value === 'voice-gateway') return 'voice';
  if (value === 'mcp') return 'models';
  if (SETTINGS_NAV.some((item) => item.id === value)) {
    return value as SettingsSection;
  }
  return 'models';
}

export function navLabel(section: SettingsSection, locale: UiLocale): string {
  return getSettingsNavigationCopy(locale).sections[section].label;
}
