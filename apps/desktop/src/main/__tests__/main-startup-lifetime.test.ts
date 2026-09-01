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
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const mainSource = readFileSync(
  fileURLToPath(new URL('../../../src/main/main.ts', import.meta.url)),
  'utf8',
);
const bootSource = readFileSync(
  fileURLToPath(new URL('../../../src/main/runtime-host-boot.ts', import.meta.url)),
  'utf8',
);
const appIpcSource = readFileSync(
  fileURLToPath(new URL('../../../src/main/app-ipc-main.ts', import.meta.url)),
  'utf8',
);
const mainWindowSource = readFileSync(
  fileURLToPath(new URL('../../../src/main/main-window.ts', import.meta.url)),
  'utf8',
);

test('retains process lifetime before a standalone startup dialog can close', () => {
  const retentionPolicy = mainSource.search(
    /app\.on\(['"]window-all-closed['"],\s*\(\)\s*=>\s*\{\s*\}\);/u,
  );
  const singleInstanceDecision = mainSource.indexOf('app.requestSingleInstanceLock()');

  assert.notEqual(retentionPolicy, -1);
  assert.notEqual(singleInstanceDecision, -1);
  assert.ok(retentionPolicy < singleInstanceDecision);
});

test('resolves persisted locale before first post-settings recovery prompt', () => {
  const rendererRecoveryStart = bootSource.indexOf('onRendererProcessGone: async');
  const rendererRecovery = bootSource.slice(
    rendererRecoveryStart,
    bootSource.indexOf('resolveBrowserDialogParent =', rendererRecoveryStart),
  );
  const hostRecoveryStart = bootSource.indexOf('prompt: async (input)');
  const hostRecovery = bootSource.slice(
    hostRecoveryStart,
    bootSource.indexOf('}).catch((error: unknown)', hostRecoveryStart),
  );
  const defaultHostRecoveryStart = bootSource.indexOf(
    'async function promptForDefaultRuntimeHostRecovery',
  );
  const defaultHostRecovery = bootSource.slice(defaultHostRecoveryStart);

  assert.match(rendererRecovery, /const locale = await desktopLocale\.resolve\(\)/u);
  assert.match(hostRecovery, /const locale = await desktopLocale\.resolve\(\)/u);
  assert.match(defaultHostRecovery, /const locale = await desktopLocale\.resolve\(\)/u);
  assert.doesNotMatch(rendererRecovery, /desktopLocale\.current\(\)/u);
  assert.doesNotMatch(hostRecovery, /desktopLocale\.current\(\)/u);
  assert.doesNotMatch(defaultHostRecovery, /resolveSystemUiLocale/u);
});

test('routes the first-paint IPC only to the active Renderer recovery listener', () => {
  const ipcHandlerStart = appIpcSource.indexOf(
    "targetIpc.handle('window:notifyRendererReady'",
  );
  const ipcHandler = appIpcSource.slice(
    ipcHandlerStart,
    appIpcSource.indexOf("targetIpc.handle('window:setThemeSource'", ipcHandlerStart),
  );
  const readyHandlerStart = mainWindowSource.indexOf('notifyRendererReady(sender)');
  const readyHandler = mainWindowSource.slice(
    readyHandlerStart,
    mainWindowSource.indexOf('setTitlebarControlsVisible(sender', readyHandlerStart),
  );

  assert.match(ipcHandler, /mainWindowController\.notifyRendererReady\(event\.sender\)/u);
  assert.match(
    readyHandler,
    /sender !== mainWindow\.webContents\) return;/u,
  );
  assert.match(
    readyHandler,
    /if \(recovery\?\.contents === sender\) recovery\.listener\?\.\(\);/u,
  );
});
