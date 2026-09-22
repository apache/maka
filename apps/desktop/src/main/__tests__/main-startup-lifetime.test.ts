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
const earlyWindowSource = readFileSync(
  fileURLToPath(new URL('../../../src/main/early-window.ts', import.meta.url)),
  'utf8',
);
const mainWindowSource = readFileSync(
  fileURLToPath(new URL('../../../src/main/main-window.ts', import.meta.url)),
  'utf8',
);
const appShellSource = readFileSync(
  fileURLToPath(new URL('../../../src/renderer/app-shell.tsx', import.meta.url)),
  'utf8',
);
const appSource = readFileSync(
  fileURLToPath(new URL('../../../src/renderer/app.tsx', import.meta.url)),
  'utf8',
);
const indexHtmlSource = readFileSync(
  fileURLToPath(new URL('../../../src/renderer/index.html', import.meta.url)),
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
    bootSource.indexOf('powerMonitor.on("resume"', windowAllClosedStart),
  );
  assert.match(
    windowAllClosed,
    /process\.platform !== "darwin" && !windowsAppTray\.hasTray\(\) && !isBrowserMessageBoxPresentationActive\(\)/u,
  );
});

test('registers one shared quit cleanup before the initial Host handoff', () => {
  const earlyWindowImport = mainSource.indexOf("import('./early-window.js')");
  const bootImport = mainSource.indexOf("import('./runtime-host-boot.js')");
  const hostStart = bootSource.indexOf('await runtimeHostManager?.start()');
  const quitRegistration = earlyWindowSource.indexOf(
    'app.on("before-quit", quitCoordinator.handleBeforeQuit)',
  );
  assert.ok(earlyWindowImport >= 0 && earlyWindowImport < bootImport);
  assert.ok(quitRegistration >= 0);
  assert.ok(hostStart >= 0);
  assert.equal(earlyWindowSource.match(/createAppQuitCoordinator\(\{/gu)?.length, 1);
  assert.equal(earlyWindowSource.match(/app\.on\("before-quit"/gu)?.length, 1);
  assert.match(bootSource, /bootContext\.cleanup = closeRuntimeHostDesktop/u);
  assert.match(bootSource, /return runtimeHostDesktopShutdown \?\?= disposeRuntimeHostDesktop\(\)/u);
  assert.match(bootSource, /workBoardIpc\?\.close\(\)/u);
});

test('mounts the handoff overlay inside the locale providers', () => {
  const provider = appShellSource.indexOf('<LocaleProvider');
  const overlay = appShellSource.indexOf('<RuntimeHostHandoffOverlay');
  assert.ok(provider >= 0 && overlay > provider);
  // Above the providers it crashes the root: useUiLocale() throws without
  // the context, and the window never reports renderer-ready.
  assert.doesNotMatch(appSource, /RuntimeHostHandoffOverlay/u);
});

test('creates the main window before starting Local Host reconciliation', () => {
  const managerCreate = bootSource.indexOf('runtimeHostManager = createLocalRuntimeHostManager()');
  const lifecycleWire = bootSource.indexOf('wireLifecycle();', managerCreate);
  const hostStart = bootSource.indexOf('await runtimeHostManager?.start()', managerCreate);
  assert.ok(managerCreate >= 0);
  assert.ok(lifecycleWire > managerCreate && hostStart > lifecycleWire);
  assert.match(earlyWindowSource, /quitCoordinator\.focusOrCreateWindow\(\)/u);
  assert.doesNotMatch(mainSource, /startup-presentation/u);
});

test('resolves persisted locale before first post-settings recovery prompt', () => {
  const rendererRecoveryStart = earlyWindowSource.indexOf('onRendererProcessGone: async');
  const rendererRecovery = earlyWindowSource.slice(
    rendererRecoveryStart,
    earlyWindowSource.indexOf('resolveBrowserDialogParent = () =>', rendererRecoveryStart),
  );
  const defaultHostRecoveryStart = bootSource.indexOf(
    'async function promptForDefaultRuntimeHostRecovery',
  );
  const defaultHostRecovery = bootSource.slice(defaultHostRecoveryStart);

  assert.match(rendererRecovery, /const locale = await desktopLocale\.resolve\(\)/u);
  assert.match(bootSource, /resolveLocale: \(\) => desktopLocale\.resolve\(\)/u);
  assert.match(defaultHostRecovery, /const locale = await desktopLocale\.resolve\(\)/u);
  assert.doesNotMatch(rendererRecovery, /desktopLocale\.current\(\)/u);
  assert.doesNotMatch(defaultHostRecovery, /resolveSystemUiLocale/u);
});

test('lets the Runtime Host migrate its State Root before Desktop opens shared tables', () => {
  const hostStart = bootSource.indexOf(
    'await runtimeHostManager?.start()',
  );
  const workBoardOpen = bootSource.indexOf(
    'registerDesktopWorkBoard();',
    hostStart,
  );
  const workBoardStore = bootSource.indexOf(
    'store: createWorkBoardStore(workspaceRoot',
  );
  const sessionCopyOpen = bootSource.indexOf(
    'createSessionCopyCleanupAuthority({',
  );

  assert.notEqual(hostStart, -1);
  assert.notEqual(workBoardOpen, -1);
  assert.notEqual(sessionCopyOpen, -1);
  assert.ok(hostStart < workBoardOpen);
  assert.notEqual(workBoardStore, -1);
  assert.match(
    bootSource.slice(workBoardStore, bootSource.indexOf('});', workBoardStore)),
    /schemaMigration: 'require_current'/u,
  );
  assert.match(
    bootSource.slice(sessionCopyOpen, bootSource.indexOf('}),', sessionCopyOpen)),
    /schemaMigration: 'require_current'/u,
  );
});

test('routes the first-paint IPC only to the active Renderer recovery listener', () => {
  const ipcHandlerStart = earlyWindowSource.indexOf(
    'ipcMain.handle("window:notifyRendererReady"',
  );
  const ipcHandler = earlyWindowSource.slice(
    ipcHandlerStart,
    earlyWindowSource.indexOf('const firstWindowLaunch = quitCoordinator.focusOrCreateWindow()', ipcHandlerStart),
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

test('retires the launch overlay only when a surface marks ready content', () => {
  // The overlay's dismissal and its emitters live in different files; pinning
  // both sides keeps the attribute from drifting into a permanent logo.
  const readRenderer = (path: string) =>
    readFileSync(
      fileURLToPath(new URL(`../../../src/renderer/${path}`, import.meta.url)),
      'utf8',
    );
  const workHubRoot = readRenderer('features/workhub/ui/workhub-root.tsx');
  const handoffOverlay = readRenderer(
    'features/runtime-host-management/ui/runtime-host-handoff-overlay.tsx',
  );
  const errorBoundary = readRenderer('error-boundary.tsx');
  const chatMessageSurface = readRenderer('chat-message-surface.tsx');

  assert.match(
    indexHtmlSource,
    /body:has\(#root \[data-maka-content-ready\]\) > \.maka-preload/u,
  );
  assert.doesNotMatch(indexHtmlSource, /body:has\(#root > \*\)/u);
  // The shell marks ready only once the first snapshot settles; the floating
  // composer is content-complete at mount; a pending handoff decision and the
  // error surface must not wait on either.
  assert.match(appShellSource, /data-maka-content-ready=\{!isOnboardingLoading/u);
  assert.match(workHubRoot, /data-maka-content-ready/u);
  assert.match(handoffOverlay, /data-maka-content-ready/u);
  assert.match(errorBoundary, /data-maka-content-ready/u);
  // The second loading surface is deleted: the overlay alone covers the gap.
  assert.doesNotMatch(chatMessageSurface, /maka-onboarding-loading/u);
});
