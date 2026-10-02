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
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyzeRendererSource,
  checkRendererArchitecture,
  collectFeatureEntrySurfaces,
  generateArchitectureConfig,
  rendererArchitectureReport,
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
  featurePrivateModules = [],
  legacyAppShellClosureDebt,
  legacyFeatureImports = [],
  legacyFiles = {},
  legacyGrowthDirectories = [],
  legacyPlatformImports = [],
  rootDebt = {},
  rootDebtClosure = {},
  legacyRendererFiles = Object.keys(rootDebt),
  ownership = [],
  rootSymbolUses,
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
    featurePrivateModules: [...featurePrivateModules].sort(),
    ...(rootSymbolUses === undefined ? {} : { rootSymbolUses }),
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

function canonicalRendererEntryHtml(
  extraBody = '',
  policy = "script-src 'self' maka-client-plugin:",
) {
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
        const rootSymbolUses = { 'src/renderer/features/alpha/index.ts': { composition: ['AlphaHost'] } };
        assert.deepEqual(violationsFor(desktopRoot, architectureConfig({ rootSymbolUses })), []);
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

  it('allows replacing a legacy dependency with a platform adapter without growing imports', async () => {
    const target = 'src/renderer/platform/desktop/transcript.ts';
    await withDesktopFixture(
      transitiveAppShellFiles(
        `import { transcript } from './platform/desktop/transcript.js'; export const legacySessionHelper = transcript;`,
        { [target]: 'export const transcript = 1;' },
      ),
      (desktopRoot) => {
        const current = generateArchitectureConfig(desktopRoot, transitiveAppShellSeedConfig());
        const base = structuredClone(current);
        base.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH].dependencyPaths = { './legacy-transcript.js': 1 };
        assert.deepEqual(violationsFor(desktopRoot, current, base), []);
        base.legacyAppShell.closure[TRANSITIVE_LEGACY_HELPER_PATH].dependencyPaths = {};
        assertHasViolation(violationsFor(desktopRoot, current, base), /new dependency debt/u);
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

  it('allows a WorkHub query on the pinned document, but rejects another surface or document', async () => {
    for (const variant of ['workhub', 'arbitrary-surface', 'alternate-document']) {
      const files = rendererEntryContractFiles();
      files['src/main/main-renderer-loader.ts'] = files['src/main/main-renderer-loader.ts'].replace(
        'rendererEntry: MainRendererEntry,\n      ): Promise<void> {',
        `rendererEntry: MainRendererEntry,
        surface?: '${variant === 'arbitrary-surface' ? 'other' : 'workhub'}',
      ): Promise<void> {
        if (surface) {
          const url = new URL(${variant === 'alternate-document' ? "'https://other.example'" : 'rendererEntry.url'});
          url.searchParams.set('surface', surface);
          await mainWindow.loadURL(url.href);
          return;
        }`,
      );
      await withDesktopFixture(files, (desktopRoot) => {
        const config = generateArchitectureConfig(desktopRoot, rendererEntrySeedConfig());
        const violations = checkRendererArchitecture({ config, desktopRoot });
        if (variant === 'workhub') assert.deepEqual(violations, []);
        else assertHasViolation(violations, /renderer loader must load only the pinned/u);
      });
    }
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
    const currentDebt = {
      ...debtForSource(appShellSource, appShellPath),
      importDeclarations: 0,
      importSpecifiers: 0,
    };
    const baseDebt = {
      ...currentDebt,
      importDeclarations: 2,
      importSpecifiers: 2,
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
    const rootSymbolUses = { 'src/renderer/features/alpha/index.ts': { appShell: ['AlphaHost'] } };
    const currentConfig = architectureConfig({
      legacyFiles: { [appShellPath]: currentDebt },
      legacyRendererFiles: [appShellPath],
      ownership,
      rootSymbolUses,
    });
    const baseConfig = architectureConfig({
      legacyFiles: { [appShellPath]: baseDebt },
      legacyRendererFiles: [appShellPath],
      ownership,
      rootSymbolUses,
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

  for (const [targetPath, pricing] of [
    ['src/renderer/application/contracts/fixture-diagnostics.ts', 'free'],
    ['src/renderer/application/sessions/fixture-service.ts', 'priced'],
  ]) {
    it(`${pricing === 'free' ? 'exempts' : 'prices'} AppShell import specifiers from ${targetPath}`, async () => {
      const specifier = `./${targetPath.slice('src/renderer/'.length).replace(/\.ts$/u, '.js')}`;
      await withDesktopFixture(
        {
          [TRANSITIVE_APP_SHELL_PATH]: `
            import { reportFixture } from '${specifier}';
            export const AppShell = reportFixture('shell');
          `,
          [targetPath]: `export function reportFixture(scope: string): string { return scope; }`,
        },
        (desktopRoot) => {
          const currentConfig = generateArchitectureConfig(desktopRoot, transitiveAppShellSeedConfig());
          const baseConfig = structuredClone(currentConfig);
          Object.assign(baseConfig.legacyAppShell.files[TRANSITIVE_APP_SHELL_PATH], {
            importDeclarations: 0,
            importSpecifiers: 0,
            dependencyPaths: {},
          });
          const priced = violationsFor(desktopRoot, currentConfig, baseConfig).some((violation) =>
            violation.startsWith(`${TRANSITIVE_APP_SHELL_PATH}: importSpecifiers debt increased`),
          );
          assert.equal(priced, pricing === 'priced');
        },
      );
    });
  }

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
    const strictWithoutBase = spawnSync(process.execPath, [checker, '--strict-base'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /usage: check-renderer-architecture/u);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /base ref does not resolve to a commit/u);
    assert.notEqual(strictWithoutBase.status, 0);
    assert.match(strictWithoutBase.stderr, /--strict-base requires --base <commit>/u);
    assert.match(strictWithoutBase.stderr, /usage: check-renderer-architecture/u);
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

  it('does not price a catalog\'s own bare package runtime import', async () => {
    await withDesktopFixture(
      transitiveAppShellFiles(
        `
          import { FIXTURE_COPY } from './locales/fixture-copy.js';
          export const legacySessionHelper = FIXTURE_COPY.en.notice;
        `,
        {
          [CATALOG_PATH]: catalogSource(`
            import { lookupCopy } from '@maka/core/ui-locale';
            export const noticeFor = (code: string) => lookupCopy(FIXTURE_COPY.en, code);
          `),
        },
      ),
      (desktopRoot) => {
        const currentConfig = generateArchitectureConfig(desktopRoot, catalogSeedConfig());
        const baseConfig = structuredClone(currentConfig);
        baseConfig.legacyAppShell.closure[CATALOG_PATH].dependencyPaths = {};
        assert.deepEqual(violationsFor(desktopRoot, currentConfig, baseConfig), []);
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

// These fixtures exercise the CLI end to end against a real git history: the
// ratchet must re-derive the base commit's debt from the base *tree* (#4249),
// `--strict-base` must refuse fallback that could reintroduce #4250's failure, and
// a checker change must still be measured by the base commit's checker.
describe('renderer architecture base-tree derivation (git fixtures)', () => {
  const checkerPath = fileURLToPath(new URL('./check-renderer-architecture.mjs', import.meta.url));
  const realNodeModules = fileURLToPath(new URL('../../../node_modules', import.meta.url));
  const LEGACY_WIDGET_PATH = 'src/renderer/legacy-widget.ts';
  const LEGACY_PANEL_PATH = 'src/renderer/legacy-panel.ts';
  const LEGACY_CLASSIFICATION = ".filter((path) => zoneFor(path).kind === 'legacy')";

  function fixtureEnvironment(scratch) {
    // Keep the fixture repository independent of the developer's git setup
    // (signing, hooks, templates) and of any hook-provided git context.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    env.GIT_CONFIG_GLOBAL = join(scratch, 'gitconfig');
    env.GIT_CONFIG_NOSYSTEM = '1';
    return env;
  }

  // The base worktree is materialized under the OS temp directory; pointing
  // every temp-dir variable at a missing directory makes that step fail
  // deterministically on every platform without touching git itself.
  function brokenTempDirectory(scratch) {
    const missing = join(scratch, 'missing-tmpdir');
    return { TEMP: missing, TMP: missing, TMPDIR: missing };
  }

  async function writeFixtureFiles(root, files) {
    for (const [path, source] of Object.entries(files)) {
      const absolutePath = join(root, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, source, 'utf8');
    }
  }

  async function withGitFixture(run) {
    // The checker only runs its CLI when process.argv[1] is its own real
    // path, so resolve the (possibly symlinked) temp directory up front.
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'maka-renderer-architecture-git-')));
    const repoRoot = join(scratch, 'repo');
    const desktopRoot = join(repoRoot, 'apps', 'desktop');
    const nodeModulesLink = join(repoRoot, 'node_modules');
    const env = fixtureEnvironment(scratch);
    const git = (...args) => {
      const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', env });
      assert.equal(result.status, 0, `git ${args.join(' ')} failed:\n${result.stderr}`);
      return result.stdout.trim();
    };
    const fixture = {
      desktopRoot,
      ledgerPath: join(desktopRoot, 'renderer-architecture.json'),
      scratch,
      scriptPath: join(desktopRoot, 'scripts', 'check-renderer-architecture.mjs'),
      commit(message) {
        git('add', '--all');
        git('commit', '--quiet', '--no-verify', '--message', message);
        return git('rev-parse', 'HEAD');
      },
      runChecker(args, extraEnv = {}) {
        return spawnSync(process.execPath, [fixture.scriptPath, ...args], {
          cwd: repoRoot,
          encoding: 'utf8',
          env: { ...env, ...extraEnv },
        });
      },
      writeFiles: (files) => writeFixtureFiles(desktopRoot, files),
      // Regenerates the ledger with the checker committed in the fixture, so a
      // patched checker produces exactly the ledger its own rules accept.
      async writeLedger(seed = rendererEntrySeedConfig()) {
        await writeFile(fixture.ledgerPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
        const result = fixture.runChecker(['--write']);
        assert.equal(result.status, 0, `ledger generation failed:\n${result.stdout}\n${result.stderr}`);
        return JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
      },
    };
    try {
      await mkdir(join(desktopRoot, 'scripts'), { recursive: true });
      await writeFile(join(scratch, 'gitconfig'), '', 'utf8');
      await copyFile(checkerPath, fixture.scriptPath);
      await symlink(realNodeModules, nodeModulesLink, 'junction');
      await writeFile(join(repoRoot, '.gitignore'), 'node_modules\n', 'utf8');
      await fixture.writeFiles(
        rendererEntryContractFiles({
          [LEGACY_WIDGET_PATH]: 'export const legacyWidget = 1;\n',
          [LEGACY_PANEL_PATH]: 'export const legacyPanel = 1;\n',
        }),
      );
      git('-c', 'init.defaultBranch=main', 'init', '--quiet');
      git('config', 'user.name', 'Renderer Architecture Fixture');
      git('config', 'user.email', 'renderer-architecture@example.invalid');
      git('config', 'commit.gpgsign', 'false');
      return await run(fixture);
    } finally {
      // Drop the node_modules link explicitly so no cleanup path can ever
      // recurse into the real dependency tree.
      try {
        await unlink(nodeModulesLink);
      } catch {
        // The link was never created.
      }
      await rm(scratch, { force: true, recursive: true });
    }
  }

  function assertPassed(result, base, label) {
    assert.equal(result.status, 0, `${label}:\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`passed against ${base}`, 'u'));
    assert.doesNotMatch(result.stderr, /falling back to the committed base ledger/u);
  }

  it('passes when the head commit holds equal or lower debt than the derived base tree', async () => {
    await withGitFixture(async (fixture) => {
      await fixture.writeLedger();
      const base = fixture.commit('base');
      await fixture.writeFiles({ [LEGACY_WIDGET_PATH]: 'export const legacyWidget = 2;\n' });
      await rm(join(fixture.desktopRoot, LEGACY_PANEL_PATH));
      const headLedger = await fixture.writeLedger();
      assert.deepEqual(headLedger.legacyRendererFiles, [LEGACY_WIDGET_PATH, RENDERER_ENTRY_PATH]);
      fixture.commit('edit one legacy file and retire another');

      for (const args of [['--base', base], ['--base', base, '--strict-base']]) {
        const result = fixture.runChecker(args);
        assertPassed(result, base, args.join(' '));
        // The checker is unchanged between the commits, so no cross-check ran.
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /cross-check/u);
      }
    });
  });

  it('admits root symbol growth only for an export the head change adds', async () => {
    await withGitFixture(async (fixture) => {
      const entry = 'src/renderer/features/alpha/index.ts';
      const composition = 'src/renderer/composition/desktop-application.tsx';
      await fixture.writeFiles({
        [entry]: "export { AlphaPanel, AlphaProvider } from './ui/alpha.js';\n",
        'src/renderer/features/alpha/ui/alpha.tsx': `
          export function AlphaProvider(_props: { readonly children?: unknown }) { return null; }
          export function AlphaPanel() { return null; }
          export function AlphaInspector() { return null; }
        `,
        [composition]: "import { AlphaProvider } from '../features/alpha';\nexport const DesktopApplication = () => <AlphaProvider />;\n",
      });
      await fixture.writeLedger();
      const base = fixture.commit('base');

      await fixture.writeFiles({
        [composition]: "import { AlphaPanel, AlphaProvider } from '../features/alpha';\nexport const DesktopApplication = () => <AlphaProvider><AlphaPanel /></AlphaProvider>;\n",
      });
      await fixture.writeLedger();
      fixture.commit('take an export the base entry already had');
      const existing = fixture.runChecker(['--base', base, '--strict-base']);
      assert.notEqual(existing.status, 0);
      assert.match(
        existing.stderr,
        /^- src\/renderer\/features\/alpha\/index\.ts: composition root newly uses existing public export AlphaPanel;/mu,
      );

      await fixture.writeFiles({
        [entry]: "export { AlphaPanel, AlphaProvider } from './ui/alpha.js';\nexport { AlphaPanel as AlphaPanelAlias } from './ui/alpha.js';\n",
        [composition]: "import { AlphaPanelAlias, AlphaProvider } from '../features/alpha';\nexport const DesktopApplication = () => <AlphaProvider><AlphaPanelAlias /></AlphaProvider>;\n",
      });
      await fixture.writeLedger();
      fixture.commit('take an existing export through a new alias');
      const aliased = fixture.runChecker(['--base', base, '--strict-base']);
      assert.notEqual(aliased.status, 0);
      assert.match(
        aliased.stderr,
        /^- src\/renderer\/features\/alpha\/index\.ts: composition root newly uses AlphaPanelAlias, an alias of existing public export AlphaPanel;/mu,
      );

      await fixture.writeFiles({
        [entry]: "export { AlphaInspector, AlphaPanel, AlphaProvider } from './ui/alpha.js';\n",
        [composition]: "import { AlphaInspector, AlphaProvider } from '../features/alpha';\nexport const DesktopApplication = () => <AlphaProvider><AlphaInspector /></AlphaProvider>;\n",
      });
      const headLedger = await fixture.writeLedger();
      assert.deepEqual(headLedger.rootSymbolUses, { [entry]: { composition: ['AlphaInspector', 'AlphaProvider'] } });
      fixture.commit('take an export the same change adds');
      const added = fixture.runChecker(['--base', base, '--strict-base', '--report']);
      assertPassed(added, base, 'new public export');
      assert.match(added.stdout, /Renderer architecture report:\n[^]*Root symbol uses: appShell 0, bootstrap 0, composition 2\n/u);
      assert.match(
        added.stdout,
        /root symbol use admitted: src\/renderer\/features\/alpha\/index\.ts: composition AlphaInspector \(new public export\)/u,
      );
    });
  });

  it('reports, without ratcheting, a feature symbol newly taken in the AppShell closure', async () => {
    await withGitFixture(async (fixture) => {
      const appShell = 'src/renderer/app-shell.ts';
      const helper = 'src/renderer/legacy-session-helper.ts';
      const seed = architectureConfig({
        rootDebt: { [RENDERER_ENTRY_PATH]: emptyDebt() },
        ownership: [
          { capability: 'fixture-root', targetZone: 'bootstrap', legacyPaths: [RENDERER_ENTRY_PATH] },
          { capability: 'fixture-app-shell', targetZone: 'shell', legacyPaths: [appShell] },
        ],
      });
      await fixture.writeFiles({
        'src/renderer/features/alpha/index.ts': "export function alphaLabel() { return 'alpha'; }\n",
        [appShell]: "import { legacySessionHelper } from './legacy-session-helper.js';\nexport const AppShell = legacySessionHelper;\n",
        [helper]: 'export const legacySessionHelper = 1;\n',
      });
      await fixture.writeLedger(seed);
      const base = fixture.commit('base');
      await fixture.writeFiles({
        [helper]: "import { alphaLabel } from './features/alpha/index.js';\nexport const legacySessionHelper = alphaLabel();\n",
      });
      await fixture.writeLedger(seed);
      fixture.commit('the closure takes a feature symbol');

      const result = fixture.runChecker(['--base', base, '--strict-base']);
      assertPassed(result, base, 'closure growth is only reported');
      assert.match(
        result.stdout,
        /AppShell closure newly uses alphaLabel from src\/renderer\/features\/alpha\/index\.ts in src\/renderer\/legacy-session-helper\.ts \(reported, not ratcheted\)/u,
      );
    });
  });

  it('rejects a new unclassified legacy renderer file relative to the derived base tree', async () => {
    await withGitFixture(async (fixture) => {
      await fixture.writeLedger();
      const base = fixture.commit('base');
      await fixture.writeFiles({ 'src/renderer/legacy-drawer.ts': 'export const legacyDrawer = 1;\n' });
      await fixture.writeLedger();
      fixture.commit('add legacy debt');

      const result = fixture.runChecker(['--base', base, '--strict-base']);
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /^- src\/renderer\/legacy-drawer\.ts: new unclassified renderer source files are forbidden/mu,
      );
      assert.doesNotMatch(result.stderr, /falling back to the committed base ledger/u);
    });
  });

  it('does not wedge on a base ledger that under-reports its own tree (#4250)', async () => {
    await withGitFixture(async (fixture) => {
      // The base ledger only knows one legacy file while the base *tree*
      // already carries a second one.
      await rm(join(fixture.desktopRoot, LEGACY_PANEL_PATH));
      await fixture.writeLedger();
      await fixture.writeFiles({ [LEGACY_PANEL_PATH]: 'export const legacyPanel = 1;\n' });
      const base = fixture.commit('base whose ledger under-reports its tree');
      const baseLedger = JSON.parse(await readFile(fixture.ledgerPath, 'utf8'));
      assert.deepEqual(baseLedger.legacyRendererFiles, [LEGACY_WIDGET_PATH, RENDERER_ENTRY_PATH]);

      // Head merely records the debt the base tree already had.
      const headLedger = await fixture.writeLedger();
      assert.deepEqual(headLedger.legacyRendererFiles, [
        LEGACY_PANEL_PATH,
        LEGACY_WIDGET_PATH,
        RENDERER_ENTRY_PATH,
      ]);
      fixture.commit('record the already-present debt');

      assertPassed(fixture.runChecker(['--base', base, '--strict-base']), base, 'derived base tree');

      // Trusting the committed base ledger instead is exactly the wedge: the
      // faithful correction reads as brand-new debt.
      const fallback = fixture.runChecker(['--base', base], brokenTempDirectory(fixture.scratch));
      assert.notEqual(fallback.status, 0);
      assert.match(fallback.stderr, /falling back to the committed base ledger/u);
      assert.match(
        fallback.stderr,
        /^- src\/renderer\/legacy-panel\.ts: new unclassified renderer source files are forbidden/mu,
      );
    });
  });

  it('fails loudly under --strict-base when the base tree cannot be materialized', async () => {
    await withGitFixture(async (fixture) => {
      await fixture.writeLedger();
      const base = fixture.commit('base');
      await fixture.writeFiles({ [LEGACY_WIDGET_PATH]: 'export const legacyWidget = 2;\n' });
      fixture.commit('head');
      const brokenTemp = brokenTempDirectory(fixture.scratch);

      const lenient = fixture.runChecker(['--base', base], brokenTemp);
      assert.equal(lenient.status, 0, `lenient:\n${lenient.stdout}\n${lenient.stderr}`);
      assert.match(
        lenient.stderr,
        /could not derive base tree debt at .*; falling back to the committed base ledger/u,
      );

      const strict = fixture.runChecker(['--base', base, '--strict-base'], brokenTemp);
      assert.notEqual(strict.status, 0);
      assert.match(
        strict.stderr,
        /could not derive base tree debt at .*--strict-base forbids falling back to the committed base ledger/u,
      );
      assert.doesNotMatch(strict.stdout, /passed/u);
    });
  });

  for (const version of [1, 2]) {
    it(`rejects weakened classification with ledger version ${version} under --strict-base`, async () => {
      await withGitFixture(async (fixture) => {
        await fixture.writeLedger();
        const base = fixture.commit('base');

        // Weaken the measurement: the head checker stops classifying anything under
        // src/renderer/widgets/ as legacy, in both the generator and the ledger
        // validation. The head ledger, the head snapshot check, and the plain
        // ratchet (which re-derives the base with the SAME weakened rules) all agree.
        const original = await readFile(fixture.scriptPath, 'utf8');
        assert.equal(
          original.split(LEGACY_CLASSIFICATION).length - 1,
          2,
          'the legacy classification filter moved; update this fixture',
        );
        let weakened = original.replaceAll(
          LEGACY_CLASSIFICATION,
          ".filter((path) => zoneFor(path).kind === 'legacy' && !path.includes('/widgets/'))",
        );
        if (version === 2) {
          for (const [before, after] of [
            [
              "if (config.version !== 1) reject('version must be 1');",
              "if (config.version !== 2) reject('version must be 2');",
            ],
            ['version: 1,', 'version: 2,'],
          ]) {
            assert.equal(weakened.split(before).length - 1, 1, `the ledger version anchor moved: ${before}`);
            weakened = weakened.replace(before, after);
          }
        }
        await writeFile(fixture.scriptPath, weakened, 'utf8');
        await fixture.writeFiles({ 'src/renderer/widgets/legacy-widget-panel.ts': 'export const hidden = 1;\n' });
        const headLedger = await fixture.writeLedger({ ...rendererEntrySeedConfig(), version });
        assert.deepEqual(headLedger.legacyRendererFiles, [
          LEGACY_PANEL_PATH,
          LEGACY_WIDGET_PATH,
          RENDERER_ENTRY_PATH,
        ]);
        fixture.commit('weaken the checker and add the debt it no longer sees');

        const result = fixture.runChecker(['--base', base, '--strict-base']);
        assert.notEqual(result.status, 0);
        if (version === 2) {
          assert.match(result.stderr, /--strict-base forbids skipping the cross-check/u);
          assert.match(result.stderr, /does not produce the current ledger shape.*version must be 2/u);
          assert.doesNotMatch(result.stdout, /passed|cross-checked debt/u);

          const lenient = fixture.runChecker(['--base', base]);
          assertPassed(lenient, base, 'lenient schema transition');
          assert.match(lenient.stdout, /does not produce the current ledger shape.*skipping the base-checker cross-check/u);
          return;
        }
        assert.match(result.stdout, /differs from .*; cross-checked debt under the base checker/u);
        assert.match(
          result.stderr,
          /^- base-checker cross-check: src\/renderer\/widgets\/legacy-widget-panel\.ts: new unclassified renderer source files are forbidden/mu,
        );
        // Every reported violation comes from the cross-check: the weakened
        // checker alone was satisfied on both sides of the ratchet.
        const reported = result.stderr.split('\n').filter((line) => line.startsWith('- '));
        assert.ok(reported.length > 0, result.stderr);
        assert.ok(
          reported.every((line) => line.startsWith('- base-checker cross-check: ')),
          result.stderr,
        );
        assert.doesNotMatch(result.stderr, /falling back|cross-check skipped/u);
      });
    });
  }

  it('requires the base generator export only under --strict-base', async () => {
    await withGitFixture(async (fixture) => {
      const original = await readFile(fixture.scriptPath, 'utf8');
      const exported = 'export function generateArchitectureConfig(';
      assert.equal(original.split(exported).length - 1, 1);
      await writeFile(fixture.scriptPath, original.replace(exported, 'function generateArchitectureConfig('), 'utf8');
      await fixture.writeLedger();
      const base = fixture.commit('base whose checker has no generator export');
      await writeFile(fixture.scriptPath, original, 'utf8');
      fixture.commit('restore the export');

      const lenient = fixture.runChecker(['--base', base]);
      assertPassed(lenient, base, 'older base checker');
      assert.match(lenient.stdout, /does not export generateArchitectureConfig; skipping the base-checker cross-check/u);

      const strict = fixture.runChecker(['--base', base, '--strict-base']);
      assert.notEqual(strict.status, 0);
      assert.match(strict.stderr, /--strict-base forbids skipping the cross-check/u);
      assert.match(strict.stderr, /does not export generateArchitectureConfig/u);
      assert.doesNotMatch(strict.stdout, /passed|cross-checked debt/u);
    });
  });

  it('handles read-only POSIX permissions on the checker directory according to --strict-base', {
    // Windows does not enforce these mode bits, and root bypasses them.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  }, async () => {
    await withGitFixture(async (fixture) => {
      await fixture.writeLedger();
      const base = fixture.commit('base');
      const original = await readFile(fixture.scriptPath, 'utf8');
      await writeFile(fixture.scriptPath, `${original}\n// Checker maintenance.\n`, 'utf8');
      fixture.commit('change the checker without changing its rules');

      const scriptDirectory = dirname(fixture.scriptPath);
      await chmod(scriptDirectory, 0o555);
      try {
        const lenient = fixture.runChecker(['--base', base]);
        assertPassed(lenient, base, 'non-writable checker directory');
        assert.match(lenient.stderr, /base-checker cross-check skipped.*EACCES/u);

        const strict = fixture.runChecker(['--base', base, '--strict-base']);
        assert.notEqual(strict.status, 0);
        assert.match(strict.stderr, /--strict-base forbids skipping the cross-check.*EACCES/u);
        assert.doesNotMatch(strict.stdout, /passed|cross-checked debt/u);
      } finally {
        await chmod(scriptDirectory, 0o755);
      }
    });
  });

  it('treats a base checker that cannot be imported as a failure only under --strict-base', async () => {
    await withGitFixture(async (fixture) => {
      const original = await readFile(fixture.scriptPath, 'utf8');
      await writeFile(fixture.scriptPath, `import './missing-base-checker-dependency.mjs';\n${original}`, 'utf8');
      // The broken checker cannot generate its own ledger; the in-process
      // generator applies the same rules.
      await writeFile(
        fixture.ledgerPath,
        `${JSON.stringify(generateArchitectureConfig(fixture.desktopRoot, rendererEntrySeedConfig()), null, 2)}\n`,
        'utf8',
      );
      const base = fixture.commit('base whose checker cannot be imported');
      await writeFile(fixture.scriptPath, original, 'utf8');
      fixture.commit('restore the checker');

      const lenient = fixture.runChecker(['--base', base]);
      assertPassed(lenient, base, 'lenient');
      assert.match(lenient.stderr, /base-checker cross-check skipped; the base checker could not be written or imported/u);

      const strict = fixture.runChecker(['--base', base, '--strict-base']);
      assert.notEqual(strict.status, 0);
      assert.match(
        strict.stderr,
        /the base checker could not be written or imported at .*--strict-base forbids skipping the cross-check/u,
      );
      assert.doesNotMatch(strict.stdout, /passed/u);
    });
  });
});

describe('private feature construction boundaries', () => {
  const implementation = 'src/renderer/features/alpha/model/state.ts';
  const privateSource = 'export interface State { value: number }; export function createState() { return { value: 0 }; }';
  const config = () => architectureConfig({ featurePrivateModules: [implementation] });

  it('allows internal construction, public types and test-only inspection', async () => {
    await withDesktopFixture({
      [implementation]: privateSource,
      'src/renderer/features/alpha/controller/owner.ts': `
        import { createState } from '../model/state.js';
        export function readValue() { return createState().value; }
      `,
      'src/renderer/features/alpha/index.ts': `
        export { readValue } from './controller/owner.js';
        export type { State } from './model/state.js';
      `,
      'src/renderer/features/alpha/testing.ts': "export { createState } from './model/state.js';",
    }, (desktopRoot) => {
      assert.deepEqual(violationsFor(desktopRoot, config()), []);
      assert.deepEqual(generateArchitectureConfig(desktopRoot, config()).featurePrivateModules, [implementation]);
    });
  });

  for (const [name, source] of [
    ['named re-export', "export { createState } from './model/state.js';"],
    ['wildcard re-export', "export * from './model/state.js';"],
    ['namespace re-export', "export * as raw from './model/state.js';"],
    ['import alias', "import { createState as factory } from './model/state.js'; export { factory };"],
    ['dynamic load', "export const raw = import('./model/state.js');"],
  ]) {
    it(`rejects a public ${name}`, async () => {
      await withDesktopFixture({
        [implementation]: privateSource,
        'src/renderer/features/alpha/index.ts': source,
      }, (desktopRoot) => {
        assertHasViolation(violationsFor(desktopRoot, config()), /private feature module .* is not a public runtime capability/u);
      });
    });
  }

  it('rejects an intermediate barrel that republishes private construction', async () => {
    await withDesktopFixture({
      [implementation]: privateSource,
      'src/renderer/features/alpha/model/barrel.ts': "import { createState as factory } from './state.js'; export { factory };",
      'src/renderer/features/alpha/index.ts': "export { factory } from './model/barrel.js';",
    }, (desktopRoot) => {
      assertHasViolation(violationsFor(desktopRoot, config()), /model\/barrel\.ts: private feature module .* cannot be re-exported/u);
    });
  });

  it('rejects outside construction and removal of a recorded boundary', async () => {
    await withDesktopFixture({
      [implementation]: privateSource,
      'src/renderer/features/beta/index.ts': "import { createState } from '../alpha/model/state.js'; export const value = createState();",
    }, (desktopRoot) => {
      assertHasViolation(violationsFor(desktopRoot, config()), /beta\/index\.ts: private feature module .* is not a public runtime capability/u);
      assertHasViolation(violationsFor(desktopRoot, architectureConfig(), config()), /historical private feature module boundaries cannot be removed/u);
    });
  });

  it('validates private module policy paths', async () => {
    await withDesktopFixture({}, (desktopRoot) => {
      assertHasViolation(violationsFor(desktopRoot, architectureConfig({ featurePrivateModules: ['../state.ts'] })), /featurePrivateModules must contain normalized feature source paths/u);
    });
  });
});

describe('root public symbol uses', () => {
  const ENTRY = 'src/renderer/features/alpha/index.ts';
  const APP_SHELL = 'src/renderer/app-shell.tsx';
  const COMPOSITION = 'src/renderer/composition/desktop-application.tsx';
  const ROOT_SYMBOL_VIOLATION = /\b(?:appShell|bootstrap|composition) root\b|rootSymbolUses/u;
  const alphaFeature = {
    [ENTRY]: `
      export { AlphaPanel, AlphaProvider } from './ui/alpha-provider.js';
      export * from './controller/alpha-reads.js';
      export type { AlphaSnapshot } from './controller/alpha-reads.js';
    `,
    'src/renderer/features/alpha/ui/alpha-provider.tsx': `
      export function AlphaProvider(_props: { readonly children?: unknown }) { return null; }
      export function AlphaPanel() { return null; }
    `,
    'src/renderer/features/alpha/controller/alpha-reads.ts': `
      export interface AlphaSnapshot { readonly value: number }
      export function useAlphaReads(): AlphaSnapshot { return { value: 0 }; }
      export function useAlphaState() { return { value: 0, setValue(_value: number) {} }; }
    `,
  };

  function generatedUses(desktopRoot, seed = architectureConfig()) {
    return generateArchitectureConfig(desktopRoot, seed).rootSymbolUses;
  }

  function rootViolations(desktopRoot, config, { baseConfig, baseEntrySurfaces } = {}) {
    return checkRendererArchitecture({
      baseConfig,
      baseEntrySurfaces,
      config,
      desktopRoot,
      enforceRendererEntryContract: false,
    }).filter((violation) => ROOT_SYMBOL_VIOLATION.test(violation));
  }

  it('records named, namespace member and JSX member uses per root zone', async () => {
    await withDesktopFixture({
      ...alphaFeature,
      [APP_SHELL]: `
        import * as Alpha from './features/alpha';
        import type { AlphaSnapshot } from './features/alpha';
        type WholeAlpha = typeof Alpha;
        export function AppShell(_whole?: WholeAlpha) {
          const reads: AlphaSnapshot = Alpha.useAlphaReads();
          const typed: Alpha.AlphaSnapshot = reads;
          return <Alpha.AlphaProvider>{typed.value}</Alpha.AlphaProvider>;
        }
      `,
      [COMPOSITION]: `
        import { AlphaPanel } from '@maka/desktop/src/renderer/features/alpha';
        export function DesktopApplication() { return <AlphaPanel />; }
      `,
      'src/renderer/composition/__tests__/desktop-application.test.tsx': `
        import { AlphaProvider } from '../../features/alpha/index.js';
        export const fixture = AlphaProvider;
      `,
      [RENDERER_ENTRY_PATH]: `
        import { useAlphaState } from './features/alpha/index.js';
        export const main = useAlphaState;
      `,
    }, (desktopRoot) => {
      const seed = rendererEntrySeedConfig();
      const rootSymbolUses = {
        [ENTRY]: {
          appShell: ['AlphaProvider', 'useAlphaReads'],
          bootstrap: ['useAlphaState'],
          composition: ['AlphaPanel'],
        },
      };
      assert.deepEqual(generatedUses(desktopRoot, seed), rootSymbolUses);
      assert.deepEqual(rootViolations(desktopRoot, { ...seed, rootSymbolUses }), []);

      const unrecorded = rootViolations(desktopRoot, { ...seed, rootSymbolUses: {} });
      assertHasViolation(unrecorded, /app-shell\.tsx: appShell root uses useAlphaReads from src\/renderer\/features\/alpha\/index\.ts, which rootSymbolUses does not record/u);
      assertHasViolation(unrecorded, /desktop-application\.tsx: composition root uses AlphaPanel from/u);
      assertHasViolation(unrecorded, /main\.tsx: bootstrap root uses useAlphaState from/u);
      assert.equal(unrecorded.length, 4);

      const stale = { [ENTRY]: { ...rootSymbolUses[ENTRY], appShell: ['AlphaProvider', 'useAlphaReads', 'useAlphaState'] } };
      assert.deepEqual(rootViolations(desktopRoot, { ...seed, rootSymbolUses: stale }), [
        `${ENTRY}: stale rootSymbolUses entry; appShell root no longer uses useAlphaState`,
      ]);
    });
  });

  it('follows named, aliased and wildcard re-exports through intermediate modules', async () => {
    await withDesktopFixture({
      ...alphaFeature,
      'src/renderer/alpha-shim.ts': "export { useAlphaState as useShimState } from './features/alpha/index.js';",
      'src/renderer/alpha-barrel.ts': "export * from './alpha-shim.js';\nexport const legacyOnly = 1;",
      'src/renderer/alpha-alias.ts': "import { AlphaProvider } from './features/alpha';\nexport { AlphaProvider as ShellProvider };",
      [APP_SHELL]: `
        import { legacyOnly, useShimState } from './alpha-barrel';
        import * as Aliases from './alpha-alias';
        export function AppShell() {
          return <Aliases.ShellProvider>{useShimState().value + legacyOnly}</Aliases.ShellProvider>;
        }
      `,
    }, (desktopRoot) => {
      assert.deepEqual(generatedUses(desktopRoot), { [ENTRY]: { appShell: ['AlphaProvider', 'useAlphaState'] } });
      assertHasViolation(rootViolations(desktopRoot, architectureConfig({ rootSymbolUses: {} })), /app-shell\.tsx: appShell root uses useAlphaState from/u);
    });
  });

  it('leaves deep feature imports to the zone rule instead of recording them', async () => {
    await withDesktopFixture({
      ...alphaFeature,
      [COMPOSITION]: `
        import { AlphaPanel } from '../features/alpha/ui/alpha-provider.js';
        export function DesktopApplication() { return <AlphaPanel />; }
      `,
    }, (desktopRoot) => {
      assert.deepEqual(generatedUses(desktopRoot), {});
      const config = architectureConfig({ rootSymbolUses: {} });
      assertHasViolation(violationsFor(desktopRoot, config), /desktop-application\.tsx: feature imports must use index/u);
      assert.deepEqual(rootViolations(desktopRoot, config), []);
    });
  });

  for (const [name, files, pattern] of [
    ['passes the namespace object on', {
      [COMPOSITION]: "import * as Alpha from '../features/alpha';\nfunction register(value: unknown) { return value; }\nexport const registered = register(Alpha);",
    }, /composition root lets namespace Alpha from \.\.\/features\/alpha escape/u],
    ['destructures the namespace', {
      [COMPOSITION]: "import * as Alpha from '../features/alpha';\nexport const { AlphaPanel } = Alpha;",
    }, /lets namespace Alpha .* escape/u],
    ['reads a computed namespace member', {
      [COMPOSITION]: "import * as Alpha from '../features/alpha';\nconst key = 'AlphaPanel';\nexport const panel = Alpha[key];",
    }, /lets namespace Alpha .* escape/u],
    ['spreads the namespace', {
      [COMPOSITION]: "import * as Alpha from '../features/alpha';\nexport const all = { ...Alpha };",
    }, /lets namespace Alpha .* escape/u],
    ['re-exports the namespace binding', {
      [COMPOSITION]: "import * as Alpha from '../features/alpha';\nexport { Alpha };",
    }, /lets namespace Alpha .* escape/u],
    ['renders the namespace object', {
      [COMPOSITION]: "import * as Alpha from '../features/alpha';\nexport const view = <Alpha />;",
    }, /lets namespace Alpha .* escape/u],
    ['aliases a member through import-equals', {
      'src/renderer/composition/desktop-application.ts': "import * as Alpha from '../features/alpha';\nimport panel = Alpha.AlphaPanel;\nexport { panel };",
    }, /lets namespace Alpha .* escape/u],
    ['wildcard re-exports the entry', {
      [COMPOSITION]: "export * from '../features/alpha';",
    }, /composition root re-exports \.\.\/features\/alpha wholesale/u],
    ['namespace re-exports the entry', {
      [COMPOSITION]: "export * as Alpha from '../features/alpha/index.js';",
    }, /re-exports .* wholesale/u],
    ['wildcard re-exports a legacy barrel over the entry', {
      'src/renderer/alpha-barrel.ts': "export * from './features/alpha';",
      [COMPOSITION]: "export * from '../alpha-barrel';",
    }, /re-exports \.\.\/alpha-barrel wholesale/u],
    ['receives a namespace object from a legacy module', {
      'src/renderer/alpha-namespace.ts': "export * as Alpha from './features/alpha';",
      [COMPOSITION]: "import { Alpha } from '../alpha-namespace';\nexport const panel = Alpha.AlphaPanel;",
    }, /receives a whole feature namespace object through \.\.\/alpha-namespace/u],
    ['loads the entry dynamically', {
      [COMPOSITION]: "export const load = () => import('../features/alpha');",
    }, /loads \.\.\/features\/alpha through dynamic-import/u],
    ['requires the entry', {
      [COMPOSITION]: "const alpha = require('../features/alpha');\nexport default alpha;",
    }, /loads \.\.\/features\/alpha through require/u],
  ]) {
    it(`rejects a root that ${name}`, async () => {
      await withDesktopFixture({ ...alphaFeature, ...files }, (desktopRoot) => {
        assertHasViolation(rootViolations(desktopRoot, architectureConfig({ rootSymbolUses: generatedUses(desktopRoot) })), pattern);
      });
    });
  }

  it('resolves each public entry surface through wildcard and aliased re-exports', async () => {
    await withDesktopFixture(alphaFeature, (desktopRoot) => {
      const surfaces = collectFeatureEntrySurfaces(desktopRoot);
      assert.deepEqual([...surfaces.keys()], ['src/renderer/features/alpha']);
      assert.deepEqual(Object.fromEntries(surfaces.get('src/renderer/features/alpha')), {
        AlphaPanel: 'src/renderer/features/alpha/ui/alpha-provider.tsx#AlphaPanel',
        AlphaProvider: 'src/renderer/features/alpha/ui/alpha-provider.tsx#AlphaProvider',
        useAlphaReads: 'src/renderer/features/alpha/controller/alpha-reads.ts#useAlphaReads',
        useAlphaState: 'src/renderer/features/alpha/controller/alpha-reads.ts#useAlphaState',
      });
    });
  });

  it('only admits root growth that takes an export the same change adds', async () => {
    await withDesktopFixture({
      ...alphaFeature,
      [COMPOSITION]: `
        import { AlphaPanel, AlphaProvider } from '../features/alpha';
        export function DesktopApplication() { return <AlphaProvider><AlphaPanel /></AlphaProvider>; }
      `,
    }, (desktopRoot) => {
      const config = architectureConfig({ rootSymbolUses: { [ENTRY]: { composition: ['AlphaPanel', 'AlphaProvider'] } } });
      const baseConfig = architectureConfig({ rootSymbolUses: { [ENTRY]: { composition: ['AlphaProvider'] } } });
      const surfacesWith = (...names) => new Map([[
        'src/renderer/features/alpha',
        new Map([...collectFeatureEntrySurfaces(desktopRoot).get('src/renderer/features/alpha')].filter(([name]) => names.includes(name))),
      ]]);

      assert.deepEqual(rootViolations(desktopRoot, config, { baseConfig, baseEntrySurfaces: surfacesWith('AlphaProvider') }), []);
      assert.deepEqual(rootViolations(desktopRoot, config, { baseConfig, baseEntrySurfaces: new Map() }), []);
      assert.deepEqual(rootViolations(desktopRoot, config, { baseConfig, baseEntrySurfaces: surfacesWith('AlphaPanel', 'AlphaProvider') }), [
        `${ENTRY}: composition root newly uses existing public export AlphaPanel; only an export the same change adds may join rootSymbolUses`,
      ]);
      assert.deepEqual(rootViolations(desktopRoot, config, { baseConfig }), [
        `${ENTRY}: composition root newly uses AlphaPanel, and without the base tree's public surface the use cannot be admitted`,
      ]);
      // The base that introduces the record has nothing to ratchet against.
      assert.deepEqual(rootViolations(desktopRoot, config, { baseConfig: architectureConfig() }), []);
      // Dropping the record would disable the rule, so it is rejected outright.
      assertHasViolation(
        rootViolations(desktopRoot, architectureConfig(), { baseConfig }),
        /^rootSymbolUses: the root public symbol record cannot be removed$/u,
      );
    });
  });

  for (const [name, aliasExport] of [
    ['a re-exported alias', "export { AlphaPanel as AlphaPanelAlias } from './ui/alpha-provider.js';"],
    ['an imported and re-exported alias', "import { AlphaPanel as panel } from './ui/alpha-provider.js';\nexport { panel as AlphaPanelAlias };"],
  ]) {
    it(`does not admit ${name} of an existing export as a new export`, async () => {
      await withDesktopFixture({
        ...alphaFeature,
        [ENTRY]: `${alphaFeature[ENTRY]}\n${aliasExport}\nexport { AlphaInspector } from './ui/alpha-inspector.js';\n`,
        'src/renderer/features/alpha/ui/alpha-inspector.tsx': 'export function AlphaInspector() { return null; }\n',
        [COMPOSITION]: `
          import { AlphaInspector, AlphaPanelAlias } from '../features/alpha';
          export function DesktopApplication() { return <><AlphaPanelAlias /><AlphaInspector /></>; }
        `,
      }, (desktopRoot) => {
        const current = collectFeatureEntrySurfaces(desktopRoot).get('src/renderer/features/alpha');
        assert.equal(current.get('AlphaPanelAlias'), current.get('AlphaPanel'));
        const baseEntrySurfaces = new Map([[
          'src/renderer/features/alpha',
          new Map([...current].filter(([exported]) => !['AlphaInspector', 'AlphaPanelAlias'].includes(exported))),
        ]]);
        const config = architectureConfig({ rootSymbolUses: { [ENTRY]: { composition: ['AlphaInspector', 'AlphaPanelAlias'] } } });
        assert.deepEqual(rootViolations(desktopRoot, config, { baseConfig: architectureConfig({ rootSymbolUses: {} }), baseEntrySurfaces }), [
          `${ENTRY}: composition root newly uses AlphaPanelAlias, an alias of existing public export AlphaPanel; only a binding the same change adds may join rootSymbolUses`,
        ]);
      });
    });
  }

  it('admits a use moving out of appShell, but not a copy or the reverse move', async () => {
    await withDesktopFixture({
      ...alphaFeature,
      [COMPOSITION]: `
        import { AlphaPanel } from '../features/alpha';
        export function DesktopApplication() { return <AlphaPanel />; }
      `,
    }, (desktopRoot) => {
      const baseEntrySurfaces = collectFeatureEntrySurfaces(desktopRoot);
      const ratchet = (current, base) =>
        rootViolations(desktopRoot, architectureConfig({ rootSymbolUses: current }), {
          baseConfig: architectureConfig({ rootSymbolUses: base }),
          baseEntrySurfaces,
        }).filter((violation) => /newly uses/u.test(violation));

      assert.deepEqual(ratchet({ [ENTRY]: { composition: ['AlphaPanel'] } }, { [ENTRY]: { appShell: ['AlphaPanel'] } }), []);
      assert.deepEqual(
        ratchet({ [ENTRY]: { appShell: ['AlphaPanel'], composition: ['AlphaPanel'] } }, { [ENTRY]: { appShell: ['AlphaPanel'] } }),
        [`${ENTRY}: composition root newly uses existing public export AlphaPanel; only an export the same change adds may join rootSymbolUses`],
      );
      assert.deepEqual(
        ratchet({ [ENTRY]: { appShell: ['AlphaPanel'] } }, { [ENTRY]: { composition: ['AlphaPanel'] } }),
        [`${ENTRY}: appShell root newly uses existing public export AlphaPanel; only an export the same change adds may join rootSymbolUses`],
      );
    });
  });

  it('validates the root symbol record shape', async () => {
    await withDesktopFixture({}, (desktopRoot) => {
      for (const [rootSymbolUses, pattern] of [
        [{ 'src/renderer/features/alpha/ui/alpha-provider.tsx': { composition: ['AlphaPanel'] } }, /keys must be normalized feature public entry paths/u],
        [{ [ENTRY]: { shell: ['AlphaPanel'] } }, /zones must be sorted and among appShell, bootstrap, composition/u],
        [{ [ENTRY]: { composition: ['AlphaProvider', 'AlphaPanel'] } }, /composition must list sorted unique export names/u],
        [{ [ENTRY]: {} }, /must map root zones to the symbols they use/u],
      ]) {
        assertHasViolation(violationsFor(desktopRoot, architectureConfig({ rootSymbolUses })), pattern);
      }
    });
  });
});

describe('retained root hook table', () => {
  const GATE = 'gate/check-app-shell-hooks.mjs';
  const README = 'src/renderer/README.md';
  const RETAINED_ROOT_VIOLATION = /retained-root|AppShell hook gate/u;
  const HEADER = '| Component | Hook | Call site | Consumer | Owner | Allowed capability | Root reason | Removal |';
  const gateSource = (inventory = `{
    AppShell: { useState: 2 },
    AppShellContent: {
      // The gate's own commentary sits between entries.
      useToast: 1,
    },
  }`) => `#!/usr/bin/env node\nexport const ALLOWED = ${inventory};\nif (process.argv[1] === undefined) main();\n`;
  const row = (component, hook, callSite, reason, removal = '—') =>
    `| \`${component}\` | \`${hook}\` | \`${callSite}\` | consumer | owner | capability | ${reason} | ${removal} |`;
  const readme = (rows, header = HEADER) => [
    '# Renderer',
    '<!-- retained-root-hooks:start -->',
    header,
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '<!-- retained-root-hooks:end -->',
    '',
  ].join('\n');
  const complete = [
    row('AppShell', 'useState', 'uiLocalePreference', 'locale'),
    row('AppShell', 'useState', 'uiLocaleOverride', 'locale'),
    row('AppShellContent', 'useToast', 'toastApi', '—', 'M5'),
  ];

  async function withTable(files, run) {
    await withDesktopFixture({ [GATE]: gateSource(), ...files }, (desktopRoot) =>
      run(
        checkRendererArchitecture({
          appShellHookGatePath: join(desktopRoot, GATE),
          config: architectureConfig(),
          desktopRoot,
          enforceRendererEntryContract: false,
        }).filter((violation) => RETAINED_ROOT_VIOLATION.test(violation)),
        desktopRoot,
      ),
    );
  }

  it('accepts one row per gate call site', async () => {
    await withTable({ [README]: readme(complete) }, (violations) => assert.deepEqual(violations, []));
  });

  it('stays inactive without a hook gate', async () => {
    await withDesktopFixture({ [README]: '# Renderer\n' }, (desktopRoot) => {
      const violations = checkRendererArchitecture({
        appShellHookGatePath: join(desktopRoot, GATE),
        config: architectureConfig(),
        desktopRoot,
        enforceRendererEntryContract: false,
      });
      assert.deepEqual(violations.filter((violation) => RETAINED_ROOT_VIOLATION.test(violation)), []);
    });
  });

  for (const [name, files, pattern] of [
    ['a missing table', { [README]: '# Renderer\n' }, /src\/renderer\/README\.md: the retained-root hook table is missing/u],
    ['a gate entry without a row', { [README]: readme(complete.slice(0, 2)) }, /^AppShellContent\.useToast: AppShell hook gate entry has no retained-root row/u],
    ['a row count below the gate count', { [README]: readme(complete.slice(1)) }, /^AppShell\.useState: the AppShell hook gate counts 2 call sites, the retained-root table has 1 rows$/u],
    ['a row for a hook the gate no longer lists', {
      [README]: readme([...complete, row('AppShellContent', 'useOnboardingSnapshot', 'onboarding', '—', 'M5')]),
    }, /README\.md:\d+: retained-root row names AppShellContent\.useOnboardingSnapshot, which the AppShell hook gate does not list/u],
    ['a row with both a reason and a removal module', {
      [README]: readme([...complete.slice(0, 2), row('AppShellContent', 'useToast', 'toastApi', 'layout', 'M5')]),
    }, /retained-root row for AppShellContent\.useToast needs exactly one root reason/u],
    ['a row with neither a reason nor a removal module', {
      [README]: readme([...complete.slice(0, 2), row('AppShellContent', 'useToast', 'toastApi', '—', '—')]),
    }, /needs exactly one root reason/u],
    ['an unknown root reason', {
      [README]: readme([...complete.slice(0, 2), row('AppShellContent', 'useToast', 'toastApi', 'convenience')]),
    }, /needs exactly one root reason/u],
    ['an unknown removal module', {
      [README]: readme([...complete.slice(0, 2), row('AppShellContent', 'useToast', 'toastApi', '—', 'M9')]),
    }, /needs exactly one root reason/u],
    ['a duplicate call site', {
      [README]: readme([complete[0], complete[0], complete[2]]),
    }, /duplicate retained-root call site uiLocalePreference for AppShell\.useState/u],
    ['a row with an empty owner', {
      [README]: readme([...complete.slice(0, 2), '| `AppShellContent` | `useToast` | `toastApi` | consumer | — | capability | — | M5 |']),
    }, /must name its call site, consumer, owner and allowed capability/u],
    ['a row with too few cells', {
      [README]: readme([...complete, '| `AppShell` | `useState` | `extra` | consumer | owner | locale | — |']),
    }, /README\.md:\d+: retained-root row must have 8 cells/u],
    ['different columns', {
      [README]: readme(complete, '| Component | Hook | Call site | Consumer | Owner | Capability | Root reason | Removal |'),
    }, /the retained-root hook table must have the columns Component \| Hook/u],
  ]) {
    it(`rejects ${name}`, async () => {
      await withTable(files, (violations) => assertHasViolation(violations, pattern));
    });
  }

  describe('rows of a hook with several call sites', () => {
    const appShell = {
      'src/renderer/app-shell.tsx': `
        import { useState } from 'react';
        import { useToast } from '@astryxdesign/core/Toast';
        export function AppShell() {
          const [uiLocalePreference] = useState('auto');
          const [uiLocaleOverride] = useState(null);
          return <AppShellContent preference={uiLocalePreference} override={uiLocaleOverride} />;
        }
        function AppShellContent(_props: unknown) {
          const toastApi = useToast();
          return toastApi ? null : null;
        }
      `,
    };
    const stateRow = (callSite) => `| \`AppShell\` | \`useState\` | ${callSite} | consumer | owner | capability | locale | — |`;

    it('binds each row to one call in app-shell.tsx', async () => {
      await withTable({ ...appShell, [README]: readme(complete) }, (violations) => assert.deepEqual(violations, []));
    });

    for (const [name, rows, pattern] of [
      ['a call site that names no call', [stateRow('`uiLocalePreference`'), stateRow('`uiLocaleBogus`')], /retained-root call site uiLocaleBogus must name an identifier of exactly one AppShell\.useState call in src\/renderer\/app-shell\.tsx; it matches 0/u],
      ['a call site that names two calls', [stateRow('`uiLocalePreference`'), stateRow('`uiLocalePreference` or `uiLocaleOverride`')], /must name an identifier of exactly one AppShell\.useState call .*; it matches 2/u],
      ['two rows on one call', [stateRow('`uiLocalePreference`'), stateRow('`uiLocalePreference`, again')], /^AppShell\.useState: retained-root rows src\/renderer\/README\.md:\d+, src\/renderer\/README\.md:\d+ name the same call site$/u],
    ]) {
      it(`rejects ${name}`, async () => {
        await withTable({ ...appShell, [README]: readme([...rows, complete[2]]) }, (violations) => assertHasViolation(violations, pattern));
      });
    }
  });

  it('reads the gate inventory only as a static literal', async () => {
    await withDesktopFixture({ [GATE]: gateSource('buildInventory()'), [README]: readme(complete) }, (desktopRoot) => {
      assertHasViolation(
        checkRendererArchitecture({
          appShellHookGatePath: join(desktopRoot, GATE),
          config: architectureConfig(),
          desktopRoot,
          enforceRendererEntryContract: false,
        }),
        /^AppShell hook gate inventory could not be read: no exported ALLOWED object literal$/u,
      );
    });
  });

  it('reports the M3 and M5 completion measures', async () => {
    await withDesktopFixture({
      [GATE]: gateSource(),
      [README]: readme(complete),
      'src/renderer/features/conversation/README.md': [
        'Remaining transitional capabilities have explicit consumers and removal work:',
        '',
        '| Capability | Current consumer | Removal module |',
        '| --- | --- | --- |',
        '| one | AppShell | M3 |',
        '| two | AppShell | M3 |',
        '',
      ].join('\n'),
      'src/renderer/app-shell.tsx': "import { LegacyPanel } from './legacy-panel';\nexport const AppShell = LegacyPanel;\n",
      'src/renderer/legacy-panel.tsx': "import { AlphaPanel } from './features/alpha';\nexport const LegacyPanel = AlphaPanel;\n",
      'src/renderer/features/alpha/index.ts': 'export function AlphaPanel() { return null; }\n',
    }, (desktopRoot) => {
      const config = architectureConfig({
        legacyFiles: {
          'src/renderer/app-shell.tsx': emptyDebt({
            actionFactories: ['createAppShellChatActions'],
            bridgePaths: { 'window.maka.attachments.readBytes': 2 },
          }),
          'src/renderer/app-shell-effects.ts': emptyDebt({ bridgePaths: { 'window.maka.app.info': 3 } }),
          'src/renderer/app-shell-e2e-fixture.ts': emptyDebt({ actionFactories: ['createAppShellE2eFixtureActions'] }),
        },
        rootSymbolUses: { 'src/renderer/features/alpha/index.ts': { appShell: ['AlphaHost', 'useAlpha'], composition: ['AlphaServicesProvider'] } },
      });
      assert.deepEqual(rendererArchitectureReport({ appShellHookGatePath: join(desktopRoot, GATE), config, desktopRoot }), [
        'AppShell-family bridge references: 5 (app-shell.tsx 2)',
        '  src/renderer/app-shell-effects.ts: 3',
        '  src/renderer/app-shell.tsx: 2',
        'AppShell-family action factories: 2 (createAppShellChatActions, createAppShellE2eFixtureActions)',
        'Transitional Conversation capabilities: 2',
        'AppShell hook gate: 2 entries / 3 call sites; entries without a retained-root row: 0',
        '  retained at the root: locale 2',
        '  scheduled for removal: M5 1',
        'AppShell closure feature-entry uses (reported, not ratcheted): 1 in 1 files',
        '  src/renderer/legacy-panel.tsx: alpha.AlphaPanel',
        'Root symbol uses: appShell 2, bootstrap 0, composition 1',
      ]);
    });
  });
});
