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

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeRendererSource,
  checkRendererArchitecture,
  generateArchitectureConfig,
} from './check-renderer-architecture.mjs';
import {
  assertRendererEntryHtml,
  rendererEntryContractPlugin,
} from './vite-renderer-entry-contract.ts';

const TRANSITIVE_APP_SHELL_PATH = 'src/renderer/app-shell.ts';
const TRANSITIVE_LEGACY_HELPER_PATH = 'src/renderer/legacy-session-helper.ts';
const RENDERER_ENTRY_PATH = 'src/renderer/main.tsx';

function emptyDebt(overrides = {}) {
  return {
    importDeclarations: 0,
    importSpecifiers: 0,
    nonTriviaTokens: 0,
    dependencyPaths: {},
    bridgePaths: {},
    environmentCapabilities: {},
    hookCalls: {},
    lifecycleMethods: {},
    unresolvedDependencies: 0,
    actionFactories: [],
    ...overrides,
  };
}

function architectureConfig({
  controllerOwners = [],
  legacyAppShellClosureDebt,
  legacyFeatureImports = [],
  legacyFiles = {},
  legacyGrowthDirectories = [],
  legacyPlatformImports = [],
  rootDebt = {},
  rootDebtClosure = {},
  legacyRendererFiles = Object.keys(rootDebt),
  ownership = [],
} = {}) {
  return {
    version: 1,
    legacyRendererFiles: [...legacyRendererFiles].sort(),
    legacyGrowthDirectories: [...legacyGrowthDirectories].sort(),
    legacyFeatureImports: [...legacyFeatureImports].sort(),
    legacyPlatformImports: [...legacyPlatformImports].sort(),
    controllerOwners: [...controllerOwners].sort((left, right) =>
      `${left.implementation}#${left.symbol}`.localeCompare(
        `${right.implementation}#${right.symbol}`,
      ),
    ),
    legacyAppShell: {
      files: legacyFiles,
      closure: legacyAppShellClosureDebt ?? {},
    },
    rootDebt,
    rootDebtClosure,
    ownership,
  };
}

function debtForSource(source, path) {
  const analysis = analyzeRendererSource(source, path);
  return {
    importDeclarations: analysis.importDeclarations,
    importSpecifiers: analysis.importSpecifiers,
    nonTriviaTokens: analysis.nonTriviaTokens,
    dependencyPaths: analysis.dependencyPaths,
    bridgePaths: analysis.bridgePaths,
    environmentCapabilities: analysis.environmentCapabilities,
    hookCalls: analysis.hookCalls,
    lifecycleMethods: analysis.lifecycleMethods,
    unresolvedDependencies: analysis.unresolvedDependencies,
    actionFactories: analysis.actionFactories,
  };
}

function capabilityDebtForSource(source, path) {
  const debt = debtForSource(source, path);
  return {
    actionFactories: debt.actionFactories,
    bridgePaths: debt.bridgePaths,
    dependencyPaths: debt.dependencyPaths,
    environmentCapabilities: debt.environmentCapabilities,
    hookCalls: debt.hookCalls,
    lifecycleMethods: debt.lifecycleMethods,
    unresolvedDependencies: debt.unresolvedDependencies,
  };
}

async function withDesktopFixture(files, run) {
  const desktopRoot = await mkdtemp(join(tmpdir(), 'maka-renderer-architecture-'));
  try {
    for (const [path, source] of Object.entries(files)) {
      const absolutePath = join(desktopRoot, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, source, 'utf8');
    }
    return await run(desktopRoot);
  } finally {
    await rm(desktopRoot, { force: true, recursive: true });
  }
}

function violationsFor(desktopRoot, config = architectureConfig(), baseConfig) {
  return checkRendererArchitecture({
    baseConfig,
    config,
    desktopRoot,
    enforceRendererEntryContract: false,
  });
}

function assertHasViolation(violations, pattern) {
  assert.ok(
    violations.some((violation) => pattern.test(violation)),
    `Expected a violation matching ${pattern}, received:\n${violations.join('\n')}`,
  );
}

function transitiveAppShellFiles(helperSource, extraFiles = {}) {
  return {
    [TRANSITIVE_APP_SHELL_PATH]: `
      import { legacySessionHelper } from './legacy-session-helper.js';
      export const AppShell = legacySessionHelper;
    `,
    [TRANSITIVE_LEGACY_HELPER_PATH]: helperSource,
    ...extraFiles,
  };
}

function transitiveAppShellSeedConfig() {
  return architectureConfig({
    ownership: [
      {
        capability: 'fixture-app-shell',
        targetZone: 'shell',
        legacyPaths: [TRANSITIVE_APP_SHELL_PATH],
      },
    ],
  });
}

function rendererEntrySeedConfig() {
  return architectureConfig({
    rootDebt: { [RENDERER_ENTRY_PATH]: emptyDebt() },
    ownership: [
      {
        capability: 'fixture-root',
        targetZone: 'bootstrap',
        legacyPaths: [RENDERER_ENTRY_PATH],
      },
    ],
  });
}

function rendererEntryContractFiles(overrides = {}) {
  return {
    'src/renderer/index.html': `
      <!doctype html>
      <html><body><script type="module" src="/main.tsx"></script></body></html>
    `,
    [RENDERER_ENTRY_PATH]: `export const main = true;`,
    'src/main/main-window.ts': `
      import { loadMainRenderer, resolveMainRendererEntry } from './main-renderer-loader.js';
      async function createWindow() {
        const rendererEntry = resolveMainRendererEntry(import.meta.dirname, process.env.VITE_DEV_SERVER_URL);
        await loadMainRenderer(mainWindow, rendererEntry);
      }
    `,
    'src/main/main-renderer-loader.ts': `
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      interface MainRendererWindow {
        loadFile(path: string): Promise<void>;
        loadURL(url: string): Promise<void>;
      }
      interface MainRendererEntry {
        readonly filePath: string;
        readonly url: string;
        readonly useDevServer: boolean;
      }
      export function resolveMainRendererEntry(
        mainModuleDirectory: string,
        viteDevServerUrl: string | undefined,
      ): MainRendererEntry {
        const rendererEntryPath = join(mainModuleDirectory, '..', '..', 'dist-renderer', 'index.html');
        const rendererEntryUrl = viteDevServerUrl ?? pathToFileURL(rendererEntryPath).href;
        return Object.freeze({
          filePath: rendererEntryPath,
          url: rendererEntryUrl,
          useDevServer: !!viteDevServerUrl,
        });
      }
      export async function loadMainRenderer(
        mainWindow: MainRendererWindow,
        rendererEntry: MainRendererEntry,
      ): Promise<void> {
        if (rendererEntry.useDevServer) {
          await mainWindow.loadURL(rendererEntry.url);
        } else {
          await mainWindow.loadFile(rendererEntry.filePath);
        }
      }
    `,
    'vite.config.ts': `
      import react from '@vitejs/plugin-react';
      import { resolve } from 'node:path';
      import { defineConfig } from 'vite';
      import { rendererEntryContractPlugin } from './scripts/vite-renderer-entry-contract.js';
      import { bundledNpmPackagesPlugin } from './vite-bundled-packages.js';
      import { dependencyPatchesCachePlugin } from './vite-dependency-patches.js';
      import { workspacePackagesPlugin } from './vite-workspace-packages.js';
      const REPO_ROOT = '/fixture';
      export default defineConfig({
        root: 'src/renderer',
        plugins: [
          react(),
          dependencyPatchesCachePlugin(REPO_ROOT),
          workspacePackagesPlugin(REPO_ROOT),
          bundledNpmPackagesPlugin(),
          rendererEntryContractPlugin(resolve(import.meta.dirname, 'src/renderer')),
        ],
        build: { outDir: '../../dist-renderer' },
      });
    `,
    'package.json': JSON.stringify({
      scripts: {
        'build:renderer':
          'vite build && node scripts/check-renderer-entry-output.mjs && node ../../scripts/check-third-party-notices.mjs',
      },
    }),
    ...overrides,
  };
}

function runRendererEntryBundleContract(directImports) {
  const plugin = rendererEntryContractPlugin('/fixture/src/renderer');
  plugin.configResolved({ root: '/fixture/src/renderer' });
  assert.equal(typeof plugin.generateBundle, 'function');
  plugin.generateBundle.call(
    {
      emitFile() {},
      error(message) {
        throw new Error(message);
      },
      getModuleInfo(id) {
        return id === '/fixture/src/renderer/index.html' ? { importedIds: directImports } : null;
      },
    },
    {},
    {
      'assets/index.js': {
        type: 'chunk',
        isEntry: true,
        facadeModuleId: '/fixture/src/renderer/index.html',
      },
    },
  );
}

function canonicalRendererEntryHtml(extraBody = '', policy = "script-src 'self'") {
  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'self'; ${policy}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'"
        />
        <title>Maka</title>
        <style>body { margin: 0; }</style>
      </head>
      <body>
        <div id="root"></div>
        ${extraBody}
        <script type="module" src="/main.tsx"></script>
      </body>
    </html>
  `;
}

describe('renderer architecture checker fixtures', () => {
  it('accepts the legal inward dependency graph and testing entry boundary', async () => {
    await withDesktopFixture(
      {
        'src/renderer/application/contracts/regions.ts': `
          export interface RegionModel { readonly id: string }
          export const fetch = () => 'injected-contract';
        `,
        'src/renderer/application/session/session-scope.ts': `
          import type { RegionModel } from '../contracts/regions.js';
          export type SessionScope = RegionModel;
        `,
        'src/renderer/shell/shell-frame.tsx': `
          import type { RegionModel } from '../application/contracts/regions.js';
          import { fetch } from '../application/contracts/regions.js';
          export function ShellFrame(props: { readonly region: RegionModel }) {
            return <main data-region={props.region.id} data-contract={fetch()} />;
          }
        `,
        'src/renderer/features/alpha/index.ts': `
          export { AlphaHost } from './ui/alpha-host.js';
          export type { AlphaServices } from './ports.js';
        `,
        'src/renderer/features/alpha/ports.ts': `
          export interface AlphaServices { readonly read: () => Promise<string> }
        `,
        'src/renderer/features/alpha/testing.ts': `
          export function createFakeAlphaServices() {
            return { read: async () => 'fixture' };
          }
        `,
        'src/renderer/features/alpha/stories.ts': `
          export const alphaStoryModel = { id: 'alpha-story' };
        `,
        'src/renderer/features/alpha/ui/alpha-host.tsx': `
          import type { RegionModel } from '../../../application/contracts/regions.js';
          export function AlphaHost(props: RegionModel) {
            return <section>{props.id}</section>;
          }
        `,
        'src/renderer/platform/desktop/create-alpha-services.ts': `
          import type { AlphaServices } from '../../features/alpha/index.js';
          export function createAlphaServices(): AlphaServices {
            return { read: async () => 'desktop' };
          }
        `,
        'src/renderer/composition/desktop-application.tsx': `
          import { AlphaHost } from '../features/alpha/index.js';
          import { createAlphaServices } from '../platform/desktop/create-alpha-services.js';
          import { ShellFrame } from '../shell/shell-frame.js';
          void createAlphaServices;
          export function DesktopApplication() {
            return <><ShellFrame region={{ id: 'primary' }} /><AlphaHost id="alpha" /></>;
          }
        `,
        'src/main/__tests__/alpha-boundary.test.ts': `
          import { createFakeAlphaServices } from '../../renderer/features/alpha/testing.js';
          void createFakeAlphaServices;
        `,
        'stories/alpha.stories.tsx': `
          import { createFakeAlphaServices } from '../src/renderer/features/alpha/testing.js';
          import { alphaStoryModel } from '../src/renderer/features/alpha/stories.js';
          export const services = createFakeAlphaServices();
          export const model = alphaStoryModel;
        `,
      },
      (desktopRoot) => {
        assert.deepEqual(violationsFor(desktopRoot), []);
      },
    );
  });

  it('resolves @maka/desktop self-imports before enforcing zone boundaries', async () => {
    await withDesktopFixture(
      {
        'src/renderer/features/alpha/controller.ts': `
          import { desktopOnly } from '@maka/desktop/src/renderer/platform/desktop/private.js';
          export const alpha = desktopOnly;
        `,
        'src/renderer/shell/shell-frame.ts': `
          import { BetaHost } from '@maka/desktop/src/renderer/features/beta/index.js';
          export const frame = BetaHost;
        `,
        'src/renderer/application/session/session-scope.ts': `
          import { BetaHost } from '@maka/desktop/src/renderer/features/beta/index.js';
          export const scope = BetaHost;
        `,
        'src/renderer/features/beta/index.ts': 'export const BetaHost = true;',
        'src/renderer/platform/desktop/private.ts': 'export const desktopOnly = true;',
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(
          violations,
          /features\/alpha\/controller\.ts: feature imports a forbidden Desktop\/shell module/u,
        );
        assertHasViolation(
          violations,
          /shell\/shell-frame\.ts: shell imports forbidden implementation module/u,
        );
        assertHasViolation(
          violations,
          /application\/session\/session-scope\.ts: application authority imports an outer implementation/u,
        );
      },
    );
  });

  it('rejects direct browser environment access in shell and composition files', async () => {
    await withDesktopFixture(
      {
        'src/renderer/shell/local-storage.ts': `
          export const persisted = localStorage.getItem('shell-layout');
        `,
        'src/renderer/shell/window-listener.ts': `
          window.addEventListener('resize', () => undefined);
        `,
        'src/renderer/composition/fetch.ts': `
          export const request = fetch('/renderer-bootstrap');
        `,
        'src/renderer/composition/timers.ts': `
          setTimeout(() => undefined, 1);
          requestAnimationFrame(() => undefined);
        `,
        'src/renderer/shell/aliased-environment.ts': `
          const later = setTimeout;
          const retrieve = fetch;
          later(() => undefined, 1);
          void retrieve('/shell-data');
        `,
        'src/renderer/composition/browser-globals.ts': `
          void indexedDB.open('maka');
          history.pushState({}, '', '/');
          void new FileReader();
          addEventListener('online', () => undefined);
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        for (const path of [
          'src/renderer/shell/local-storage.ts',
          'src/renderer/shell/window-listener.ts',
          'src/renderer/composition/fetch.ts',
          'src/renderer/composition/timers.ts',
          'src/renderer/shell/aliased-environment.ts',
          'src/renderer/composition/browser-globals.ts',
        ]) {
          assertHasViolation(
            violations,
            new RegExp(
              `^${path.replaceAll('/', '\\/').replaceAll('.', '\\.')}.*directly accesses browser environment capabilities$`,
              'u',
            ),
          );
        }
      },
    );
  });

  it('resolves browser-global shadowing lexically instead of masking the whole file', () => {
    const analysis = analyzeRendererSource(
      `
        function useInjected(fetch, history, setTimeout) {
          fetch('/injected');
          history.pushState({}, '', '/injected');
          setTimeout(() => undefined, 1);
        }
        void useInjected;
        fetch('/global');
        history.pushState({}, '', '/global');
        setTimeout(() => undefined, 1);
      `,
      'src/renderer/shell/lexical-browser-globals.ts',
    );

    assert.equal(analysis.environmentCapabilities.fetch, 1);
    assert.equal(analysis.environmentCapabilities['history.pushState'], 1);
    assert.equal(analysis.environmentCapabilities.setTimeout, 1);
  });

  it('counts environment globals only in value-reference positions', () => {
    const analysis = analyzeRendererSource(
      `
        interface Rows { history: string; report(location: string): void; }
        export const rows = { history: 'Input history' };
        export function digest(input) { return input.location; }
        export type Snapshot = typeof history;
        history.replaceState(null, '');
        location.assign('/next');
      `,
      'src/renderer/shell/environment-reference-positions.ts',
    );

    assert.deepEqual(analysis.environmentCapabilities, {
      'history.replaceState': 1,
      'location.assign': 1,
    });
  });

  it('rejects computed and optional access to the Desktop bridge in strict zones', async () => {
    await withDesktopFixture(
      {
        'src/renderer/application/computed-bridge.ts': `
          void window['maka'].sessions.list();
        `,
        'src/renderer/application/optional-bridge.ts': `
          void window?.maka?.sessions?.subscribeEvents?.(() => undefined);
        `,
        'src/renderer/application/dynamic-global.ts': `
          const bridgeName = 'maka';
          void window[bridgeName];
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(
          violations,
          /^src\/renderer\/application\/computed-bridge\.ts: application code accesses the Desktop global bridge$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/application\/optional-bridge\.ts: application code accesses the Desktop global bridge$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/application\/dynamic-global\.ts: application code contains non-static global environment access$/u,
        );
      },
    );
  });

  it('rejects cross-feature, deep feature, and production testing imports', async () => {
    await withDesktopFixture(
      {
        'src/renderer/features/alpha/controller.ts': `
          export async function loadBeta() {
            return import('../beta/index.js');
          }
        `,
        'src/renderer/features/beta/index.ts': `
          export const beta = true;
        `,
        'src/renderer/composition/deep-feature.ts': `
          const alphaController = require('../features/alpha/controller/use-alpha.js');
          void alphaController;
        `,
        'src/renderer/composition/testing-in-production.ts': `
          import { createFakeAlphaServices } from '../features/alpha/testing.js';
          void createFakeAlphaServices;
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(
          violations,
          /^src\/renderer\/features\/alpha\/controller\.ts: feature alpha imports feature beta:/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/composition\/deep-feature\.ts: feature imports must use index:/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/composition\/testing-in-production\.ts: production code imports a feature testing entry:/u,
        );
      },
    );
  });

  it('rejects a feature production module importing its own testing entry', async () => {
    await withDesktopFixture(
      {
        'src/renderer/features/alpha/controller.ts': `
          import { fakeAlpha } from './testing.js';
          export const alpha = fakeAlpha;
        `,
        'src/renderer/features/alpha/testing.ts': 'export const fakeAlpha = true;',
      },
      (desktopRoot) => {
        assertHasViolation(
          violationsFor(desktopRoot),
          /features\/alpha\/controller\.ts:.*testing entry/u,
        );
      },
    );
  });

  it('keeps feature stories entries test-only', async () => {
    await withDesktopFixture(
      {
        'src/renderer/features/alpha/stories.ts': 'export const storyModel = true;',
        'src/renderer/composition/stories-in-production.ts': `
          import { storyModel } from '../features/alpha/stories.js';
          export const leakedStoryModel = storyModel;
        `,
      },
      (desktopRoot) => {
        assertHasViolation(
          violationsFor(desktopRoot),
          /composition\/stories-in-production\.ts: production code imports a feature stories entry/u,
        );
      },
    );
  });

  it('rejects an application contract re-exporting application implementation', async () => {
    await withDesktopFixture(
      {
        'src/renderer/application/contracts/index.ts': `
          export { sessionStore } from '../session/session-store.js';
        `,
        'src/renderer/application/session/session-store.ts': `
          export const sessionStore = true;
        `,
      },
      (desktopRoot) => {
        assertHasViolation(
          violationsFor(desktopRoot),
          /application\/contracts\/index\.ts:.*(?:contract|contracts).*implementation/iu,
        );
      },
    );
  });

  it('rejects composition and Desktop adapters importing deep application implementation', async () => {
    await withDesktopFixture(
      {
        'src/renderer/application/session/session-store.ts': `export const sessionStore = true;`,
        'src/renderer/composition/deep-application.ts': `
          import { sessionStore } from '../application/session/session-store.js';
          export const composed = sessionStore;
        `,
        'src/renderer/platform/desktop/deep-application.ts': `
          import { sessionStore } from '../../application/session/session-store.js';
          export const adapted = sessionStore;
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(
          violations,
          /composition\/deep-application\.ts: composition imports application implementation instead of a public entry/u,
        );
        assertHasViolation(
          violations,
          /platform\/desktop\/deep-application\.ts: Desktop adapter imports application implementation instead of a public entry/u,
        );
      },
    );
  });

  it('rejects Electron and node built-in imports from strict feature code', async () => {
    await withDesktopFixture(
      {
        'src/renderer/features/alpha/electron-import.ts': `
          import { ipcRenderer } from 'electron';
          export const ipc = ipcRenderer;
        `,
        'src/renderer/features/alpha/node-import.ts': `
          import { readFile } from 'node:fs/promises';
          export const read = readFile;
        `,
        'src/renderer/features/alpha/controller.test.ts': `
          import { strict as assert } from 'node:assert';
          assert.equal(1, 1);
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(
          violations,
          /features\/alpha\/electron-import\.ts:.*feature.*electron/iu,
        );
        assertHasViolation(
          violations,
          /features\/alpha\/node-import\.ts:.*feature.*node:fs/iu,
        );
        assert.ok(
          !violations.some((violation) => violation.includes('controller.test.ts')),
          `Feature tests may use the Node test environment:\n${violations.join('\n')}`,
        );
      },
    );
  });

  it('keeps Desktop platform adapters free of UI lifecycle and runtime module loading', async () => {
    await withDesktopFixture(
      {
        'src/renderer/platform/desktop/stateful-view.tsx': `
          import * as React from 'react';
          import { useState } from 'react';
          export function StatefulView() {
            const [open] = useState(false);
            return <div>{String(open)}</div>;
          }
          export class StatefulAdapter extends React.Component {
            componentDidMount() {}
            render() { return null; }
          }
        `,
        'src/renderer/platform/desktop/dynamic-adapter.ts': `
          export function loadAdapter(path: string) { return import(path); }
        `,
        'src/renderer/platform/desktop/electron-adapter.ts': `
          import { ipcRenderer } from 'electron';
          export const ipc = ipcRenderer;
        `,
        'src/renderer/platform/desktop/node-adapter.ts': `
          import { readFile } from 'node:fs/promises';
          export const read = readFile;
        `,
        'src/renderer/platform/desktop/allowed-capabilities.ts': `
          export function createAllowedCapabilities() {
            localStorage.getItem('desktop-adapter');
            return window.maka.sessions.list();
          }
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(
          violations,
          /platform\/desktop\/stateful-view\.tsx: platform code owns stateful React hooks/u,
        );
        assertHasViolation(
          violations,
          /platform\/desktop\/stateful-view\.tsx: platform code owns React class lifecycle methods/u,
        );
        assertHasViolation(
          violations,
          /platform\/desktop\/stateful-view\.tsx: Desktop adapters cannot own React UI/u,
        );
        assertHasViolation(
          violations,
          /platform\/desktop\/dynamic-adapter\.ts: platform code contains a non-static import or require/u,
        );
        assertHasViolation(
          violations,
          /platform\/desktop\/electron-adapter\.ts: platform code imports forbidden environment module: electron/u,
        );
        assertHasViolation(
          violations,
          /platform\/desktop\/node-adapter\.ts: platform code imports forbidden environment module: node:fs\/promises/u,
        );
        assert.ok(
          !violations.some((violation) => violation.includes('allowed-capabilities.ts')),
          `Desktop adapters may own the bridge and browser environment:\n${violations.join('\n')}`,
        );
      },
    );
  });

  it('rejects new AppShell-family helper files outside the debt ledger', async () => {
    await withDesktopFixture(
      {
        'src/renderer/app-shell-fresh-owner.ts': 'export const owner = true;',
        'src/renderer/use-app-shell-fresh-owner.ts': 'export const owner = true;',
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(
          violations,
          /^legacy AppShell file set changed;.*app-shell-fresh-owner\.ts.*use-app-shell-fresh-owner\.ts/u,
        );
      },
    );
  });

  it('generates the transitive legacy closure owned directly by AppShell', async () => {
    const helperSource = `
      export const legacySessionHelper = 'legacy-session';
    `;

    await withDesktopFixture(
      transitiveAppShellFiles(helperSource),
      (desktopRoot) => {
        const generated = generateArchitectureConfig(
          desktopRoot,
          transitiveAppShellSeedConfig(),
        );

        assert.deepEqual(
          Object.keys(generated.legacyAppShell.closure),
          [TRANSITIVE_LEGACY_HELPER_PATH],
        );
        assert.deepEqual(
          generated.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH],
          capabilityDebtForSource(helperSource, TRANSITIVE_LEGACY_HELPER_PATH),
        );
      },
    );
  });

  it('prefers runtime source over a same-stem declaration in the AppShell closure', async () => {
    const runtimePath = 'src/renderer/legacy-session-helper.js';
    const runtimeSource = `
      export function legacySessionHelper() {
        return window.maka.sessions.list();
      }
    `;

    await withDesktopFixture(
      {
        [TRANSITIVE_APP_SHELL_PATH]: `
          import { legacySessionHelper } from './legacy-session-helper.js';
          export const AppShell = legacySessionHelper;
        `,
        'src/renderer/legacy-session-helper.d.ts': `
          export declare function legacySessionHelper(): Promise<unknown>;
        `,
        [runtimePath]: runtimeSource,
      },
      (desktopRoot) => {
        const generated = generateArchitectureConfig(
          desktopRoot,
          transitiveAppShellSeedConfig(),
        );

        assert.deepEqual(Object.keys(generated.legacyAppShell.closure), [runtimePath]);
        assert.deepEqual(
          generated.legacyAppShell.closure[runtimePath],
          capabilityDebtForSource(runtimeSource, runtimePath),
        );
      },
    );
  });

  it('ratchets legacy helpers reachable through a feature public ownership boundary', async () => {
    await withDesktopFixture(
      {
        [TRANSITIVE_APP_SHELL_PATH]: `
          import { AlphaHost } from './features/alpha/index.js';
          export const AppShell = AlphaHost;
        `,
        'src/renderer/features/alpha/index.ts': `
          import { legacySessionHelper } from '../../legacy-session-helper.js';
          export const AlphaHost = legacySessionHelper;
        `,
        [TRANSITIVE_LEGACY_HELPER_PATH]: `
          import { useState } from 'react';
          export function legacySessionHelper() {
            void window.maka.sessions.list();
            localStorage.getItem('feature-owned');
            return useState(false);
          }
        `,
      },
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(
          desktopRoot,
          transitiveAppShellSeedConfig(),
        );
        assert.deepEqual(
          Object.keys(currentConfig.legacyAppShell.closure),
          [TRANSITIVE_LEGACY_HELPER_PATH],
        );

        const baseConfig = structuredClone(currentConfig);
        const baseHelperDebt = baseConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH];
        baseHelperDebt.hookCalls = {};
        baseHelperDebt.bridgePaths = {};
        baseHelperDebt.environmentCapabilities = {};

        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: new or increased hookCalls debt useState$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: new or increased bridgePaths debt window\.maka\.sessions\.list$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: new or increased environmentCapabilities debt localStorage\.getItem$/u,
        );
      },
    );
  });

  it('ratchets legacy helpers reachable through a shared Desktop boundary', async () => {
    await withDesktopFixture(
      {
        [TRANSITIVE_APP_SHELL_PATH]: `
          import { rootBridge } from '../shared/root-bridge.js';
          export const AppShell = rootBridge;
        `,
        'src/shared/root-bridge.ts': `
          import { legacySessionHelper } from '../renderer/legacy-session-helper.js';
          export const rootBridge = legacySessionHelper;
        `,
        [TRANSITIVE_LEGACY_HELPER_PATH]: `
          export function legacySessionHelper() {
            return window.maka.sessions.list();
          }
        `,
      },
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(
          desktopRoot,
          transitiveAppShellSeedConfig(),
        );
        assert.deepEqual(
          Object.keys(currentConfig.legacyAppShell.closure),
          [TRANSITIVE_LEGACY_HELPER_PATH, 'src/shared/root-bridge.ts'],
        );

        const baseConfig = structuredClone(currentConfig);
        baseConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH].bridgePaths = {};

        assertHasViolation(
          violationsFor(desktopRoot, currentConfig, baseConfig),
          /^src\/renderer\/legacy-session-helper\.ts: new or increased bridgePaths debt window\.maka\.sessions\.list$/u,
        );
      },
    );
  });

  it('ratchets capability debt owned directly by a shared Desktop intermediary', async () => {
    const sharedPath = 'src/shared/root-bridge.ts';
    await withDesktopFixture(
      {
        [TRANSITIVE_APP_SHELL_PATH]: `
          import { rootBridge } from '../shared/root-bridge.js';
          export const AppShell = rootBridge;
        `,
        [sharedPath]: `
          import { useState } from 'react';
          export function rootBridge() {
            void window.maka.sessions.list();
            localStorage.getItem('shared-root-state');
            return useState(false);
          }
        `,
      },
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(
          desktopRoot,
          transitiveAppShellSeedConfig(),
        );
        assert.deepEqual(Object.keys(currentConfig.legacyAppShell.closure), [sharedPath]);

        const baseConfig = structuredClone(currentConfig);
        const baseSharedDebt = baseConfig.legacyAppShell.closure[sharedPath];
        baseSharedDebt.hookCalls = {};
        baseSharedDebt.bridgePaths = {};
        baseSharedDebt.environmentCapabilities = {};

        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/shared\/root-bridge\.ts: new or increased hookCalls debt useState$/u,
        );
        assertHasViolation(
          violations,
          /^src\/shared\/root-bridge\.ts: new or increased bridgePaths debt window\.maka\.sessions\.list$/u,
        );
        assertHasViolation(
          violations,
          /^src\/shared\/root-bridge\.ts: new or increased environmentCapabilities debt localStorage\.getItem$/u,
        );
      },
    );
  });

  it('allows support debt to leave the AppShell closure but rejects the reverse ownership regression', async () => {
    const mainPath = 'src/renderer/main.tsx';
    const compositionPath = 'src/renderer/composition/desktop-application.ts';
    const sharedPath = 'src/shared/root-bridge.ts';
    const appShellOwnsSupport = `
      import { rootBridge } from '../shared/root-bridge.js';
      export const AppShell = rootBridge;
    `;
    const compositionUsesAppShell = `
      import { AppShell } from '../app-shell.js';
      export const DesktopApplication = AppShell;
    `;
    const compositionOwnsSupport = `
      import { rootBridge } from '../../shared/root-bridge.js';
      export const DesktopApplication = rootBridge;
    `;

    await withDesktopFixture(
      {
        [mainPath]: `
          import { DesktopApplication } from './composition/desktop-application.js';
          export const main = DesktopApplication;
        `,
        [compositionPath]: compositionUsesAppShell,
        [TRANSITIVE_APP_SHELL_PATH]: appShellOwnsSupport,
        [sharedPath]: `export const rootBridge = window.maka.sessions.list();`,
      },
      async (desktopRoot) => {
        const seedConfig = architectureConfig({
          rootDebt: { [mainPath]: emptyDebt() },
          ownership: [
            {
              capability: 'fixture-app-shell',
              targetZone: 'shell',
              legacyPaths: [TRANSITIVE_APP_SHELL_PATH],
            },
            {
              capability: 'fixture-root',
              targetZone: 'bootstrap',
              legacyPaths: [mainPath],
            },
          ],
        });
        const appShellOwnedConfig = generateArchitectureConfig(desktopRoot, seedConfig);
        assert.deepEqual(Object.keys(appShellOwnedConfig.legacyAppShell.closure), [sharedPath]);
        assert.deepEqual(Object.keys(appShellOwnedConfig.rootDebtClosure), []);

        await writeFile(join(desktopRoot, compositionPath), compositionOwnsSupport, 'utf8');
        await writeFile(
          join(desktopRoot, TRANSITIVE_APP_SHELL_PATH),
          `export const AppShell = true;`,
          'utf8',
        );
        const rootOwnedConfig = generateArchitectureConfig(desktopRoot, appShellOwnedConfig);
        assert.deepEqual(Object.keys(rootOwnedConfig.legacyAppShell.closure), []);
        assert.deepEqual(Object.keys(rootOwnedConfig.rootDebtClosure), [sharedPath]);
        assert.deepEqual(
          violationsFor(desktopRoot, rootOwnedConfig, appShellOwnedConfig),
          [],
        );

        await writeFile(join(desktopRoot, compositionPath), compositionUsesAppShell, 'utf8');
        await writeFile(
          join(desktopRoot, TRANSITIVE_APP_SHELL_PATH),
          appShellOwnsSupport,
          'utf8',
        );
        const regressedConfig = generateArchitectureConfig(desktopRoot, rootOwnedConfig);
        assertHasViolation(
          violationsFor(desktopRoot, regressedConfig, rootOwnedConfig),
          /^src\/shared\/root-bridge\.ts: new legacyAppShellClosure debt entries are forbidden$/u,
        );
      },
    );
  });

  it('rejects stateful hook growth inside a transitive legacy AppShell helper', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(`
        import { useState } from 'react';
        export function legacySessionHelper() {
          const [session] = useState('legacy-session');
          return session;
        }
      `),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(
          desktopRoot,
          transitiveAppShellSeedConfig(),
        );
        const baseConfig = structuredClone(currentConfig);
        baseConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH].hookCalls = {};

        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: hookCalls debt increased from 0 to 1$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: new or increased hookCalls debt useState$/u,
        );
      },
    );
  });

  it('rejects a feature controller Hook returning to AppShell after provider migration', async () => {
    const providerOwnedAppShell = `
      import { GoalProvider } from './features/goals/index.js';
      export const AppShell = GoalProvider;
    `;
    await withDesktopFixture(
      {
        [TRANSITIVE_APP_SHELL_PATH]: providerOwnedAppShell,
        'src/renderer/features/goals/index.ts': `
          export const GoalProvider = true;
          export function useGoalController() { return true; }
        `,
      },
      async (desktopRoot) => {
        const seedConfig = transitiveAppShellSeedConfig();
        const providerOwnedConfig = generateArchitectureConfig(desktopRoot, seedConfig);

        await writeFile(
          join(desktopRoot, TRANSITIVE_APP_SHELL_PATH),
          `
            import { GoalProvider, useGoalController } from './features/goals/index.js';
            export const AppShell = [GoalProvider, useGoalController()];
          `,
          'utf8',
        );
        const regressedConfig = generateArchitectureConfig(
          desktopRoot,
          providerOwnedConfig,
        );
        const violations = violationsFor(
          desktopRoot,
          regressedConfig,
          providerOwnedConfig,
        );

        assertHasViolation(
          violations,
          /^src\/renderer\/app-shell\.ts: hookCalls debt increased from 0 to 1$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/app-shell\.ts: new or increased hookCalls debt useGoalController$/u,
        );
      },
    );
  });
  it('rejects bridge and environment capability growth inside a transitive legacy AppShell helper', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(`
        export function legacySessionHelper() {
          void window.maka.sessions.list();
          return localStorage.getItem('legacy-session');
        }
      `),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(
          desktopRoot,
          transitiveAppShellSeedConfig(),
        );
        const baseConfig = structuredClone(currentConfig);
        const baseHelperDebt = baseConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH];
        baseHelperDebt.bridgePaths = {};
        baseHelperDebt.environmentCapabilities = {};

        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: new or increased bridgePaths debt window\.maka\.sessions\.list$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: new or increased environmentCapabilities debt localStorage\.getItem$/u,
        );
      },
    );
  });

  it('rejects dependency growth inside a transitive legacy AppShell helper', async () => {
    const dependencyPath = 'src/renderer/legacy-session-store.ts';
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import { legacySessionStore } from './legacy-session-store.js';
          export const legacySessionHelper = legacySessionStore;
        `,
        {
          [dependencyPath]: `export const legacySessionStore = 'legacy-session';`,
        },
      ),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(
          desktopRoot,
          transitiveAppShellSeedConfig(),
        );
        const baseConfig = structuredClone(currentConfig);
        baseConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH].dependencyPaths = {};

        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: dependencyPaths debt increased from 0 to 1$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: new dependency debt \.\/legacy-session-store\.js$/u,
        );
      },
    );
  });

  it('rejects a stale AppShell closure ledger when another legacy file becomes reachable', async () => {
    const newlyReachablePath = 'src/renderer/legacy-session-store.ts';
    await withDesktopFixture(
      transitiveAppShellFiles(`
        export const legacySessionHelper = 'legacy-session';
      `),
      async (desktopRoot) => {
        const staleConfig = generateArchitectureConfig(
          desktopRoot,
          transitiveAppShellSeedConfig(),
        );
        const expandedHelperSource = `
          import { legacySessionStore } from './legacy-session-store.js';
          export const legacySessionHelper = legacySessionStore;
        `;
        await writeFile(
          join(desktopRoot, TRANSITIVE_LEGACY_HELPER_PATH),
          expandedHelperSource,
          'utf8',
        );
        await writeFile(
          join(desktopRoot, newlyReachablePath),
          `export const legacySessionStore = 'legacy-session';`,
          'utf8',
        );
        staleConfig.legacyRendererFiles = [
          ...staleConfig.legacyRendererFiles,
          newlyReachablePath,
        ].sort();
        staleConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH] = capabilityDebtForSource(
          expandedHelperSource,
          TRANSITIVE_LEGACY_HELPER_PATH,
        );

        assertHasViolation(
          violationsFor(desktopRoot, staleConfig),
          /legacy AppShell transitive renderer closure changed;.*legacy-session-store\.ts/u,
        );
      },
    );
  });

  it('rejects non-static dependency escape hatches inside the AppShell legacy closure', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          export const hiddenLegacyOwners = import.meta.glob('./legacy-session-store.ts');
        `,
        {
          'src/renderer/legacy-session-store.ts': `
            void window.maka.sessions.list();
          `,
        },
      ),
      (desktopRoot) => {
        assert.throws(
          () => generateArchitectureConfig(desktopRoot, transitiveAppShellSeedConfig()),
          /legacy-session-helper\.ts: AppShell closure contains a non-static import, require, or import\.meta glob/u,
        );
      },
    );
  });

  it('rejects stateful shell hooks and imports from legacy implementation', async () => {
    await withDesktopFixture(
      {
        'src/renderer/legacy-session-owner.ts': 'export const legacySessionOwner = true;',
        'src/renderer/shell/shell-frame.tsx': `
          import * as React from 'react';
          import { legacySessionOwner } from '../legacy-session-owner.js';
          export function ShellFrame() {
            const [open] = React.useState(legacySessionOwner);
            return <main data-open={open} />;
          }
        `,
        'src/renderer/shell/custom-hook.ts': `
          import { useExternalSession } from '@example/session-hooks';
          export const session = useExternalSession();
        `,
        'src/renderer/shell/namespace-hook.ts': `
          import * as hooks from '@example/session-hooks';
          export const session = hooks.useExternalSession();
        `,
        'src/renderer/shell/react-namespace-alias.ts': `
          import * as React from 'react';
          const R = React;
          export const state = R.useState(false);
        `,
        'src/renderer/shell/react-19-hooks.tsx': `
          import { useActionState, useInsertionEffect, useOptimistic, useTransition } from 'react';
          export function StatefulFrame() {
            useActionState(async (state: number) => state, 0);
            useInsertionEffect(() => undefined, []);
            useOptimistic(0);
            useTransition();
            return null;
          }
        `,
        'src/renderer/composition/class-lifecycle.tsx': `
          import * as React from 'react';
          export class DesktopComposition extends React.Component {
            componentDidMount() {}
            render() { return null; }
          }
        `,
        'src/renderer/composition/class-field-lifecycle.tsx': `
          import * as React from 'react';
          export class DesktopComposition extends React.Component {
            componentDidMount = () => {};
            render() { return null; }
          }
        `,
        'src/renderer/composition/class-state.tsx': `
          import * as React from 'react';
          export class StatefulComposition extends React.Component {
            constructor() {
              super({});
              this.state = { mounted: false };
            }
            render() { return null; }
          }
        `,
        'src/renderer/composition/feature-namespace-hook.ts': `
          import * as session from '../features/alpha/index.js';
          export const controller = session.useSessionController();
        `,
        'src/renderer/features/alpha/index.ts': `
          export function useSessionController() { return {}; }
        `,
        'src/renderer/composition/plain-class.ts': `
          export class DomainLifecycleName {
            componentDidMount() { return 'not React'; }
          }
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(
          violations,
          /^src\/renderer\/shell\/shell-frame\.tsx: shell code owns stateful React hooks$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/shell\/shell-frame\.tsx: shell imports forbidden implementation module:/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/shell\/custom-hook\.ts: shell code owns stateful React hooks$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/shell\/namespace-hook\.ts: shell code owns stateful React hooks$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/shell\/react-namespace-alias\.ts: shell code owns stateful React hooks$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/shell\/react-19-hooks\.tsx: shell code owns stateful React hooks$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/composition\/class-lifecycle\.tsx: composition code owns React class lifecycle methods$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/composition\/class-field-lifecycle\.tsx: composition code owns React class lifecycle methods$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/composition\/class-state\.tsx: composition code owns React class lifecycle methods$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/composition\/feature-namespace-hook\.ts: composition code owns stateful React hooks$/u,
        );
        assert.ok(
          !violations.some((violation) => violation.includes('plain-class.ts')),
          `Non-React classes must not be treated as React lifecycle owners:\n${violations.join('\n')}`,
        );
      },
    );
  });

  it('rejects bridge debt that grows relative to the base ledger', async () => {
    const debtPath = 'src/renderer/legacy-root.ts';
    const currentConfig = architectureConfig({
      rootDebt: {
        [debtPath]: emptyDebt({ bridgePaths: { 'window.maka.sessions.list': 1 } }),
      },
    });
    const baseConfig = architectureConfig({
      rootDebt: {
        [debtPath]: emptyDebt(),
      },
    });

    await withDesktopFixture(
      {
        [debtPath]: 'void window.maka.sessions.list();',
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-root\.ts: bridgePaths debt increased from 0 to 1$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-root\.ts: new or increased bridgePaths debt window\.maka\.sessions\.list$/u,
        );
      },
    );
  });

  it('accepts the single pinned renderer module entry', async () => {
    await withDesktopFixture(
      rendererEntryContractFiles(),
      (desktopRoot) => {
        const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
        assert.deepEqual(checkRendererArchitecture({ config, desktopRoot }), []);
      },
    );
  });

  it('rejects replacing the pinned renderer module entry with an alternate source', async () => {
    await withDesktopFixture(
      rendererEntryContractFiles({
        'src/renderer/index.html': `
          <!doctype html>
          <html><body><script type="module" src="/settings/alternate-entry.tsx"></script></body></html>
        `,
        'src/renderer/settings/alternate-entry.tsx': `
          void window.maka.sessions.list();
          export const alternateEntry = true;
        `,
      }),
      (desktopRoot) => {
        const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
        assertHasViolation(
          checkRendererArchitecture({ config, desktopRoot }),
          /^src\/renderer\/index\.html: renderer entry contract requires exactly one empty external module script for \/main\.tsx$/u,
        );
      },
    );
  });

  it('rejects adding another renderer module entry beside the pinned source', async () => {
    await withDesktopFixture(
      rendererEntryContractFiles({
        'src/renderer/index.html': `
          <!doctype html>
          <html><body>
            <script type="module" src="/main.tsx"></script>
            <script type="module" src="/settings/alternate-entry.tsx"></script>
          </body></html>
        `,
        'src/renderer/settings/alternate-entry.tsx': `export const alternateEntry = true;`,
      }),
      (desktopRoot) => {
        const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
        assertHasViolation(
          checkRendererArchitecture({ config, desktopRoot }),
          /^src\/renderer\/index\.html: renderer entry contract requires exactly one empty external module script for \/main\.tsx$/u,
        );
      },
    );
  });

  it('rejects changing the packaged main-window loader to an alternate renderer document', async () => {
    await withDesktopFixture(
      rendererEntryContractFiles({
        'src/main/main-renderer-loader.ts': `
          import { join } from 'node:path';
          import { pathToFileURL } from 'node:url';
          interface MainRendererWindow {
            loadFile(path: string): Promise<void>;
            loadURL(url: string): Promise<void>;
          }
          interface MainRendererEntry {
            readonly filePath: string;
            readonly url: string;
            readonly useDevServer: boolean;
          }
          export function resolveMainRendererEntry(
            mainModuleDirectory: string,
            viteDevServerUrl: string | undefined,
          ): MainRendererEntry {
            const rendererEntryPath = join(mainModuleDirectory, '..', '..', 'dist-renderer', 'alternate.html');
            const rendererEntryUrl = viteDevServerUrl ?? pathToFileURL(rendererEntryPath).href;
            return Object.freeze({
              filePath: rendererEntryPath,
              url: rendererEntryUrl,
              useDevServer: !!viteDevServerUrl,
            });
          }
          export async function loadMainRenderer(
            mainWindow: MainRendererWindow,
            rendererEntry: MainRendererEntry,
          ): Promise<void> {
            if (rendererEntry.useDevServer) {
              await mainWindow.loadURL(rendererEntry.url);
            } else {
              await mainWindow.loadFile(rendererEntry.filePath);
            }
          }
        `,
      }),
      (desktopRoot) => {
        const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
        assertHasViolation(
          checkRendererArchitecture({ config, desktopRoot }),
          /^src\/main\/main-renderer-loader\.ts: renderer loader must load only the pinned dist-renderer\/index\.html entry$/u,
        );
      },
    );
  });

  it('rejects shadowing the pinned renderer path helpers behind local bindings', async () => {
    const files = rendererEntryContractFiles();
    files['src/main/main-renderer-loader.ts'] = files['src/main/main-renderer-loader.ts']
      .replace("import { join } from 'node:path';", "import { join as pathJoin } from 'node:path';")
      .replace(
        "import { pathToFileURL } from 'node:url';",
        `
          import { pathToFileURL as nodePathToFileURL } from 'node:url';
          function join(...parts) {
            return pathJoin(...parts.slice(0, -1), 'alternate.html');
          }
          function pathToFileURL(path) {
            return nodePathToFileURL(path);
          }
        `,
      );
    await withDesktopFixture(files, (desktopRoot) => {
      const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
      assertHasViolation(
        checkRendererArchitecture({ config, desktopRoot }),
        /^src\/main\/main-renderer-loader\.ts: renderer loader must load only the pinned dist-renderer\/index\.html entry$/u,
      );
    });
  });

  it('rejects reassigning the resolved renderer entry before loading it', async () => {
    const files = rendererEntryContractFiles();
    files['src/main/main-window.ts'] = files['src/main/main-window.ts']
      .replace('const rendererEntry =', 'let rendererEntry =')
      .replace(
        'await loadMainRenderer(mainWindow, rendererEntry);',
        `
          rendererEntry = {
            filePath: '/alternate.html',
            url: 'file:///alternate.html',
            useDevServer: false,
          };
          await loadMainRenderer(mainWindow, rendererEntry);
        `,
      );
    await withDesktopFixture(files, (desktopRoot) => {
      const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
      assertHasViolation(
        checkRendererArchitecture({ config, desktopRoot }),
        /^src\/main\/main-window\.ts: main window must delegate exactly once to the pinned renderer loader$/u,
      );
    });
  });

  it('rejects mutating the frozen renderer entry before loading it', async () => {
    const files = rendererEntryContractFiles();
    files['src/main/main-window.ts'] = files['src/main/main-window.ts'].replace(
      'await loadMainRenderer(mainWindow, rendererEntry);',
      `
        rendererEntry.filePath = '/alternate.html';
        await loadMainRenderer(mainWindow, rendererEntry);
      `,
    );
    await withDesktopFixture(files, (desktopRoot) => {
      const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
      assertHasViolation(
        checkRendererArchitecture({ config, desktopRoot }),
        /^src\/main\/main-window\.ts: main window must delegate exactly once to the pinned renderer loader$/u,
      );
    });
  });

  it('rejects aliasing the main window navigation API around the dedicated loader', async () => {
    await withDesktopFixture(
      rendererEntryContractFiles({
        'src/main/main-window.ts': `
          import { loadMainRenderer, resolveMainRendererEntry } from './main-renderer-loader.js';
          async function createWindow() {
            const rendererEntry = resolveMainRendererEntry(import.meta.dirname, process.env.VITE_DEV_SERVER_URL);
            await loadMainRenderer(mainWindow, rendererEntry);
            const alternateEntryPath = join(import.meta.dirname, '..', '..', 'dist-renderer', 'alternate.html');
            const loadAlternateEntry = mainWindow.loadFile.bind(mainWindow);
            await loadAlternateEntry(alternateEntryPath);
          }
        `,
      }),
      (desktopRoot) => {
        const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
        assertHasViolation(
          checkRendererArchitecture({ config, desktopRoot }),
          /^src\/main\/main-window\.ts: main window must delegate exactly once to the pinned renderer loader$/u,
        );
      },
    );
  });

  it('rejects a computed second navigation inside the dedicated loader branch', async () => {
    const files = rendererEntryContractFiles();
    files['src/main/main-renderer-loader.ts'] = files['src/main/main-renderer-loader.ts'].replace(
      'await mainWindow.loadFile(rendererEntry.filePath);',
      `
        await mainWindow.loadFile(rendererEntry.filePath);
        await mainWindow['load' + 'File'](
          rendererEntry.filePath.replace('index.html', 'alternate.html'),
        );
      `,
    );
    await withDesktopFixture(files, (desktopRoot) => {
      const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
      assertHasViolation(
        checkRendererArchitecture({ config, desktopRoot }),
        /^src\/main\/main-renderer-loader\.ts: renderer loader must load only the pinned dist-renderer\/index\.html entry$/u,
      );
    });
  });

  it('rejects remapping the Vite renderer root to an alternate source tree', async () => {
    await withDesktopFixture(
      rendererEntryContractFiles({
        'vite.config.ts': `
          export default defineConfig({
            root: 'src/renderer/settings/alternate-root',
            build: { outDir: '../../../../dist-renderer' },
          });
        `,
      }),
      (desktopRoot) => {
        const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
        assertHasViolation(
          checkRendererArchitecture({ config, desktopRoot }),
          /^vite\.config\.ts: Vite must build src\/renderer\/index\.html into dist-renderer without an input override$/u,
        );
      },
    );
  });

  it('rejects shadowing the pinned Vite config factory behind a local binding', async () => {
    const files = rendererEntryContractFiles();
    files['vite.config.ts'] = files['vite.config.ts']
      .replace("import { defineConfig } from 'vite';", "import { defineConfig as viteDefineConfig } from 'vite';")
      .replace(
        "const REPO_ROOT = '/fixture';",
        `
          const REPO_ROOT = '/fixture';
          function defineConfig(config) {
            return viteDefineConfig(config);
          }
        `,
      );
    await withDesktopFixture(files, (desktopRoot) => {
      const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
      assertHasViolation(
        checkRendererArchitecture({ config, desktopRoot }),
        /^vite\.config\.ts: Vite must build src\/renderer\/index\.html into dist-renderer without an input override$/u,
      );
    });
  });

  it('rejects pointing the Vite entry guard at a different renderer root', async () => {
    const files = rendererEntryContractFiles();
    files['vite.config.ts'] = files['vite.config.ts'].replace(
      "rendererEntryContractPlugin(resolve(import.meta.dirname, 'src/renderer'))",
      "rendererEntryContractPlugin(resolve(import.meta.dirname, 'src/renderer/settings/alternate-root'))",
    );
    await withDesktopFixture(files, (desktopRoot) => {
      const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
      assertHasViolation(
        checkRendererArchitecture({ config, desktopRoot }),
        /^vite\.config\.ts: Vite must build src\/renderer\/index\.html into dist-renderer without an input override$/u,
      );
    });
  });

  it('attests the canonical main source in the final Vite entry graph', () => {
    assert.doesNotThrow(() =>
      runRendererEntryBundleContract([
        '\0vite/modulepreload-polyfill.js',
        '/fixture/src/renderer/index.html?html-proxy&inline-css&index=0.css',
        '/fixture/src/renderer/main.tsx',
      ]),
    );
  });

  it('does not apply the renderer entry contract to Storybook builds', () => {
    const plugin = rendererEntryContractPlugin('/fixture/src/renderer');
    plugin.configResolved({ root: '/fixture/storybook' });
    assert.doesNotThrow(() =>
      plugin.generateBundle.call(
        {
          emitFile() {
            assert.fail('a non-renderer build must not emit a renderer attestation');
          },
        },
        {},
        {},
      ),
    );
  });

  it('rejects a Vite HTML transform that swaps the final entry graph', () => {
    assert.throws(
      () =>
        runRendererEntryBundleContract([
          '\0vite/modulepreload-polyfill.js',
          '/fixture/src/renderer/settings/alternate-entry.tsx',
        ]),
      /renderer entry contract requires src\/renderer\/index\.html to import only src\/renderer\/main\.tsx/u,
    );
  });

  it('rejects executable HTML injected around the canonical module entry', () => {
    assert.doesNotThrow(() => assertRendererEntryHtml(canonicalRendererEntryHtml()));
    const emittedHtml = canonicalRendererEntryHtml().replace(
      '/main.tsx',
      './assets/index-canonical.js',
    );
    assert.doesNotThrow(() =>
      assertRendererEntryHtml(emittedHtml, './assets/index-canonical.js'),
    );
    assert.throws(
      () => assertRendererEntryHtml(emittedHtml, './assets/index-other.js'),
      /renderer entry HTML contract forbids transformed executable or navigation surfaces/u,
    );
    assert.throws(
      () =>
        assertRendererEntryHtml(
          canonicalRendererEntryHtml(
            '<script>window.maka.sessions.list()</script>',
            "script-src 'self' 'unsafe-inline'",
          ),
        ),
      /renderer entry HTML contract forbids transformed executable or navigation surfaces/u,
    );
    assert.throws(
      () =>
        assertRendererEntryHtml(
          canonicalRendererEntryHtml('<iframe src="/settings/alternate.html"></iframe>'),
        ),
      /renderer entry HTML contract forbids transformed executable or navigation surfaces/u,
    );
  });

  it('rejects a newly allowlisted root debt file relative to the base ledger', async () => {
    const debtPath = 'src/renderer/new-root-debt.ts';
    const currentConfig = architectureConfig({
      rootDebt: { [debtPath]: emptyDebt() },
    });
    const baseConfig = architectureConfig();

    await withDesktopFixture(
      {
        [debtPath]: 'export const newRootDebt = true;',
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/new-root-debt\.ts: new rootDebt debt entries are forbidden$/u,
        );
      },
    );
  });

  it('rejects deleting root debt while the existing root entry is still dirty', async () => {
    const debtPath = 'src/renderer/main.tsx';
    const currentConfig = architectureConfig({ legacyRendererFiles: [debtPath] });
    const baseConfig = architectureConfig({
      legacyRendererFiles: [debtPath],
      rootDebt: {
        [debtPath]: emptyDebt({
          bridgePaths: { 'window.maka.sessions.list': 1 },
          hookCalls: { useEffect: 1 },
        }),
      },
    });

    await withDesktopFixture(
      {
        [debtPath]: `
          import { useEffect } from 'react';
          void window.maka.sessions.list();
          export function RendererEntry() { useEffect(() => undefined, []); return null; }
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/main\.tsx: permanent root entry guard cannot be removed while the source exists$/u,
        );
      },
    );
  });

  it('rejects removing the permanent root guard while a clean thin entry still exists', async () => {
    const debtPath = 'src/renderer/main.tsx';
    const currentConfig = architectureConfig({ legacyRendererFiles: [debtPath] });
    const baseConfig = architectureConfig({
      legacyRendererFiles: [debtPath],
      rootDebt: {
        [debtPath]: emptyDebt({
          bridgePaths: { 'window.maka.onboarding.getSnapshot': 1 },
          hookCalls: { useEffect: 1 },
        }),
      },
    });

    await withDesktopFixture(
      {
        [debtPath]: `
          import { mountDesktopApplication } from './bootstrap/mount-desktop-application.js';
          mountDesktopApplication();
        `,
        'src/renderer/bootstrap/mount-desktop-application.ts': `
          export function mountDesktopApplication() {}
        `,
      },
      (desktopRoot) => {
        assertHasViolation(
          violationsFor(desktopRoot, currentConfig, baseConfig),
          /^src\/renderer\/main\.tsx: permanent root entry guard cannot be removed while the source exists$/u,
        );
      },
    );
  });

  it('rejects bridge debt returning to a retained clean root entry', async () => {
    const debtPath = 'src/renderer/main.tsx';
    const cleanSource = `
      import { mountDesktopApplication } from './bootstrap/mount-desktop-application.js';
      mountDesktopApplication();
    `;
    const pollutedSource = `
      import { mountDesktopApplication } from './bootstrap/mount-desktop-application.js';
      void window.maka.sessions.list();
      mountDesktopApplication();
    `;
    const baseConfig = architectureConfig({
      legacyRendererFiles: [debtPath],
      rootDebt: { [debtPath]: debtForSource(cleanSource, debtPath) },
    });
    const currentConfig = architectureConfig({
      legacyRendererFiles: [debtPath],
      rootDebt: { [debtPath]: debtForSource(pollutedSource, debtPath) },
    });

    await withDesktopFixture(
      {
        [debtPath]: pollutedSource,
        'src/renderer/bootstrap/mount-desktop-application.ts': `
          export function mountDesktopApplication() {}
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/main\.tsx: bridgePaths debt increased from 0 to 1$/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/main\.tsx: new or increased bridgePaths debt window\.maka\.sessions\.list$/u,
        );
      },
    );
  });

  it('allows removing the permanent root guard after its source is deleted', async () => {
    const debtPath = 'src/renderer/main.tsx';
    const currentConfig = architectureConfig();
    const baseConfig = architectureConfig({
      legacyRendererFiles: [debtPath],
      rootDebt: { [debtPath]: emptyDebt() },
    });

    await withDesktopFixture(
      {
        'src/renderer/bootstrap/mount-desktop-application.ts': `
          export function mountDesktopApplication() {}
        `,
      },
      (desktopRoot) => {
        assert.deepEqual(violationsFor(desktopRoot, currentConfig, baseConfig), []);
      },
    );
  });

  it('rejects retiring root debt by moving state and storage ownership into bootstrap', async () => {
    const debtPath = 'src/renderer/main.tsx';
    const currentConfig = architectureConfig({ legacyRendererFiles: [debtPath] });
    const baseConfig = architectureConfig({
      legacyRendererFiles: [debtPath],
      rootDebt: { [debtPath]: emptyDebt() },
    });

    await withDesktopFixture(
      {
        [debtPath]: `
          import { PollutedBootstrap } from './bootstrap/polluted-bootstrap.js';
          void PollutedBootstrap;
        `,
        'src/renderer/bootstrap/polluted-bootstrap.tsx': `
          import { useState } from 'react';
          export function PollutedBootstrap() {
            const [value] = useState(() => localStorage.getItem('root-state'));
            return <main>{value}</main>;
          }
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /bootstrap\/polluted-bootstrap\.tsx: bootstrap code owns stateful React hooks/u,
        );
        assertHasViolation(
          violations,
          /bootstrap\/polluted-bootstrap\.tsx: bootstrap code directly accesses browser environment capabilities/u,
        );
        assertHasViolation(
          violations,
          /^src\/renderer\/main\.tsx: permanent root entry guard cannot be removed while the source exists$/u,
        );
      },
    );
  });

  it('allows new legacy files inside an explicitly approved growth directory', async () => {
    const growthDirectory = 'src/renderer/settings';
    const path = `${growthDirectory}/new-preference.ts`;
    const currentConfig = architectureConfig({
      legacyGrowthDirectories: [growthDirectory],
      legacyRendererFiles: [path],
    });
    const baseConfig = architectureConfig({
      legacyGrowthDirectories: [growthDirectory],
    });

    await withDesktopFixture(
      {
        [path]: 'export const newPreference = true;',
      },
      (desktopRoot) => {
        assert.deepEqual(violationsFor(desktopRoot, currentConfig, baseConfig), []);
      },
    );
  });

  it('rejects arbitrary new unclassified renderer source names relative to the base ledger', async () => {
    const path = 'src/renderer/session-coordinator.mts';
    const currentConfig = architectureConfig({ legacyRendererFiles: [path] });
    const baseConfig = architectureConfig();

    await withDesktopFixture(
      {
        [path]: 'export const coordinator = true;',
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/session-coordinator\.mts: new unclassified renderer source files are forbidden outside approved legacy directories$/u,
        );
      },
    );
  });

  it('rejects unbudgeted legacy imports from every strict ownership zone', async () => {
    await withDesktopFixture(
      {
        'src/renderer/legacy-helper.ts': 'export const legacy = true;',
        'src/renderer/features/alpha/controller.ts': `
          import { legacy } from '../../legacy-helper.js';
          export const featureValue = legacy;
        `,
        'src/renderer/application/session/session-scope.ts': `
          import { legacy } from '../../legacy-helper.js';
          export const applicationValue = legacy;
        `,
        'src/renderer/composition/desktop-application.ts': `
          import { legacy } from '../legacy-helper.js';
          export const compositionValue = legacy;
        `,
        'src/renderer/platform/desktop/create-services.ts': `
          import { legacy } from '../../legacy-helper.js';
          export const platformValue = legacy;
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(violations, /feature imports unbudgeted renderer legacy code/u);
        assertHasViolation(violations, /application authority imports an outer implementation/u);
        assertHasViolation(violations, /composition imports a forbidden implementation module/u);
        assertHasViolation(violations, /Desktop adapter imports unbudgeted renderer legacy code/u);
      },
    );
  });

  it('detects bridge aliases, TypeScript wrappers, and aliased React hooks', async () => {
    await withDesktopFixture(
      {
        'src/renderer/application/bridge-aliases.ts': `
          const desktopWindow = window;
          void desktopWindow.maka.sessions.list();
          void globalThis.maka.sessions.list();
          void self['maka'].sessions.list();
          void (window as Window).maka.sessions.list();
          void window!.maka.sessions.list();
          const { maka } = window;
          void maka.sessions.list();
        `,
        'src/renderer/shell/aliased-hook.ts': `
          import { useState as state } from 'react';
          export function useFrameState() { return state(false); }
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(violations, /bridge-aliases\.ts: application code accesses the Desktop global bridge/u);
        assertHasViolation(violations, /aliased-hook\.ts: shell code owns stateful React hooks/u);
      },
    );
  });

  it('retains full bridge method paths after the Desktop bridge is aliased', () => {
    const analysis = analyzeRendererSource(
      `
        const bridge = window.maka;
        void bridge.sessions.list();
        const { maka: desktop } = window;
        void desktop.transcripts.open('session-a');
      `,
      'src/renderer/application/bridge-method-aliases.ts',
    );

    assert.equal(analysis.bridgePaths['window.maka.sessions.list'], 1);
    assert.equal(analysis.bridgePaths['window.maka.transcripts.open'], 1);
  });

  it('retains stateful hook ownership through local aliases', () => {
    const analysis = analyzeRendererSource(
      `
        import { useState as state } from 'react';
        const localState = state;
        localState(false);
      `,
      'src/renderer/shell/hook-method-aliases.ts',
    );

    assert.equal(analysis.hookCalls.useState, 1);

    const reassigned = analyzeRendererSource(
      `
        import { useEffect, useState } from 'react';
        let hook = useState;
        hook = useEffect;
        hook(false);
      `,
      'src/renderer/shell/reassigned-hook-alias.ts',
    );
    assert.equal(reassigned.hookCalls.useState, 1);
    assert.equal(reassigned.hookCalls.useEffect, 1);

    const repeatedVar = analyzeRendererSource(
      `
        import React, { useState } from 'react';
        function legacyAliases() {
          var hook;
          var hook = useState;
          var R;
          var R = React;
          var NestedReact;
          if (true) {
            var NestedReact = React;
          }
          hook(false);
          R.useState(false);
          NestedReact.useState(false);
        }
      `,
      'src/renderer/shell/repeated-var-hook-alias.ts',
    );
    assert.equal(repeatedVar.hookCalls.useState, 3);
  });

  it('recognizes React 19 use and namespace-destructured custom Hooks', async () => {
    const analysis = analyzeRendererSource(
      `
        import { use as read } from 'react';
        import * as React from 'react';
        import * as hooks from '@astryxdesign/core/hooks';
        const R = React;
        const { use: readFromNamespace } = R;
        const hookNamespace = hooks;
        const { useHotkeys: hotkeys } = hookNamespace;
        const { useHotkeys } = hooks as typeof hooks;
        const { useHotkeys: defaultHotkeys = () => undefined } = hooks as typeof hooks;
        read(Promise.resolve('direct'));
        React.use(Promise.resolve('member'));
        readFromNamespace(Promise.resolve('destructured'));
        hotkeys([]);
        useHotkeys([]);
        defaultHotkeys([]);
        function shadowedReact(React: { use(value: unknown): unknown }) {
          return React.use(Promise.resolve('shadowed'));
        }
        function shadowedHook(useHotkeys: (bindings: unknown[]) => unknown) {
          return useHotkeys([]);
        }
        function blockShadowedReact() {
          const React = { use: (value: unknown) => value };
          return React.use(Promise.resolve('block-shadowed'));
        }
        function blockShadowedHook() {
          const useHotkeys = (bindings: unknown[]) => bindings;
          return useHotkeys([]);
        }
        function lateDestructuredAlias() {
          const lateHotkeys = lateUseHotkeys;
          return lateHotkeys([]);
        }
        const { useHotkeys: lateUseHotkeys } = hooks as typeof hooks;
      `,
      'src/renderer/shell/react-use-aliases.tsx',
    );
    assert.equal(analysis.hookCalls.use, 3);
    assert.equal(analysis.hookCalls.useHotkeys, 4);

    const nonReactUse = analyzeRendererSource(
      `
        import { use } from './plain-helper.js';
        use('not-react');
      `,
      'src/renderer/shell/plain-use.ts',
    );
    assert.deepEqual(nonReactUse.hookCalls, {});

    await withDesktopFixture(
      {
        'src/renderer/shell/react-use.tsx': `
          import { use } from 'react';
          export function ShellRead() { return use(Promise.resolve('shell')); }
        `,
        'src/renderer/composition/react-namespace-use.tsx': `
          import * as React from 'react';
          export function CompositionRead() { return React.use(Promise.resolve('composition')); }
        `,
        'src/renderer/platform/desktop/destructured-hook.ts': `
          import * as hooks from '@astryxdesign/core/hooks';
          const { useHotkeys = () => undefined } = hooks as typeof hooks;
          export function installHotkeys() { return useHotkeys([]); }
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(violations, /shell\/react-use\.tsx: shell code owns stateful React hooks/u);
        assertHasViolation(
          violations,
          /composition\/react-namespace-use\.tsx: composition code owns stateful React hooks/u,
        );
        assertHasViolation(
          violations,
          /platform\/desktop\/destructured-hook\.ts: platform code owns stateful React hooks/u,
        );
      },
    );
  });

  it('parses TypeScript and static-template dependencies and fails closed on dynamic paths', async () => {
    await withDesktopFixture(
      {
        'src/renderer/features/alpha/import-equals.ts': `
          import beta = require('../beta/private.js');
          export const value = beta;
        `,
        'src/renderer/features/alpha/dynamic.ts': `
          export function load(path: string) { return import(path); }
        `,
        'src/renderer/features/beta/private.ts': 'export const beta = true;',
        'src/renderer/application/contracts/deep-type.ts': `
          export type Deep = import('../../features/alpha/private.js').Deep;
        `,
        'src/renderer/composition/static-template.ts': `
          export const deep = import(\`../features/alpha/private.js\`);
        `,
        'src/renderer/composition/import-meta-glob.ts': `
          export const privateFeatures = import.meta.glob('../features/alpha/private.ts');
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(desktopRoot);
        assertHasViolation(violations, /import-equals\.ts: feature alpha imports feature beta/u);
        assertHasViolation(violations, /dynamic\.ts: feature code contains a non-static import or require/u);
        assertHasViolation(violations, /deep-type\.ts: feature imports must use index/u);
        assertHasViolation(violations, /static-template\.ts: feature imports must use index/u);
        assertHasViolation(violations, /import-meta-glob\.ts: composition code contains a non-static import or require/u);
      },
    );
  });

  it('forbids exposing a feature testing entry through its public index', async () => {
    await withDesktopFixture(
      {
        'src/renderer/features/alpha/index.ts': `export * from './testing.js';`,
        'src/renderer/features/alpha/testing.ts': 'export const fake = true;',
      },
      (desktopRoot) => {
        assertHasViolation(
          violationsFor(desktopRoot),
          /feature .*testing entry/u,
        );
      },
    );
  });

  it('allows legacy AppShell dependency replacement with feature public APIs and application contracts', async () => {
    const appShellPath = 'src/renderer/app-shell.tsx';
    const appShellSource = `
      import { AlphaHost } from './features/alpha/index.js';
      import { defaultSessionScope } from './application/contracts/session-scope.js';
      export function AppShell() {
        return <AlphaHost scope={defaultSessionScope} />;
      }
    `;
    const currentDebt = debtForSource(appShellSource, appShellPath);
    const baseDebt = {
      ...currentDebt,
      dependencyPaths: {
        './legacy-alpha-owner.js': 1,
        './legacy-session-owner.js': 1,
      },
    };
    const ownership = [
      {
        capability: 'fixture-app-shell',
        targetZone: 'shell',
        legacyPaths: [appShellPath],
      },
    ];
    const currentConfig = architectureConfig({
      legacyFiles: { [appShellPath]: currentDebt },
      legacyRendererFiles: [appShellPath],
      ownership,
    });
    const baseConfig = architectureConfig({
      legacyFiles: { [appShellPath]: baseDebt },
      legacyRendererFiles: [appShellPath],
      ownership,
    });

    await withDesktopFixture(
      {
        [appShellPath]: appShellSource,
        'src/renderer/features/alpha/index.ts': `
          export function AlphaHost(_props: unknown) { return null; }
        `,
        'src/renderer/application/contracts/session-scope.ts': `
          export const defaultSessionScope = { sessionId: undefined };
        `,
      },
      (desktopRoot) => {
        assert.deepEqual(violationsFor(desktopRoot, currentConfig, baseConfig), []);
      },
    );
  });

  it('rejects replacing legacy AppShell debt with a feature private import', async () => {
    const appShellPath = 'src/renderer/app-shell.tsx';
    const appShellSource = `
      import { alphaController } from './features/alpha/controller.js';
      export const AppShell = alphaController;
    `;
    const currentDebt = debtForSource(appShellSource, appShellPath);
    const baseDebt = {
      ...currentDebt,
      dependencyPaths: { './legacy-alpha-owner.js': 1 },
    };
    const ownership = [
      {
        capability: 'fixture-app-shell',
        targetZone: 'shell',
        legacyPaths: [appShellPath],
      },
    ];
    const currentConfig = architectureConfig({
      legacyFiles: { [appShellPath]: currentDebt },
      legacyRendererFiles: [appShellPath],
      ownership,
    });
    const baseConfig = architectureConfig({
      legacyFiles: { [appShellPath]: baseDebt },
      legacyRendererFiles: [appShellPath],
      ownership,
    });

    await withDesktopFixture(
      {
        [appShellPath]: appShellSource,
        'src/renderer/features/alpha/controller.ts': 'export const alphaController = true;',
      },
      (desktopRoot) => {
        assertHasViolation(
          violationsFor(desktopRoot, currentConfig, baseConfig),
          /^src\/renderer\/app-shell\.tsx: new dependency debt \.\/features\/alpha\/controller\.js$/u,
        );
      },
    );
  });

  it('enforces a unique feature owner for registered controllers', async () => {
    const controllerOwner = {
      implementation:
        'src/renderer/features/alpha/controller/use-alpha-controller.ts',
      symbol: 'useAlphaController',
      owner: 'src/renderer/features/alpha/ui/alpha-provider.tsx',
      ownerSymbol: 'AlphaProvider',
      count: 1,
    };
    await withDesktopFixture(
      {
        [controllerOwner.implementation]: `
          export interface AlphaController { readonly ready: boolean }
          export function useAlphaController(): AlphaController {
            return { ready: true };
          }
        `,
        [controllerOwner.owner]: `
          import { useAlphaController as useController } from '../controller/use-alpha-controller.js';
          export function AlphaProvider() {
            const controller = useController();
            return controller.ready ? null : null;
          }
        `,
        'src/renderer/features/alpha/index.ts': `
          export { AlphaProvider } from './ui/alpha-provider.js';
        `,
        'src/renderer/features/alpha/testing.ts': `
          import type { AlphaController } from './controller/use-alpha-controller.js';
          export {
            useAlphaController,
            type AlphaController,
          } from './controller/use-alpha-controller.js';
        `,
      },
      (desktopRoot) => {
        const config = architectureConfig({ controllerOwners: [controllerOwner] });
        assert.deepEqual(
          violationsFor(desktopRoot, config, architectureConfig()),
          [],
        );
        assertHasViolation(
          violationsFor(
            desktopRoot,
            architectureConfig({
              controllerOwners: [
                {
                  ...controllerOwner,
                  owner:
                    'src/renderer/features/alpha/ui/alpha-provider.test.tsx',
                },
              ],
            }),
          ),
          /owner must be a production feature implementation file/u,
        );
      },
    );
  });

  it('keeps the registered owner as a JSX-only component inside its own file', async () => {
    const controllerOwner = {
      implementation:
        'src/renderer/features/alpha/controller/use-alpha-controller.ts',
      symbol: 'useAlphaController',
      owner: 'src/renderer/features/alpha/ui/alpha-provider.tsx',
      ownerSymbol: 'AlphaProvider',
      count: 1,
    };
    await withDesktopFixture(
      {
        [controllerOwner.implementation]: `
          export function useAlphaController() { return true; }
        `,
        [controllerOwner.owner]: `
          import { useAlphaController } from '../controller/use-alpha-controller.js';
          export function AlphaProvider() { useAlphaController(); return null; }
          export const controllerFactory = (props) => AlphaProvider(props);
        `,
        'src/renderer/features/alpha/index.ts': `
          export { AlphaProvider, controllerFactory } from './ui/alpha-provider.js';
        `,
      },
      (desktopRoot) => {
        assertHasViolation(
          violationsFor(
            desktopRoot,
            architectureConfig({ controllerOwners: [controllerOwner] }),
          ),
          /owner must expose AlphaProvider only as a JSX component/u,
        );
      },
    );
  });

  it('binds controller calls to the registered import instead of a same-name hook', async () => {
    const controllerOwner = {
      implementation:
        'src/renderer/features/alpha/controller/use-alpha-controller.ts',
      symbol: 'useAlphaController',
      owner: 'src/renderer/features/alpha/ui/alpha-provider.tsx',
      ownerSymbol: 'AlphaProvider',
      count: 1,
    };
    await withDesktopFixture(
      {
        [controllerOwner.implementation]: `
          export function useAlphaController() { return 'registered'; }
        `,
        [controllerOwner.owner]: `
          import { useAlphaController } from '../controller/use-alpha-controller.js';
          import { useAlphaController as useOtherController } from '../other-controller.js';
          export function AlphaProvider() { return useOtherController(); }
        `,
        'src/renderer/features/alpha/other-controller.ts': `
          export function useAlphaController() { return 'other'; }
        `,
        'src/renderer/features/alpha/index.ts': `
          export { AlphaProvider } from './ui/alpha-provider.js';
        `,
      },
      (desktopRoot) => {
        assertHasViolation(
          violationsFor(
            desktopRoot,
            architectureConfig({ controllerOwners: [controllerOwner] }),
          ),
          /must call the controller 1 time\(s\), received 0/u,
        );
      },
    );
  });

  it('requires consumers to mount the registered owner through JSX', async () => {
    const controllerOwner = {
      implementation:
        'src/renderer/features/alpha/controller/use-alpha-controller.ts',
      symbol: 'useAlphaController',
      owner: 'src/renderer/features/alpha/ui/alpha-provider.tsx',
      ownerSymbol: 'AlphaProvider',
      count: 1,
    };
    await withDesktopFixture(
      {
        [controllerOwner.implementation]: `
          export function useAlphaController() { return true; }
        `,
        [controllerOwner.owner]: `
          import { useAlphaController } from '../controller/use-alpha-controller.js';
          export function AlphaProvider() { useAlphaController(); return null; }
        `,
        'src/renderer/features/alpha/index.ts': `
          export { AlphaProvider } from './ui/alpha-provider.js';
        `,
        'src/renderer/composition/direct-provider.ts': `
          import * as Alpha from '../features/alpha';
          export const direct = Alpha.AlphaProvider({});
        `,
        'src/renderer/composition/aliased-provider.ts': `
          import * as Alpha from '../features/alpha/index.js';
          const Provider = Alpha.AlphaProvider;
          export const direct = Provider({});
        `,
        'src/renderer/composition/runtime-provider.ts': `
          const Alpha = require('../features/alpha');
          export const direct = Alpha.AlphaProvider({});
        `,
        'src/renderer/composition/provider-barrel.ts': `
          export { AlphaProvider as controllerFactory } from '../features/alpha/index.js';
        `,
        'src/renderer/features/alpha/ui/provider-factory.ts': `
          import { AlphaProvider } from './alpha-provider.js';
          export const controllerFactory = AlphaProvider;
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(
          desktopRoot,
          architectureConfig({ controllerOwners: [controllerOwner] }),
        );
        assertHasViolation(
          violations,
          /direct-provider\.ts must mount AlphaProvider through JSX/u,
        );
        assertHasViolation(
          violations,
          /aliased-provider\.ts must mount AlphaProvider through JSX/u,
        );
        assertHasViolation(
          violations,
          /runtime-provider\.ts must import AlphaProvider statically and mount it through JSX/u,
        );
        assertHasViolation(
          violations,
          /provider-barrel\.ts must not re-export AlphaProvider from the public feature entry/u,
        );
        assertHasViolation(
          violations,
          /provider-factory\.ts must consume AlphaProvider through the public feature entry/u,
        );
      },
    );
  });

  it('rejects controller imports, runtime loading, and public re-exports outside the owner', async () => {
    const controllerOwner = {
      implementation:
        'src/renderer/features/alpha/controller/use-alpha-controller.ts',
      symbol: 'useAlphaController',
      owner: 'src/renderer/features/alpha/ui/alpha-provider.tsx',
      ownerSymbol: 'AlphaProvider',
      count: 1,
    };
    await withDesktopFixture(
      {
        [controllerOwner.implementation]: `
          export function useAlphaController() { return true; }
        `,
        [controllerOwner.owner]: `
          import { useAlphaController } from '../controller/use-alpha-controller.js';
          export function AlphaProvider() { useAlphaController(); return null; }
        `,
        'src/renderer/features/alpha/secondary-owner.ts': `
          import { useAlphaController as useSecondary } from './controller/use-alpha-controller.js';
          export const secondary = () => useSecondary();
        `,
        'src/renderer/features/alpha/default-owner.ts': `
          import controller from './controller/use-alpha-controller.js';
          export const defaultOwner = controller;
        `,
        'src/renderer/features/alpha/other-value-owner.ts': `
          import { helper } from './controller/use-alpha-controller.js';
          export const otherOwner = helper;
        `,
        'src/renderer/features/alpha/query-owner.ts': `
          import { useAlphaController } from './controller/use-alpha-controller.js?raw';
          export const queryOwner = () => useAlphaController();
        `,
        'src/renderer/features/alpha/dynamic-owner.ts': `
          export const loadController = () => import('./controller/use-alpha-controller.js');
        `,
        'src/renderer/features/alpha/private-controller.ts': `
          export { useAlphaController } from './controller/use-alpha-controller.js';
        `,
        'src/renderer/features/alpha/index.ts': `
          export { default as useAlphaController } from './controller/use-alpha-controller.js';
        `,
      },
      (desktopRoot) => {
        const violations = violationsFor(
          desktopRoot,
          architectureConfig({ controllerOwners: [controllerOwner] }),
        );
        assertHasViolation(
          violations,
          /controller implementation is imported by non-owner .*secondary-owner\.ts/u,
        );
        assertHasViolation(
          violations,
          /controller implementation is imported by non-owner .*default-owner\.ts/u,
        );
        assertHasViolation(
          violations,
          /controller implementation is imported by non-owner .*other-value-owner\.ts/u,
        );
        assertHasViolation(
          violations,
          /controller implementation is imported by non-owner .*query-owner\.ts/u,
        );
        assertHasViolation(
          violations,
          /controller implementation is referenced by non-owner .*dynamic-owner\.ts/u,
        );
        assertHasViolation(
          violations,
          /controller implementation is re-exported by .*private-controller\.ts/u,
        );
        assertHasViolation(
          violations,
          /controller implementation is re-exported by .*index\.ts/u,
        );
        assertHasViolation(
          violations,
          /public feature entry must not expose the controller/u,
        );
      },
    );
  });

  it('requires the registered owner to import and call its controller exactly once', async () => {
    const controllerOwner = {
      implementation:
        'src/renderer/features/alpha/controller/use-alpha-controller.ts',
      symbol: 'useAlphaController',
      owner: 'src/renderer/features/alpha/ui/alpha-provider.tsx',
      ownerSymbol: 'AlphaProvider',
      count: 1,
    };
    await withDesktopFixture(
      {
        [controllerOwner.implementation]: `
          export function useAlphaController() { return true; }
        `,
        [controllerOwner.owner]: `
          import { useAlphaController } from '../controller/use-alpha-controller.js';
          export function AlphaProvider() {
            useAlphaController();
            useAlphaController();
            return null;
          }
        `,
      },
      (desktopRoot) => {
        assertHasViolation(
          violationsFor(
            desktopRoot,
            architectureConfig({ controllerOwners: [controllerOwner] }),
          ),
          /must call the controller 1 time\(s\), received 2/u,
        );
      },
    );
  });

  it('ratchets controller owner contracts against their base configuration', async () => {
    const controllerOwner = {
      implementation:
        'src/renderer/features/alpha/controller/use-alpha-controller.ts',
      symbol: 'useAlphaController',
      owner: 'src/renderer/features/alpha/ui/alpha-provider.tsx',
      ownerSymbol: 'AlphaProvider',
      count: 1,
    };
    const alternateOwner = {
      ...controllerOwner,
      owner: 'src/renderer/features/alpha/ui/alternate-provider.tsx',
    };
    await withDesktopFixture(
      {
        [controllerOwner.implementation]: `
          export function useAlphaController() { return true; }
        `,
        [alternateOwner.owner]: `
          import { useAlphaController } from '../controller/use-alpha-controller.js';
          export function AlternateProvider() { useAlphaController(); return null; }
        `,
      },
      (desktopRoot) => {
        const base = architectureConfig({ controllerOwners: [controllerOwner] });
        assertHasViolation(
          violationsFor(desktopRoot, architectureConfig(), base),
          /historical controller owner entries cannot be removed/u,
        );
        assertHasViolation(
          violationsFor(
            desktopRoot,
            architectureConfig({ controllerOwners: [alternateOwner] }),
            base,
          ),
          /historical controller owner cannot change/u,
        );

        const retiredBase = architectureConfig({
          controllerOwners: [{ ...controllerOwner, count: 0 }],
        });
        assertHasViolation(
          violationsFor(
            desktopRoot,
            architectureConfig({ controllerOwners: [controllerOwner] }),
            retiredBase,
          ),
          /controller call count cannot increase from 0 to 1/u,
        );
      },
    );
  });

  it('allows a registered controller to retire without allowing it to return', async () => {
    const activeOwner = {
      implementation:
        'src/renderer/features/alpha/controller/use-alpha-controller.ts',
      symbol: 'useAlphaController',
      owner: 'src/renderer/features/alpha/ui/alpha-provider.tsx',
      ownerSymbol: 'AlphaProvider',
      count: 1,
    };
    const retiredOwner = { ...activeOwner, count: 0 };
    await withDesktopFixture(
      {
        [activeOwner.implementation]: `
          export function useAlphaController() { return true; }
        `,
        [activeOwner.owner]: `
          export function AlphaProvider() { return null; }
        `,
        'src/renderer/features/alpha/index.ts': `
          export { AlphaProvider } from './ui/alpha-provider.js';
        `,
      },
      (desktopRoot) => {
        assert.deepEqual(
          violationsFor(
            desktopRoot,
            architectureConfig({ controllerOwners: [retiredOwner] }),
            architectureConfig({ controllerOwners: [activeOwner] }),
          ),
          [],
        );
      },
    );
  });

  it('preserves hand-authored controller owner policy when regenerating debt', async () => {
    const controllerOwner = {
      implementation:
        'src/renderer/features/alpha/controller/use-alpha-controller.ts',
      symbol: 'useAlphaController',
      owner: 'src/renderer/features/alpha/ui/alpha-provider.tsx',
      ownerSymbol: 'AlphaProvider',
      count: 1,
    };
    await withDesktopFixture(
      {
        [controllerOwner.implementation]: `
          export function useAlphaController() { return true; }
        `,
        [controllerOwner.owner]: `
          import { useAlphaController } from '../controller/use-alpha-controller.js';
          export function AlphaProvider() { useAlphaController(); return null; }
        `,
      },
      (desktopRoot) => {
        const generated = generateArchitectureConfig(
          desktopRoot,
          architectureConfig({ controllerOwners: [controllerOwner] }),
        );
        assert.deepEqual(generated.controllerOwners, [controllerOwner]);
      },
    );
  });

  it('fails closed when the CLI base argument is missing or invalid', () => {
    const checker = fileURLToPath(new URL('./check-renderer-architecture.mjs', import.meta.url));
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const missing = spawnSync(process.execPath, [checker, '--base'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const invalid = spawnSync(process.execPath, [checker, '--base', 'definitely-not-a-renderer-architecture-ref'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /usage: check-renderer-architecture/u);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /base ref does not resolve to a commit/u);
  });
});

describe('validated copy catalog dependencies', () => {
  const CATALOG_PATH = 'src/renderer/locales/fixture-copy.ts';

  function catalogSource(extra = '') {
    return `
      import type { UiCatalog } from '@maka/core/ui-locale';
      export interface FixtureCopy { readonly notice: string; }
      export const FIXTURE_COPY = {
        en: { notice: 'Notice' },
        zh: { notice: '通知' },
      } satisfies UiCatalog<FixtureCopy>;
      ${extra}
    `;
  }

  function catalogSeedConfig() {
    return architectureConfig({
      legacyGrowthDirectories: ['src/renderer/locales'],
      ownership: [
        {
          capability: 'fixture-app-shell',
          targetZone: 'shell',
          legacyPaths: [TRANSITIVE_APP_SHELL_PATH],
        },
      ],
    });
  }

  function baseWithoutCatalog(currentConfig) {
    const baseConfig = structuredClone(currentConfig);
    delete baseConfig.legacyAppShell.closure[CATALOG_PATH];
    baseConfig.legacyRendererFiles = baseConfig.legacyRendererFiles.filter(
      (path) => path !== CATALOG_PATH,
    );
    baseConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH].dependencyPaths = {};
    return baseConfig;
  }

  it('admits a validated copy catalog as a new legacy dependency and closure entry', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import { FIXTURE_COPY } from './locales/fixture-copy.js';
          export const legacySessionHelper = FIXTURE_COPY.en.notice;
        `,
        { [CATALOG_PATH]: catalogSource() },
      ),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
        assert.deepEqual(
          violationsFor(desktopRoot, currentConfig, baseWithoutCatalog(currentConfig)),
          [],
        );
      },
    );
  });

  const INVALID_CATALOGS = [
    ['a hook call', catalogSource(`
      import { useState } from 'react';
      export function useFixtureCopy() { return useState(FIXTURE_COPY); }
    `)],
    ['a relative implementation import', catalogSource(`
      import { legacySessionStore } from '../legacy-session-store.js';
      export const smuggled = legacySessionStore;
    `)],
    ['a @maka/desktop self-import', catalogSource(`
      import { legacySessionStore } from '@maka/desktop/src/renderer/legacy-session-store.js';
      export const smuggled = legacySessionStore;
    `)],
    ['no UiCatalog marker', `
      export const FIXTURE_COPY = {
        en: { notice: 'Notice' },
        zh: { notice: '通知' },
      };
    `],
  ];

  for (const [flaw, source] of INVALID_CATALOGS) {
    it(`keeps the ratchet for a catalog with ${flaw}`, async () => {
      await withDesktopFixture(
        transitiveAppShellFiles(
          `
            import { FIXTURE_COPY } from './locales/fixture-copy.js';
            export const legacySessionHelper = FIXTURE_COPY;
          `,
          {
            [CATALOG_PATH]: source,
            'src/renderer/legacy-session-store.ts': `export const legacySessionStore = 'legacy';`,
          },
        ),
        (desktopRoot) => {
          const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
          const violations = violationsFor(
            desktopRoot,
            currentConfig,
            baseWithoutCatalog(currentConfig),
          );
          assertHasViolation(
            violations,
            /^src\/renderer\/locales\/fixture-copy\.ts: new legacyAppShellClosure debt entries are forbidden$/u,
          );
          assertHasViolation(
            violations,
            /^src\/renderer\/legacy-session-helper\.ts: new dependency debt \.\/locales\/fixture-copy\.js$/u,
          );
          assertHasViolation(
            violations,
            /^src\/renderer\/locales\/fixture-copy\.ts: copy catalog validation failed: /u,
          );
        },
      );
    });
  }

  it('keeps admission for copy keys named after browser globals and type-only relative imports', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import { FIXTURE_COPY } from './locales/fixture-copy.js';
          export const legacySessionHelper = FIXTURE_COPY.en.history;
        `,
        {
          [CATALOG_PATH]: `
            import type { UiCatalog } from '@maka/core/ui-locale';
            import type { LegacySessionStore } from '../legacy-session-store.js';
            export interface FixtureCopy { readonly history: string; readonly location: string; }
            export type StoreRef = LegacySessionStore;
            export const FIXTURE_COPY = {
              en: { history: 'History', location: 'Location' },
              zh: { history: '历史', location: '位置' },
            } satisfies UiCatalog<FixtureCopy>;
          `,
          'src/renderer/legacy-session-store.ts': `export interface LegacySessionStore { readonly id: string }`,
        },
      ),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
        assert.deepEqual(
          violationsFor(desktopRoot, currentConfig, baseWithoutCatalog(currentConfig)),
          [],
        );
      },
    );
  });

  it('exempts a validated catalog\'s own type-only contract imports from dependency debt', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import { FIXTURE_COPY } from './locales/fixture-copy.js';
          export const legacySessionHelper = FIXTURE_COPY.en.byCode.missing;
        `,
        {
          [CATALOG_PATH]: `
            import type { UiCatalog } from '@maka/core/ui-locale';
            import type { FixtureErrorCode } from '../fixture-contract.js';
            export interface FixtureCopy { readonly byCode: Record<FixtureErrorCode, string>; }
            export const FIXTURE_COPY = {
              en: { byCode: { missing: 'Missing' } },
              zh: { byCode: { missing: '缺失' } },
            } satisfies UiCatalog<FixtureCopy>;
          `,
          'src/renderer/fixture-contract.ts': `export type FixtureErrorCode = 'missing';`,
        },
      ),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
        const baseConfig = baseWithoutCatalog(currentConfig);
        delete baseConfig.legacyAppShell.closure['src/renderer/fixture-contract.ts'];
        baseConfig.legacyRendererFiles = baseConfig.legacyRendererFiles.filter(
          (path) => path !== 'src/renderer/fixture-contract.ts',
        );
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assert.ok(
          !violations.some((violation) => violation.includes('fixture-copy')),
          `type-only contract import must carry no debt, received:\n${violations.join('\n')}`,
        );
      },
    );
  });

  const IMPORT_FORMS = [
    [`import type { A } from './x.js'; export type B = A;`, 0, 0, {}],
    [`import { type A } from './x.js'; export type B = A;`, 0, 0, {}],
    [`export type { A } from './x.js';`, 0, 0, {}],
    [`export type * from './x.js';`, 0, 0, {}],
    [`export type B = import('./x.js').A;`, 0, 0, {}],
    [`import { a, type A } from './x.js'; export const b: A = a;`, 1, 1, { './x.js': 1 }],
    [`import './x.js';`, 1, 0, { './x.js': 1 }],
    [`export * from './x.js';`, 0, 0, { './x.js': 1 }],
  ];

  for (const [source, importDeclarations, importSpecifiers, dependencyPaths] of IMPORT_FORMS) {
    it(`prices only the runtime part of \`${source.split(';')[0]}\``, () => {
      const debt = debtForSource(source, 'src/renderer/fixture.ts');
      assert.deepEqual(
        { importDeclarations: debt.importDeclarations, importSpecifiers: debt.importSpecifiers, dependencyPaths: debt.dependencyPaths },
        { importDeclarations, importSpecifiers, dependencyPaths },
      );
    });
  }

  it('records no dependency debt for a new type-only import anywhere in the closure', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import type { LegacyShape } from './legacy-session-store.js';
          export const legacySessionHelper: LegacyShape = { kind: 'legacy' };
        `,
        {
          'src/renderer/legacy-session-store.ts': `export interface LegacyShape { kind: string }`,
        },
      ),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
        const baseConfig = structuredClone(currentConfig);
        baseConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH].dependencyPaths = {};
        delete baseConfig.legacyAppShell.closure['src/renderer/legacy-session-store.ts'];
        baseConfig.legacyRendererFiles = baseConfig.legacyRendererFiles.filter(
          (path) => path !== 'src/renderer/legacy-session-store.ts',
        );
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assert.ok(
          !violations.some((violation) => violation.includes('dependency debt')),
          `type-only edge must carry no debt, received:\n${violations.join('\n')}`,
        );
      },
    );
  });

  it('starts counting the moment a type-only edge turns into a runtime import', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import { legacySessionStore } from './legacy-session-store.js';
          export const legacySessionHelper = legacySessionStore;
        `,
        {
          'src/renderer/legacy-session-store.ts': `export const legacySessionStore = 'legacy';`,
        },
      ),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
        const baseConfig = structuredClone(currentConfig);
        // The base recorded the same edge as type-only: no debt entry.
        baseConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH].dependencyPaths = {};
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: new dependency debt \.\/legacy-session-store\.js$/u,
        );
      },
    );
  });

  const NEW_EDGE_TARGETS = [
    ['src/renderer/application/contracts/fixture-diagnostics.ts', 'free'],
    ['src/renderer/shell/fixture-shell.ts', 'free'],
    ['src/renderer/features/alpha/index.ts', 'free'],
    ['src/renderer/application/sessions/fixture-service.ts', 'priced'],
    ['src/renderer/features/alpha/fixture-internal.ts', 'priced'],
  ];

  for (const [targetPath, pricing] of NEW_EDGE_TARGETS) {
    it(`${pricing === 'free' ? 'exempts' : 'prices'} a new legacy edge to ${targetPath}`, async () => {
      const specifier = `./${targetPath.slice('src/renderer/'.length).replace(/\.ts$/u, '.js')}`;
      await withDesktopFixture(
        transitiveAppShellFiles(
          `
            import { reportFixture } from '${specifier}';
            export const legacySessionHelper = reportFixture('legacy');
          `,
          { [targetPath]: `export function reportFixture(scope: string): string { return scope; }` },
        ),
        (desktopRoot) => {
          const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
          const baseConfig = structuredClone(currentConfig);
          baseConfig.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH].dependencyPaths = {};
          const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
          const priced = violations.some((violation) =>
            violation.startsWith(`${TRANSITIVE_LEGACY_HELPER_PATH}: new dependency debt`),
          );
          assert.equal(priced, pricing === 'priced', violations.join('\n'));
        },
      );
    });
  }

  it('rejects a legacy type-only edge into an application implementation as a hard violation', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import type { FixtureService } from './application/sessions/fixture-service.js';
          export const legacySessionHelper: FixtureService = { kind: 'legacy' };
        `,
        { 'src/renderer/application/sessions/fixture-service.ts': `export interface FixtureService { kind: string }` },
      ),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
        const violations = violationsFor(desktopRoot, currentConfig, structuredClone(currentConfig));
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: legacy renderer code imports application implementation instead of a public entry: \.\/application\/sessions\/fixture-service\.js$/u,
        );
        assert.ok(!violations.some((violation) => violation.includes('dependency debt')), violations.join('\n'));
      },
    );
  });

  it('keeps pricing every non-catalog edge for a root entry', async () => {
    const source = `
      import { AlphaFeature } from './features/alpha/index.js';
      import { FIXTURE_COPY } from './locales/fixture-copy.js';
      export const main = [AlphaFeature, FIXTURE_COPY];
    `;
    await withDesktopFixture(
      {
        [RENDERER_ENTRY_PATH]: source,
        'src/renderer/features/alpha/index.ts': `export const AlphaFeature = 'alpha';`,
        [CATALOG_PATH]: catalogSource(),
      },
      (desktopRoot) => {
        const seedConfig = rendererEntrySeedConfig();
        seedConfig.legacyGrowthDirectories = ['src/renderer/locales'];
        const currentConfig = generateArchitectureConfig(desktopRoot, seedConfig);
        const baseConfig = structuredClone(currentConfig);
        baseConfig.rootDebt[RENDERER_ENTRY_PATH].dependencyPaths = {};
        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(violations, /^src\/renderer\/main\.tsx: new dependency debt \.\/features\/alpha\/index\.js$/u);
        assert.ok(!violations.some((violation) => violation.includes('fixture-copy')), violations.join('\n'));
      },
    );
  });

  it('fails closed upstream when a reachable catalog uses a dynamic import', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import { FIXTURE_COPY } from './locales/fixture-copy.js';
          export const legacySessionHelper = FIXTURE_COPY;
        `,
        {
          [CATALOG_PATH]: catalogSource(`
            export async function load(name) { return import(name); }
          `),
        },
      ),
      (desktopRoot) => {
        assert.throws(
          () => generateArchitectureConfig(desktopRoot, catalogSeedConfig()),
          /non-static import/u,
        );
      },
    );
  });

  it('still rejects an unrelated dependency added beside a validated catalog', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import { FIXTURE_COPY } from './locales/fixture-copy.js';
          import { legacySessionStore } from './legacy-session-store.js';
          export const legacySessionHelper = FIXTURE_COPY.en.notice + legacySessionStore;
        `,
        {
          [CATALOG_PATH]: catalogSource(),
          'src/renderer/legacy-session-store.ts': `export const legacySessionStore = 'legacy';`,
        },
      ),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
        const baseConfig = baseWithoutCatalog(currentConfig);
        delete baseConfig.legacyAppShell.closure['src/renderer/legacy-session-store.ts'];
        baseConfig.legacyRendererFiles = baseConfig.legacyRendererFiles.filter(
          (path) => path !== 'src/renderer/legacy-session-store.ts',
        );

        const violations = violationsFor(desktopRoot, currentConfig, baseConfig);
        assertHasViolation(
          violations,
          /^src\/renderer\/legacy-session-helper\.ts: new dependency debt \.\/legacy-session-store\.js$/u,
        );
        assert.ok(
          !violations.some((violation) => violation.includes('fixture-copy')),
          `catalog dependency must stay admitted, received:\n${violations.join('\n')}`,
        );
      },
    );
  });

  it('lets feature code import a validated catalog without a legacy budget edge', async () => {
    await withDesktopFixture(
      {
        [CATALOG_PATH]: catalogSource(),
        'src/renderer/features/alpha/controller.ts': `
          import { FIXTURE_COPY } from '../../locales/fixture-copy.js';
          export const featureNotice = FIXTURE_COPY.en.notice;
        `,
      },
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(
          desktopRoot,
          architectureConfig({ legacyGrowthDirectories: ['src/renderer/locales'] }),
        );
        assert.deepEqual(currentConfig.legacyFeatureImports, []);
        assert.deepEqual(violationsFor(desktopRoot, currentConfig), []);
      },
    );
  });
});
