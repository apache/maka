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
import { describe, test } from 'node:test';
import { slashCommandsForSurface } from '@maka/core/slash-command-catalog';
import { getTuiPrimaryGuidance } from '../tui-primary-guidance.js';

describe('TUI primary guidance catalog', () => {
  test('both locales describe every TUI slash command', () => {
    const expected = slashCommandsForSurface('tui')
      .map((command) => command.id)
      .sort();

    for (const locale of ['zh', 'en'] as const) {
      assert.deepEqual(Object.keys(getTuiPrimaryGuidance(locale).commands).sort(), expected);
    }
  });

  test('keeps keybinding tokens identical across locales', () => {
    const tokens = (locale: 'zh' | 'en') =>
      getTuiPrimaryGuidance(locale).help.keybindings.flatMap((line) => {
        const match = /^\s*(.*?)\s*—/u.exec(line);
        return match ? [match[1]!.replace(/\s*[（(].*$/u, '')] : [];
      });

    assert.deepEqual(tokens('zh'), tokens('en'));
  });
});
