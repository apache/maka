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
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, Platform } from 'electron-builder';
import { _electron as electron } from 'playwright';
import { closeElectronApplication } from '../../../scripts/electron-lifecycle.mjs';
import config from '../electron-builder.config.mjs';

if (process.platform !== 'darwin') throw new Error('This smoke test requires macOS');
const desktop = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const electronDirectory = dirname(require.resolve('electron/package.json'));
const root = await mkdtemp(join(tmpdir(), 'maka-notification-packaged-'));
const source = join(root, 'app');
let application;
try {
  await mkdir(join(source, 'dist', 'native'), { recursive: true });
  await mkdir(join(source, 'dist', 'main'), { recursive: true });
  await cp(join(desktop, 'dist', 'native', 'notification-settings.node'),
    join(source, 'dist', 'native', 'notification-settings.node'));
  await cp(join(desktop, 'dist', 'main', 'notification-permission.js'),
    join(source, 'dist', 'main', 'notification-permission.js'));
  await writeFile(join(source, 'package.json'), JSON.stringify({
    name: 'maka-notification-smoke', version: '1.0.0', type: 'module',
    main: 'dist/main/main.js', description: 'Notification bridge packaging test',
    author: 'The Maka Authors',
  }));
  await writeFile(join(source, 'dist', 'main', 'main.js'), `
    import { app, BrowserWindow } from 'electron';
    import { notificationPermissionSnapshot } from './notification-permission.js';
    app.whenReady().then(async () => {
      globalThis.notificationResults = await Promise.all(
        Array.from({ length: 8 }, () => notificationPermissionSnapshot(Date.now(), process.platform, true))
      );
      const window = new BrowserWindow({ show: false });
      await window.loadURL('about:blank');
    });
  `);
  const { version } = JSON.parse(await readFile(join(electronDirectory, 'package.json')));
  await build({
    targets: Platform.MAC.createTarget('dir'),
    projectDir: source,
    config: {
      appId: `com.maka.notification-smoke.${Date.now()}`,
      productName: 'Maka Notification Smoke',
      electronVersion: version,
      electronDist: join(electronDirectory, 'dist'),
      directories: { output: join(root, 'out') },
      files: ['dist/**/*', 'package.json'],
      asar: config.asar,
      asarUnpack: config.asarUnpack,
      mac: { identity: '-', hardenedRuntime: true, notarize: false },
    },
  });
  const executable = join(root, 'out', process.arch === 'arm64' ? 'mac-arm64' : 'mac',
    'Maka Notification Smoke.app', 'Contents', 'MacOS', 'Maka Notification Smoke');
  application = await electron.launch({ executablePath: executable, args: [] });
  await application.firstWindow();
  const result = await application.evaluate(({ app }) => ({
    snapshots: globalThis.notificationResults,
    packaged: app.isPackaged,
    executable: process.execPath,
  }));
  assert.equal(result.packaged, true);
  for (const snapshot of result.snapshots) {
    assert.equal(snapshot.source, 'platform');
    assert.equal(snapshot.status, 'not_determined', JSON.stringify(result));
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (application) await closeElectronApplication(application, 5_000);
  await rm(root, { recursive: true, force: true });
}
