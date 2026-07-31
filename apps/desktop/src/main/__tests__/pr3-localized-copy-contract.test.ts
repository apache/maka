import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { getConversationCopy, getToolActivityCopy } from '@maka/ui';
import { getDesktopConversationCopy } from '../../renderer/locales/conversation-copy.js';
import {
  findInlineCjkLiterals,
  findSilentCatalogFallbacks,
  formatSourceViolations,
  type LiteralExemption,
} from './localized-source-contract-helpers.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

const PR3_PRESENTATION_FILES = [
  'apps/desktop/src/renderer/app-shell-chat-actions.ts',
  'apps/desktop/src/renderer/app-shell-session-events.ts',
  'apps/desktop/src/renderer/app-shell-stop-action.ts',
  'apps/desktop/src/renderer/app-shell-turn-actions.ts',
  'apps/desktop/src/renderer/app-shell-turn-view-model.ts',
  'apps/desktop/src/renderer/app-shell.tsx',
  'apps/desktop/src/renderer/attachment-preflight.ts',
  'apps/desktop/src/renderer/derive-turn-lineage-badges.ts',
  'apps/desktop/src/renderer/model-connection-errors.ts',
  'apps/desktop/src/renderer/session-health-notice.ts',
  'apps/desktop/src/renderer/session-status-presentation.ts',
  'apps/desktop/src/renderer/session-workbar.tsx',
  'apps/desktop/src/renderer/turn-footer-actions.ts',
  'apps/desktop/src/renderer/use-app-shell-composer-attachments.ts',
  'apps/desktop/src/renderer/use-app-shell-session-list.ts',
  'apps/desktop/src/renderer/use-shell-chat-model.ts',
  'packages/ui/src/attachment-file-card.tsx',
  'packages/ui/src/chat-display-helpers.ts',
  'packages/ui/src/chat-empty-hero.tsx',
  'packages/ui/src/chat-model-switcher.tsx',
  'packages/ui/src/chat-turn.tsx',
  'packages/ui/src/chat-view.tsx',
  'packages/ui/src/composer-mention-popup.tsx',
  'packages/ui/src/composer-workspace-row.tsx',
  'packages/ui/src/composer.tsx',
  'packages/ui/src/permission-mode-menu.tsx',
  'packages/ui/src/prompt-anchor-rail.tsx',
  'packages/ui/src/session-history-list.tsx',
  'packages/ui/src/session-list-panel.tsx',
  'packages/ui/src/session-status-presentation.ts',
  'packages/ui/src/tool-activity.tsx',
  'packages/ui/src/tool-activity/agent-preview.tsx',
  'packages/ui/src/tool-activity/presentation.ts',
  'packages/ui/src/tool-activity/preview-utils.ts',
  'packages/ui/src/tool-activity/result-projection.ts',
  'packages/ui/src/tool-activity/tool-result-preview.tsx',
  'packages/ui/src/tool-activity/trow-summary.ts',
  'packages/ui/src/tool-format.ts',
  'packages/ui/src/user-question-prompt.tsx',
] as const;

const PR3_CATALOG_FILES = [
  'apps/desktop/src/renderer/locales/conversation-copy.ts',
  'packages/ui/src/conversation-copy.ts',
  'packages/ui/src/tool-activity/copy.ts',
] as const;

const PR3_LITERAL_EXEMPTIONS: readonly LiteralExemption[] = [];

function repoSource(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

describe('PR3 conversation/session/tool copy contract', () => {
  it('selects independent complete catalogs for both resolved locales', () => {
    assert.equal(getConversationCopy('zh').composer.sendLabel, '发送');
    assert.equal(getConversationCopy('en').composer.sendLabel, 'Send');
    assert.equal(getToolActivityCopy('zh').status.running, '运行中');
    assert.equal(getToolActivityCopy('en').status.running, 'Running');
    assert.equal(getDesktopConversationCopy('zh').actions.stopFailedTitle, '停止失败');
    assert.equal(getDesktopConversationCopy('en').actions.stopFailedTitle, 'Failed to stop');
  });

  it('contains no inline user-visible Chinese in migrated presentation owners', () => {
    const violations = PR3_PRESENTATION_FILES.flatMap((file) =>
      findInlineCjkLiterals(repoSource(file), file, { exemptions: PR3_LITERAL_EXEMPTIONS }),
    );

    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });

  it('does not silently fall English catalogs back to Chinese', () => {
    const violations = PR3_CATALOG_FILES.flatMap((file) => findSilentCatalogFallbacks(repoSource(file), file));
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });
});
