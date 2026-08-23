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
import { join } from 'node:path';
import { test } from 'node:test';
import { desktopAssetPath, desktopAssetRoot } from '../desktop-assets.js';

test('a packaged build reads assets from the copy beside the app', () => {
  const resourcesPath = join('/Applications', 'Maka.app', 'Contents', 'Resources');
  assert.equal(desktopAssetRoot({ isPackaged: true, resourcesPath }), resourcesPath);
  assert.equal(
    desktopAssetPath({ isPackaged: true, resourcesPath }, 'assets', 'icon.png'),
    join(resourcesPath, 'assets', 'icon.png'),
  );
});

test('a dev run keeps resolving the repo layout, not the resources path', () => {
  const root = desktopAssetRoot({ isPackaged: false, resourcesPath: '/unused' });
  assert.ok(root.endsWith(join('apps', 'desktop')), `${root} should point at apps/desktop`);
});
