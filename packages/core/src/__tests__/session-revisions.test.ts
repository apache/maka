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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  collapseSessionRevisions,
  projectRevisionLinkedSessionTree,
  revisionFamilySessionIds,
} from '../session-revisions.js';
import type { SessionSummary } from '../session.js';

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: 'Conversation',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'fake',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'ask',
    ...overrides,
  };
}

describe('logical session revision projection', () => {
  it('keeps one committed version and an ordinary branch as separate conversations', () => {
    const root = summary('root', { lastMessageAt: 10 });
    const revision = summary('revision', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
      revisionIndex: 2,
      revisionState: 'committed',
      lastMessageAt: 20,
    });
    const branch = summary('branch', { parentSessionId: 'root', branchOfTurnId: 'turn-1' });
    assert.deepEqual(
      collapseSessionRevisions([revision, branch, root]).map((session) => session.id),
      ['revision', 'branch'],
    );
    assert.deepEqual(revisionFamilySessionIds([revision, branch, root], 'revision'), [
      'revision',
      'root',
    ]);
  });

  it('hides preparing versions unless they own the active draft', () => {
    const root = summary('root', { lastMessageAt: 10 });
    const preparing = summary('preparing', {
      revisionRootSessionId: 'root',
      revisionParentSessionId: 'root',
      revisionIndex: 2,
      revisionState: 'preparing',
    });
    assert.deepEqual(
      collapseSessionRevisions([preparing, root]).map((session) => session.id),
      ['root'],
    );
    assert.deepEqual(
      collapseSessionRevisions([preparing, root], 'preparing').map((session) => session.id),
      ['preparing'],
    );
  });

  it('keeps a child nested under the selected representative of its physical parent revision', () => {
    const root = summary('parent-v1', { lastMessageAt: 10 });
    const revision = summary('parent-v2', {
      revisionRootSessionId: root.id,
      revisionParentSessionId: root.id,
      revisionIndex: 2,
      revisionState: 'committed',
      lastMessageAt: 20,
    });
    const child = summary('child', {
      subagentParent: {
        kind: 'subagent',
        parentSessionId: root.id,
        spawnedBy: {
          parentRunId: 'parent-run',
          parentTurnId: 'parent-turn',
          toolCallId: 'tool-call',
        },
        lifecycle: 'foreground',
      },
    });

    const tree = projectRevisionLinkedSessionTree([root, child, revision]);

    assert.deepEqual(
      tree.roots.map((session) => session.id),
      [revision.id],
    );
    assert.deepEqual(
      tree.childrenByParentId.get(revision.id)?.map((session) => session.id),
      [child.id],
    );
  });
});
