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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  type SessionHeader,
  type SessionSummary,
  sessionRevisionFamilyId,
} from '@maka/core/session';
import { createSqliteSessionMetadataStore } from '@maka/storage/sqlite-session-metadata-store';
import { archivedTaskRows } from '../../renderer/features/session-navigation/testing.js';

/**
 * Retention may delete only what Settings › Archived tasks shows. Both read
 * one catalog: the page through the rail's projection of catalog rows, the
 * Host through its candidate query. Agent Graph operators, which retire only
 * with their root, are the one deliberate difference, and none is an
 * archived-task row here because each has a live root.
 */
test('the retention candidates are exactly the families Archived tasks lists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-retention-rows-'));
  const path = join(root, 'state.sqlite');
  const store = createSqliteSessionMetadataStore(path, { now: () => 10 });
  try {
    const create = (overrides: Partial<SessionHeader>) => store.create(header(overrides));
    await create({ id: 'root', isArchived: true });
    await create({ ...revisionOf('root'), id: 'root-revision', isArchived: true });
    await create({ id: 'active' });
    await create({ id: 'archived-parent', isArchived: true });
    await create({ id: 'child-of-archived', isArchived: true, subagentParent: parent('archived-parent') });
    await create({ id: 'child-of-active', isArchived: true, subagentParent: parent('active') });
    await create({ id: 'orphan', isArchived: true, subagentParent: parent('gone') });
    await create({
      id: 'operator',
      isArchived: true,
      subagentParent: { ...parent('root'), graph: { graphId: 'g', workId: 'w', operatorId: 'o' } },
    });
    await create({ id: 'preparing', isArchived: true });
    await create({ id: 'unprojected', isArchived: true });
    // A subtask whose only parent is a row the catalog does not list is an orphan on the page.
    await create({ id: 'hidden-parent', isArchived: true });
    await create({ id: 'child-of-hidden', isArchived: true, subagentParent: parent('hidden-parent') });
    const database = new DatabaseSync(path);
    try {
      database
        .prepare(
          `UPDATE session_metadata
           SET payload_json = json_set(payload_json, '$.conversationCopy', json(?))
           WHERE session_id IN ('preparing', 'hidden-parent')`,
        )
        .run(
          JSON.stringify({
            kind: 'branch',
            sourceSessionId: 'active',
            sourceTurnId: 'turn-1',
            requestFingerprint: `sha256:${'a'.repeat(64)}`,
            state: 'preparing',
          }),
        );
      database.prepare('DELETE FROM session_catalog_projection WHERE session_id = ?').run('unprojected');
    } finally {
      database.close();
    }

    const catalog = (await store.listCatalogPage({}, undefined, 128)).records.map(
      (record) => record.header as unknown as SessionSummary,
    );
    const pageFamilies = new Set(archivedTaskRows(catalog).map(sessionRevisionFamilyId));
    const candidateFamilies = new Set(
      (await store.listArchiveRetentionCandidates({ limit: 256 })).map((row) => {
        assert.ok(!('undecodable' in row));
        return sessionRevisionFamilyId(row.header);
      }),
    );
    assert.deepEqual([...candidateFamilies].sort(), [...pageFamilies].sort());
    assert.deepEqual([...pageFamilies].sort(), [
      'archived-parent',
      'child-of-hidden',
      'orphan',
      'root',
    ]);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

function parent(parentSessionId: string): NonNullable<SessionHeader['subagentParent']> {
  return {
    kind: 'subagent',
    parentSessionId,
    spawnedBy: { parentRunId: 'run', parentTurnId: 'turn', toolCallId: 'call' },
    lifecycle: 'foreground',
  };
}

function revisionOf(rootId: string): Partial<SessionHeader> {
  return {
    revisionRootSessionId: rootId,
    revisionParentSessionId: rootId,
    revisionOfTurnId: 'turn-1',
    revisionIndex: 2,
    revisionState: 'committed',
  };
}

function header(overrides: Partial<SessionHeader>): SessionHeader {
  return {
    id: 'session',
    workspaceRoot: '/workspace',
    cwd: '/workspace/repo',
    createdAt: 1,
    lastMessageAt: 3,
    name: 'Session',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 4,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'openai',
    connectionLocked: true,
    model: 'gpt-5',
    toolProfile: 'headless-coding-v1',
    thinkingLevel: 'high',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'swarm',
    schemaVersion: 1,
    ...overrides,
  };
}
