import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const RENDERER_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');

const sourcePaths = [
  'main.tsx',
  'app.tsx',
  'app-shell-session-start-actions.ts',
  'app-shell-layout-actions.ts',
  'app-shell-daily-review-bridge.ts',
  'app-shell-daily-review-actions.ts',
  'app-shell-turn-actions.ts',
  'app-shell-revision-actions.ts',
  'session-revisions.ts',
  'app-shell-turn-view-model.ts',
  'app-shell.tsx',
  'app-shell-chrome-actions.tsx',
  'app-shell-overlays.tsx',
  'app-shell-plan-actions.ts',
  'app-shell-skill-actions.ts',
  'app-shell-project-actions.ts',
  'app-shell-open-skill-action.ts',
  'app-shell-chat-actions.ts',
  'app-shell-stop-action.ts',
  'app-shell-copy.ts',
  'app-shell-command-actions.ts',
  'app-shell-effects.ts',
  'app-shell-session-events.ts',
  'app-shell-session-row-actions.ts',
  'app-shell-session-settings-actions.ts',
  'use-app-shell-session-list.ts',
  'use-app-shell-session-workspace.ts',
  'use-pending-action-registry.ts',
  'use-project-context.ts',
  'use-module-data.ts',
  'use-shell-connections.ts',
  'use-shell-chat-model.ts',
  'use-shell-live-turn.ts',
  'use-shell-resume.ts',
  'use-shell-expert-teams.ts',
  'use-shell-memory-pill.ts',
  'use-shell-layout.ts',
  'use-settings-modal.ts',
  'chat-message-surface.tsx',
  'chat-composer-region.tsx',
  'chat-workbar.tsx',
  'use-shell-appearance.ts',
  'use-shell-search.ts',
  'app-shell-e2e-fixture.ts',
  'cached-theme-bootstrap.ts',
  'chat-model-selection.ts',
  'conversation-markdown.ts',
  'daily-review-actions.ts',
  'model-connection-errors.ts',
  'nav-selection.ts',
  'session-list-layout.ts',
  'locales/shell-copy.ts',
] as const;

export type RendererShellSourcePath = typeof sourcePaths[number];

export const RENDERER_SHELL_SOURCE_REPO_PATHS: readonly string[] = sourcePaths.map(
  (sourcePath) => `apps/desktop/src/renderer/${sourcePath}`,
);

export async function readRendererShellSource(sourcePath: RendererShellSourcePath): Promise<string> {
  return readFile(resolve(RENDERER_ROOT, sourcePath), 'utf8');
}

export async function readRendererShellSources(sourcePaths: readonly RendererShellSourcePath[]): Promise<string> {
  const sources = await Promise.all(
    sourcePaths.map((sourcePath) => readRendererShellSource(sourcePath)),
  );
  return sources.join('\n');
}

export async function readRendererShellCombinedSource(): Promise<string> {
  return readRendererShellSources(sourcePaths);
}
