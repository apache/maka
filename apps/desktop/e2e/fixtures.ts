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

import { _electron as electron, test as base, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  createProjectCatalog,
  createSessionStore,
  createSettingsStore,
} from '@maka/storage';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
} from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
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
export const PARENT_REMOVAL_PARENT_NAME = '待删除的父任务';
export const PARENT_REMOVAL_CHILD_NAME = '应归档的子任务';
/** Directory basename, and so the Project name the workspace picker lists. */
export const NEW_TASK_PROJECT_NAME = 'new-task-project';

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
async function seedE2eConnection(userDataDir: string): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  const capability = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) throw new Error('E2E fixture could not acquire its isolated Runtime Host root');
  try {
    const stores = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const catalog = await stores.connectionCatalog.getSnapshot();
    const created = await stores.connectionCatalog.create({
      expectedCatalogRevision: catalog.revision,
      connection: {
        slug: 'e2e',
        name: 'E2E',
        providerType: 'anthropic',
        enabled: true,
        enabledModelIds: ['claude-sonnet-4-5-20250929'],
      },
    });
    if (created.kind !== 'committed') {
      throw new Error(`E2E connection seed was not committed: ${created.kind}`);
    }
    const connection = created.snapshot.connections.find(({ slug }) => slug === 'e2e');
    if (!connection) throw new Error('E2E connection seed is missing from the committed catalog');
    const credential = await stores.credentialVault.set({
      locator: {
        scope: 'connection',
        connectionId: connection.connectionId,
        kind: 'api_key',
      },
      expected: null,
      secret: 'e2e-placeholder',
    });
    if (credential.kind !== 'committed') {
      throw new Error(`E2E credential seed was not committed: ${credential.kind}`);
    }
    const modelFetch = await stores.operations.beginModelFetch(connection.connectionId);
    if (modelFetch.kind !== 'ready') {
      throw new Error(`E2E model inventory seed could not start: ${modelFetch.kind}`);
    }
    const modelInventory = await stores.operations.completeModelFetch(modelFetch.ticket, {
      models: [{ id: 'claude-sonnet-4-5-20250929' }],
      source: 'fallback',
      fetchedAt: 0,
    });
    if (modelInventory.kind !== 'committed') {
      throw new Error(`E2E model inventory seed was not committed: ${modelInventory.kind}`);
    }
    const defaultTarget = await stores.connectionCatalog.setDefaultTarget({
      expectedCatalogRevision: modelInventory.snapshot.revision,
      target: {
        connectionId: connection.connectionId,
        modelId: 'claude-sonnet-4-5-20250929',
      },
    });
    if (defaultTarget.kind !== 'committed') {
      throw new Error(`E2E default target seed was not committed: ${defaultTarget.kind}`);
    }
  } finally {
    await owner.close();
  }
}

async function seedE2eLocale(userDataDir: string, locale: 'zh' | 'en'): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  await createSettingsStore(workspaceRoot).update({
    personalization: { uiLocale: locale },
  });
}

async function seedParentRemovalSessions(userDataDir: string): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  const store = createSessionStore(workspaceRoot);
  try {
    const parent = await store.create({
      cwd: path.join(userDataDir, 'project'),
      llmConnectionSlug: 'e2e',
      model: 'claude-sonnet-4-5-20250929',
      permissionMode: 'ask',
      name: PARENT_REMOVAL_PARENT_NAME,
      labels: [],
    });
    await store.createSubagent({
      cwd: path.join(userDataDir, 'project'),
      llmConnectionSlug: 'e2e',
      model: 'claude-sonnet-4-5-20250929',
      permissionMode: 'execute',
      name: PARENT_REMOVAL_CHILD_NAME,
      labels: [],
      subagentParent: {
        kind: 'subagent',
        parentSessionId: parent.id,
        spawnedBy: {
          parentRunId: 'e2e-parent-run',
          parentTurnId: 'e2e-parent-turn',
          toolCallId: 'e2e-spawn-call',
        },
        lifecycle: 'foreground',
      },
      subagentRuntime: {
        schemaVersion: 1,
        definitionVersion: 1,
        agentId: 'implementation',
        agentName: 'Implementation',
        profile: 'implementation',
        systemPrompt: 'Implement the assigned task.',
        toolNames: ['Read', 'Write'],
        categoryPolicy: {},
      },
      subagentSpawn: {
        schemaVersion: 1,
        requestFingerprint: 'a'.repeat(64),
        initialTurnId: 'e2e-child-turn',
        initialRunId: 'e2e-child-run',
      },
    });
  } finally {
    await store.close?.();
  }
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
  ]);
  await seedCurrentProject(workspaceRoot, projectRoot);
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
  await seedCurrentProject(workspaceRoot, projectRoot);
}

/**
 * One registered Project and nothing else, so the workspace picker under the
 * new-task composer offers two selectable targets: this Project and the Host's
 * implicit "no project". The new-task draft slot is keyed by (profile, host,
 * project), so moving between them is what re-keys it (#3408). The directory is
 * plain — its basename becomes the Project name the picker menu shows.
 */
async function seedE2eNewTaskProject(userDataDir: string): Promise<void> {
  const workspaceRoot = path.join(userDataDir, 'workspaces', 'default');
  const projectRoot = path.join(userDataDir, NEW_TASK_PROJECT_NAME);
  await mkdir(projectRoot, { recursive: true });
  await seedCurrentProject(workspaceRoot, projectRoot);
}

async function seedCurrentProject(workspaceRoot: string, projectRoot: string): Promise<void> {
  const storageRoot = await resolveStorageRoot({ path: workspaceRoot, kind: 'interactive' });
  const catalog = createProjectCatalog(workspaceRoot);
  try {
    const project = await catalog.register(projectRoot);
    await writeFile(
      path.join(workspaceRoot, 'project-preferences.json'),
      JSON.stringify({ version: 1, selections: { [storageRoot.rootId]: project.id } }),
      'utf8',
    );
  } finally {
    catalog.close();
  }
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
    scrollMotion,
    invocableSkills,
    gitReviewExtraFiles,
    parentRemovalSessions,
    newTaskProject,
  }: {
    seed: boolean;
    readinessSelector: string;
    e2eFixtureScenario?: string;
    locale?: 'zh' | 'en';
    /** Opt this window back into animated scrolling; see `scroll-motion-policy`. */
    scrollMotion?: 'auto' | 'smooth';
    /** #1312: force app:info's platform so the window boots natively into that platform's `data-os` cascade. */
    platform?: 'darwin' | 'win32' | 'linux';
    /** Show fixtures whose contract depends on compositor-paced frames. */
    showWindow?: boolean;
    invocableSkills?: boolean;
    gitReviewExtraFiles?: number;
    parentRemovalSessions?: boolean;
    newTaskProject?: boolean;
  },
  use: (page: Page, context: { userDataDir: string }) => Promise<void>,
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
    if (seed) await seedE2eConnection(userDataDir);
    if (parentRemovalSessions) await seedParentRemovalSessions(userDataDir);
    if (invocableSkills) await seedE2eInvocableSkills(userDataDir);
    if (gitReviewExtraFiles !== undefined) {
      await seedE2eGitReviewProject(userDataDir, gitReviewExtraFiles);
    }
    if (newTaskProject) await seedE2eNewTaskProject(userDataDir);
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
        scrollMotion,
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
    await use(page, { userDataDir });
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
  onboardingWindow: Page;
  gitReviewWindow: { page: Page; projectRoot: string };
  invocableSkillsWindow: Page;
  linkColorWindow: Page;
  projectSidebarWindow: Page;
  parentRemovalWindow: Page;
  promptRailWindow: Page;
  promptRailMotionWindow: Page;
  requestHeaderRowWindow: Page;
  newTaskTargetWindow: Page;
}>({
  // Seeded: a pre-staged connection clears onboarding so the composer is ready.
  window: async ({}, use) => {
    await withE2eWindow({ seed: true, readinessSelector: COMPOSER_INPUT, locale: 'zh' }, use);
  },
  onboardingWindow: async ({}, use) => {
    await withE2eWindow({
      seed: false,
      readinessSelector: '[data-maka-contract="onboarding-card"]',
      locale: 'zh',
      showWindow: true,
    }, use);
  },
  gitReviewWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: true,
        readinessSelector: COMPOSER_INPUT,
        locale: 'zh',
        gitReviewExtraFiles: 0,
      },
      async (page, context) => {
        await use({
          page,
          projectRoot: path.join(context.userDataDir, 'git-review-project'),
        });
      },
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
  linkColorWindow: async ({}, use) => {
    await withE2eWindow({
      seed: false,
      readinessSelector: '.settingsBotConfigDocLink',
      e2eFixtureScenario: 'settings-bots-onboarding',
    }, use);
  },
  // A real project with several sessions. Shown because the contract under
  // test is native focus order across independently interactive row controls.
  // Seeded connection so the composer is ready, plus one registered Project so
  // the workspace picker under it has a second target to move to.
  newTaskTargetWindow: async ({}, use) => {
    await withE2eWindow({
      seed: true,
      readinessSelector: COMPOSER_INPUT,
      locale: 'zh',
      newTaskProject: true,
      showWindow: true,
    }, use);
  },
  projectSidebarWindow: async ({}, use) => {
    await withE2eWindow({
      seed: false,
      readinessSelector: '[data-maka-contract="search-modal"][open]',
      e2eFixtureScenario: 'sidebar-search-modal-open',
      locale: 'zh',
      showWindow: true,
    }, use);
  },
  parentRemovalWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: true,
        readinessSelector: COMPOSER_INPUT,
        locale: 'zh',
        parentRemovalSessions: true,
      },
      use,
    );
  },
  // A multi-prompt transcript for the prompt anchor rail. Shown, because every
  // assertion in prompt-rail.spec.ts is geometry the compositor has to settle.
  promptRailWindow: async ({}, use) => {
    await withE2eWindow({
      seed: false,
      // A rendered turn, deliberately not the rail: Playwright treats a
      // zero-area element as hidden, so gating readiness on a tick would turn
      // every rail regression into a 20s cold-start timeout instead of the
      // assertion that names it.
      readinessSelector: '[data-turn-id]',
      e2eFixtureScenario: 'chat-prompt-rail',
      showWindow: true,
    }, use);
  },
  // The same transcript, scrolling the way the shipped app scrolls. Separate
  // from `promptRailWindow` because it is only the jump that needs a scroll
  // still in flight, and paying for one everywhere costs several seconds per
  // window and settles less predictably.
  promptRailMotionWindow: async ({}, use) => {
    await withE2eWindow({
      seed: false,
      readinessSelector: '[data-turn-id]',
      e2eFixtureScenario: 'chat-prompt-rail',
      showWindow: true,
      scrollMotion: 'smooth',
    }, use);
  },
  // Settings → 模型, where `no-models` is the seeded openai-compatible relay —
  // the connection type whose detail page owns the custom request headers
  // editor. Shown, because what this window is for is a rendered box
  // measurement and a throttled compositor is not a layout the user has.
  requestHeaderRowWindow: async ({}, use) => {
    await withE2eWindow({
      seed: false,
      readinessSelector: '.settingsSurface',
      e2eFixtureScenario: 'settings-models',
      locale: 'zh',
      showWindow: true,
    }, use);
  },
});

export { expect };
