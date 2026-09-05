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

  const lifecycleStart = bootSource.indexOf('function wireLifecycle');
  const windowAllClosedStart = bootSource.indexOf(
    'app.on("window-all-closed"',
    lifecycleStart,
  );
  const windowAllClosed = bootSource.slice(
    windowAllClosedStart,
    bootSource.indexOf('app.on("before-quit"', windowAllClosedStart),
  );
  assert.match(
    windowAllClosed,
    /process\.platform !== "darwin" && !isBrowserMessageBoxPresentationActive\(\)/u,
  );
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

test('lets the Runtime Host migrate its State Root before Desktop opens shared tables', () => {
  const hostStart = bootSource.indexOf(
    'runtimeHostManager = await startDesktopRuntimeHostWithRecovery',
  );
  const workBoardOpen = bootSource.indexOf(
    'store: createWorkBoardStore(workspaceRoot',
  );
  const sessionCopyOpen = bootSource.indexOf(
    'createSessionCopyCleanupAuthority({',
  );

  assert.notEqual(hostStart, -1);
  assert.notEqual(workBoardOpen, -1);
  assert.notEqual(sessionCopyOpen, -1);
  assert.ok(hostStart < workBoardOpen);
  assert.match(
    bootSource.slice(workBoardOpen, bootSource.indexOf('});', workBoardOpen)),
    /schemaMigration: 'require_current'/u,
  );
  assert.match(
    bootSource.slice(sessionCopyOpen, bootSource.indexOf('}),', sessionCopyOpen)),
    /schemaMigration: 'require_current'/u,
  );
});

test('routes the first-paint IPC only to the active Renderer recovery listener', () => {
  const ipcHandlerStart = appIpcSource.indexOf(
    "targetIpc.handle('window:notifyRendererReady'",
  );
  const ipcHandler = appIpcSource.slice(
    ipcHandlerStart,
    appIpcSource.indexOf("targetIpc.handle('window:setThemeSource'", ipcHandlerStart),
  );
  const readyHandlerStart = mainWindowSource.indexOf(
    'notifyRendererReady(sender, senderFrame)',
  );
  const readyHandler = mainWindowSource.slice(
    readyHandlerStart,
    mainWindowSource.indexOf('setTitlebarControlsVisible(sender', readyHandlerStart),
  );
  const reloadStart = mainWindowSource.indexOf('    async reloadMainRenderer() {');
  const reloadHandler = mainWindowSource.slice(
    reloadStart,
    mainWindowSource.indexOf('    send: safeSendToRenderer', reloadStart),
  );

  assert.match(
    ipcHandler,
    /mainWindowController\.notifyRendererReady\(event\.sender, event\.senderFrame\)/u,
  );
  assert.match(
    reloadHandler,
    /clearShowFallbackTimer\(\);\s*revealGate\.reset\(\);\s*target\.hide\(\);/u,
  );
  assert.match(reloadHandler, /reloadMainRendererProcess\(/u);
  assert.match(reloadHandler, /subscribeMainFrameCommitted:/u);
  assert.match(
    reloadHandler,
    /if \(!isMainFrame\) return;\s*const frame = webFrameMain\.fromId\(frameProcessId, frameRoutingId\);\s*if \(frame\) listener\(rendererFrameIdentity\(frame\)\);/u,
  );
  assert.match(
    readyHandler,
    /sender !== mainWindow\.webContents\) return;/u,
  );
  assert.match(
    readyHandler,
    /if \(recovery\?\.contents === sender\) \{\s*[^}]*if \(!senderFrame \|\| !recovery\.listener\?\.\(rendererFrameIdentity\(senderFrame\)\)\) return;\s*\}/u,
  );
  assert.match(
    reloadHandler,
    /if \(rendererRecoveryReadiness === readiness\) \{\s*if \(loaded\) rendererRecoveryReadiness = undefined;\s*else readiness\.listener = undefined;\s*\}/u,
  );
  assert.match(readyHandler, /revealGate\.markReady\(mainWindow\)/u);
});
