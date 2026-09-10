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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { desktopAssetRoot } from '../desktop-assets.js';
import { pngOfSize } from './app-icon-test-fixture.js';

/**
 * What the fake Electron hands the module under test.
 *
 * `applyAppIcon` imports Electron at load time, and a plain `node --test`
 * process cannot resolve that: the package's real entry point exports a path
 * to the binary, not `app`, so the import fails before any assertion runs.
 * The call chain is therefore exercised against these fakes — with the
 * platform pinned, because the same code has to behave differently on Windows
 * and on the per-window platforms, and CI does not run Windows.
 */
const electron = {
  userDataRoot: '',
  reads: (_path: string) => true,
  icons: [] as string[],
};

mock.module('electron', {
  namedExports: {
    app: {
      getPath: () => electron.userDataRoot,
      isPackaged: false,
      dock: undefined,
    },
    BrowserWindow: {
      getAllWindows: () => [{ setIcon: (icon: string) => electron.icons.push(icon) }],
    },
    nativeImage: {
      createFromPath: (path: string) => ({
        isEmpty: () => !electron.reads(path),
        resize: ({ width }: { width: number }) => ({ toPNG: () => pngOfSize(width) }),
      }),
      createFromBuffer: () => ({ isEmpty: () => true }),
    },
  },
});

/** The 1024px master a window falls back to when nothing else can be used. */
const DEFAULT_MASTER = join(
  desktopAssetRoot({ isPackaged: false, resourcesPath: process.resourcesPath }),
  'assets',
  'icon.png',
);

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = process.platform;
  // `process.platform` is configurable, so pinning it keeps these assertions
  // about the platform's branch rather than about the machine running them.
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

async function withTempUserData(run: (root: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'maka-app-icon-'));
  electron.userDataRoot = root;
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Runs one icon change against the real module and reports what reached the window. */
async function applyIcon(
  value: unknown,
): Promise<{ readonly icons: readonly string[]; readonly errors: readonly unknown[] }> {
  const { applyAppIcon } = await import('../app-icon-surface.js');
  electron.icons = [];
  const errors: unknown[] = [];
  applyAppIcon(value, (error) => errors.push(error));
  return { icons: electron.icons, errors };
}

test('the taskbar gets the rebuilt ICO path, so the picker and the taskbar agree', async () => {
  await withTempUserData(async (root) => {
    electron.reads = () => true;
    const { icons, errors } = await withPlatform('win32', () => applyIcon('default'));

    const cached = join(root, 'app-icon-cache', 'taskbar.ico');
    assert.deepEqual(icons, [cached]);
    assert.deepEqual(errors, []);

    // And the file Windows is pointed at holds every size it asks for: a path
    // to a PNG master leaves the taskbar on the packaged `.exe` tile.
    const ico = readFileSync(cached);
    assert.equal(ico.readUInt16LE(2), 1, 'not an ICO');
    assert.equal(ico.readUInt16LE(4), 6, 'the small/large HICON sizes are missing');
  });
});

test('a cache that cannot be written leaves the window on the PNG master', async (t) => {
  const reported = t.mock.method(console, 'error', () => undefined);
  await withTempUserData(async (root) => {
    electron.reads = () => true;
    // A file where the cache directory has to go, so the write cannot happen.
    writeFileSync(join(root, 'app-icon-cache'), 'in the way');

    const { icons, errors } = await withPlatform('win32', () => applyIcon('default'));

    // The fallback is a readable PNG — never the ICO path that decodes to
    // nothing — and the failure is not swallowed into silence.
    assert.deepEqual(icons, [DEFAULT_MASTER]);
    assert.deepEqual(errors, []);
    assert.equal(reported.mock.callCount(), 1);
  });
});

for (const platform of ['win32', 'linux'] as const) {
  test(`artwork that is gone on ${platform} reports instead of blanking the running icon`, async () => {
    await withTempUserData(async () => {
      electron.reads = () => false;
      const { icons, errors } = await withPlatform(platform, () => applyIcon('default'));

      // `setIcon` with a path that decodes to nothing blanks the icon the
      // window already has, which is worse than leaving it as it is.
      assert.deepEqual(icons, []);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]), /no readable artwork for app icon "default"/);
    });
  });
}
