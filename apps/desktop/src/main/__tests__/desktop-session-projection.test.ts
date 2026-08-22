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
import test from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import type { SessionSummary } from '@maka/core/session';
import {
  projectDesktopSessionEvent,
  projectDesktopSessionSummary,
  projectDesktopTurnRecord,
} from '../../shared/desktop-session-projection.js';

test('keeps equal raw Session ids distinct across Runtime Hosts', () => {
  const raw = summary('same-session');
  const local = projectDesktopSessionSummary(
    {
      hostId: 'local-root',
      profileId: 'local',
      profileName: 'Local',
      profileKind: 'local',
    },
    raw,
  );
  const remote = projectDesktopSessionSummary(
    {
      hostId: 'remote-root',
      profileId: 'office',
      profileName: 'Office',
      profileKind: 'remote',
    },
    raw,
  );

  assert.notEqual(local.id, remote.id);
  assert.equal(local.profileKind, 'local');
  assert.equal(remote.profileName, 'Office');
});

test('projects typed linked Session ids without rewriting opaque tool data', () => {
  const host = { hostId: 'remote-root' };
  const linkedSessionId = JSON.stringify(['remote-root', 'child-session']);
  const subagent = projectDesktopSessionEvent(host, {
    type: 'tool_result_preview',
    id: 'event-1',
    turnId: 'turn-1',
    ts: 1,
    toolUseId: 'tool-1',
    isError: false,
    content: {
      kind: 'subagent',
      childSessionId: 'child-session',
      agentName: 'Worker',
      turnId: 'child-turn',
      status: 'running',
      permissionMode: 'ask',
    },
  });
  const opaque = projectDesktopSessionEvent(host, {
    type: 'tool_result',
    id: 'event-2',
    turnId: 'turn-1',
    ts: 2,
    toolUseId: 'tool-2',
    isError: false,
    content: { kind: 'json', value: { childSessionId: 'opaque-value' } },
  });

  assert.equal(
    (subagent as Extract<SessionEvent, { type: 'tool_result_preview' }>).content.childSessionId,
    linkedSessionId,
  );
  assert.deepEqual(
    (opaque as Extract<SessionEvent, { type: 'tool_result' }>).content,
    { kind: 'json', value: { childSessionId: 'opaque-value' } },
  );
  assert.equal(
    projectDesktopTurnRecord(host, {
      turnId: 'turn-1',
      status: 'completed',
      parentSessionId: 'child-session',
      partialOutputRetained: false,
    }).parentSessionId,
    linkedSessionId,
  );
});

function summary(id: string): SessionSummary {
  return {
    id,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'model',
    permissionMode: 'ask',
  };
}
