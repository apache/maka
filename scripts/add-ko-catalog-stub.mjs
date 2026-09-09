#!/usr/bin/env node
/**
 * Adds `ko:` entries to UiCatalog objects by duplicating the `en:` block.
 * Used for integration branches where ko is enabled before all slices land.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const files = [
  'packages/ui/src/tool-activity/copy.ts',
  'packages/ui/src/skills-copy.ts',
  'packages/ui/src/shell-controls-copy.ts',
  'packages/ui/src/shared-ui-copy.ts',
  'packages/ui/src/scheduled-task-copy.ts',
  'packages/ui/src/daily-review-copy.ts',
  'packages/ui/src/conversation-copy.ts',
  'apps/desktop/src/renderer/settings/provider-display-copy.ts',
  'apps/desktop/src/renderer/locales/shell-remaining-copy.ts',
  'apps/desktop/src/renderer/locales/shell-copy.ts',
  'apps/desktop/src/renderer/locales/settings-web-search-copy.ts',
  'apps/desktop/src/renderer/locales/settings-usage-copy.ts',
  'apps/desktop/src/renderer/locales/settings-test-result-copy.ts',
  'apps/desktop/src/renderer/locales/settings-tasks-copy.ts',
  'apps/desktop/src/renderer/locales/settings-subagents-copy.ts',
  'apps/desktop/src/renderer/locales/settings-shared-copy.ts',
  'apps/desktop/src/renderer/locales/settings-provider-copy.ts',
  'apps/desktop/src/renderer/locales/settings-projects-copy.ts',
  'apps/desktop/src/renderer/locales/settings-preferences-copy.ts',
  'apps/desktop/src/renderer/locales/settings-navigation-copy.ts',
  'apps/desktop/src/renderer/locales/settings-memory-copy.ts',
  'apps/desktop/src/renderer/locales/settings-health-copy.ts',
  'apps/desktop/src/renderer/locales/settings-data-copy.ts',
  'apps/desktop/src/renderer/locales/settings-daily-review-copy.ts',
  'apps/desktop/src/renderer/locales/settings-bot-copy.ts',
  'apps/desktop/src/renderer/locales/session-collaboration-copy.ts',
  'apps/desktop/src/renderer/locales/plan-mode-copy.ts',
  'apps/desktop/src/renderer/locales/permission-center-copy.ts',
  'apps/desktop/src/renderer/locales/mcp-copy.ts',
  'apps/desktop/src/renderer/locales/external-session-import-copy.ts',
  'apps/desktop/src/renderer/locales/conversation-copy.ts',
  'apps/desktop/src/renderer/locales/browser-copy.ts',
  'apps/desktop/src/renderer/locales/artifact-copy.ts',
  'apps/desktop/src/main/client-settings-confirmation-copy.ts',
  'apps/desktop/src/main/permission-overlay/permission-overlay-copy.ts',
  'apps/desktop/src/main/runtime-host-upgrade-copy.ts',
];

function extractLocaleBlock(source, localeKey) {
  const marker = `\n  ${localeKey}: `;
  const start = source.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  if (source[i] !== '{') return null;
  let depth = 0;
  const begin = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

for (const file of files) {
  const path = join(root, file);
  let source = readFileSync(path, 'utf8');
  if (source.includes('\n  ko:') || source.includes("\n  'ko':")) {
    continue;
  }
  const enBlock = extractLocaleBlock(source, 'en');
  if (!enBlock) {
    console.warn(`skip (no en block): ${file}`);
    continue;
  }
  const koBlock = enBlock.replace('\n  en:', '\n  ko:');
  const insertAt = source.lastIndexOf('\n} satisfies UiCatalog');
  if (insertAt === -1) {
    console.warn(`skip (no satisfies): ${file}`);
    continue;
  }
  source = `${source.slice(0, insertAt)},${koBlock}${source.slice(insertAt)}`;
  writeFileSync(path, source);
  console.log(`updated: ${file}`);
}
