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

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';

// Electron owns the native backing of dropped Files and their transfer through
// contextBridge to webUtils.getPathForFile. Mocked File or preload tests cannot
// expose loss of that backing; this journey feeds a real directory through CDP
// native drag input and reads the project admitted by the actual Host.
test('native folder drop registers the real directory as a project', async ({ projectSidebarWindow: page }) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-native-folder-drop-'));
  const folderName = '文件夹 Project';
  const folder = join(temporaryRoot, folderName);
  await mkdir(folder);
  const canonicalFolder = await realpath(folder);
  const cdp = await page.context().newCDPSession(page);

  try {
    await page.keyboard.press('Escape');
    const sidebar = page.getByRole('navigation', { name: '任务列表' });
    await sidebar.getByRole('radio', { name: '按项目', exact: true }).click();
    const dropZone = sidebar.locator('.maka-project-folder-drop-zone[data-maka-file-drop-target="true"]');
    await expect(dropZone).toBeVisible();

    const bounds = await dropZone.boundingBox();
    if (!bounds) throw new Error('Project folder drop zone has no bounds');
    const input = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + Math.min(bounds.height / 2, 32),
      data: { items: [], files: [folder], dragOperationsMask: 1 },
    };
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...input });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...input });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...input });

    await expect.poll(() => page.evaluate(async (directory) => {
      const catalog = await window.maka.newTasks.getCatalog();
      return catalog.hosts.flatMap((host) => {
        if (host.profile.kind !== 'local' || host.readiness !== 'ready' || host.state !== 'available') return [];
        return host.projects
          .filter((project) => project.locations.some((location) => location.path === directory))
          .map((project) => project.name);
      });
    }, canonicalFolder)).toEqual([folderName]);
  } finally {
    await cdp.detach();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
