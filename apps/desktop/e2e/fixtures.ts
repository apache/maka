import { _electron as electron, test as base, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createConnectionStore, createFileCredentialStore, createSettingsStore } from '@maka/storage';
import { buildFixtureEnv, isCiLinuxDisplay } from '../../../scripts/fixture-env.mjs';
import { closeElectronApplication } from '../../../scripts/electron-lifecycle.mjs';

const DESKTOP_ROOT = process.cwd();

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

/**
 * The sandboxed HOME of the run currently under test. Set by withE2eWindow
 * before Electron launches.
 *
 * Read it from inside a test BODY, never as a fixture: a fixture would have no
 * declared dependency on the window fixture, so Playwright could resolve it
 * before the window is set up and hand back a stale path.
 */
let currentHomeDir = '';

export function e2eHomeDir(): string {
  if (!currentHomeDir) throw new Error('e2eHomeDir() is only valid inside a test that opened a window');
  return currentHomeDir;
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
    invocableSkills,
    extraConnectionCount,
  }: {
    seed: boolean;
    readinessSelector: string;
    e2eFixtureScenario?: string;
    locale?: 'zh' | 'en';
    /** #1312: force app:info's platform so the window boots natively into that platform's `data-os` cascade. */
    platform?: 'darwin' | 'win32' | 'linux';
    invocableSkills?: boolean;
    extraConnectionCount?: number;
  },
  use: (page: Page) => Promise<void>,
): Promise<void> {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
  // Lives inside the throwaway userData dir so the existing teardown removes
  // it too — there is no second path to leak.
  const homeDir = path.join(userDataDir, 'home');
  await mkdir(homeDir, { recursive: true });
  currentHomeDir = homeDir;
  let app: ElectronApplication | undefined;
  const mainLogs: string[] = [];
  const rendererLogs: string[] = [];
  try {
    if (seed) await seedE2eConnection(userDataDir, extraConnectionCount);
    if (invocableSkills) await seedE2eInvocableSkills(userDataDir);
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
        // xvfb throttles a hidden window's compositor to ~1fps; only that
        // isolated display gets a visible window.
        showWindow: isCiLinuxDisplay(),
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
  firstRunWindow: Page;
  modelPickerLongWindow: Page;
  longTranscriptWindow: Page;
  shortFinalTurnWindow: Page;
  overflowingRailWindow: Page;
  sidebarLongSessionsWindow: Page;
  disclosureOutputWindow: Page;
  sandboxBoundaryWindow: Page;
  readOnlyBoundaryWindow: Page;
  staleSessionsWindow: Page;
  sessionWorkbarWindow: Page;
  botSettingsWindow: Page;
  localeSwitchWindow: Page;
  invocableSkillsWindow: Page;
  planRemindersWindow: Page;
  oauthReloginWindow: Page;
}>({
  // Seeded: a pre-staged connection clears onboarding so the composer is ready.
  // Used by chat / session / settings / attachment specs.
  window: async ({}, use) => {
    await withE2eWindow({ seed: true, readinessSelector: COMPOSER_INPUT, locale: 'zh' }, use);
  },
  // No connection: the real main process derives `needs_connection`, and the
  // renderer replaces the empty chat with the first-task activation card.
  firstRunWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        readinessSelector: '[data-maka-contract="onboarding-card"]',
        e2eFixtureScenario: 'first-run',
        locale: 'zh',
      },
      use,
    );
  },
  modelPickerLongWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: true,
        readinessSelector: COMPOSER_INPUT,
        locale: 'zh',
        extraConnectionCount: 10,
      },
      use,
    );
  },
  // Long transcript: boots the e2e-fixture `long-transcript` fixture, which
  // seeds a 24-turn (~1300px each) session and opens it as the active
  // session. Fixture mode seeds its own connections, so no connection is
  // pre-staged here. Readiness = turns on screen and RENDERED BY THE REAL
  // MARKDOWN PIPELINE: the session is open and above-viewport turns sit at
  // their content-visibility placeholder size. Used by the scroll-geometry
  // spec.
  //
  // `.maka-markdown-pending` is the Suspense fallback for the lazily imported
  // markdown chunk, and the turn-size warm-up will not start while one is on
  // screen. Handing the page over before that chunk lands charged the spec's
  // settle budget for a module load: under 50x CPU throttling the fallback
  // holds for ~9.6s of a ~19s cold start, most of the spec's 15s, for work
  // that is boot rather than settling.
  longTranscriptWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        readinessSelector: '[data-chat-scroll-container="true"]:has(.maka-turn):not(:has(.maka-markdown-pending))',
        e2eFixtureScenario: 'long-transcript',
        locale: 'zh',
      },
      use,
    );
  },
  // Short final turn: boots the e2e-fixture `short-final-turn` fixture — five
  // tall turns and a one-line last turn — and opens it as the active session.
  // Same readiness contract as `longTranscriptWindow` and for the same reason:
  // the markdown chunk must have landed before the spec scrolls. Used by the
  // prompt-rail spec to reach an end of the scroller that the rail's
  // activation band never covers.
  shortFinalTurnWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        readinessSelector: '[data-chat-scroll-container="true"]:has(.maka-turn):not(:has(.maka-markdown-pending))',
        e2eFixtureScenario: 'short-final-turn',
        locale: 'zh',
      },
      use,
    );
  },
  // Overflowing rail: boots the e2e-fixture `overflowing-rail` fixture — 90
  // short turns — and opens it as the active session. Same readiness contract
  // as the two above. Used by the prompt-rail spec to exercise the rail once it
  // is past its cap and scrolling independently of the transcript.
  overflowingRailWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        readinessSelector: '[data-chat-scroll-container="true"]:has(.maka-turn):not(:has(.maka-markdown-pending))',
        e2eFixtureScenario: 'overflowing-rail',
        locale: 'zh',
      },
      use,
    );
  },
  // Long sidebar sessions: boots the e2e-fixture `sidebar-long-sessions`
  // fixture, which seeds 60 active sessions and opens the newest one
  // (`...-00`) with the sidebar expanded. Fixture mode seeds its own
  // connections, so no connection is pre-staged here. Readiness = a session
  // row on screen INSIDE AN EXPANDED SIDEBAR: the panel grid has mounted, the
  // session list has loaded from IPC, and the footer sits below the
  // constrained list row. Used by the sidebar-geometry and sidebar-navigation
  // specs.
  //
  // The `[data-sidebar-state="expanded"]` part is load-bearing. The shell
  // boots collapsed (the localStorage default), and `sidebarCollapsed: false`
  // only lands later, from `applyE2eFixture` — a rAF plus two IPC round trips
  // after mount. A bare session label does not gate on it: a collapsed
  // sidebar keeps the whole list mounted at full width behind `opacity: 0` in
  // a 0px grid column, which Playwright still reports as visible. Tests then
  // started against a sidebar that was about to expand under them.
  sidebarLongSessionsWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        readinessSelector: '[data-sidebar-state="expanded"] [data-session-id]',
        e2eFixtureScenario: 'sidebar-long-sessions',
        locale: 'zh',
      },
      use,
    );
  },
  disclosureOutputWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        readinessSelector: '.astryx-chat-tool-calls [role="button"][aria-expanded="false"]',
        e2eFixtureScenario: 'disclosure-output',
        locale: 'zh',
      },
      use,
    );
  },
  // Sandbox-boundary takeover: boots a deterministic expansion request in the
  // real desktop shell so the composer-slot placement and non-modal behavior
  // are covered without a provider or test-only renderer state path.
  sandboxBoundaryWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '.maka-sandbox-boundary-prompt', e2eFixtureScenario: 'sandbox-boundary', locale: 'zh' },
      use,
    );
  },
  // Read-only boundary (#1611): the Deep Research fixture session is seeded
  // with `permissionMode: 'explore'`, so the metadata store derives a genesis
  // managed read-only boundary for it. That makes this the only window where
  // the composer's permission label is driven by a real read-only profile
  // travelling main → IPC → renderer.
  readOnlyBoundaryWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: COMPOSER_INPUT, e2eFixtureScenario: 'deep-research-progress', locale: 'zh' },
      use,
    );
  },
  // Stale sessions: boots the e2e-fixture `stale-sessions` fixture — one
  // healthy session (zai-live, secret seeded) and one locked fake-backend session
  // (opened active). Exercises the #1038 health-notice authority against real IPC
  // (connection list, hasSecret probe, connectionLocked summaries).
  // Readiness = turns on screen: the fake session is open.
  staleSessionsWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '.maka-turn', e2eFixtureScenario: 'stale-sessions', locale: 'zh' },
      use,
    );
  },
  // Session workbar: seeds a task tree and opens the unified auxiliary
  // workspace so its shell controls and peer tabs run against real IPC data.
  sessionWorkbarWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        // The data contract, not the tag: the panel's surface is an Astryx Card
        // (a div carrying role="complementary"), so a tag-anchored selector
        // would pin an implementation detail the design system owns.
        readinessSelector: '[data-maka-contract="session-workbar"]',
        e2eFixtureScenario: 'task-ledger',
        locale: 'zh',
      },
      use,
    );
  },
  // Remote access: uses the e2e-fixture workspace so Settings opens on the
  // channel catalog and main injects deterministic IM onboarding adapters.
  // The renderer still talks through the real preload/IPC/session authority.
  botSettingsWindow: async ({}, use) => {
    await withE2eWindow(
      { seed: false, readinessSelector: '[aria-label="设置内容"]', e2eFixtureScenario: 'settings-bots', locale: 'zh' },
      use,
    );
  },
  // Keep this fixture unpinned so the Follow system assertion observes the
  // actual host language while the legacy fixtures remain deterministic.
  localeSwitchWindow: async ({}, use) => {
    await withE2eWindow({ seed: true, readinessSelector: COMPOSER_INPUT }, use);
  },
  // Project + Maka-workspace Skills with one deliberately host-incompatible
  // entry. Proves `/` uses Runtime discovery/gating rather than management UI data.
  invocableSkillsWindow: async ({}, use) => {
    await withE2eWindow({
      seed: true,
      readinessSelector: COMPOSER_INPUT,
      locale: 'zh',
      invocableSkills: true,
    }, use);
  },
  planRemindersWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        readinessSelector: '.maka-module-page-rows',
        e2eFixtureScenario: 'plan-reminders',
        locale: 'zh',
      },
      use,
    );
  },
  oauthReloginWindow: async ({}, use) => {
    await withE2eWindow(
      {
        seed: false,
        // The connection detail is a page now, not a dialog; waiting on
        // `dialog[open]` waited for markup this redesign deleted.
        readinessSelector: '[data-maka-contract="connection-detail"]',
        e2eFixtureScenario: 'oauth-relogin',
        locale: 'zh',
      },
      use,
    );
  },
});

export { expect };
