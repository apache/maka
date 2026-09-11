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
import { it } from 'node:test';
import type { PtyShellOutput } from '../shell-run.js';
import { ptyHumanTerminalText, ptyTuiTerminalRows } from '../pty-output-view.js';

it('projects the same retained PTY text to human and TUI views when truncated', () => {
  const output: PtyShellOutput = {
    mode: 'pty',
    screen: 'ALL_TESTS_PASSED',
    scrollback: 'retained output',
    cols: 80,
    rows: 24,
    cursor: { x: 0, y: 0, visible: true },
    alternateScreen: false,
    truncated: true,
    redacted: false,
  };

  assert.equal(ptyHumanTerminalText(output), 'retained output\nALL_TESTS_PASSED');
  assert.deepEqual(ptyTuiTerminalRows(output), ['retained output', 'ALL_TESTS_PASSED']);
});
