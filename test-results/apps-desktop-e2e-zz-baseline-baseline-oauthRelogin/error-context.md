# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: apps/desktop/e2e/zz-baseline.spec.ts >> baseline oauthRelogin
- Location: apps/desktop/e2e/zz-baseline.spec.ts:82:1

# Error details

```
Error: electron.launch: Process failed to launch!
Call log:
  - <launching> /Users/yuhan/workspace/oss/maka-agent/.worktree/text-roles/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron -r /Users/yuhan/workspace/oss/maka-agent/.worktree/text-roles/node_modules/playwright-core/lib/server/electron/loader.js --inspect=0 --remote-debugging-port=0 .
  - <launched> pid=33819
  - [pid=33819][err] Debugger listening on ws://127.0.0.1:63366/c89215ae-ba67-4989-8af0-07754f596511
  - [pid=33819][err] For help, see: https://nodejs.org/learn/getting-started/debugging
  - <ws connecting> ws://127.0.0.1:63366/c89215ae-ba67-4989-8af0-07754f596511
  - [pid=33819][err] Debugger attached.
  - <ws connected> ws://127.0.0.1:63366/c89215ae-ba67-4989-8af0-07754f596511
  - [pid=33819] <kill>
  - [pid=33819] <will force kill>
  - [pid=33819] exception while trying to kill process: Error: kill EPERM
  - <ws disconnected> ws://127.0.0.1:63366/c89215ae-ba67-4989-8af0-07754f596511 code=1006 reason=
  - [pid=33819] <process did exit: exitCode=1, signal=null>
  - [pid=33819] starting temporary directories cleanup
  - [pid=33819] finished temporary directories cleanup

```

# Test source

```ts
  66  |     mkdir(path.join(workspaceSkillRoot, 'workspace-only'), { recursive: true }),
  67  |     mkdir(path.join(userSkillRoot, 'user-only'), { recursive: true }),
  68  |   ]);
  69  |   await writeFile(
  70  |     path.join(userSkillRoot, 'user-only', 'SKILL.md'),
  71  |     `---\nname: User Only\ndescription: User-scoped install, deletable from the panel.\n---\n# User Only`,
  72  |     'utf8',
  73  |   );
  74  |   await Promise.all([
  75  |     writeFile(
  76  |       path.join(projectSkillRoot, 'project-only', 'SKILL.md'),
  77  |       `---\nname: Project Only\ndescription: Project-scoped suggestion.\n---\n# Project Only`,
  78  |       'utf8',
  79  |     ),
  80  |     writeFile(
  81  |       path.join(projectSkillRoot, 'host-incompatible', 'SKILL.md'),
  82  |       `---\nname: Host Incompatible\ndescription: Must be hidden from this host.\nrequired-tools: [DefinitelyMissingTool]\n---\n# Host Incompatible`,
  83  |       'utf8',
  84  |     ),
  85  |     writeFile(
  86  |       path.join(projectSkillRoot, 'agent-write', 'SKILL.md'),
  87  |       `---\nname: Agent Write\ndescription: Requires a mutating tool excluded from Plan mode.\nrequired-tools: [Write]\n---\n# Agent Write`,
  88  |       'utf8',
  89  |     ),
  90  |     writeFile(
  91  |       path.join(projectSkillRoot, 'deep-research-only', 'SKILL.md'),
  92  |       `---\nname: Deep Research Only\ndescription: Requires a tool available only in Deep Research mode.\nrequired-tools: [deep_research_status]\n---\n# Deep Research Only`,
  93  |       'utf8',
  94  |     ),
  95  |     writeFile(
  96  |       path.join(workspaceSkillRoot, 'workspace-only', 'SKILL.md'),
  97  |       `---\nname: Workspace Only\ndescription: Maka workspace suggestion.\n---\n# Workspace Only`,
  98  |       'utf8',
  99  |     ),
  100 |     writeFile(
  101 |       path.join(workspaceRoot, 'last-project-path.json'),
  102 |       JSON.stringify({ projectPath: projectRoot }),
  103 |       'utf8',
  104 |     ),
  105 |   ]);
  106 | }
  107 | 
  108 | /**
  109 |  * The sandboxed HOME of the run currently under test. Set by withE2eWindow
  110 |  * before Electron launches.
  111 |  *
  112 |  * Read it from inside a test BODY, never as a fixture: a fixture would have no
  113 |  * declared dependency on the window fixture, so Playwright could resolve it
  114 |  * before the window is set up and hand back a stale path.
  115 |  */
  116 | let currentHomeDir = '';
  117 | 
  118 | export function e2eHomeDir(): string {
  119 |   if (!currentHomeDir) throw new Error('e2eHomeDir() is only valid inside a test that opened a window');
  120 |   return currentHomeDir;
  121 | }
  122 | 
  123 | /**
  124 |  * Own the full launch lifecycle so a failure anywhere — seeding, Electron
  125 |  * launch, firstWindow, or the readiness wait — still tears down the Electron
  126 |  * process and the throwaway userData dir. The previous shape ran `mkdtemp`
  127 |  * and `launchE2eApp` outside the try, so a readiness timeout left a zombie
  128 |  * Electron and a leaked `maka-e2e-*` directory.
  129 |  */
  130 | async function withE2eWindow(
  131 |   {
  132 |     seed,
  133 |     readinessSelector,
  134 |     e2eFixtureScenario,
  135 |     locale,
  136 |     platform,
  137 |     invocableSkills,
  138 |     extraConnectionCount,
  139 |   }: {
  140 |     seed: boolean;
  141 |     readinessSelector: string;
  142 |     e2eFixtureScenario?: string;
  143 |     locale?: 'zh' | 'en';
  144 |     /** #1312: force app:info's platform so the window boots natively into that platform's `data-os` cascade. */
  145 |     platform?: 'darwin' | 'win32' | 'linux';
  146 |     invocableSkills?: boolean;
  147 |     extraConnectionCount?: number;
  148 |   },
  149 |   use: (page: Page) => Promise<void>,
  150 | ): Promise<void> {
  151 |   const userDataDir = await mkdtemp(path.join(tmpdir(), 'maka-e2e-'));
  152 |   // Lives inside the throwaway userData dir so the existing teardown removes
  153 |   // it too — there is no second path to leak.
  154 |   const homeDir = path.join(userDataDir, 'home');
  155 |   await mkdir(homeDir, { recursive: true });
  156 |   currentHomeDir = homeDir;
  157 |   let app: ElectronApplication | undefined;
  158 |   const mainLogs: string[] = [];
  159 |   const rendererLogs: string[] = [];
  160 |   try {
  161 |     if (seed) await seedE2eConnection(userDataDir, extraConnectionCount);
  162 |     if (invocableSkills) await seedE2eInvocableSkills(userDataDir);
  163 |     // Legacy E2E specs assert Chinese labels and should not inherit the CI
  164 |     // host locale. E2e-fixture workspaces use the explicit renderer override.
  165 |     if (locale && !e2eFixtureScenario) await seedE2eLocale(userDataDir, locale);
> 166 |     app = await electron.launch({
      |           ^ Error: electron.launch: Process failed to launch!
  167 |       args: ['.'],
  168 |       cwd: DESKTOP_ROOT,
  169 |       env: buildFixtureEnv(userDataDir, homeDir, {
  170 |         scenario: e2eFixtureScenario,
  171 |         locale,
  172 |         platform,
  173 |         // xvfb throttles a hidden window's compositor to ~1fps; only that
  174 |         // isolated display gets a visible window.
  175 |         showWindow: isCiLinuxDisplay(),
  176 |       }),
  177 |     });
  178 |     app.on('console', (message) => {
  179 |       mainLogs.push(message.text());
  180 |       if (mainLogs.length > 20) mainLogs.shift();
  181 |     });
  182 |     let page: Page;
  183 |     try {
  184 |       page = await app.firstWindow();
  185 |     } catch (error) {
  186 |       const detail = error instanceof Error ? error.message : String(error);
  187 |       const logs = mainLogs.length > 0 ? `\nElectron main console:\n${mainLogs.join('\n')}` : '';
  188 |       throw new Error(`${detail}${logs}`, { cause: error });
  189 |     }
  190 |     page.on('console', (message) => {
  191 |       rendererLogs.push(`[console:${message.type()}] ${message.text()}`);
  192 |       if (rendererLogs.length > 30) rendererLogs.shift();
  193 |     });
  194 |     page.on('pageerror', (error) => {
  195 |       rendererLogs.push(`[pageerror] ${error.stack ?? error.message}`);
  196 |       if (rendererLogs.length > 30) rendererLogs.shift();
  197 |     });
  198 |     // Centralize the cold-start wait so test bodies are flake-free under retries:0.
  199 |     try {
  200 |       await page.waitForSelector(readinessSelector, { timeout: 20_000 });
  201 |     } catch (error) {
  202 |       const detail = error instanceof Error ? error.message : String(error);
  203 |       const mainDetail = mainLogs.length > 0 ? `\nElectron main console:\n${mainLogs.join('\n')}` : '';
  204 |       const rendererDetail = rendererLogs.length > 0 ? `\nRenderer console:\n${rendererLogs.join('\n')}` : '';
  205 |       throw new Error(`${detail}${mainDetail}${rendererDetail}`, { cause: error });
  206 |     }
  207 |     await use(page);
  208 |   } finally {
  209 |     try {
  210 |       if (app) await closeElectronApplication(app, 5_000);
  211 |     } finally {
  212 |       await rm(userDataDir, { recursive: true, force: true });
  213 |     }
  214 |   }
  215 | }
  216 | 
  217 | export const test = base.extend<{
  218 |   window: Page;
  219 |   modelPickerLongWindow: Page;
  220 |   longTranscriptWindow: Page;
  221 |   sidebarLongSessionsWindow: Page;
  222 |   disclosureOutputWindow: Page;
  223 |   sandboxBoundaryWindow: Page;
  224 |   readOnlyBoundaryWindow: Page;
  225 |   staleSessionsWindow: Page;
  226 |   sessionWorkbarWindow: Page;
  227 |   botSettingsWindow: Page;
  228 |   /** #1361: Permissions page with the typed OS-permission snapshot fixture. */
  229 |   permissionSettingsWindow: Page;
  230 |   localeSwitchWindow: Page;
  231 |   invocableSkillsWindow: Page;
  232 |   planRemindersWindow: Page;
  233 |   oauthReloginWindow: Page;
  234 | }>({
  235 |   // Seeded: a pre-staged connection clears onboarding so the composer is ready.
  236 |   // Used by chat / session / settings / attachment specs.
  237 |   window: async ({}, use) => {
  238 |     await withE2eWindow({ seed: true, readinessSelector: '.maka-composer-textarea', locale: 'zh' }, use);
  239 |   },
  240 |   modelPickerLongWindow: async ({}, use) => {
  241 |     await withE2eWindow(
  242 |       {
  243 |         seed: true,
  244 |         readinessSelector: '.maka-composer-textarea',
  245 |         locale: 'zh',
  246 |         extraConnectionCount: 10,
  247 |       },
  248 |       use,
  249 |     );
  250 |   },
  251 |   // Long transcript: boots the e2e-fixture `long-transcript` fixture, which
  252 |   // seeds a 24-turn (~1300px each) session and opens it as the active
  253 |   // session. Fixture mode seeds its own connections, so no connection is
  254 |   // pre-staged here. Readiness = turns on screen and RENDERED BY THE REAL
  255 |   // MARKDOWN PIPELINE: the session is open and above-viewport turns sit at
  256 |   // their content-visibility placeholder size. Used by the scroll-geometry
  257 |   // spec.
  258 |   //
  259 |   // `.maka-markdown-pending` is the Suspense fallback for the lazily imported
  260 |   // markdown chunk, and the turn-size warm-up will not start while one is on
  261 |   // screen. Handing the page over before that chunk lands charged the spec's
  262 |   // settle budget for a module load: under 50x CPU throttling the fallback
  263 |   // holds for ~9.6s of a ~19s cold start, most of the spec's 15s, for work
  264 |   // that is boot rather than settling.
  265 |   longTranscriptWindow: async ({}, use) => {
  266 |     await withE2eWindow(
```