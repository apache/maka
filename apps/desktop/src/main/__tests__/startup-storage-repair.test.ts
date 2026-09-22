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

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from '@babel/parser';
import { transform } from 'esbuild';
import { resolveSystemUiLocale } from '@maka/core/ui-locale';
import { resolveStorageRoot, STORAGE_ROOT_MARKER_FILE } from '@maka/storage/root-authority';
import type { BrowserMessageBoxAppearance } from '../browser-message-box.js';
import { showMessageBoxWithDiagnostics } from '../native-diagnostic-dialog.js';
import { getNativeDiagnosticDialogCopy } from '../native-diagnostic-dialog-copy.js';
import { resolveDesktopStorageRoot } from '../storage-root-startup.js';
import { startupStep } from '../startup-step.js';
import { resolveWindowRevealMode } from '../window-reveal.js';

const require = createRequire(import.meta.url);

async function compile(name: string, asynchronous = false): Promise<string> {
  let source = readFileSync(new URL(`../../../src/main/${name}.ts`, import.meta.url), 'utf8');
  if (asynchronous) {
    const imports = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body
      .filter((node) => node.type === 'ImportDeclaration');
    const end = imports.at(-1)?.end ?? 0;
    // The wrapped body keeps the module's own `export` keywords (early-window
    // exports its products) — they are illegal inside the function wrapper and
    // the sandbox reaches the bindings through the deps object anyway.
    const body = source.slice(end).replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gu, '');
    source = `${source.slice(0, end)}\nexport default async function() {\n${body}\n}`;
  }
  return (await transform(source, {
    loader: 'ts', format: 'cjs', target: 'esnext', define: { 'import.meta': 'importMeta' },
  })).code;
}

const boot = await compile('early-window', true);
const context = await compile('startup-context');

for (const accept of [false, true]) {
  test(`startup storage repair reaches the dialog and ${accept ? 'adopts' : 'preserves'} the root`, async () => {
    const userData = await mkdtemp(join(tmpdir(), 'maka-startup-repair-'));
    const root = join(userData, 'workspaces', 'default');
    const stopped = new Error('boot stopped after the storage decision');
    const dialogs: BrowserMessageBoxAppearance[] = [];
    let settingsOpened = false;
    let quit = false;
    try {
      await mkdir(root, { recursive: true });
      const original = await resolveStorageRoot({ path: root, kind: 'interactive' });
      const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
      const marker = JSON.parse(await readFile(markerPath, 'utf8'));
      marker.rootIdentity.dev = (BigInt(marker.rootIdentity.dev) + 1n).toString();
      const staleMarker = JSON.stringify(marker);
      await writeFile(markerPath, staleMarker);

      const app = {
        isPackaged: true,
        getAppPath: () => '/test/Maka.app',
        getPath: () => userData,
        getVersion: () => 'test',
        getPreferredSystemLanguages: () => ['en-US'],
        quit: () => { quit = true; throw stopped; },
      };
      const process = { env: {}, argv: [] };
      const contextModule = { exports: {} };
      runInNewContext(context, {
        module: contextModule, process,
        require: (name: string) => name === 'electron' ? { app } : { resolveWindowRevealMode },
      });

      // Run the boot module in its original order; only external services and
      // the native dialog are replaced. Stop before opening post-repair stores.
      const deps = {
        app,
        protocol: { handle: () => undefined },
        ClientPluginTransport: class {},
        MAKA_CLIENT_PLUGIN_SCHEME: 'maka-plugin',
        registerClientPluginIpc: () => undefined,
        resolveSystemUiLocale,
        resolveShellEnv: async () => {},
        resolveBuildInfo: () => ({ mode: 'packaged' }),
        configureDesktopRuntimeHostPeerClient: async () => undefined,
        loadOrCreateRuntimeHostClientInstanceId: async () => 'test',
        createRuntimeHostCandidateLaunchBarrier: () => ({}),
        createClientRuntimeHostCredentialStore: () => ({}),
        createClientRuntimeHostProfileCatalog: () => ({}),
        resolveDesktopRuntimeHostStartup: async () => ({}),
        resolveE2eFixture: () => undefined,
        resolveDesktopStorageRoot,
        startupStep,
        getNativeDiagnosticDialogCopy,
        showMessageBoxWithDiagnostics,
        resolveWindowRevealMode,
        showBrowserMessageBox: async (_options: unknown, _parent: unknown, appearance: BrowserMessageBoxAppearance) => {
          dialogs.push(appearance);
          assert.equal(await readFile(markerPath, 'utf8'), staleMarker);
          return { response: accept ? 0 : 1, checkboxChecked: false };
        },
        createSettingsStore: () => { settingsOpened = true; throw stopped; },
      };
      const completion = runInNewContext(`${boot}\nmodule.exports.default()`, {
        module: { exports: {} }, process, console,
        require: (name: string) => name.startsWith('node:') ? require(name)
          : name === './startup-context.js' ? contextModule.exports : deps,
      }) as Promise<void>;
      await assert.rejects(completion, (error) => error === stopped);
      assert.equal(dialogs.length, 1);
      assert.equal(dialogs[0]?.revealMode, 'active');
      assert.equal(quit, !accept);
      assert.equal(settingsOpened, accept);
      if (accept) {
        assert.equal((await resolveStorageRoot({ path: root, kind: 'interactive' })).rootId, original.rootId);
      } else {
        assert.equal(await readFile(markerPath, 'utf8'), staleMarker);
      }
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });
}
