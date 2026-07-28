import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProjectGitInfo, resolveProjectRoot } from '@maka/runtime';
import { readRendererContractCss } from './contract-css-helpers.js';
import { readRendererShellCombinedSource } from './renderer-shell-source-helpers.js';

const repoRoot = process.cwd().endsWith('apps/desktop')
  ? join(process.cwd(), '..', '..')
  : process.cwd();

async function readRepo(path: string): Promise<string> {
  return readFile(join(repoRoot, path), 'utf8');
}

// Main-process sources are read per owning file (not the combined blob), so
// each assertion locks the file that actually implements the behavior — a
// regression in one module can neither hide behind matching text in another
// nor be masked by the shared project-root controller's internals.
const MAIN = 'apps/desktop/src/main/main.ts';
const APP_IPC = 'apps/desktop/src/main/app-ipc-main.ts';
const CONTROLLER = 'apps/desktop/src/main/project-root-controller.ts';
const SESSIONS_IPC = 'apps/desktop/src/main/sessions-ipc-main.ts';
const WORKSPACE_INSTRUCTIONS_IPC = 'apps/desktop/src/main/workspace-instructions-ipc-main.ts';

describe('project context workspace picker', () => {
  it('resolves git branch from normal and worktree-style .git metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-project-context-'));
    const worktree = await mkdtemp(join(tmpdir(), 'maka-project-context-worktree-'));
    const gitDir = await mkdtemp(join(tmpdir(), 'maka-project-context-gitdir-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      assert.deepEqual(await resolveProjectGitInfo(root), { isGitRepo: true, branch: 'main' });

      await writeFile(join(worktree, '.git'), `gitdir: ${gitDir}\n`, 'utf8');
      await writeFile(join(gitDir, 'HEAD'), 'ref: refs/heads/feature/sidebar\n', 'utf8');
      assert.deepEqual(await resolveProjectGitInfo(worktree), { isGitRepo: true, branch: 'feature/sidebar' });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
      await rm(gitDir, { recursive: true, force: true });
    }
  });

  it('resolves the project root by walking upward from nested app paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-project-root-'));
    const nested = join(root, 'apps', 'desktop');
    const fallback = await mkdtemp(join(tmpdir(), 'maka-project-root-fallback-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await mkdir(nested, { recursive: true });

      assert.equal(await resolveProjectRoot(['/', nested]), root);
      assert.equal(await resolveProjectRoot([fallback]), fallback);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(fallback, { recursive: true, force: true });
    }
  });

  it('exposes the main-owned project path through app info', async () => {
    const main = await readRepo(MAIN);
    const appIpc = await readRepo(APP_IPC);
    const controller = await readRepo(CONTROLLER);
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');

    assert.match(main, /fallbackRoots: \(\) => \[process\.cwd\(\), app\.getAppPath\(\)\]/);
    assert.match(appIpc, /projectGit:\s*await resolveProjectGitInfo\(projectPath\)/);
    assert.match(main, /function registerIpc\(\): void/);
    assert.match(controller, /const persistedProjectRootPromise = loadPersistedProjectRoot\(\)/);
    assert.doesNotMatch(main, /async function registerIpc\(\): Promise<void>/);
    assert.doesNotMatch(main, /void registerIpc\(\);/);
    assert.match(preload, /projectPath:\s*string;/);
    assert.match(preload, /projectGit:\s*\{ isGitRepo: boolean; branch\?: string \};/);
    assert.match(globalTypes, /projectPath:\s*string;/);
    assert.match(globalTypes, /projectGit:\s*\{ isGitRepo: boolean; branch\?: string \};/);
  });

  it('uses the persistent project catalog as the composer picker authority', async () => {
    const appIpc = await readRepo(APP_IPC);
    const controller = await readRepo(CONTROLLER);
    const preload = await readRepo('apps/desktop/src/preload/preload.ts');
    const globalTypes = await readRepo('apps/desktop/src/preload/bridge-contract.d.ts');
    const renderer = await readRendererShellCombinedSource();
    const projectActionsSource = await readRepo(
      'apps/desktop/src/renderer/app-shell-project-actions.ts',
    );
    const workspacePickerBlock = renderer.match(/workspacePicker=\{\{[\s\S]*?\n\s*\}\}/)?.[0] ?? '';

    assert.match(controller, /let selectedProject: CurrentProjectSelection \| null = null;/);
    assert.match(controller, /if \(selectedProject\) return selectedProject;/);
    assert.match(appIpc, /ipcMain\.handle\('projects:list'/);
    assert.match(appIpc, /ipcMain\.handle\('projects:add'/);
    assert.match(appIpc, /ipcMain\.handle\('projects:select'/);
    assert.match(appIpc, /ipcMain\.handle\('projects:relink'/);
    assert.match(appIpc, /ipcMain\.handle\('projects:rename'/);
    assert.match(appIpc, /ipcMain\.handle\('projects:archive'/);
    assert.match(appIpc, /ipcMain\.handle\('projects:restore'/);
    assert.match(
      controller,
      /function setSelection\(projectId: string \| null, projectPath: string\): void \{\s*selectedProject = \{ projectId, path: projectPath \};\s*void saveLastProjectPath\(projectPath, projectId\);/,
      'the controller must persist the project association and path together',
    );
    assert.match(preload, /projects:\s*\{/);
    assert.match(preload, /ipcRenderer\.invoke\('projects:list'\)/);
    assert.match(preload, /ipcRenderer\.invoke\('projects:add'\)/);
    assert.match(globalTypes, /projects:\s*\{/);
    assert.match(globalTypes, /list\(\): Promise<ProjectRecord\[\]>/);
    assert.match(renderer, /window\.maka\.projects\.list\(\)/);
    assert.match(renderer, /window\.maka\.projects\.add\(\)/);
    assert.doesNotMatch(renderer, /recentProjectPaths/);
    assert.match(renderer, /const \[projectPickerPending, setProjectPickerPending\] = useState\(false\)/);
    assert.match(renderer, /const rendererMountedRef = useRef\(true\)/);
    assert.match(renderer, /const projectPickerPendingRef = useRef\(false\)/);
    assert.match(renderer, /const projectPickerRequestRef = useRef\(0\)/);
    assert.match(
      renderer,
      /return \(\) => \{[\s\S]*rendererMountedRef\.current = false;[\s\S]*projectPickerRequestRef\.current \+= 1;[\s\S]*projectPickerPendingRef\.current = false;/,
      'project picker must invalidate native-dialog owners when the renderer shell unmounts',
    );
    assert.match(
      renderer,
      /async function addProject\(\)[\s\S]*if \(projectPickerPendingRef\.current\) return null;[\s\S]*const requestId = projectPickerRequestRef\.current \+ 1;[\s\S]*window\.maka\.projects\.add\(\)[\s\S]*if \(!isCurrentProjectPickerRequest\(\)\) return null;/,
      'project picker must synchronously reject duplicate native dialog requests before React commits disabled state',
    );
    assert.match(
      renderer,
      /catch \(error\) \{[\s\S]*if \(isCurrentProjectPickerRequest\(\)\) \{[\s\S]*toastApi\.error\(\s*copy\.selectDirectoryFailedTitle,\s*localizedShellErrorMessage\(error, copy\.readPathFailedFallback, uiLocale\)/,
      'project picker failure feedback must stay scoped to the current mounted picker request',
    );
    assert.match(
      renderer,
      /finally \{[\s\S]*if \(projectPickerRequestRef\.current === requestId\) \{[\s\S]*projectPickerPendingRef\.current = false;[\s\S]*if \(rendererMountedRef\.current\) setProjectPickerPending\(false\);/,
      'project picker must release only the matching pending owner after the native dialog resolves or fails',
    );
    assert.match(
      projectActionsSource,
      /await applySelectedProject\(result\.project, result\.path, true\)/,
    );
    assert.doesNotMatch(
      projectActionsSource.match(
        /async function addProject\(\): Promise<ProjectRecord \| null> \{[\s\S]*?\n  \}/,
      )?.[0] ?? '',
      /async function addProject\(\)[\s\S]*await selectProjectRecord\(result\.project/,
      'adding a project must not select it a second time after main already adopted the path',
    );
    assert.match(workspacePickerBlock, /pending:\s*projectPickerPending/);
    assert.match(workspacePickerBlock, /projects:\s*projects\.filter/);
    assert.match(workspacePickerBlock, /void addProject\(\)/);
    assert.match(workspacePickerBlock, /onSelectNoProject:\s*selectNoProject/);
    assert.doesNotMatch(workspacePickerBlock, /openProjectFolder\(\)|openWorkspaceFolder\(\)|openPath\(/);
  });

  it('defaults new sessions to the main-owned current project root', async () => {
    const main = await readRepo(MAIN);
    const sessionsIpc = await readRepo(SESSIONS_IPC);
    const sessionEntryIpc = await readRepo('apps/desktop/src/main/session-entry-ipc-main.ts');
    const botIncoming = await readRepo('apps/desktop/src/main/bot-incoming-main.ts');
    const chatActions = await readRepo('apps/desktop/src/renderer/app-shell-chat-actions.ts');

    assert.match(
      main,
      /resolveDesktopSessionSelection\(input, projectManagement\)/,
      'all desktop session entry points must resolve the main-owned selection once',
    );
    assert.match(
      sessionEntryIpc,
      /\.\.\.\(typeof projectId === 'string' \|\| projectId === null \? \{ projectId \} : \{\}\)/,
    );
    assert.doesNotMatch(sessionsIpc, /getCurrentProjectRoot/);
    assert.doesNotMatch(sessionEntryIpc, /getCurrentProjectRoot/);
    assert.doesNotMatch(botIncoming, /getCurrentProjectRoot/);
    assert.doesNotMatch(main, /quickChat/, '#1433 merged quickChat:start into sessions:create');
    assert.doesNotMatch(sessionsIpc, /const cwd = input\?\.cwd \?\? process\.cwd\(\)/);
    assert.doesNotMatch(sessionsIpc, /cwd:\s*process\.cwd\(\)/);
    assert.doesNotMatch(main, /cwd:\s*process\.cwd\(\)/);
    assert.doesNotMatch(chatActions, /\.\.\.\(projectPath \? \{ cwd: projectPath \} : \{\}\)/);
  });

  it('resolves workspace instruction files under the selected project root', async () => {
    const main = await readRepo(MAIN);
    const wsIpc = await readRepo(WORKSPACE_INSTRUCTIONS_IPC);

    assert.match(main, /registerWorkspaceInstructionsIpc\(\{ getCurrentProjectRoot: currentProjectRoot \}\)/);
    assert.match(wsIpc, /ipcMain\.handle\('workspaceInstructions:getState', async \(\) => getWorkspaceInstructionsState\(await currentProjectRoot\(\)\)\)/);
    assert.match(wsIpc, /resolveWorkspaceInstructionFileForOpen\(await currentProjectRoot\(\), typeof file === 'string' \? file : ''\)/);
    assert.match(wsIpc, /createWorkspaceInstructionFile\(await currentProjectRoot\(\), typeof file === 'string' \? file : ''\)/);
    assert.doesNotMatch(wsIpc, /getWorkspaceInstructionsState\(process\.cwd\(\)\)/);
  });

  it('opens project directory by allowlisted key, not renderer-supplied path', async () => {
    const appIpc = await readRepo(APP_IPC);
    const guard = await readRepo('apps/desktop/src/main/open-path-guard.ts');
    const renderer = await readRendererShellCombinedSource();

    assert.match(appIpc, /key === 'project'[\s\S]*await deps\.getProjectRoot\(sessionId\)/);
    assert.match(appIpc, /resolveOpenPath\(\{ key, workspaceRoot, projectRoot: projectPath \}\)/);
    assert.match(guard, /value === 'project'/);
    assert.match(renderer, /window\.maka\.app\.openPath\('project', sessionId\)/);
    assert.doesNotMatch(renderer, /openPath\(appInfo\.projectPath\)/);
  });

  it('renders the guarded project picker below the composer', async () => {
    const ui = await readRepo('packages/ui/src/composer.tsx');
    // Issue #1044: the workspace row JSX + its picker prop shapes moved into
    // ComposerWorkspaceRow; Composer forwards the props. The picker-contract
    // assertions read the row component, the prop wiring stays on Composer.
    const workspaceRow = await readRepo('packages/ui/src/composer-workspace-row.tsx');
    const styles = await readRendererContractCss();
    const renderer = await readRendererShellCombinedSource();

    assert.match(ui, /workspacePicker\?: ComposerWorkspacePicker;/);
    assert.match(ui, /<ComposerWorkspaceRow workspacePicker=\{props\.workspacePicker\} branchPicker=\{props\.branchPicker\} \/>/);
    assert.match(workspaceRow, /className="maka-composer-workspace-picker"/);
    assert.match(workspaceRow, /branch\?: string \| null;/);
    assert.match(workspaceRow, /pending\?: boolean;/);
    assert.match(workspaceRow, /projects:\s*readonly ProjectRecord\[\]/);
    assert.match(workspaceRow, /className="maka-composer-project-scroll"/);
    assert.match(workspaceRow, /className="maka-composer-no-project"/);
    assert.match(workspaceRow, /wp\.onRelink\(project\.id\)/);
    assert.match(workspaceRow, /wp\.onSelectNoProject\(\)/);
    assert.match(workspaceRow, /disabled=\{wp\.pending === true\}/);
    assert.match(workspaceRow, /aria-busy=\{wp\.pending === true \? 'true' : undefined\}/);
    // WAWQAQ msg `28128c9e` (2026-06-20): the "选择工作目录" placeholder
    // is only rendered when no directory has been selected yet. Once
    // a label is set, the picker renders `.maka-composer-workspace-current`
    // alone — no more "选择工作目录 ai ▾" doubled string.
    assert.match(workspaceRow, /\? <span className="maka-composer-workspace-current">\{wp\.label\}<\/span>[\s\S]*?: <span>\{copy\.choose\}<\/span>/);
    assert.match(workspaceRow, /title=\{copy\.branchTitle\(bp\.branch \?\? undefined\)\}/);
    // Workspace picker must track the shared chat/composer measure token,
    // not a bespoke hard-coded width, so future measure updates keep the
    // row aligned with the composer card automatically.
    assert.match(styles, /\.maka-composer-workspace-row\s*\{[\s\S]*?width:\s*min\(var\(--maka-chat-measure\),\s*100%\)/);
    assert.match(styles, /\.maka-composer-workspace-picker\s*\{/);
    assert.match(styles, /\.maka-composer-project-scroll\s*\{[\s\S]*?overflow-y:\s*auto/);
    assert.match(styles, /\.maka-composer-no-project\s*\{/);
    assert.match(styles, /-webkit-app-region:\s*no-drag/);
    assert.match(renderer, /currentProject\?\.name/);
    assert.match(renderer, /branch:\s*currentProjectId === null \? null : projectInfo\?\.projectGit\.branch/);
    assert.match(renderer, /workspacePicker=\{\{/);
    assert.doesNotMatch(ui, /className="maka-project-badge"/);
  });

  it('adds a command palette action for the same guarded project open path', async () => {
    const palette = await readRepo('apps/desktop/src/renderer/command-palette-commands.ts');
    const renderer = await readRendererShellCombinedSource();
    const openProjectBlock = renderer.match(/async function openProjectFolder\(\)[\s\S]*?async function openWorkspaceFolder/)?.[0] ?? '';
    const openWorkspaceBlock = renderer.match(/async function openWorkspaceFolder\(\)[\s\S]*?function createSkillFailureCopy/)?.[0] ?? '';

    assert.match(palette, /onOpenProjectFolder\?\(\): Promise<void> \| void/);
    assert.match(palette, /id:\s*'diag:open-project-folder'/);
    assert.match(palette, /\.\.\.staticCopy\('diag:open-project-folder'\)/);
    // #1045: run() reads folder openers from the live options ref.
    assert.match(renderer, /onOpenProjectFolder:\s*\(\)\s*=>\s*optionsRef\.current\.openProjectFolder\(\)/);
    assert.match(renderer, /onOpenWorkspace: async \(\) => \{\s*await optionsRef\.current\.openWorkspaceFolder\(\);\s*\}/);
    assert.match(
      renderer,
      /function openPathActionErrorMessage\([\s\S]*?key: 'workspace' \| 'project' \| 'skills',[\s\S]*?locale: UiLocale,[\s\S]*?const copy = getShellCopy\(locale\);[\s\S]*?localizedErrorMessage\(error, copy\.errors\.openPath\(copy\.paths\[key\]\), locale\)/,
    );
    assert.match(
      openProjectBlock,
      /catch \(error\) \{[\s\S]*toastApi\.error\(\s*copy\.openFailedTitle\(openPathActionLabel\('project', uiLocale\)\),\s*openPathActionErrorMessage\(error, 'project', uiLocale\)/,
    );
    assert.match(
      openWorkspaceBlock,
      /catch \(error\) \{[\s\S]*toastApi\.error\(\s*copy\.openFailedTitle\(openPathActionLabel\('workspace', uiLocale\)\),\s*openPathActionErrorMessage\(error, 'workspace', uiLocale\)/,
    );
    assert.doesNotMatch(openProjectBlock, /cleanErrorMessage\(error\)/);
    assert.doesNotMatch(openWorkspaceBlock, /cleanErrorMessage\(error\)/);
    assert.doesNotMatch(palette, /openPath\('project'\)/);
  });
});
