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
import {
  catalogJobs,
  isExpectedConsoleError,
  jobLabel,
  storyUrl,
} from './storybook-visual-smoke.mjs';

const REFERENCE_STORY_ID = 'product-shell-official-appshell--native-conversation';

test('job labels support independent locale and viewport overrides', () => {
  const job = { storyId: 'example', colorScheme: 'light', palette: 'default' };
  assert.equal(jobLabel(job), 'example (light/default)');
  assert.equal(jobLabel({ ...job, locale: 'en' }), 'example (light/default/en)');
  assert.equal(
    jobLabel({ ...job, viewport: { width: 720, height: 900 } }),
    'example (light/default/720px)',
  );
  assert.equal(
    jobLabel({ ...job, locale: 'en', viewport: { width: 720, height: 900 } }),
    'example (light/default/en/720px)',
  );
});
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
        forcedColors: 'none',
        palette: 'default',
      },
    ],
  );
});

test('dark theme sentinel stories render the default palette in both colour schemes', () => {
  const storyId = 'product-settings-pages--appearance';

  assert.deepEqual(catalogJobs(storyIndex(storyId), { themePalettes: THEME_PALETTES }), [
    { storyId, colorScheme: 'light', forcedColors: 'none', palette: 'default' },
    { storyId, colorScheme: 'dark', forcedColors: 'none', palette: 'default' },
  ]);
});

test('system-note regression covers both locales at standard and narrow widths', () => {
  const storyId = 'product-shell-official-appshell--long-system-notes';
  const jobs = catalogJobs(storyIndex(storyId));
  assert.equal(jobs.length, 4);
  assert.deepEqual(
    jobs.map(({ locale, viewport }) => [locale, viewport.width, viewport.height]),
    [
      ['zh-CN', 1280, 900],
      ['zh-CN', 720, 900],
      ['en', 1280, 900],
      ['en', 720, 900],
    ],
  );
  for (const job of jobs) {
    const url = new URL(storyUrl('http://localhost:6006', job));
    assert.equal(url.searchParams.get('id'), storyId);
    assert.equal(
      url.searchParams.get('globals'),
      `colorScheme:light;palette:default;locale:${job.locale}`,
    );
  }
});

test('forced-colors stories render under the forced palette', () => {
  const storyId = 'product-settings-pages--general-forced-colors-focus-ring';

  assert.deepEqual(catalogJobs(storyIndex(storyId), { themePalettes: THEME_PALETTES }), [
    { storyId, colorScheme: 'light', forcedColors: 'active', palette: 'default' },
  ]);
});

test('the reference story renders every palette in both colour schemes', () => {
  const jobs = catalogJobs(storyIndex(REFERENCE_STORY_ID), {
    themePalettes: THEME_PALETTES,
  });

  assert.equal(jobs.length, 22);
  assert.equal(new Set(jobs.map((job) => `${job.colorScheme}/${job.palette}`)).size, 22);
  assert.deepEqual(jobs.slice(0, 4), [
    { storyId: REFERENCE_STORY_ID, colorScheme: 'light', forcedColors: 'none', palette: 'default' },
    { storyId: REFERENCE_STORY_ID, colorScheme: 'dark', forcedColors: 'none', palette: 'default' },
    {
      storyId: REFERENCE_STORY_ID,
      colorScheme: 'light',
      forcedColors: 'none',
      palette: 'test-palette-1',
    },
    {
      storyId: REFERENCE_STORY_ID,
      colorScheme: 'dark',
      forcedColors: 'none',
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

const errorStory = 'product-settings-pages--general-host-settings-error';
const expectedError =
  '[settings] operation failed: Runtime Host settings read failed in this story.';

test('allows the intentional settings read failure only in its error story', () => {
  assert.equal(isExpectedConsoleError(errorStory, expectedError), true);
  assert.equal(isExpectedConsoleError('product-settings-pages--general', expectedError), false);
  assert.equal(
    isExpectedConsoleError(
      'product-settings-pages--projects-cached-host-revalidation',
      expectedError,
    ),
    false,
  );
});

test('keeps unexpected settings errors fatal, including errors in the error story', () => {
  const missingBridgeError =
    "[settings] operation failed: Cannot read properties of undefined (reading 'getSnapshot')";
  assert.equal(isExpectedConsoleError(errorStory, missingBridgeError), false);
  assert.equal(
    isExpectedConsoleError(
      'product-settings-pages--projects-cached-host-revalidation',
      missingBridgeError,
    ),
    false,
  );
  assert.equal(isExpectedConsoleError(errorStory, `${expectedError} unexpected detail`), false);
  assert.equal(isExpectedConsoleError(errorStory, 'unexpected render failure'), false);
});
