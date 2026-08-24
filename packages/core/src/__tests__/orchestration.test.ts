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

import { resolveEffectiveOrchestration } from '../orchestration.js';

describe('orchestration contract', () => {
  test('a persisted swarm mode grants only the session-scoped swarm authorization', () => {
    assert.deepEqual(resolveEffectiveOrchestration('swarm', undefined), {
      mode: 'swarm',
      source: 'session',
      agentSwarmAuthorization: 'session_mode',
    });
  });

  test('graph mode preserves the graph identity without granting swarm authority', () => {
    assert.deepEqual(resolveEffectiveOrchestration('graph', undefined), {
      mode: 'graph',
      source: 'session',
      agentSwarmAuthorization: 'none',
    });
  });

  test('a trusted turn override wins without changing the persisted session mode', () => {
    assert.deepEqual(
      resolveEffectiveOrchestration('default', { mode: 'swarm', source: 'host_api' }),
      {
        mode: 'swarm',
        source: 'turn_override',
        agentSwarmAuthorization: 'turn_override',
      },
    );
    assert.deepEqual(
      resolveEffectiveOrchestration('swarm', { mode: 'default', source: 'slash_command' }),
      {
        mode: 'default',
        source: 'turn_override',
        agentSwarmAuthorization: 'none',
      },
    );
  });
});
