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
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
import { createSessionStore, type SessionAuthorityStore } from '../session-store.js';
import { createSqliteArtifactStoreWriteAuthority } from '../artifact-store.js';
import { createAttachmentByteReader } from '../artifact-attachments.js';
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';

describe('ExternalSessionImporter', () => {
  test('persists explicit images in the destination Session and survives source removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-import-images-'));
    const source = join(root, 'original.png');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      'base64',
    );
    await writeFile(source, png);
    const sessions = createSessionStore(root);
    const authority = createSqliteArtifactStoreWriteAuthority(root);
    try {
      const adapter = fakeAdapter({
        metadata: { name: 'Images', cwd: root },
        messages: [
          {
            type: 'user',
            id: 'user-1',
            turnId: 'turn-1',
            ts: 1,
            text: `Compare this image; ordinary path: ${join(root, 'not-an-attachment.png')}`,
          },
        ],
        sourceImages: [{ messageId: 'user-1', path: source }],
      });
      const importer = new ExternalSessionImporter(
        new ExternalSessionAdapterRegistry([adapter]),
        sessions,
        authority.store,
      );
      const header = await importer.import({
        adapterId: 'fake',
        sourceSessionId: 'source-1',
        target: target(),
      });
      await rm(source);
      const messages = await sessions.readMessages(header.id);
      const user = messages[0];
      assert.equal(user?.type, 'user');
      if (user?.type !== 'user') throw new Error('Missing user');
      assert.equal(
        user.text,
        `Compare this image; ordinary path: ${join(root, 'not-an-attachment.png')}`,
      );
      assert.equal(user.attachments?.length, 1);
      const attachment = user.attachments![0]!;
      assert.equal(attachment.ref.kind, 'session_file');
      assert.equal(attachment.bytes, png.byteLength);
      assert.deepEqual(
        await createAttachmentByteReader({ artifactStore: authority.store, sessionId: header.id })(
          attachment.ref,
        ),
        { ok: true, bytes: png },
      );
      assert.deepEqual(
        await createAttachmentByteReader({
          artifactStore: authority.store,
          sessionId: 'different-session',
        })(attachment.ref),
        { ok: false, reason: 'session_mismatch' },
      );
      assert.equal(JSON.stringify(messages).includes(source), false);
    } finally {
      await sessions.close?.();
      authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('bounds attempts even for missing images and reports unavailable originals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-import-missing-images-'));
    const invalid = join(root, 'invalid.png');
    const large = join(root, 'large.png');
    await writeFile(invalid, 'not an image');
    const beyondAttemptLimit = join(root, 'ninth.png');
    await writeFile(
      beyondAttemptLimit,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const { open } = await import('node:fs/promises');
    const handle = await open(large, 'w');
    await handle.truncate(MAX_ATTACHMENT_BYTES + 1);
    await handle.close();
    const sessions = createSessionStore(root);
    const authority = createSqliteArtifactStoreWriteAuthority(root);
    try {
      const adapter = fakeAdapter({
        metadata: { name: 'Missing images', cwd: root },
        messages: [message()],
        sourceImages: [
          join(root, 'missing.png'),
          invalid,
          large,
          ...Array.from({ length: 5 }, (_, index) => join(root, `missing-${index}.png`)),
          beyondAttemptLimit,
        ].map((path) => ({
          messageId: 'user-1',
          path,
        })),
      });
      const header = await new ExternalSessionImporter(
        new ExternalSessionAdapterRegistry([adapter]),
        sessions,
        authority.store,
      ).import({ adapterId: 'fake', sourceSessionId: 'source-1', target: target() });
      const user = (await sessions.readMessages(header.id))[0];
      assert.equal(user?.type, 'user');
      if (user?.type !== 'user') throw new Error('Missing user');
      assert.match(user.text, /^hello/);
      assert.match(user.text, /9 imported image attachment\(s\) unavailable/);
      assert.equal(user.attachments, undefined);
      assert.equal((await authority.store.listPage(header.id, { offset: 0, limit: 10 })).total, 0);
    } finally {
      await sessions.close?.();
      authority.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('forwards the exact external Session origin to imported persistence', async () => {
    const calls: SessionExternalOrigin[] = [];
    const adapter = fakeAdapter({
      metadata: { name: 'Imported parser work', cwd: '/external/repo' },
      messages: [message()],
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
      {
        type: 'user',
        id: 'user-1',
        turnId: 'turn-1',
        ts: 10,
        text: 'fix the parser',
        displayText: 'Fix the parser (display)',
      },
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
        fakeAdapter({ metadata: { name: 'Source name', cwd: '/source' }, messages: [message()] }),
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

  for (const [label, directory] of [
    ['decomposed Unicode', 'cafe\u0301'],
    ['a zero-width joiner', 'a\u200Db'],
  ]) {
    test(`preserves a target cwd containing ${label} after reopening storage`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-external-session-target-unicode-'));
      const storageRoot = join(root, 'storage');
      const sessions = createSessionStore(storageRoot);
      const importer = new ExternalSessionImporter(
        new ExternalSessionAdapterRegistry([
          fakeAdapter({ metadata: { name: 'Source name', cwd: '/source' }, messages: [message()] }),
        ]),
        sessions,
      );

      try {
        const workspace = join(root, directory);
        await mkdir(workspace);
        const cwd = await realpath(workspace);
        const header = await importer.import({
          adapterId: 'fake',
          sourceSessionId: 'source-1',
          target: target({ cwd }),
        });

        assert.equal(header.cwd, cwd);
        await sessions.close?.();
        const reopened = createSessionStore(storageRoot);
        try {
          const persisted = await reopened.readHeaderSnapshot(header.id);
          assert.equal(persisted.cwd, cwd);
          assert.ok((await stat(persisted.cwd)).isDirectory());
          assert.deepEqual(await reopened.readMessages(header.id), [message()]);
        } finally {
          await reopened.close?.();
        }
      } finally {
        await sessions.close?.();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test('canonicalizes adapter metadata before entering persistence', async () => {
    let persistedInput: Parameters<SessionAuthorityStore['createImportedSession']>[0] | undefined;
    const importer = new ExternalSessionImporter(
      new ExternalSessionAdapterRegistry([
        fakeAdapter({
          metadata: {
            name: '  token sk-live-abcdefghijklmnop\nwork  ',
            cwd: `/repo\u0000/cafe\u0301\u200D/${'界'.repeat(5_000)}`,
          },
          messages: [message()],
        }),
      ]),
      {
        createImportedSession: async (input) => {
          persistedInput = input;
          return {} as SessionHeader;
        },
      },
    );

    await importer.import({ adapterId: 'fake', sourceSessionId: 'source-1', target: target() });

    assert.ok(persistedInput);
    assert.doesNotMatch(persistedInput.name ?? '', /sk-live-/);
    assert.doesNotMatch(persistedInput.cwd, /\u0000/);
    assert.ok(persistedInput.cwd.startsWith('/repo/caf\u00e9/'));
    assert.ok(Buffer.byteLength(persistedInput.cwd, 'utf8') <= 4 * 1024);
  });

  test('rejects invalid message timestamps before entering persistence', async () => {
    let creates = 0;
    const importer = new ExternalSessionImporter(
      new ExternalSessionAdapterRegistry([
        fakeAdapter({
          metadata: { name: 'Invalid time', cwd: '/repo' },
          messages: [{ ...message(), ts: -1 }],
        }),
      ]),
      {
        createImportedSession: async () => {
          creates += 1;
          return {} as SessionHeader;
        },
      },
    );

    await assert.rejects(
      importer.import({ adapterId: 'fake', sourceSessionId: 'source-1', target: target() }),
      /invalid message timestamp/,
    );
    assert.equal(creates, 0);
  });

  test('rejects rows that hold no conversation the Ledger would keep', async () => {
    // The rows are individually valid and the array is not empty, but an
    // imported transcript materializes as `conversation_text` — the user's
    // words and the model's — so this converts to a Session with no history at
    // all. It has to be refused before anything is persisted, not published.
    let creates = 0;
    const importer = new ExternalSessionImporter(
      new ExternalSessionAdapterRegistry([
        fakeAdapter({
          metadata: { name: 'Tool noise', cwd: '/source' },
          messages: [
            {
              type: 'assistant',
              id: 'assistant-thought',
              turnId: 'turn-1',
              ts: 1,
              text: '',
              thinking: { text: 'weighing options' },
              modelId: 'external-model',
            },
            {
              type: 'tool_call',
              id: 'call-1',
              turnId: 'turn-1',
              ts: 2,
              toolName: 'read',
              args: { path: '/repo/a.ts' },
            },
            {
              type: 'tool_result',
              id: 'result-1',
              turnId: 'turn-1',
              ts: 3,
              toolUseId: 'call-1',
              content: { kind: 'text', text: 'contents' },
              isError: false,
            },
            {
              type: 'system_note',
              id: 'note-1',
              turnId: 'turn-1',
              ts: 4,
              kind: 'context_compacted',
              data: { text: 'compacted' },
            },
            { type: 'turn_state', id: 'state-1', turnId: 'turn-1', ts: 5, status: 'completed' },
          ],
        }),
      ]),
      {
        createImportedSession: async () => {
          creates += 1;
          return {} as SessionHeader;
        },
      },
    );

    await assert.rejects(
      importer.import({ adapterId: 'fake', sourceSessionId: 'source-1', target: target() }),
      /no importable conversation/,
    );
    assert.equal(creates, 0);
  });

  test('rejects invalid adapter messages without exposing a partial Session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-external-session-invalid-'));
    const sessions = createSessionStore(root);
    // A user row is conversation by type, so it passes the import projection and
    // the persistence decoder is what has to refuse it — which is the case a
    // malformed row that claims to be a user turn would otherwise reach.
    const adapter = fakeAdapter({
      metadata: { name: 'Invalid import', cwd: '/repo' },
      messages: [{ type: 'user' } as unknown as StoredMessage],
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

function message(): StoredMessage {
  return { type: 'user', id: 'user-1', turnId: 'turn-1', ts: 1, text: 'hello' };
}

function fakeAdapter(
  session: Pick<
    Awaited<ReturnType<ExternalSessionAdapter['readSession']>>,
    'metadata' | 'messages' | 'sourceImages'
  >,
): ExternalSessionAdapter {
  return {
    id: 'fake',
    detect: async () => true,
    listSessionPage: async () => ({ items: [], hasMore: false }),
    readSession: async (sourceSessionId) => ({ sourceSessionId, ...session }),
  };
}
