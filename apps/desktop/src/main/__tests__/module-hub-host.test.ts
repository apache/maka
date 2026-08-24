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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { NavSelection } from '@maka/ui';
import { resolveModuleHubHostRoute } from '../../renderer/features/module-hub/testing.js';

test('Module Hub resolves all four leaf routes and no chat route', () => {
  const cases: Array<[NavSelection, ReturnType<typeof resolveModuleHubHostRoute>]> = [
    [{ section: 'extensions', module: 'skills' }, 'skills'],
    [{ section: 'extensions', module: 'mcp' }, 'mcp'],
    [{ section: 'automations', module: 'scheduled-tasks' }, 'scheduled-tasks'],
    [{ section: 'automations', module: 'daily-review' }, 'daily-review'],
    [{ section: 'sessions' }, null],
  ];
  for (const [selection, expected] of cases) {
    assert.equal(resolveModuleHubHostRoute(selection), expected);
  }
});

test('Host maps each route to one existing leaf and preserves the MCP exception', () => {
  const desktopRoot = resolve(
    fileURLToPath(new URL('../../../', import.meta.url)),
  );
  const source = readFileSync(
    resolve(
      desktopRoot,
      'src/renderer/features/module-hub/ui/module-hub-host.tsx',
    ),
    'utf8',
  );
  for (const leaf of [
    '<SkillsPage',
    '<McpPage',
    '<ScheduledTasksPage',
    '<DailyReviewPage',
  ]) {
    assert.equal(source.split(leaf).length - 1, 1, leaf);
  }
  assert.match(source, /route === 'mcp'/);
  assert.match(source, /MCP keeps its existing page-owned/);
  assert.match(source, /return null;/);
});
