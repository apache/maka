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
import type { UsageStats } from '@maka/core/settings';
import { EMPTY_USAGE_PROVENANCE } from '@maka/core/usage-ledger-merge';
import {
  projectDesktopSessionEvent,
  projectDesktopSessionSummary,
  projectDesktopStoredMessage,
  projectDesktopTurnRecord,
  projectDesktopUsageStats,
} from '../../shared/desktop-session-projection.js';
import { runtimeHostChangeRetiresSession } from '../../shared/runtime-host-identity.js';

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

test('retires an active Session only after it leaves the refreshed Host catalog', () => {
  const owner = projectDesktopSessionSummary(
    {
      hostId: 'shared-root',
      profileId: 'owner',
      profileName: 'Owner',
      profileKind: 'remote',
    },
    summary('shared-session'),
  );
  const guest = projectDesktopSessionSummary(
    {
      hostId: 'shared-root',
      profileId: 'guest',
      profileName: 'Guest',
      profileKind: 'remote',
    },
    summary('shared-session'),
  );
  const removedGuest = {
    epoch: 'guest-epoch',
    profileId: 'guest',
    profileName: 'Guest',
    profileKind: 'remote',
    profileAccess: 'session_guest',
    readiness: 'unavailable',
    hostId: 'shared-root',
    isDefault: false,
    removed: true,
  } as const;

  assert.equal(runtimeHostChangeRetiresSession(removedGuest, guest.id, [owner]), false);
  assert.equal(runtimeHostChangeRetiresSession(removedGuest, guest.id, []), true);
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

test('projects queued Session attachments into the Desktop host namespace', () => {
  const host = { hostId: 'remote-root' };
  const projected = projectDesktopSessionEvent(host, {
    type: 'queue_update',
    id: 'event-queue',
    turnId: 'turn-1',
    ts: 3,
    queueRevision: 2,
    steering: [],
    followup: ['inspect this'],
    steeringEntries: [],
    followupEntries: [{
      entryId: 'entry-1',
      messageId: 'message-1',
      content: {
        text: 'inspect this',
        attachments: [{
          kind: 'other',
          name: 'notes.txt',
          mimeType: 'text/plain',
          bytes: 5,
          ref: {
            kind: 'session_file',
            sessionId: 'session-1',
            relativePath: 'artifact-1',
          },
        }],
      },
      placement: 'next_turn',
      state: 'queued',
    }],
  });

  assert.deepEqual(
    (projected as Extract<SessionEvent, { type: 'queue_update' }>).followupEntries?.[0]
      ?.content.attachments?.[0].ref,
    {
      kind: 'session_file',
      sessionId: JSON.stringify(['remote-root', 'session-1']),
      relativePath: 'artifact-1',
    },
  );
});

test('projects only present Usage Session ids into the Desktop host namespace', () => {
  const stats: UsageStats = {
    summary: {
      totalRequests: 2,
      totalCostUsd: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      cacheMiss: 0,
      cacheRead: 0,
      cacheCreation: 0,
      reasoning: 0,
    },
    logs: [
      {
        id: 'with-session',
        ts: 1,
        kind: 'model',
        sessionId: 'session-1',
        turnId: 'turn-1',
        provider: 'provider',
        model: 'model',
        inputTokens: 0,
        outputTokens: 0,
        status: 'success',
      },
      {
        id: 'without-session',
        ts: 2,
        kind: 'model',
        provider: 'provider',
        model: 'model',
        inputTokens: 0,
        outputTokens: 0,
        status: 'aborted',
      },
    ],
    byProvider: [],
    byModel: [],
    byTool: [],
    pricing: [],
    provenance: EMPTY_USAGE_PROVENANCE,
  };

  const projected = projectDesktopUsageStats({ hostId: 'remote-root' }, stats);

  assert.equal(projected.logs[0]?.sessionId, JSON.stringify(['remote-root', 'session-1']));
  assert.equal(projected.logs[1]?.sessionId, undefined);
});

test('projects durable WorkHub delegation targets into the Desktop host namespace', () => {
  const projected = projectDesktopStoredMessage(
    { hostId: 'remote-root' },
    {
      type: 'workhub_coordination',
      id: 'delegation-assignment-message',
      turnId: 'coordination-turn',
      ts: 2,
      schemaVersion: 1,
      kind: 'delegation_assigned',
      actionId: 'action-id',
      actionFingerprint: `sha256:${'a'.repeat(64)}`,
      coordinationTurnId: 'coordination-turn',
      targetSessionId: 'payments',
      disposition: 'delegate_existing',
      userText: 'Continue payment work',
      delegationId: 'delegation-id',
      targetTurnId: 'payments-turn',
      targetMessageId: 'payments-message',
      targetSessionName: 'Payments',
    },
  );

  assert.equal(projected.type, 'workhub_coordination');
  if (
    projected.type === 'workhub_coordination' &&
    projected.kind === 'delegation_assigned'
  ) {
    assert.equal(projected.targetSessionId, JSON.stringify(['remote-root', 'payments']));
  }
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
