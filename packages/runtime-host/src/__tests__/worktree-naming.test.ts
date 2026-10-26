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
import { test } from 'node:test';
import { parseWorktreeName } from '../server/worktree-naming.js';

test('generated conventional branch names decode into a type and independent directory slug', () => {
  for (const type of [
    'feat',
    'fix',
    'docs',
    'style',
    'refactor',
    'perf',
    'test',
    'build',
    'ci',
    'chore',
    'revert',
  ]) {
    assert.deepEqual(parseWorktreeName(`  ${type}/login-redirect\n`), {
      type,
      slug: 'login-redirect',
    });
  }
  const slug = 'a'.repeat(40);
  assert.deepEqual(parseWorktreeName(`feat/${slug}`), { type: 'feat', slug });
});

test('invalid model responses cannot become branch refs or directory paths', () => {
  for (const text of [
    '',
    'add-search',
    'feature/add-search',
    'Feat/add-search',
    'feat/',
    'feat/-add-search',
    'feat/add-search-',
    'feat/add--search',
    'feat/Add-Search',
    'feat/add search',
    'feat/搜索',
    'feat/foo/bar',
    'feat/../outside',
    'feat/..',
    'feat/foo.lock',
    'feat/foo@{1}',
    'feat/foo\\bar',
    'feat/con',
    'fix/nul',
    'chore/com1',
    'chore/lpt9',
    '"feat/add-search"',
    '```feat/add-search```',
    'feat/add-search\nExplanation',
    'feat/add-search\nfix/another-task',
    `feat/${'a'.repeat(41)}`,
  ])
    assert.equal(parseWorktreeName(text), undefined, text);
});
