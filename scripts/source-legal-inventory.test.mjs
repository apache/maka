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
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');

test('root release documents describe the source candidate', async () => {
  const [license, notice] = await Promise.all([
    readFile(join(root, 'LICENSE'), 'utf8'),
    readFile(join(root, 'NOTICE'), 'utf8'),
  ]);
  assert.equal(
    notice,
    'Apache Maka (incubating)\nCopyright 2026 The Apache Software Foundation\n\nThis product includes software developed at\nThe Apache Software Foundation (https://www.apache.org/).\n',
  );
  assert.match(license, /apps\/desktop\/src\/renderer\/public\/THIRD_PARTY_LICENSES\.txt/);

  const patches = (await readdir(join(root, 'patches'))).filter((name) => name.endsWith('.patch'));
  for (const patch of patches) assert.ok(license.includes(patch), patch);
});

test('mixed-origin DeepSeek profile carries both scopes without a whole-file ASF claim', async () => {
  const [license, profile] = await Promise.all([
    readFile(join(root, 'LICENSE'), 'utf8'),
    readFile(join(root, 'packages/eval/harbor/deepseek-harness-profile/cordis.patch.yml'), 'utf8'),
  ]);
  assert.match(license, /DeepSeek Harness \(adapted source\)/);
  assert.match(license, /47f943859bef60e4160492346772ded9b24f765a/);
  assert.match(profile, /Copyright \(c\) 2026 DeepSeek/);
  assert.match(profile, /Licensed under the MIT License/);
  assert.doesNotMatch(profile, /Licensed to the Apache Software Foundation \(ASF\)/);
});

test('PawWork browser provenance is pinned to the confirmed transfer boundary', async () => {
  const audit = await readFile(join(root, 'docs/code-origin-audit.md'), 'utf8');
  const section = audit
    .split('### PawWork browser port\n', 2)[1]
    ?.split('\n### Bundled Skills\n', 1)[0];
  assert.ok(section, 'PawWork browser provenance section is missing');
  assert.match(section, /fab537af179232cc88dc39314038000f70d15d05/);
  assert.match(section, /aff7ce202f5ccb9a7166a95172aa754b0d4de7db/);
  assert.match(section, /e3595b705c687c369828736ecd154127ed44f545/);
  assert.match(section, /only two source batches/);
  assert.match(section, /submitted it directly as an ASF contribution/);

  const inventoriedPaths = [...section.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
  assert.deepEqual(inventoriedPaths, [
    'apps/desktop/src/global.d.ts',
    'apps/desktop/src/main/__tests__/automation-host.test.ts',
    'apps/desktop/src/main/__tests__/browser-logic.test.ts',
    'apps/desktop/src/main/__tests__/browser-session.test.ts',
    'apps/desktop/src/main/__tests__/browser-tools.test.ts',
    'apps/desktop/src/main/__tests__/browser-view-manager.test.ts',
    'apps/desktop/src/main/__tests__/cdp-bridge.test.ts',
    'apps/desktop/src/main/browser/automation-host.ts',
    'apps/desktop/src/main/browser/browser-host.ts',
    'apps/desktop/src/main/browser/browser-tools.ts',
    'apps/desktop/src/main/browser/cdp-bridge.ts',
    'apps/desktop/src/main/browser/controller.ts',
    'apps/desktop/src/main/browser/logic.ts',
    'apps/desktop/src/main/browser/options.ts',
    'apps/desktop/src/main/browser/session.ts',
    'apps/desktop/src/main/browser/view-manager.ts',
    'apps/desktop/src/main/main.ts',
    'apps/desktop/src/preload/preload.ts',
    'apps/desktop/src/renderer/browser-panel.tsx',
    'apps/desktop/src/renderer/main.tsx',
    'apps/desktop/src/renderer/styles.css',
    'packages/core/src/browser.ts',
    'packages/core/src/index.ts',
  ]);
});

test('MingCute license pointer resolves in both source and packaged layouts', async () => {
  const [license, inventory, builderConfig] = await Promise.all([
    readFile(join(root, 'LICENSE'), 'utf8'),
    readFile(join(root, 'apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt'), 'utf8'),
    readFile(join(root, 'apps/desktop/electron-builder.config.mjs'), 'utf8'),
  ]);
  const entry = inventory.split('## MingCute DingTalk mark\n', 2)[1]?.split('\n## ', 1)[0];
  assert.ok(entry, 'MingCute inventory entry is missing');
  assert.match(entry, /repository-root `LICENSE`/);
  assert.match(entry, /`licenses\/renderer\/MINGCUTE_APACHE_LICENSE\.txt`/);
  assert.match(license, /Apache License\n\s+Version 2\.0, January 2004/);
  assert.match(
    builderConfig,
    /from: '\.\.\/\.\.\/LICENSE',\n\s+to: 'licenses\/renderer\/MINGCUTE_APACHE_LICENSE\.txt'/,
  );
});

test('every vendored provider mark is bound to its reviewed inventory and digest', async () => {
  const assetDirectory = join(root, 'apps/desktop/src/renderer/assets/provider-brands');
  const inventory = await readFile(
    join(root, 'apps/desktop/src/renderer/public/THIRD_PARTY_LICENSES.txt'),
    'utf8',
  );
  const assetNames = (await readdir(assetDirectory)).filter((name) => name.endsWith('.svg'));
  for (const assetName of assetNames) {
    const relativePath = `apps/desktop/src/renderer/assets/provider-brands/${assetName}`;
    const digest = createHash('sha256')
      .update(await readFile(join(assetDirectory, assetName)))
      .digest('hex');
    const marker = `\`${relativePath}\``;
    const entryStart = inventory.indexOf(marker);
    assert.notEqual(entryStart, -1, `${relativePath} is not inventoried`);
    const nextEntry = inventory.indexOf('\n  - `', entryStart + marker.length);
    const entry = inventory.slice(entryStart, nextEntry === -1 ? undefined : nextEntry);
    assert.ok(
      entry.includes(`SHA-256: \`${digest}\``),
      `${relativePath} digest is not inventoried`,
    );
  }
});
