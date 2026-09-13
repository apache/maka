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
import { detectColorLevelFromEnv } from '../tui-ansi.js';

/** Node's answer on a Windows 10+ console: truecolor, whatever TERM says. */
const WINDOWS_CONSOLE_DEPTH = 24;
/** Node's answer for a 256-color xterm. */
const XTERM_256_DEPTH = 8;
/** Node's answer when it finds no evidence of color support. */
const NO_COLOR_DEPTH = 1;

describe('detectColorLevelFromEnv', () => {
  test('uses the terminal capability when TERM is unset — native Windows shells', () => {
    // PowerShell and cmd.exe set no TERM at all. Reading that as "colorless"
    // turns the whole TUI monochrome on a console that supports truecolor.
    assert.equal(detectColorLevelFromEnv({}, WINDOWS_CONSOLE_DEPTH), 3);
  });

  test('honours an explicit COLORTERM even when TERM is unset', () => {
    assert.equal(detectColorLevelFromEnv({ COLORTERM: 'truecolor' }, NO_COLOR_DEPTH), 3);
    assert.equal(detectColorLevelFromEnv({ COLORTERM: '24bit' }, NO_COLOR_DEPTH), 3);
  });

  test('NO_COLOR and TERM=dumb still win over any capability', () => {
    assert.equal(
      detectColorLevelFromEnv({ NO_COLOR: '1', TERM: 'xterm-256color' }, WINDOWS_CONSOLE_DEPTH),
      0,
    );
    assert.equal(detectColorLevelFromEnv({ TERM: 'dumb' }, WINDOWS_CONSOLE_DEPTH), 0);
    // The NO_COLOR spec: an empty value does NOT disable color.
    assert.equal(
      detectColorLevelFromEnv({ NO_COLOR: '', TERM: 'xterm-256color' }, XTERM_256_DEPTH),
      2,
    );
  });

  test('maps the reported depth onto the three color levels', () => {
    assert.equal(detectColorLevelFromEnv({ TERM: 'xterm-256color' }, XTERM_256_DEPTH), 2);
    assert.equal(detectColorLevelFromEnv({ TERM: 'xterm' }, 4), 1);
    assert.equal(detectColorLevelFromEnv({ TERM: 'xterm' }, NO_COLOR_DEPTH), 0);
  });

  test('falls back to the TERM ladder when there is no terminal to ask', () => {
    // Piped output has no tty.WriteStream, so no depth is available. The
    // pre-existing env ladder still answers, unchanged.
    assert.equal(detectColorLevelFromEnv({ TERM: 'xterm-256color' }, undefined), 2);
    assert.equal(detectColorLevelFromEnv({ TERM: 'xterm' }, undefined), 1);
    assert.equal(detectColorLevelFromEnv({ TERM: 'xterm-truecolor' }, undefined), 3);
    assert.equal(detectColorLevelFromEnv({}, undefined), 0);
  });
});
