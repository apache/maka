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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  listShots,
  parseCliArgs,
  planShots,
  runCompare,
  shotFileName,
  shotJobs,
  staleShots,
} from './storybook-visual-diff.mjs';

const STORIES = [
  'product-shell-official-appshell--native-conversation',
  'product-shell-official-appshell--waiting-for-permission',
  'product-tool-activity--contiguous-group',
];

test('shot filenames carry the story id and colour scheme', () => {
  assert.equal(
    shotFileName('product-shell-official-appshell--native-conversation', 'dark'),
    'product-shell-official-appshell--native-conversation.dark.png',
  );
});

test('every default story renders in both colour schemes', () => {
  const jobs = shotJobs(STORIES);
  assert.equal(jobs.length, STORIES.length * 2);
  assert.deepEqual(
    jobs.filter((job) => job.storyId === STORIES[0]).map((job) => job.colorScheme),
    ['light', 'dark'],
  );
});

test('a story filter keeps only matching story ids', () => {
  const jobs = shotJobs(STORIES, { stories: ['tool-activity'] });
  assert.deepEqual(
    jobs.map((job) => job.storyId),
    ['product-tool-activity--contiguous-group', 'product-tool-activity--contiguous-group'],
  );
  assert.equal(shotJobs(STORIES, { stories: ['no-such-story'] }).length, 0);
});

test('a scheme filter narrows the colour matrix and rejects typos', () => {
  assert.deepEqual(
    shotJobs(STORIES, { schemes: ['dark'] }).map((job) => job.colorScheme),
    ['dark', 'dark', 'dark'],
  );
  assert.throws(() => shotJobs(STORIES, { schemes: ['dart'] }), /Unknown color scheme "dart"/);
});

test('shot listings ignore *.diff.png report artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-shots-'));
  try {
    await writeFile(join(dir, 'a.light.png'), 'shot');
    await writeFile(join(dir, 'a.light.png.diff.png'), 'diff');
    assert.deepEqual(await listShots(dir), ['a.light.png']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('files missing from the capture manifest are stale, not evidence', () => {
  const manifest = { shots: ['a.light.png'] };
  assert.deepEqual(staleShots(['a.light.png', 'old.dark.png'], manifest), ['old.dark.png']);
  assert.deepEqual(staleShots(['a.light.png'], null), []);
  assert.deepEqual(staleShots(['a.light.png'], { platform: 'darwin' }), []);
});

test('a shot that failed in both captures surfaces as not-captured', () => {
  const manifest = { expected: ['a.light.png', 'b.dark.png'], shots: ['a.light.png'] };
  const plan = planShots(new Set(['a.light.png']), new Set(['a.light.png']), manifest, manifest);
  assert.deepEqual(plan, [
    { file: 'a.light.png', status: 'compare' },
    { file: 'b.dark.png', status: 'not-captured' },
  ]);
});

test('planShots flags one-sided shots and manifest-listed leftovers', () => {
  const beforeManifest = { expected: ['a.png', 'b.png'], shots: ['a.png'] };
  const afterManifest = { expected: ['a.png', 'b.png'], shots: ['a.png', 'b.png'] };
  const plan = planShots(
    new Set(['a.png', 'leftover.png']),
    new Set(['a.png', 'b.png']),
    beforeManifest,
    afterManifest,
  );
  assert.deepEqual(plan, [
    { file: 'a.png', status: 'compare' },
    { file: 'b.png', status: 'missing-before' },
    { file: 'leftover.png', status: 'stale' },
  ]);
});

test('compare fails rather than certify an empty comparison', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-shots-'));
  const before = join(dir, 'before');
  const after = join(dir, 'after');
  await mkdir(before);
  await mkdir(after);
  try {
    await assert.rejects(runCompare(before, after, {}), /nothing to compare/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('cli parsing splits positionals, space values and = values', () => {
  const parsed = parseCliArgs([
    'compare',
    '/tmp/before',
    '/tmp/after',
    '--diff-dir',
    '/tmp/report dir',
    '--stories=native-conversation',
    '--dry',
  ]);
  assert.equal(parsed.command, 'compare');
  assert.deepEqual(parsed.positionals, ['/tmp/before', '/tmp/after']);
  assert.deepEqual(parsed.options, {
    'diff-dir': '/tmp/report dir',
    stories: 'native-conversation',
    dry: true,
  });
});
