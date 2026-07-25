import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Walk up to the workspace root by looking for it, rather than counting `..`
 * segments. Contract tests run from `dist/main/__tests__`, so a fixed chain
 * silently resolves to `/` if the build output ever moves — the failure then
 * reads as "story directory missing" instead of "root lookup broke".
 */
function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (
      existsSync(join(dir, 'apps', 'desktop', 'package.json'))
      && existsSync(join(dir, 'packages', 'ui', 'package.json'))
    ) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) throw new Error(`Unable to locate repo root from ${start}`);
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(import.meta.dirname);

/**
 * Every production module of the main process, discovered rather than listed.
 *
 * The curated list below is the older seam and still serves the assertions
 * that need one concatenated string. This one exists for the assertions that
 * claim a NEGATIVE over the whole process ("nothing else does X"), where a
 * subset is not evidence: a hand-maintained list and a top-level-only
 * `readdir` both answer "not in the part I looked at", which is the wrong
 * question. `src/main` is 133 production modules, 33 of them below the top
 * level.
 */
export async function mainProcessSourceFiles(): Promise<string[]> {
  const root = resolve(REPO_ROOT, 'apps/desktop/src/main');
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = await Promise.all(
      entries.map(async (entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '__tests__' ? [] : walk(full);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
      }),
    );
    return found.flat();
  };
  return (await walk(root)).sort();
}

export const MAIN_PROCESS_SOURCE_REPO_PATHS: readonly string[] = [
  'apps/desktop/src/main/main.ts',
  'apps/desktop/src/main/app-ipc-main.ts',
  'apps/desktop/src/main/app-lifecycle.ts',
  'apps/desktop/src/main/bot-incoming-main.ts',
  'apps/desktop/src/main/browser-ipc-main.ts',
  'apps/desktop/src/main/config-ipc-main.ts',
  'apps/desktop/src/main/create-connection-with-credential.ts',
  'apps/desktop/src/main/connections-ipc-main.ts',
  'apps/desktop/src/main/daily-review-ipc-main.ts',
  'apps/desktop/src/main/daily-review-main.ts',
  'apps/desktop/src/main/desktop-backend-tool-surface.ts',
  'apps/desktop/src/main/gateway-ipc-main.ts',
  'apps/desktop/src/main/git-ipc-main.ts',
  'apps/desktop/src/main/main-window.ts',
  'apps/desktop/src/main/memory-ipc-main.ts',
  'apps/desktop/src/main/mcp-ipc-main.ts',
  'apps/desktop/src/main/notifications-ipc-main.ts',
  'apps/desktop/src/main/oauth-model-connections-main.ts',
  'apps/desktop/src/main/onboarding-ipc-main.ts',
  'apps/desktop/src/main/permission-mode-default.ts',
  'apps/desktop/src/main/permissions-ipc-main.ts',
  'apps/desktop/src/main/plan-reminders-ipc-main.ts',
  'apps/desktop/src/main/plan-reminders-main.ts',
  'apps/desktop/src/main/project-context-root.ts',
  'apps/desktop/src/main/project-root-controller.ts',
  'apps/desktop/src/main/session-entry-ipc-main.ts',
  'apps/desktop/src/main/create-session-input.ts',
  'apps/desktop/src/main/session-branch.ts',
  'apps/desktop/src/main/session-revision.ts',
  'apps/desktop/src/main/session-stream.ts',
  'apps/desktop/src/main/settings-runtime-effects.ts',
  'apps/desktop/src/main/sessions-ipc-main.ts',
  'apps/desktop/src/main/settings-ipc-main.ts',
  'apps/desktop/src/main/subscription-model-fetch.ts',
  'apps/desktop/src/main/subscription-ipc-main.ts',
  'apps/desktop/src/main/system-prompt-main.ts',
  'apps/desktop/src/main/tool-assembly.ts',
  'apps/desktop/src/main/tool-artifact-persistence.ts',
  'apps/desktop/src/main/usage-ipc-main.ts',
  'apps/desktop/src/main/web-search-ipc-main.ts',
  'apps/desktop/src/main/workspace-instructions-ipc-main.ts',
  'apps/desktop/src/main/workspace-resources-ipc-main.ts',
  'apps/desktop/src/main/workspace-search-ipc-main.ts',
];

export async function readMainProcessCombinedSource(): Promise<string> {
  const sources = await Promise.all(
    MAIN_PROCESS_SOURCE_REPO_PATHS.map((sourcePath) =>
      readFile(resolve(REPO_ROOT, sourcePath), 'utf8')
    ),
  );
  return sources.join('\n');
}

export function readMainProcessCombinedSourceSync(): string {
  return MAIN_PROCESS_SOURCE_REPO_PATHS
    .map((sourcePath) => readFileSync(resolve(REPO_ROOT, sourcePath), 'utf8'))
    .join('\n');
}

/** Read just apps/desktop/src/main/main.ts. Use this for assertions that
 *  target main.ts specifically and must not be matched by another main
 *  module that the combined source folds in (e.g. the extracted resolver
 *  module's own `export async function resolveDefaultPermissionMode`). */
export async function readMainTsSource(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/main.ts'), 'utf8');
}

/** Read just apps/desktop/src/main/sessions-ipc-main.ts — the single
 *  session-creation IPC since #1433 merged `quickChat:start` into it. */
export async function readSessionsIpcSource(): Promise<string> {
  return readFile(resolve(REPO_ROOT, 'apps/desktop/src/main/sessions-ipc-main.ts'), 'utf8');
}
