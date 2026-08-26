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
 * #2578: the chat-defaults tool-mode preference resolves exactly once, here,
 * at the product boundary. What reaches the Runtime Host is an explicit
 * `ToolMode` or field omission — never `auto` — so an unset preference
 * produces turn payloads byte-identical to before the preference existed,
 * and a persisted AgentRun only ever carries a concrete mode.
 *
 * Like `create-session-input.ts`, these gates live as behavior in a pure
 * module rather than as regexes over an `ipcMain.handle` closure.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { resolveDefaultToolMode, resolveTurnToolMode } from '../turn-tool-mode.js';

describe('resolveTurnToolMode', () => {
  it('resolves explicit overrides to their concrete mode', () => {
    assert.equal(resolveTurnToolMode('direct'), 'direct');
    assert.equal(resolveTurnToolMode('code_mode'), 'code_mode');
  });

  it('resolves auto, absence, and garbage to omission — never a mode', () => {
    for (const value of ['auto', undefined, null, '', 'AUTO', 'claude_mode', 42, {}]) {
      assert.equal(resolveTurnToolMode(value), undefined);
    }
  });
});

describe('resolveDefaultToolMode', () => {
  it('reads the stored preference through the same single resolution point', async () => {
    assert.equal(
      await resolveDefaultToolMode(async () => ({
        chatDefaults: { permissionMode: 'ask', toolModePreference: 'code_mode' },
      })),
      'code_mode',
    );
    // A legacy policy omits the field entirely; that is `auto`, which omits.
    assert.equal(
      await resolveDefaultToolMode(async () => ({ chatDefaults: { permissionMode: 'ask' } })),
      undefined,
    );
  });

  it('falls back to no override when settings cannot be read', async () => {
    assert.equal(
      await resolveDefaultToolMode(async () => {
        throw new Error('Runtime Host unavailable');
      }),
      undefined,
    );
  });

  it('an unset preference yields exactly the pre-feature payload shape', async () => {
    const read = async () =>
      ({ chatDefaults: { permissionMode: 'ask' } }) as const;
    const resolved = await resolveDefaultToolMode(read);
    // The send handler spreads `...(resolved === undefined ? {} : { toolMode })`,
    // so undefined reproduces today's payload key-for-key; a concrete value is
    // the only thing that can add the field.
    const payload = resolved === undefined ? {} : { toolMode: resolved };
    assert.deepEqual(payload, {});
    assert.equal(Object.hasOwn(payload, 'toolMode'), false);
  });
});
