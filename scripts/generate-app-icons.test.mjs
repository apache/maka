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

/**
 * The shipped icon artwork has to stay reproducible from source.
 *
 * A directory of opaque PNGs cannot be audited: nobody reviewing a change can
 * tell whether a tile was regenerated from the committed geometry, exported
 * from a design tool, or pasted in from somewhere with an unclear licence.
 * Keeping the generator in the tree only helps if something checks that it
 * still produces exactly what is committed — otherwise the two drift and the
 * script becomes decoration.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { APP_ICONS } from '@maka/core/settings';

const SCRIPT = fileURLToPath(new URL('./generate-app-icons.py', import.meta.url));
const ART = new URL('../apps/desktop/assets/app-icons/', import.meta.url);

/** Ids whose artwork does not come from the generator. */
const NOT_GENERATED = new Set([
  // The brand mark lives at assets/icon.png, outside this directory.
  'default',
  // Its grayscale companion is a derived export of that same mark.
  'mono',
]);

function python() {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return undefined;
}

test('every shipped id has artwork, and every file is claimed by an id', async () => {
  // Pure bookkeeping, so it runs everywhere: adding an id without art, or art
  // without an id, is the mistake that would otherwise surface as an icon the
  // picker silently drops into the "imported" group.
  const files = (await readdir(ART)).filter((name) => name.endsWith('.png'));
  const onDisk = new Set(files.map((name) => name.slice(0, -'.png'.length)));
  const expected = new Set(APP_ICONS.filter((id) => !NOT_GENERATED.has(id)));

  for (const id of expected) {
    assert.ok(onDisk.has(id), `APP_ICONS names ${id} but no artwork ships for it`);
  }
  for (const name of onDisk) {
    if (NOT_GENERATED.has(name)) continue;
    assert.ok(expected.has(name), `${name}.png ships but no id in APP_ICONS selects it`);
  }
});

test('the committed artwork is byte-identical to what the generator produces', (t) => {
  const runner = python();
  if (!runner) {
    t.skip('no python3 on PATH; run scripts/generate-app-icons.py --check locally');
    return;
  }
  // A sample rather than all 38: rendering one 1024px tile is ~1.5s of
  // pure-Python signed-distance evaluation. These four cover the three paint
  // paths — flat fill, angled tile gradient, and a gradient carried by the
  // stroke itself — so a regression in any of them fails here.
  const result = spawnSync(runner, [SCRIPT, '--check', 'sky', 'ink', 'midnight', 'gold'], {
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    `generator disagrees with the committed artwork:\n${result.stdout}${result.stderr}`,
  );
});
