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
import { describe, it } from 'node:test';
import { parseNavigationState } from '../../renderer/nav-selection.js';

describe('Navigation selection persistence', () => {
  it('hydrates the hub-shaped navigation state written by supported versions', () => {
    assert.deepEqual(
      parseNavigationState(
        JSON.stringify({
          selection: { section: 'extensions', module: 'mcp' },
          moduleMemory: {
            extensions: 'mcp',
            automations: 'daily-review',
          },
        }),
      ),
      {
        selection: { section: 'extensions', module: 'mcp' },
        moduleMemory: {
          extensions: 'mcp',
          automations: 'daily-review',
        },
      },
    );
  });

  it('migrates plan reminders written by the oldest supported version', () => {
    assert.deepEqual(
      parseNavigationState(
        JSON.stringify({
          selection: { section: 'automations', module: 'plan-reminders' },
          moduleMemory: {
            extensions: 'skills',
            automations: 'plan-reminders',
          },
        }),
      ),
      {
        selection: { section: 'automations', module: 'scheduled-tasks' },
        moduleMemory: {
          extensions: 'skills',
          automations: 'scheduled-tasks',
        },
      },
    );
  });

  it('ignores pre-hub selections from versions outside the support window', () => {
    const legacySelections = [
      { section: 'skills' },
      { section: 'mcp' },
      { section: 'daily-review' },
      { section: 'automations' },
    ];

    for (const selection of legacySelections) {
      assert.deepEqual(parseNavigationState(JSON.stringify(selection)), {
        selection: { section: 'sessions' },
        moduleMemory: {
          extensions: 'skills',
          automations: 'scheduled-tasks',
        },
      });
    }
  });
});
