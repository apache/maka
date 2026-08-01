import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const SETTINGS_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer', 'settings');

const sourcePaths = [
  'SettingsModal.tsx',
  'settings-nav.ts',
  'settings-surface.tsx',
  'about-settings-page.tsx',
  'settings-skeleton.tsx',
  'daily-review-settings-page.tsx',
  'voice-settings-page.tsx',
  'data-settings-page.tsx',
  'appearance-settings-page.tsx',
  'web-search-settings-page.tsx',
  'memory-settings-page.tsx',
  'use-memory-settings-controller.ts',
  'use-workspace-instructions-controller.ts',
  'memory-settings-view-model.ts',
  'memory-settings-sections.tsx',
  'memory-entry-list.tsx',
  'memory-settings-labels.ts',
  'settings-error-copy.ts',
  'general-settings-page.tsx',
  'bot-chat-settings-page.tsx',
  'bot-chat-shared.tsx',
  'bot-chat-overview.tsx',
  'bot-chat-detail.tsx',
  'bot-wechat-login.tsx',
  'usage-settings-page.tsx',
  'settings-metric-card.tsx',
  'settings-status-badge.ts',
  'permission-center-page.tsx',
  'health-center-page.tsx',
  'settings-rows.tsx',
  '../locales/settings-navigation-copy.ts',
  '../locales/settings-preferences-copy.ts',
  '../locales/settings-shared-copy.ts',
] as const;

export const SETTINGS_SOURCE_REPO_PATHS: readonly string[] = sourcePaths.map(
  (sourcePath) => `apps/desktop/src/renderer/settings/${sourcePath}`,
);

export async function readSettingsCombinedSource(): Promise<string> {
  const sources = await Promise.all(
    sourcePaths.map((sourcePath) => readFile(resolve(SETTINGS_ROOT, sourcePath), 'utf8')),
  );
  return sources.join('\n');
}

