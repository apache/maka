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
import test from 'node:test';
import { catalogJobs, storyUrl } from './storybook-visual-smoke.mjs';

const REFERENCE_STORY_ID = 'product-shell-official-appshell--native-conversation';
const THEME_PALETTES = [
  'default',
  ...Array.from({ length: 10 }, (_, index) => `test-palette-${index + 1}`),
];

function storyIndex(...storyIds) {
  return {
    entries: Object.fromEntries(
      storyIds.map((storyId) => [storyId, { id: storyId, type: 'story' }]),
    ),
  };
}

test('ordinary catalog stories render the default palette in light mode', () => {
  assert.deepEqual(
    catalogJobs(storyIndex('product-settings--memory'), { themePalettes: THEME_PALETTES }),
    [
      {
        storyId: 'product-settings--memory',
        colorScheme: 'light',
        palette: 'default',
      },
    ],
  );
});

test('dark theme sentinel stories render the default palette in both colour schemes', () => {
  const storyId = 'product-settings-pages--appearance';

  assert.deepEqual(catalogJobs(storyIndex(storyId), { themePalettes: THEME_PALETTES }), [
    { storyId, colorScheme: 'light', palette: 'default' },
    { storyId, colorScheme: 'dark', palette: 'default' },
  ]);
});

test('the reference story renders every palette in both colour schemes', () => {
  const jobs = catalogJobs(storyIndex(REFERENCE_STORY_ID), {
    themePalettes: THEME_PALETTES,
  });

  assert.equal(jobs.length, 22);
  assert.equal(new Set(jobs.map((job) => `${job.colorScheme}/${job.palette}`)).size, 22);
  assert.deepEqual(jobs.slice(0, 4), [
    { storyId: REFERENCE_STORY_ID, colorScheme: 'light', palette: 'default' },
    { storyId: REFERENCE_STORY_ID, colorScheme: 'dark', palette: 'default' },
    {
      storyId: REFERENCE_STORY_ID,
      colorScheme: 'light',
      palette: 'test-palette-1',
    },
    {
      storyId: REFERENCE_STORY_ID,
      colorScheme: 'dark',
      palette: 'test-palette-1',
    },
  ]);
});

test('a mixed catalog adds only the full palette story theme matrix', () => {
  const storyIds = ['product-settings--memory', REFERENCE_STORY_ID, 'design-system--button'];
  const jobs = catalogJobs(storyIndex(...storyIds), { themePalettes: THEME_PALETTES });

  assert.equal(jobs.length, storyIds.length + THEME_PALETTES.length * 2 - 1);
  assert.deepEqual(new Set(jobs.map((job) => job.storyId)), new Set(storyIds));
});

test('duplicate palette ids do not duplicate render jobs', () => {
  const jobs = catalogJobs(storyIndex(REFERENCE_STORY_ID), {
    themePalettes: ['default', 'onedark', 'default', 'onedark'],
  });

  assert.equal(jobs.length, 4);
});

test('catalog jobs require a non-empty palette inventory containing default', () => {
  assert.throws(
    () => catalogJobs(storyIndex('product-settings--memory'), { themePalettes: [] }),
    /at least one theme palette/,
  );
  assert.throws(
    () =>
      catalogJobs(storyIndex('product-settings--memory'), {
        themePalettes: ['onedark'],
      }),
    /must include default/,
  );
});

test('story URLs encode the selected colour scheme and palette', () => {
  const url = new URL(
    storyUrl('http://127.0.0.1:6006', {
      storyId: REFERENCE_STORY_ID,
      colorScheme: 'dark',
      palette: 'tokyo-night',
    }),
  );

  assert.equal(url.pathname, '/iframe.html');
  assert.equal(url.searchParams.get('id'), REFERENCE_STORY_ID);
  assert.equal(url.searchParams.get('viewMode'), 'story');
  assert.equal(url.searchParams.get('globals'), 'colorScheme:dark;palette:tokyo-night');
});
