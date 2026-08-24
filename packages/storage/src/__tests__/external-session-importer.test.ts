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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { SessionExternalOrigin, SessionHeader, StoredMessage } from '@maka/core/session';
import {
  ExternalSessionAdapterRegistry,
  type ExternalSessionAdapter,
} from '@maka/core/external-session';
import {
  ExternalSessionImporter,
  type ExternalSessionImportTarget,
} from '../external-session-importer.js';
import { createSessionStore } from '../session-store.js';

describe('ExternalSessionImporter', () => {
  test('forwards the exact external Session origin to imported persistence', async () => {
    const calls: SessionExternalOrigin[] = [];
    const adapter = fakeAdapter({
      metadata: { name: 'Imported parser work', cwd: '/external/repo' },
      messages: [],
    });
    const importer = new ExternalSessionImporter(new ExternalSessionAdapterRegistry([adapter]), {
      createImportedSession: async (_input, _messages, externalOrigin) => {
        calls.push(externalOrigin);
        return {} as SessionHeader;
      },
    });

    await importer.import({
      adapterId: 'fake',
      sourceSessionId: 'source-1',
      target: target(),
    });

    assert.deepEqual(calls, [{ adapterId: 'fake', sourceSessionId: 'source-1' }]);
  });

  test('persists adapter output as native Maka StoredMessages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-external-session-import-'));
    const sessions = createSessionStore(root);
    const messages: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 10, text: 'fix the parser' },
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'turn-1',
        ts: 20,
        text: 'done',
        modelId: 'external-model',
      },
    ];
    const adapter = fakeAdapter({
      metadata: { name: 'Imported parser work', cwd: '/external/repo' },
      messages,
    });
    const importer = new ExternalSessionImporter(
      new ExternalSessionAdapterRegistry([adapter]),
      sessions,
    );

    try {
      const header = await importer.import({
        adapterId: 'fake',
        sourceSessionId: 'source-1',
        target: target(),
      });

      assert.equal(header.name, 'Imported parser work');
      assert.equal(header.cwd, '/external/repo');
      assert.equal(header.model, 'maka-model');
      assert.equal(header.connectionLocked, true);
      assert.deepEqual(header.externalOrigin, {
        adapterId: 'fake',
        sourceSessionId: 'source-1',
      });
      assert.deepEqual(await sessions.readMessages(header.id), messages);

      await sessions.close?.();
      const reopened = createSessionStore(root);
      try {
        assert.deepEqual((await reopened.readHeaderSnapshot(header.id)).externalOrigin, {
          adapterId: 'fake',
          sourceSessionId: 'source-1',
        });
        assert.deepEqual(await reopened.readMessages(header.id), messages);
      } finally {
        await reopened.close?.();
      }
    } finally {
      await sessions.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('allows the Maka target to override imported name and cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-external-session-target-'));
    const sessions = createSessionStore(root);
    const importer = new ExternalSessionImporter(
      new ExternalSessionAdapterRegistry([
        fakeAdapter({ metadata: { name: 'Source name', cwd: '/source' }, messages: [] }),
      ]),
      sessions,
    );

    try {
      const header = await importer.import({
        adapterId: 'fake',
        sourceSessionId: 'source-1',
        target: target({ name: 'Maka name', cwd: '/target' }),
      });

      assert.equal(header.name, 'Maka name');
      assert.equal(header.cwd, '/target');
    } finally {
      await sessions.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects invalid adapter messages without exposing a partial Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-external-session-invalid-'));
    const sessions = createSessionStore(root);
    const adapter = fakeAdapter({
      metadata: { name: 'Invalid import', cwd: '/repo' },
      messages: [{ type: 'assistant' } as unknown as StoredMessage],
    });
    const importer = new ExternalSessionImporter(
      new ExternalSessionAdapterRegistry([adapter]),
      sessions,
    );

    try {
      await assert.rejects(
        importer.import({
          adapterId: 'fake',
          sourceSessionId: 'source-1',
          target: target(),
        }),
        /Invalid stored message schema/,
      );
      assert.deepEqual(await sessions.listHeaders(), []);
    } finally {
      await sessions.close?.();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function target(overrides: Partial<ExternalSessionImportTarget> = {}): ExternalSessionImportTarget {
  return {
    llmConnectionSlug: 'fake',
    model: 'maka-model',
    permissionMode: 'ask',
    ...overrides,
  };
}

function fakeAdapter(
  session: Pick<
    Awaited<ReturnType<ExternalSessionAdapter['readSession']>>,
    'metadata' | 'messages'
  >,
): ExternalSessionAdapter {
  return {
    id: 'fake',
    detect: async () => true,
    listSessions: async () => [],
    readSession: async (sourceSessionId) => ({ sourceSessionId, ...session }),
  };
}
