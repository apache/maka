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
import { test } from 'node:test';
import { projectSessionCatalogSummary } from '../client/session-catalog-summary.js';
import type { SessionCatalogProjection } from '../protocol/index.js';

function projection(overrides: Partial<SessionCatalogProjection> = {}): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    workspace: { target: { kind: 'host_path', path: '/workspace' }, hostCwd: '/workspace' },
    createdAt: 1,
    activityAt: 2,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

// Every Desktop and CLI session row comes through this projection, so the
// archive time reaches the archived-tasks page only if it is carried here.
test('carries the archive time of an archived Session into its summary', () => {
  const summary = projectSessionCatalogSummary(
    projection({ isArchived: true, archivedAt: 1_700_000_000_000 }),
  );
  assert.equal(summary.isArchived, true);
  assert.equal(summary.archivedAt, 1_700_000_000_000);
});

test('adds no archive time key when the Host reports none', () => {
  const summary = projectSessionCatalogSummary(projection({ isArchived: true }));
  assert.equal(summary.isArchived, true);
  assert.equal(Object.hasOwn(summary, 'archivedAt'), false);
});
