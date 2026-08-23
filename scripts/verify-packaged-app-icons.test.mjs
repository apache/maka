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
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPackagedResources } from './verify-packaged-app.mjs';

/**
 * Artwork is read at runtime, and Electron reports a missing file as an EMPTY
 * image rather than an error — a packaging change that dropped it would ship a
 * blank dock tile with nothing failing. So the packaged-resource check has to
 * name every icon, and these prove it would notice.
 *
 * Nothing here imports build output: this file and the verifier it covers must
 * load in a clean checkout, which is exactly what `check:release` gives them.
 * That the shipped catalog matches the ids the app offers is the desktop
 * suite's job, where `APP_ICONS` is walked against the same directory.
 */
const ART_DIRECTORY = new URL('../apps/desktop/assets/app-icons/', import.meta.url);

function recorder(missing = new Set()) {
  const asked = [];
  return {
    asked,
    requirePath: async (path) => {
      asked.push(path);
      if ([...missing].some((suffix) => path.endsWith(suffix))) {
        throw new Error(`missing ${path}`);
      }
    },
    forbidPath: async () => {},
  };
}

test('every shipped icon file is required in a packaged build', async () => {
  const artwork = (await readdir(ART_DIRECTORY)).filter((name) => name.endsWith('.png'));
  assert.ok(artwork.length > 0, 'the picker ships artwork; this fixture is not optional');

  const probe = recorder();
  await assertPackagedResources('/Resources', probe);

  for (const name of artwork) {
    assert.ok(
      probe.asked.includes(join('/Resources', 'assets', 'app-icons', name)),
      `${name} ships in the repo but is not required in the package`,
    );
  }
});

/**
 * The upgrade lifecycle verifies the PREVIOUSLY released installer, which
 * predates `assets/` being packaged at all. Requiring the catalog there would
 * fail an upgrade check over an artifact that was correct when it shipped, so
 * the requirement belongs to the current contract only.
 */
test('a legacy baseline is not asked for artwork that postdates it', async () => {
  const probe = recorder();
  // The canonical icon rides its own flag, added for the same reason; a legacy
  // baseline predates both.
  await assertPackagedResources('/Resources', {
    ...probe,
    requireAppIconCatalog: false,
    requireCanonicalIcon: false,
  });

  const assets = probe.asked.filter((path) => path.includes('assets'));
  assert.deepEqual(assets, [], `legacy baseline asked for ${assets.join(', ')}`);
  // It still verifies everything the old contract did carry.
  assert.ok(probe.asked.includes(join('/Resources', 'app.asar')));
});

test('a package that dropped the artwork fails the check', async () => {
  const [first] = (await readdir(ART_DIRECTORY)).filter((name) => name.endsWith('.png'));
  for (const dropped of [join('assets', 'app-icons', first)]) {
    await assert.rejects(
      assertPackagedResources('/Resources', recorder(new Set([dropped]))),
      /missing/,
      `dropping ${dropped} should fail`,
    );
  }
});
