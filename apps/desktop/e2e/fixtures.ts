import { _electron as electron, test as base, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createConnectionStore, createFileCredentialStore, createSettingsStore } from '@maka/storage';
import { buildFixtureEnv, isCiLinuxDisplay } from '../../../scripts/fixture-env.mjs';
import { closeElectronApplication } from '../../../scripts/electron-lifecycle.mjs';

const DESKTOP_ROOT = process.cwd();
const execFileAsync = promisify(execFile);

/**
 * The composer's text surface. It is Astryx's `ChatComposerInput`, so the
 * typing target is the contentEditable inside the component root, not the
 * root itself — and `toHaveValue` / `.value` no longer apply: assert with
 * `toHaveText` and type with `fill` / `pressSequentially`.
 *
 * `toHaveText` reads an inline token's rendered label, not the value it
 * serializes to on send. Assert a mention's wire form through the fake
 * backend echo and its display form on the sent message.
 */
export const COMPOSER_INPUT = '.maka-composer-editor [contenteditable="true"]';

/**
 * Wait for Runtime's authoritative Skill projection, not merely for the
 * composer DOM to mount. The renderer requests this projection after its first
 * render, so a visible editor can still have an empty `/` source during cold
 * start.
 */
export async function waitForInvocableSkills(
  page: Page,
  expectedIds: readonly string[],
): Promise<void> {
  await expect
    .poll(async () =>
      page.evaluate(async () =>
        (await window.maka.skills.listInvocable(undefined)).map((skill) => skill.id),
      ),
    )
    .toEqual(expect.arrayContaining(expectedIds));
}

/**
 * Pre-seed a real-looking connection into the throwaway workspace so onboarding
 * clears and the composer is enabled. Actual sessions still run on the fake
 * backend (BackendRegistry override in main); this only satisfies the UI
 * readiness gates. Kept in the fixture so test data stays out of production main.
 */
async function seedE2eConnection(
  userDataDir: string,
  extraConnectionCount = 0,
): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  const connections = createConnectionStore(workspaceRoot);
  const credentials = createFileCredentialStore(workspaceRoot);
  await connections.create({
    slug: 'e2e',
    name: 'E2E',
    providerType: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
  });
  await credentials.setSecret('e2e', 'api_key', 'e2e-placeholder');
  for (let index = 0; index < extraConnectionCount; index += 1) {
    const slug = `e2e-extra-${index + 1}`;
    await connections.create({
      slug,
      name: `E2E Extra ${index + 1}`,
      providerType: 'anthropic',
      defaultModel: `claude-e2e-${index + 1}`,
    });
    await credentials.setSecret(slug, 'api_key', 'e2e-placeholder');
  }
  await connections.setDefault('e2e');
}

async function seedE2eLocale(userDataDir: string, locale: 'zh' | 'en'): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  await createSettingsStore(workspaceRoot).update({
    personalization: { uiLocale: locale },
  });
}

async function seedE2eInvocableSkills(userDataDir: string): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  const projectRoot = path.join(userDataDir, 'project');
  const projectSkillRoot = path.join(projectRoot, '.maka', 'skills');
  const workspaceSkillRoot = path.join(workspaceRoot, 'skills');
  // Under the sandboxed HOME (see buildE2eEnv), so `~/.agents/skills` here is
  // the throwaway dir, never the developer's. This is the only user-scope
  // skill the suite sees, which is what makes the delete journey assertable.
  const userSkillRoot = path.join(userDataDir, 'home', '.agents', 'skills');
  await Promise.all([
    mkdir(path.join(projectSkillRoot, 'project-only'), { recursive: true }),
    mkdir(path.join(projectSkillRoot, 'host-incompatible'), { recursive: true }),
    mkdir(path.join(projectSkillRoot, 'agent-write'), { recursive: true }),
    mkdir(path.join(projectSkillRoot, 'deep-research-only'), { recursive: true }),
    mkdir(path.join(workspaceSkillRoot, 'workspace-only'), { recursive: true }),
    mkdir(path.join(userSkillRoot, 'user-only'), { recursive: true }),
  ]);
  await writeFile(
    path.join(userSkillRoot, 'user-only', 'SKILL.md'),
    `---\nname: User Only\ndescription: User-scoped install, deletable from the panel.\n---\n# User Only`,
    'utf8',
  );
  await Promise.all([
    writeFile(
      path.join(projectSkillRoot, 'project-only', 'SKILL.md'),
      `---\nname: Project Only\ndescription: Project-scoped suggestion.\n---\n# Project Only`,
      'utf8',
    ),
    writeFile(
      path.join(projectSkillRoot, 'host-incompatible', 'SKILL.md'),
      `---\nname: Host Incompatible\ndescription: Must be hidden from this host.\nrequired-tools: [DefinitelyMissingTool]\n---\n# Host Incompatible`,
      'utf8',
    ),
    writeFile(
      path.join(projectSkillRoot, 'agent-write', 'SKILL.md'),
      `---\nname: Agent Write\ndescription: Requires a mutating tool excluded from Plan mode.\nrequired-tools: [Write]\n---\n# Agent Write`,
      'utf8',
    ),
    writeFile(
      path.join(projectSkillRoot, 'deep-research-only', 'SKILL.md'),
      `---\nname: Deep Research Only\ndescription: Requires a tool available only in Deep Research mode.\nrequired-tools: [deep_research_status]\n---\n# Deep Research Only`,
      'utf8',
    ),
    writeFile(
      path.join(workspaceSkillRoot, 'workspace-only', 'SKILL.md'),
      `---\nname: Workspace Only\ndescription: Maka workspace suggestion.\n---\n# Workspace Only`,
      'utf8',
    ),
    writeFile(
      path.join(workspaceRoot, 'last-project-path.json'),
      JSON.stringify({ projectPath: projectRoot }),
      'utf8',
    ),
  ]);
}

async function seedE2eGitReviewProject(
  userDataDir: string,
  extraUntrackedFiles = 0,
): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  const projectRoot = path.join(userDataDir, 'git-review-project');
  await mkdir(projectRoot, { recursive: true });
  const git = (...args: string[]) =>
    execFileAsync('git', ['-C', projectRoot, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Maka E2E');
  await git('config', 'user.email', 'maka-e2e@example.invalid');
  await writeFile(path.join(projectRoot, 'base.txt'), 'base\n', 'utf8');
  await git('add', 'base.txt');
  await git('commit', '-m', 'base');
  await git('checkout', '-b', 'feature/review');
  await writeFile(path.join(projectRoot, 'feature.txt'), 'feature\n', 'utf8');
  await git('add', 'feature.txt');
  await git('commit', '-m', 'feature');
  await writeFile(path.join(projectRoot, 'base.txt'), 'base\nunstaged\n', 'utf8');
  await writeFile(path.join(projectRoot, 'staged.txt'), 'staged\n', 'utf8');
  await git('add', 'staged.txt');
  await writeFile(path.join(projectRoot, 'untracked.txt'), 'untracked\n', 'utf8');
  await Promise.all(
    Array.from({ length: extraUntrackedFiles }, (_, index) =>
      writeFile(
        path.join(projectRoot, `bulk-${String(index).padStart(3, '0')}.txt`),
        `bulk ${index}\n`,
        'utf8',
      ),
    ),
  );
  await writeFile(
    path.join(workspaceRoot, 'last-project-path.json'),
    JSON.stringify({ projectPath: projectRoot }),
    'utf8',
  );
}

/**
 * Own the full launch lifecycle so a failure anywhere — seeding, Electron
 * launch, firstWindow, or the readiness wait — still tears down the Electron
 * process and the throwaway userData dir. The previous shape ran `mkdtemp`
 * and `launchE2eApp` outside the try, so a readiness timeout left a zombie
 * Electron and a leaked `maka-e2e-*` directory.
 */
async function withE2eWindow(
  {
    seed,
    readinessSelector,
    e2eFixtureScenario,
    locale,
    platform,
    showWindow,
    invocableSkills,
    gitReviewExtraFiles,
    extraConnectionCount,
  }: {
    seed: boolean;
    readinessSelector: string;
    e2eFixtureScenario?: string;
    locale?: 'zh' | 'en';
    /** #1312: force app:info's platform so the window boots natively into that platform's `data-os` cascade. */
    platform?: 'darwin' | 'win32' | 'linux';
    /** Show fixtures whose contract depends on compositor-paced frames. */
    showWindow?: boolean;
    invocableSkills?: boolean;
    gitReviewExtraFiles?: number;
    extraConnectionCount?: number;
  },
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
  // Lives inside the throwaway userData dir so the existing teardown removes
  // it too — there is no second path to leak.
  const homeDir = path.join(userDataDir, 'home');
  await mkdir(homeDir, { recursive: true });
  let app: ElectronApplication | undefined;
  const mainLogs: string[] = [];
  const rendererLogs: string[] = [];
  try {
    if (seed) await seedE2eConnection(userDataDir, extraConnectionCount);
    if (invocableSkills) await seedE2eInvocableSkills(userDataDir);
    if (gitReviewExtraFiles !== undefined) {
      await seedE2eGitReviewProject(userDataDir, gitReviewExtraFiles);
    }
    // Legacy E2E specs assert Chinese labels and should not inherit the CI
    // host locale. E2e-fixture workspaces use the explicit renderer override.
    if (locale && !e2eFixtureScenario) await seedE2eLocale(userDataDir, locale);
    app = await electron.launch({
      args: ['.'],
      cwd: DESKTOP_ROOT,
      env: buildFixtureEnv(userDataDir, homeDir, {
        scenario: e2eFixtureScenario,
        locale,
        platform,
        // xvfb throttles a hidden window's compositor to ~1fps. Geometry
        // fixtures opt in locally; every fixture is visible on isolated CI X.
        showWindow: showWindow || isCiLinuxDisplay(),
      }),
    });
    app.on('console', (message) => {
      mainLogs.push(message.text());
      if (mainLogs.length > 20) mainLogs.shift();
    });
    let page: Page;
    try {
      page = await app.firstWindow();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const logs = mainLogs.length > 0 ? `\nElectron main console:\n${mainLogs.join('\n')}` : '';
      throw new Error(`${detail}${logs}`, { cause: error });
    }
    page.on('console', (message) => {
      rendererLogs.push(`[console:${message.type()}] ${message.text()}`);
      if (rendererLogs.length > 30) rendererLogs.shift();
    });
    page.on('pageerror', (error) => {
      rendererLogs.push(`[pageerror] ${error.stack ?? error.message}`);
      if (rendererLogs.length > 30) rendererLogs.shift();
    });
    // Centralize the cold-start wait so test bodies are flake-free under retries:0.
    try {
      await page.waitForSelector(readinessSelector, { timeout: 20_000 });
      if (invocableSkills) {
        await waitForInvocableSkills(page, ['project-only', 'workspace-only']);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const mainDetail = mainLogs.length > 0 ? `\nElectron main console:\n${mainLogs.join('\n')}` : '';
      const rendererDetail = rendererLogs.length > 0 ? `\nRenderer console:\n${rendererLogs.join('\n')}` : '';
      throw new Error(`${detail}${mainDetail}${rendererDetail}`, { cause: error });
    }
    await use(page);
  } finally {
    try {
      if (app) await closeElectronApplication(app, 5_000);
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  }
}

export const test = base.extend<{
  window: Page;
  artifactPaneWindow: Page;
  invocableSkillsWindow: Page;
}>({
  // Seeded: a pre-staged connection clears onboarding so the composer is ready.
  window: async ({}, use) => {
    await withE2eWindow({ seed: true, readinessSelector: COMPOSER_INPUT, locale: 'zh' }, use);
  },
  artifactPaneWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        readinessSelector: '.maka-artifact-list',
        e2eFixtureScenario: 'artifact-pane',
        locale: 'zh',
      },
      use,
    );
  },
  // Project + workspace Skills for draft/chip journeys.
  invocableSkillsWindow: async ({}, use) => {
    await withE2eWindow({
      seed: true,
      readinessSelector: COMPOSER_INPUT,
      locale: 'zh',
      invocableSkills: true,
    }, use);
  },
});

export { expect };
