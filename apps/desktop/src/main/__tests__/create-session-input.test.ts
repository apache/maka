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
 *
 * What a product mode expands into — its boundary, name and labels — belongs
 * to the Runtime Host, which receives `mode` verbatim and owns the expansion.
 * This module only decides what reaches the wire, so that is all it pins.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEEP_RESEARCH_SESSION_LABEL } from '@maka/core/deep-research';

import { DEFAULT_SESSION_NAME } from '@maka/core/session-name';

import {
  type CreateSessionRequest,
  resolveCreateSessionRequest,
} from '../create-session-input.js';

/** Anything the renderer can put on the wire, including what the type forbids:
 *  `sessions:create` is an IPC boundary, so the type is a hint, not a gate. */
function resolve(input: unknown) {
  return resolveCreateSessionRequest(input as CreateSessionRequest | undefined);
}

describe('resolveCreateSessionRequest', () => {
  /**
   * An omitted mode must stay omitted all the way to the Host: the Host
   * resolves it from its own `chatDefaults`, and substituting a literal here
   * would make this module a second authority over the starting boundary.
   */
  it('leaves an omitted permission choice to the owning runtime', () => {
    assert.equal(resolve(undefined).permissionMode, undefined);
    assert.equal(resolve({}).permissionMode, undefined);
    assert.equal(resolve({ permissionMode: 'bypass' }).permissionMode, 'bypass');
    assert.equal(resolve({ permissionMode: 'ask' }).permissionMode, 'ask');
  });

  it('passes a product mode through verbatim for the Host to expand', () => {
    assert.deepEqual(resolve({ mode: 'deep_research' }), {
      mode: 'deep_research',
      collaborationMode: 'agent',
      orchestrationMode: 'default',
      name: DEFAULT_SESSION_NAME,
      labels: undefined,
    });
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
  it('refuses a directly-requested explore boundary', () => {
    assert.throws(() => resolve({ permissionMode: 'explore' }), TypeError);
    assert.throws(() => resolve({ permissionMode: 'nonsense' }), TypeError);
  });

  it('rejects an invalid collaboration or orchestration mode', () => {
    assert.throws(() => resolve({ collaborationMode: 'nonsense' }), TypeError);
    assert.throws(() => resolve({ orchestrationMode: 'nonsense' }), TypeError);
  });

  /**
   * The mode is a closed set, exercised with the raw values a renderer can
   * actually put on the wire. An unrecognized mode must not reach the Host as
   * one — it simply is not a mode.
   */
  it('drops an unrecognized mode from the renderer', () => {
    for (const mode of ['explore', 'deep-reseach', 'chat', 'admin', '', null, 42, {}]) {
      const resolved = resolve({ mode });
      assert.equal(resolved.mode, undefined, `mode ${JSON.stringify(mode)} reached the wire`);
      assert.equal(resolved.name, DEFAULT_SESSION_NAME);
      assert.equal(resolved.labels, undefined);
    }
  });

  it("carries the caller's name and labels when no mode overrides them", () => {
    const resolved = resolve({ name: 'Release notes', labels: ['pinned', DEEP_RESEARCH_SESSION_LABEL] });
    assert.equal(resolved.name, 'Release notes');
    assert.deepEqual(resolved.labels, ['pinned', DEEP_RESEARCH_SESSION_LABEL]);
  });
});
