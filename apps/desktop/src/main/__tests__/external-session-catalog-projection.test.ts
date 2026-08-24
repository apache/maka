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
import type { SessionSummary } from '@maka/core/session';
import {
  projectDesktopExternalSessionCatalogItem,
} from '../../preload/external-session-catalog.js';
import { projectDesktopSessionSummary } from '../../shared/desktop-session-projection.js';
import { desktopSessionKey } from '../../shared/runtime-host-identity.js';

test('projects imported Session ids into the same Desktop identity space as Session summaries', () => {
  const host = { hostId: 'host-a' };
  const catalogItem = projectDesktopExternalSessionCatalogItem(host, {
    id: 'source-1',
    name: 'Source',
    cwd: '/external',
    importState: {
      importedCount: 1,
      importedSessionIds: ['imported-1'],
      isImporting: false,
    },
  });
  const summary = projectDesktopSessionSummary(
    {
      ...host,
      profileId: 'profile-a',
      profileName: 'Profile A',
      profileKind: 'remote',
    },
    session('imported-1'),
  );

  assert.deepEqual(catalogItem.importState.importedSessionIds, [
    desktopSessionKey({ hostId: host.hostId, sessionId: 'imported-1' }),
  ]);
  assert.equal(catalogItem.importState.importedSessionIds[0], summary.id);
});

function session(id: string): SessionSummary {
  return {
    id,
    name: 'Imported',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'gpt-5',
    permissionMode: 'ask',
  };
}
