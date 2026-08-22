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
 * #1433: `quickChat:start` was a second session-creation IPC whose only
 * distinct job was turning a product mode into session fields. The IPC is
 * gone; this is the part that survived, and the gates it used to carry are
 * pinned here as behavior rather than as regexes over the handler's source.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { AppSettings, ChatDefaultPermissionMode } from '@maka/core/settings';
import { DEEP_RESEARCH_SESSION_LABEL } from '@maka/core/explore-agent';

import { DEFAULT_SESSION_NAME } from '@maka/core/session-name';

import {
  type CreateSessionRequest,
  resolveCreateSessionInput,
  resolveCreateSessionRequest,
} from '../create-session-input.js';

function settings(permissionMode: ChatDefaultPermissionMode) {
  return async () => (({
    chatDefaults: { permissionMode },
  }) as AppSettings);
}

/** Anything the renderer can put on the wire, including what the type forbids:
 *  `sessions:create` is an IPC boundary, so the type is a hint, not a gate. */
function resolve(input: unknown, readSettings = settings('ask')) {
  return resolveCreateSessionInput(input as CreateSessionRequest | undefined, { readSettings });
}

describe('resolveCreateSessionInput', () => {
  it('leaves an ordinary default permission choice to the owning runtime', () => {
    assert.equal(resolveCreateSessionRequest(undefined).permissionMode, undefined);
    assert.equal(resolveCreateSessionRequest({ permissionMode: 'bypass' }).permissionMode, 'bypass');
    assert.deepEqual(resolveCreateSessionRequest({ mode: 'deep_research' }), {
      mode: 'deep_research',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      name: DEFAULT_SESSION_NAME,
      labels: undefined,
    });
  });

  it('forces the read-only boundary for Deep Research', async () => {
    const resolved = await resolve({ mode: 'deep_research' });
    assert.equal(resolved.permissionMode, 'explore');
    assert.equal(resolved.name, 'Deep Research');
    assert.deepEqual(resolved.labels, [DEEP_RESEARCH_SESSION_LABEL]);
  });

  /**
   * Deep Research is a read-only boundary, so it must outrank BOTH the
   * renderer's own request and the configured default — otherwise the mode is
   * a suggestion, and the session it names is not the session you get.
   */
  it("a mode's boundary outranks the renderer's request and the configured default", async () => {
    const resolved = await resolve(
      { mode: 'deep_research', permissionMode: 'bypass' },
      settings('ask'),
    );
    assert.equal(resolved.permissionMode, 'explore');
  });

  /**
   * `explore` is a boundary a mode confers, never one a caller may open a
   * session at — core names the pickable set `ChatDefaultPermissionMode`.
   * Without this refusal the seed is only a default: a renderer could ask for
   * `explore` outright and get it without the Deep Research label, tools or
   * system prompt that define the mode. `sessions:setPermissionMode` stays the
   * separate, deliberate path for moving an EXISTING session (the quote
   * companion relies on it), so the guard belongs on creation only.
   */
  it('refuses a directly-requested explore boundary', async () => {
    await assert.rejects(() => resolve({ permissionMode: 'explore' }), TypeError);
    await assert.rejects(() => resolve({ permissionMode: 'nonsense' }), TypeError);
  });

  it('rejects an invalid collaboration or orchestration mode', async () => {
    await assert.rejects(() => resolve({ collaborationMode: 'nonsense' }), TypeError);
    await assert.rejects(() => resolve({ orchestrationMode: 'nonsense' }), TypeError);
  });

  /**
   * The mode is a closed mapping, exercised with the raw values a renderer can
   * actually put on the wire. An unrecognized mode must confer no boundary, no
   * name and no label — it simply is not a mode.
   */
  it('cannot be reached by an unrecognized mode from the renderer', async () => {
    for (const mode of ['explore', 'deep-reseach', 'chat', 'admin', '', null, 42, {}]) {
      const resolved = await resolve({ mode }, settings('ask'));
      assert.equal(resolved.permissionMode, 'ask', `mode ${JSON.stringify(mode)} conferred a boundary`);
      assert.equal(resolved.name, DEFAULT_SESSION_NAME);
      assert.equal(resolved.labels, undefined);
    }
  });

  it('falls back to the configured default when neither a mode nor the caller says otherwise', async () => {
    assert.equal((await resolve(undefined, settings('ask'))).permissionMode, 'ask');
    assert.equal((await resolve({}, settings('bypass'))).permissionMode, 'bypass');
    assert.equal((await resolve({ permissionMode: 'ask' }, settings('bypass'))).permissionMode, 'ask');
  });

  /**
   * The pre-feature fallback was a synchronous `'ask'` literal that could
   * never fail. Reading the configured default must not change that: a
   * corrupted settings.json must not reject session creation.
   */
  it('never rejects when settings cannot be read', async () => {
    const resolved = await resolve({}, async () => {
      throw new Error('EACCES: settings.json');
    });
    assert.equal(resolved.permissionMode, 'ask');
  });

  /**
   * The one input no caller sends today: both a mode and a name. The mode wins,
   * matching what `quickChat:start` did (it never let the renderer name a Deep
   * Research session at all) and matching `permissionMode`, where the mode also
   * outranks the request. Pinned because the type accepts the combination, so
   * "whichever the expression happened to list first" is not an answer.
   */
  it('a mode names the session even when the caller also sent a name', async () => {
    const resolved = await resolve({ mode: 'deep_research', name: 'Release notes' });
    assert.equal(resolved.name, 'Deep Research');
  });

  it("adds the mode's label to the caller's rather than replacing them", async () => {
    const resolved = await resolve({
      mode: 'deep_research',
      labels: ['pinned', DEEP_RESEARCH_SESSION_LABEL],
    });
    assert.deepEqual(resolved.labels, ['pinned', DEEP_RESEARCH_SESSION_LABEL]);
  });

});
