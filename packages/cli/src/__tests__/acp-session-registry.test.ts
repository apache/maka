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
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import {
  RequestError,
  type NewSessionRequest,
  type SessionNotification,
  type SessionConfigOption,
  type SetSessionConfigOptionRequest,
} from '@agentclientprotocol/sdk';
import type { StoredMessage } from '@maka/core/session';
import { THINKING_LEVELS, type ThinkingLevel } from '@maka/core/model-thinking';
import {
  RuntimeHostOperationError,
  RuntimeHostRequestInterruptedError,
  RuntimeHostSubscriptionError,
  type RuntimeHostSessionSubscription,
  type DecodedSessionTranscriptPage,
} from '@maka/runtime-host/client';
import {
  SESSION_CATALOG_CWD_MAX_BYTES,
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type InteractionPendingSnapshot,
  type InteractionSnapshot,
  type SessionCatalogProjection,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
  type SessionTranscriptPage,
  type SessionTranscriptBootstrap,
  type SessionTranscriptPageInput,
} from '@maka/runtime-host/protocol';
import {
  AcpSessionRegistry,
  type AcpAttachedTurnStatus,
  type AcpSessionRegistryConnection,
} from '../acp/session-registry.js';

const SESSION_REVISION = `sha256:${'a'.repeat(64)}` as const;
const NEW_SESSION_REVISION = `sha256:${'b'.repeat(64)}` as const;
const TEST_CWD = await realpath(process.cwd());

const DEFAULT_CONFIG_OPTIONS: Array<Extract<SessionConfigOption, { type: 'select' }>> = [
  {
    type: 'select',
    id: 'permission_mode',
    name: 'Permission mode',
    category: '_maka/permission_mode',
    currentValue: 'ask',
    options: [
      { value: 'ask', name: 'Ask' },
      { value: 'bypass', name: 'Bypass' },
    ],
  },
  {
    type: 'select',
    id: 'thinking_level',
    name: 'Thinking level',
    category: 'thought_level',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'off', name: 'Off' },
      { value: 'minimal', name: 'Minimal' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Extra high' },
      { value: 'max', name: 'Max' },
    ],
  },
  {
    type: 'select',
    id: 'collaboration_mode',
    name: 'Collaboration mode',
    category: 'mode',
    currentValue: 'agent',
    options: [
      { value: 'agent', name: 'Agent' },
      { value: 'plan', name: 'Plan' },
    ],
  },
  {
    type: 'select',
    id: 'orchestration_mode',
    name: 'Orchestration mode',
    category: '_maka/orchestration_mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'swarm', name: 'Swarm' },
      { value: 'graph', name: 'Graph' },
    ],
  },
];

describe('ACP Session registry', () => {
  test('does not replay a dispatched Memory mutation after Host connection loss', async () => {
    let attempts = 0;
    let connects = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-memory',
      connect: async () => {
        connects += 1;
        return fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('session-memory');
            if (operation === 'memory.query') return { kind: 'blocked', reason: 'disabled' };
            if (operation === 'memory.mutate') {
              attempts += 1;
              throw new RuntimeHostRequestInterruptedError(
                'memory.mutate',
                'command',
                'dispatched',
                'connection_lost',
              );
            }
            throw new Error(`Unexpected ${operation}`);
          },
        });
      },
    });
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      await assert.rejects(
        registry.memoryMutate({
          kind: 'remember',
          expectedRevision: SESSION_REVISION,
          title: 'Memory',
          content: 'Do not replay',
          scope: { kind: 'session', sessionId: 'session-memory' },
        }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.deepEqual(error.data, {
            source: 'runtime_host',
            operation: 'memory.mutate',
            code: 'request_interrupted',
            reason: 'connection_lost',
            dispatch: 'dispatched',
          });
          return true;
        },
      );
      assert.equal(attempts, 1);
      assert.deepEqual(await registry.memoryQuery({ kind: 'state' }), {
        kind: 'blocked',
        reason: 'disabled',
      });
      assert.equal(connects, 1);
    } finally {
      await registry.dispose();
    }
  });

  test('close aborts a possibly opened Artifact after its dispatched response is lost', async () => {
    const requests: string[] = [];
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-lost-upload',
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-lost-upload');
            if (operation === 'artifact.ingest') {
              const upload = input as { kind: string; uploadId: string };
              requests.push(upload.kind);
              if (upload.kind === 'begin') {
                throw new RuntimeHostRequestInterruptedError(
                  'artifact.ingest',
                  'command',
                  'dispatched',
                  'connection_lost',
                );
              }
              return { kind: 'upload_aborted', uploadId: upload.uploadId };
            }
            throw new Error(`Unexpected ${operation}`);
          },
        }),
    });
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      await assert.rejects(
        registry.artifactIngest({
          kind: 'begin',
          sessionId: 'session-lost-upload',
          uploadId: 'lost-upload',
          name: 'x.bin',
          mimeType: 'application/octet-stream',
          totalBytes: 0,
          contentSha256: `sha256:${'0'.repeat(64)}`,
        }),
        (error: unknown) =>
          error instanceof RequestError &&
          (error.data as { dispatch?: string }).dispatch === 'dispatched',
      );
      await registry.close({ sessionId: 'session-lost-upload' });
      assert.deepEqual(requests, ['begin', 'abort']);
    } finally {
      await registry.dispose();
    }
  });

  test('Session close waits for a dispatched Artifact begin and aborts its staged upload', async () => {
    const opening = deferred<{ kind: 'upload_opened'; uploadId: string; nextOffset: number }>();
    const requests: string[] = [];
    let subscriptionOpens = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-artifact',
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-artifact');
            if (operation === 'artifact.ingest') {
              const upload = input as { kind: string; uploadId: string };
              requests.push(upload.kind);
              if (upload.kind === 'begin') return opening.promise;
              return { kind: 'upload_aborted', uploadId: upload.uploadId };
            }
            throw new Error(`Unexpected ${operation}`);
          },
          openSessionSubscription: async () => {
            subscriptionOpens += 1;
            throw new Error('Unexpected subscription');
          },
        }),
    });
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      const begin = registry.artifactIngest({
        kind: 'begin',
        sessionId: 'session-artifact',
        uploadId: 'upload-1',
        name: 'x.bin',
        mimeType: 'application/octet-stream',
        totalBytes: 1,
        contentSha256: `sha256:${'0'.repeat(64)}`,
      });
      await waitFor(() => requests.includes('begin'));
      const close = registry.close({ sessionId: 'session-artifact' });
      await assertInvalidParams(
        registry.artifactQuery({ kind: 'list_start', sessionId: 'session-artifact' }),
        { reason: 'unknown_session' },
      );
      assert.deepEqual(requests, ['begin']);
      opening.resolve({ kind: 'upload_opened', uploadId: 'upload-1', nextOffset: 0 });
      await begin;
      await close;
      assert.deepEqual(requests, ['begin', 'abort']);
      assert.equal(subscriptionOpens, 0);
    } finally {
      await registry.dispose();
    }
  });

  test('a conflicting replay does not hide an earlier open Artifact from Session close', async () => {
    const requests: string[] = [];
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-replayed-upload',
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-replayed-upload');
            if (operation !== 'artifact.ingest') throw new Error(`Unexpected ${operation}`);
            const upload = input as { kind: string; uploadId: string; name?: string };
            requests.push(`${upload.kind}:${upload.uploadId}`);
            if (upload.kind === 'begin' && upload.name === 'conflict.bin') {
              throw new RuntimeHostOperationError(
                'artifact.ingest',
                'operation_conflict',
                'Upload identity is already in use',
              );
            }
            if (upload.kind === 'begin') {
              return { kind: 'upload_opened', uploadId: upload.uploadId, nextOffset: 0 };
            }
            return { kind: 'upload_aborted', uploadId: upload.uploadId };
          },
        }),
    });
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      const original = {
        kind: 'begin' as const,
        sessionId: 'session-replayed-upload',
        uploadId: 'same-upload',
        name: 'original.bin',
        mimeType: 'application/octet-stream',
        totalBytes: 1,
        contentSha256: `sha256:${'0'.repeat(64)}` as const,
      };
      await registry.artifactIngest(original);
      await assert.rejects(registry.artifactIngest({ ...original, name: 'conflict.bin' }));
      await registry.close({ sessionId: original.sessionId });
      assert.deepEqual(requests, ['begin:same-upload', 'begin:same-upload', 'abort:same-upload']);
    } finally {
      await registry.dispose();
    }
  });

  test('a failed concurrent begin does not discard a successful begin with the same ID', async () => {
    const first = deferred<{ kind: 'upload_opened'; uploadId: string; nextOffset: number }>();
    const second = deferred<{ kind: 'upload_opened'; uploadId: string; nextOffset: number }>();
    let begins = 0;
    let aborts = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-overlapping-begins',
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-overlapping-begins');
            if (operation !== 'artifact.ingest') throw new Error(`Unexpected ${operation}`);
            const upload = input as { kind: string; uploadId: string };
            if (upload.kind === 'begin') return ++begins === 1 ? first.promise : second.promise;
            aborts += 1;
            return { kind: 'upload_aborted', uploadId: upload.uploadId };
          },
        }),
    });
    const input = {
      kind: 'begin' as const,
      sessionId: 'session-overlapping-begins',
      uploadId: 'same-upload',
      name: 'payload.bin',
      mimeType: 'application/octet-stream',
      totalBytes: 0,
      contentSha256: `sha256:${'0'.repeat(64)}` as const,
    };
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      const failed = registry.artifactIngest(input);
      const opened = registry.artifactIngest(input);
      await waitFor(() => begins === 2);
      second.resolve({ kind: 'upload_opened', uploadId: input.uploadId, nextOffset: 0 });
      await opened;
      first.reject(
        new RuntimeHostOperationError(
          'artifact.ingest',
          'operation_conflict',
          'Upload identity is already in use',
        ),
      );
      await assert.rejects(failed);
      await registry.close({ sessionId: input.sessionId });
      assert.equal(aborts, 1);
    } finally {
      await registry.dispose();
    }
  });

  test('failed Artifact commits do not exhaust an adapter-only upload limit', async () => {
    let begins = 0;
    let aborts = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-failed-commits',
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-failed-commits');
            if (operation !== 'artifact.ingest') throw new Error(`Unexpected ${operation}`);
            const upload = input as { kind: string; uploadId: string };
            if (upload.kind === 'begin') {
              begins += 1;
              return { kind: 'upload_opened', uploadId: upload.uploadId, nextOffset: 0 };
            }
            if (upload.kind === 'commit') {
              throw new RuntimeHostOperationError(
                'artifact.ingest',
                'operation_conflict',
                'Attachment content digest does not match',
              );
            }
            aborts += 1;
            return { kind: 'upload_aborted', uploadId: upload.uploadId };
          },
        }),
    });
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      for (let index = 0; index < 65; index += 1) {
        const uploadId = `failed-${index}`;
        await registry.artifactIngest({
          kind: 'begin',
          sessionId: 'session-failed-commits',
          uploadId,
          name: 'payload.bin',
          mimeType: 'application/octet-stream',
          totalBytes: 0,
          contentSha256: `sha256:${'0'.repeat(64)}`,
        });
        await assert.rejects(
          registry.artifactIngest({
            kind: 'commit',
            sessionId: 'session-failed-commits',
            uploadId,
          }),
        );
      }
      assert.equal(begins, 65);
      await registry.close({ sessionId: 'session-failed-commits' });
      assert.equal(aborts, 0);
    } finally {
      await registry.dispose();
    }
  });

  test('definitively rejected Artifact begins do not accumulate for Session close', async () => {
    let aborts = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-rejected-begins',
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-rejected-begins');
            if (operation !== 'artifact.ingest') throw new Error(`Unexpected ${operation}`);
            const upload = input as { kind: string; uploadId: string };
            if (upload.kind === 'begin') {
              throw new RuntimeHostOperationError(
                'artifact.ingest',
                'operation_conflict',
                'Attachment upload capacity is exhausted',
              );
            }
            aborts += 1;
            return { kind: 'upload_aborted', uploadId: upload.uploadId };
          },
        }),
    });
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      for (let index = 0; index < 65; index += 1) {
        await assert.rejects(
          registry.artifactIngest({
            kind: 'begin',
            sessionId: 'session-rejected-begins',
            uploadId: `rejected-${index}`,
            name: 'payload.bin',
            mimeType: 'application/octet-stream',
            totalBytes: 0,
            contentSha256: `sha256:${'0'.repeat(64)}`,
          }),
        );
      }
      await registry.close({ sessionId: 'session-rejected-begins' });
      assert.equal(aborts, 0);
    } finally {
      await registry.dispose();
    }
  });

  test('outcome-unknown Artifact begins remain bounded and are cleaned up on close', async () => {
    let dispatchedBegins = 0;
    let aborts = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-uncertain-begins',
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-uncertain-begins');
            if (operation !== 'artifact.ingest') throw new Error(`Unexpected ${operation}`);
            const upload = input as { kind: string; uploadId: string };
            if (upload.kind === 'begin') {
              dispatchedBegins += 1;
              throw new RuntimeHostRequestInterruptedError(
                'artifact.ingest',
                'command',
                'dispatched',
                'connection_lost',
              );
            }
            aborts += 1;
            return { kind: 'upload_aborted', uploadId: upload.uploadId };
          },
        }),
    });
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      for (let index = 0; index < 64; index += 1) {
        await assert.rejects(
          registry.artifactIngest({
            kind: 'begin',
            sessionId: 'session-uncertain-begins',
            uploadId: `uncertain-${index}`,
            name: 'payload.bin',
            mimeType: 'application/octet-stream',
            totalBytes: 0,
            contentSha256: `sha256:${'0'.repeat(64)}`,
          }),
        );
      }
      await assert.rejects(
        registry.artifactIngest({
          kind: 'begin',
          sessionId: 'session-uncertain-begins',
          uploadId: 'uncertain-64',
          name: 'payload.bin',
          mimeType: 'application/octet-stream',
          totalBytes: 0,
          contentSha256: `sha256:${'0'.repeat(64)}`,
        }),
        (error: unknown) =>
          error instanceof RequestError &&
          (error.data as { code?: string }).code === 'upload_tracking_capacity',
      );
      assert.equal(dispatchedBegins, 64);
      await registry.close({ sessionId: 'session-uncertain-begins' });
      assert.equal(aborts, 64);
    } finally {
      await registry.dispose();
    }
  });

  test('expired Artifact identities are aborted before the tracking limit rejects a new upload', async (t) => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    let begins = 0;
    let aborts = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-expired-uploads',
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-expired-uploads');
            if (operation !== 'artifact.ingest') throw new Error(`Unexpected ${operation}`);
            const upload = input as { kind: string; uploadId: string };
            if (upload.kind === 'begin') {
              begins += 1;
              return { kind: 'upload_opened', uploadId: upload.uploadId, nextOffset: 0 };
            }
            aborts += 1;
            return { kind: 'upload_aborted', uploadId: upload.uploadId };
          },
        }),
    });
    const begin = (uploadId: string) =>
      registry.artifactIngest({
        kind: 'begin',
        sessionId: 'session-expired-uploads',
        uploadId,
        name: 'payload.bin',
        mimeType: 'application/octet-stream',
        totalBytes: 0,
        contentSha256: `sha256:${'0'.repeat(64)}`,
      });
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      for (let index = 0; index < 64; index += 1) await begin(`expired-${index}`);
      assert.equal(aborts, 0);
      now += 5 * 60_000 + 30_001;
      await begin('fresh');
      assert.equal(begins, 65);
      assert.equal(aborts, 64);
      await registry.close({ sessionId: 'session-expired-uploads' });
      assert.equal(aborts, 65);
    } finally {
      await registry.dispose();
    }
  });

  for (const mode of [
    'same_host',
    'replaced_host',
    'failed_old_abort',
    'lost_new_begin',
  ] as const) {
    test(`expired-upload cleanup finishes before a concurrent begin reuses that identity (${mode})`, async (t) => {
      let now = Date.now();
      t.mock.method(Date, 'now', () => now);
      const oldAbort = deferred<void>();
      const requests: string[] = [];
      let firstOldAbort = true;
      let availability:
        | Parameters<
            NonNullable<AcpSessionRegistryConnection['subscribeConnectionAvailability']>
          >[0]
        | undefined;
      const registry = new AcpSessionRegistry({
        newSessionId: () => 'session-prune-race',
        connect: async () =>
          fakeConnection({
            subscribeConnectionAvailability: (listener) => {
              availability = listener;
              listener({ kind: 'connected', hostEpoch: 'host-1', connectionId: 'connection-1' });
              return () => undefined;
            },
            request: async (operation, input) => {
              if (operation === 'session.create') return catalogSession('session-prune-race');
              if (operation !== 'artifact.ingest') throw new Error(`Unexpected ${operation}`);
              const upload = input as { kind: string; uploadId: string };
              requests.push(`${upload.kind}:${upload.uploadId}`);
              if (upload.kind === 'abort' && upload.uploadId === 'expired-0' && firstOldAbort) {
                firstOldAbort = false;
                await oldAbort.promise;
              }
              if (
                upload.kind === 'begin' &&
                upload.uploadId === 'fresh' &&
                mode === 'lost_new_begin'
              ) {
                throw new RuntimeHostRequestInterruptedError(
                  'artifact.ingest',
                  'command',
                  'dispatched',
                  'connection_lost',
                );
              }
              return upload.kind === 'begin'
                ? { kind: 'upload_opened', uploadId: upload.uploadId, nextOffset: 0 }
                : { kind: 'upload_aborted', uploadId: upload.uploadId };
            },
          }),
      });
      const begin = (uploadId: string) =>
        registry.artifactIngest({
          kind: 'begin',
          sessionId: 'session-prune-race',
          uploadId,
          name: 'payload.bin',
          mimeType: 'application/octet-stream',
          totalBytes: 0,
          contentSha256: `sha256:${'0'.repeat(64)}`,
        });
      try {
        await registry.create({ cwd: '/workspace', mcpServers: [] });
        for (let index = 0; index < 64; index += 1) await begin(`expired-${index}`);
        now += 5 * 60_000 + 30_001;
        const fresh = begin('fresh');
        await waitFor(() => requests.includes('abort:expired-0'));
        if (mode !== 'same_host') {
          availability?.({ kind: 'unavailable' });
          availability?.({ kind: 'connected', hostEpoch: 'host-2', connectionId: 'connection-2' });
        }
        const replay = begin('expired-0');
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(requests.filter((request) => request === 'begin:expired-0').length, 1);
        if (mode === 'failed_old_abort') {
          oldAbort.reject(
            new RuntimeHostRequestInterruptedError(
              'artifact.ingest',
              'command',
              'not_dispatched',
              'connection_lost',
            ),
          );
        } else {
          oldAbort.resolve();
        }
        if (mode === 'lost_new_begin') {
          await assert.rejects(fresh);
          await replay;
        } else {
          await Promise.all([fresh, replay]);
        }
        assert.equal(requests.filter((request) => request === 'begin:expired-0').length, 2);
        await registry.close({ sessionId: 'session-prune-race' });
        assert.equal(requests.filter((request) => request === 'abort:expired-0').length, 2);
        if (mode === 'lost_new_begin') {
          assert.equal(requests.filter((request) => request === 'abort:fresh').length, 1);
        }
      } finally {
        oldAbort.resolve();
        await registry.dispose();
      }
    });
  }

  test('Host replacement releases upload identities from the previous connection', async () => {
    let availability:
      | ((
          value:
            | { kind: 'connected'; hostEpoch: string; connectionId: string }
            | { kind: 'unavailable' },
        ) => void)
      | undefined;
    let begins = 0;
    const aborts: string[] = [];
    const registry = new AcpSessionRegistry({
      newSessionId: () => 'session-replaced-host',
      connect: async () =>
        fakeConnection({
          subscribeConnectionAvailability: (listener) => {
            availability = listener;
            listener({ kind: 'connected', hostEpoch: 'host-1', connectionId: 'connection-1' });
            return () => undefined;
          },
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession('session-replaced-host');
            if (operation !== 'artifact.ingest') throw new Error(`Unexpected ${operation}`);
            const upload = input as { kind: string; uploadId: string };
            if (upload.kind === 'begin') {
              begins += 1;
              if (upload.uploadId !== 'fresh') {
                throw new RuntimeHostRequestInterruptedError(
                  'artifact.ingest',
                  'command',
                  'dispatched',
                  'connection_lost',
                );
              }
              return { kind: 'upload_opened', uploadId: upload.uploadId, nextOffset: 0 };
            }
            aborts.push(upload.uploadId);
            return { kind: 'upload_aborted', uploadId: upload.uploadId };
          },
        }),
    });
    const begin = (uploadId: string) =>
      registry.artifactIngest({
        kind: 'begin',
        sessionId: 'session-replaced-host',
        uploadId,
        name: 'payload.bin',
        mimeType: 'application/octet-stream',
        totalBytes: 0,
        contentSha256: `sha256:${'0'.repeat(64)}`,
      });
    try {
      await registry.create({ cwd: '/workspace', mcpServers: [] });
      for (let index = 0; index < 64; index += 1) {
        await assert.rejects(begin(`old-${index}`));
      }
      availability?.({ kind: 'unavailable' });
      availability?.({ kind: 'connected', hostEpoch: 'host-2', connectionId: 'connection-2' });
      await begin('fresh');
      assert.equal(begins, 65);
      await registry.close({ sessionId: 'session-replaced-host' });
      assert.deepEqual(aborts, ['fresh']);
    } finally {
      await registry.dispose();
    }
  });

  for (const method of ['load', 'resume'] as const) {
    test(`${method} failure before client replacement preserves a live prompt interaction`, async () => {
      const sessionId = `interaction-rollback-${method}`;
      const turnId = 'local-turn';
      const subscription = new FakeSubscription(continuitySnapshot(sessionId));
      const pending: InteractionPendingSnapshot = {
        schemaVersion: 1,
        interactionId: 'question',
        sessionId,
        turnId,
        runId: `run-${turnId}`,
        revision: 1,
        status: 'pending',
        outcome: null,
        request: {
          kind: 'question',
          toolUseId: 'tool',
          questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
        },
      };
      let started = false;
      let dialogs = 0;
      let stops = 0;
      const registry = new AcpSessionRegistry({
        newSessionId: () => sessionId,
        newTurnId: () => turnId,
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'session.catalog.query')
                return { kind: 'session', session: catalogSession(sessionId) };
              if (operation === 'turn.start') {
                started = true;
                const turn = runningTurn(sessionId, turnId);
                subscription.setRoot(turn);
                return {
                  kind: 'started',
                  turn,
                  skillInvocation: { loaded: [], failed: [], receipts: [] },
                };
              }
              if (operation === 'interaction.query') return pending;
              if (operation === 'turn.stop') {
                stops += 1;
                subscription.setRoot(completedTurn(sessionId, turnId));
                return {};
              }
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => subscription,
          }),
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const context = {
        ...promptContext([]),
        interactions: {
          capabilities: { elicitation: { form: {} } },
          createElicitation: async () => {
            dialogs += 1;
            return new Promise<never>(() => undefined);
          },
          requestPermission: async () => assert.fail('Unexpected permission'),
        },
      };
      const prompt = registry
        .prompt({ sessionId, prompt: [{ type: 'text', text: 'run' }] }, context)
        .catch(() => undefined);
      try {
        await waitFor(() => started);
        await assert.rejects(
          registry[method]({ sessionId, cwd: '/other', mcpServers: [] }, context),
        );
        subscription.project({ interactions: { pending: [pending] } });
        await waitFor(() => dialogs > 0 || stops > 0);
        assert.equal(dialogs, 1);
        assert.equal(stops, 0);
      } finally {
        await registry.cancel({ sessionId });
        await prompt;
        await registry.dispose();
      }
    });
  }

  for (const repeatRestore of [false, true]) {
    test(`retained restore preserves notification invocation order across a successor (repeat=${repeatRestore})`, async () => {
      const sessionId = `restore-order-${repeatRestore}`;
      const first = runningTurn(sessionId, 'first');
      const subscription = new FakeSubscription(continuitySnapshot(sessionId, { rootTurn: first }));
      const blocked = deferred<void>();
      const release = deferred<void>();
      const calls: string[] = [];
      let dialogs = 0;
      const successor = runningTurn(sessionId, 'second');
      const pending: InteractionPendingSnapshot = {
        schemaVersion: 1,
        interactionId: 'second-question',
        sessionId,
        turnId: successor.turnId,
        runId: successor.runId,
        revision: 1,
        status: 'pending',
        outcome: null,
        request: {
          kind: 'question',
          toolUseId: 'tool',
          questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
        },
      };
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.catalog.query')
                return { kind: 'session', session: catalogSession(sessionId) };
              if (operation === 'interaction.query') return pending;
              if (operation === 'turn.stop') return {};
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => subscription,
          }),
      });
      const context = {
        ...promptContext([]),
        interactions: {
          capabilities: { elicitation: { form: {} } },
          createElicitation: async () => {
            dialogs += 1;
            return new Promise<never>(() => undefined);
          },
          requestPermission: async () => assert.fail('Unexpected permission'),
        },
        notify: async ({ update }: SessionNotification) => {
          if (update.sessionUpdate !== 'agent_message_chunk' || update.content.type !== 'text')
            return;
          calls.push(update.content.text);
          if (update.content.text === 'A1') {
            blocked.resolve();
            await release.promise;
          }
        },
      };
      try {
        await registry.resume({ sessionId, cwd: TEST_CWD }, context);
        subscription.appendText(first.turnId, first.runId, 'A1');
        await blocked.promise;
        subscription.appendText(first.turnId, first.runId, 'A1A2', true);
        subscription.setRoot(completedTurn(sessionId, first.turnId));
        const reads = subscription.nextCalls;
        subscription.setRoot(successor);
        await waitFor(() => subscription.nextCalls > reads);
        if (repeatRestore) await registry.resume({ sessionId, cwd: TEST_CWD }, context);
        subscription.project({ interactions: { pending: [pending] } });
        subscription.appendText('second', 'run-second', 'B', true);
        await new Promise<void>((resolve) => setImmediate(resolve));
        release.resolve();
        await waitFor(() => calls.length === 3);
        assert.deepEqual(calls, ['A1', 'A2', 'B']);
        await waitFor(() => dialogs === 1);
      } finally {
        release.resolve();
        subscription.setRoot(null);
        await registry.dispose();
      }
    });
  }

  test('aborted history replay restores the interaction client it replaced', async () => {
    const sessionId = 'interaction-rollback-after-replacement';
    const turnId = 'local-turn';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    subscription.seedBootstrap([
      { type: 'user', id: 'history', turnId: 'old', ts: 1, text: 'old' },
    ]);
    let pageRead = false;
    const pageGate = deferred<void>();
    const abort = new AbortController();
    const pending: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'question',
      sessionId,
      turnId,
      runId: `run-${turnId}`,
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'question',
        toolUseId: 'tool',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    };
    let started = false;
    let oldDialogs = 0;
    let newDialogs = 0;
    let stops = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      newTurnId: () => turnId,
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'turn.start') {
              started = true;
              const turn = runningTurn(sessionId, turnId);
              subscription.setRoot(turn);
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            if (operation === 'interaction.query') return pending;
            if (operation === 'turn.stop') {
              stops += 1;
              subscription.setRoot(completedTurn(sessionId, turnId));
              return {};
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    const client = (onDialog: () => void) => ({
      capabilities: { elicitation: { form: {} } },
      createElicitation: async () => {
        onDialog();
        return new Promise<never>(() => undefined);
      },
      requestPermission: async () => assert.fail('Unexpected permission'),
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry
      .prompt(
        { sessionId, prompt: [{ type: 'text', text: 'run' }] },
        { ...promptContext([]), interactions: client(() => (oldDialogs += 1)) },
      )
      .catch(() => undefined);
    try {
      await waitFor(() => started);
      subscription.transcriptPageGate = pageGate.promise;
      subscription.onTranscriptPageRead = () => {
        pageRead = true;
      };
      const loading = registry.load(
        { sessionId, cwd: TEST_CWD, mcpServers: [] },
        {
          ...promptContext([]),
          signal: abort.signal,
          interactions: client(() => (newDialogs += 1)),
        },
      );
      await waitFor(() => pageRead);
      abort.abort();
      pageGate.resolve();
      await assert.rejects(loading);
      subscription.project({ interactions: { pending: [pending] } });
      await waitFor(() => oldDialogs + newDialogs + stops > 0);
      assert.deepEqual([oldDialogs, newDialogs, stops], [1, 0, 0]);
    } finally {
      pageGate.resolve();
      await registry.cancel({ sessionId });
      await prompt;
      await registry.dispose();
    }
  });

  test('a failed explicit resume cannot roll back a newer restore using the same context', async () => {
    const sessionId = 'resume-context-epoch';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const startEntered = deferred<void>();
    const start = deferred<never>();
    const oldNotifications: SessionNotification[] = [];
    const newNotifications: SessionNotification[] = [];
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      newTurnId: () => 'resumed-turn',
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'turn.resume.query')
              return {
                sessionId,
                disposition: 'ready',
                sourceRunId: 'source-run',
                sourceTurnId: 'source-turn',
                sourceRuntimeEventHighWater: 42,
              };
            if (operation === 'turn.resume.start') {
              startEntered.resolve();
              return start.promise;
            }
            if (operation === 'turn.stop') return {};
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    const newerContext = promptContext(newNotifications);
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    try {
      await registry.resume({ sessionId, cwd: TEST_CWD }, promptContext(oldNotifications));
      const resuming = registry.resumeTurn({ sessionId }, newerContext);
      void resuming.catch(() => undefined);
      await startEntered.promise;
      await registry.resume({ sessionId, cwd: TEST_CWD }, newerContext);
      start.reject(new Error('Resume start rejected'));
      await assert.rejects(resuming);
      const external = runningTurn(sessionId, 'external-turn');
      subscription.setRoot(external);
      subscription.appendText(external.turnId, external.runId, 'new client output', true);
      await waitFor(() =>
        newNotifications.some(
          ({ update }) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text === 'new client output',
        ),
      );
      assert.equal(oldNotifications.length, 0);
    } finally {
      start.reject(new Error('Resume start rejected'));
      subscription.setRoot(null);
      await registry.dispose();
    }
  });

  test('overlapping failed restores return to the original prompt client', async () => {
    const sessionId = 'nested-interaction-rollback';
    const turnId = 'local-turn';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    subscription.seedBootstrap([
      { type: 'user', id: 'history', turnId: 'old', ts: 1, text: 'old' },
    ]);
    let pageRead = false;
    const pageGate = deferred<void>();
    let startEntered = false;
    const start = deferred<never>();
    const abort = new AbortController();
    const dialogs: string[] = [];
    const pending: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'question',
      sessionId,
      turnId,
      runId: `run-${turnId}`,
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'question',
        toolUseId: 'tool',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    };
    let turnIds = 0;
    let started = false;
    let stops = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      newTurnId: () => (++turnIds === 1 ? turnId : 'resumed-turn'),
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'turn.start') {
              started = true;
              const turn = runningTurn(sessionId, turnId);
              subscription.setRoot(turn);
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            if (operation === 'turn.resume.query')
              return {
                sessionId,
                disposition: 'ready',
                sourceRunId: 'source-run',
                sourceTurnId: 'source-turn',
                sourceRuntimeEventHighWater: 42,
              };
            if (operation === 'turn.resume.start') {
              startEntered = true;
              return start.promise;
            }
            if (operation === 'interaction.query') return pending;
            if (operation === 'turn.stop') {
              stops += 1;
              subscription.setRoot(completedTurn(sessionId, turnId));
              return {};
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    const client = (name: string) => ({
      capabilities: { elicitation: { form: {} } },
      createElicitation: async () => {
        dialogs.push(name);
        return new Promise<never>(() => undefined);
      },
      requestPermission: async () => assert.fail('Unexpected permission'),
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry
      .prompt(
        { sessionId, prompt: [{ type: 'text', text: 'run' }] },
        { ...promptContext([]), interactions: client('prompt') },
      )
      .catch(() => undefined);
    try {
      await waitFor(() => started);
      subscription.transcriptPageGate = pageGate.promise;
      subscription.onTranscriptPageRead = () => {
        pageRead = true;
      };
      const loading = registry.load(
        { sessionId, cwd: TEST_CWD, mcpServers: [] },
        { ...promptContext([]), signal: abort.signal, interactions: client('load') },
      );
      void loading.catch(() => undefined);
      await waitFor(() => pageRead);
      const resuming = registry.resumeTurn(
        { sessionId },
        { ...promptContext([]), interactions: client('resumeTurn') },
      );
      void resuming.catch(() => undefined);
      await waitFor(() => startEntered);
      abort.abort();
      pageGate.resolve();
      await assert.rejects(loading);
      start.reject(new Error('Resume start rejected'));
      await assert.rejects(resuming);
      subscription.project({ interactions: { pending: [pending] } });
      await waitFor(() => dialogs.length > 0 || stops > 0);
      assert.deepEqual(dialogs, ['prompt']);
      assert.equal(stops, 0);
    } finally {
      pageGate.resolve();
      start.reject(new Error('Resume start rejected'));
      await registry.cancel({ sessionId });
      await prompt;
      await registry.dispose();
    }
  });

  for (const method of ['load', 'resume'] as const) {
    test(`${method} reuses an attachment and adopts a Turn started before restore`, async () => {
      const sessionId = `retained-${method}`;
      const turnId = 'external-turn';
      const subscription = new FakeSubscription(continuitySnapshot(sessionId));
      const notifications: SessionNotification[] = [];
      let opens = 0;
      let pendingPresented = 0;
      const external = runningTurn(sessionId, turnId);
      const pending: InteractionPendingSnapshot = {
        schemaVersion: 1,
        interactionId: 'external-question',
        sessionId,
        turnId,
        runId: external.runId,
        revision: 1,
        status: 'pending',
        outcome: null,
        request: {
          kind: 'question',
          toolUseId: 'tool',
          questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
        },
      };
      const registry = new AcpSessionRegistry({
        newSessionId: () => sessionId,
        newTurnId: () => 'local-turn',
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'session.catalog.query')
                return { kind: 'session', session: catalogSession(sessionId) };
              if (operation === 'interaction.query') return pending;
              if (operation === 'turn.start') {
                const local = runningTurn(sessionId, 'local-turn');
                subscription.setRoot(local);
                subscription.setRoot(completedTurn(sessionId, 'local-turn'));
                return {
                  kind: 'started',
                  turn: local,
                  skillInvocation: { loaded: [], failed: [], receipts: [] },
                };
              }
              if (operation === 'turn.stop') return {};
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => {
              opens += 1;
              return subscription;
            },
          }),
      });
      try {
        await registry.create({ cwd: TEST_CWD, mcpServers: [] });
        await registry.prompt(
          { sessionId, prompt: [{ type: 'text', text: 'first' }] },
          promptContext([]),
        );
        const before = subscription.nextCalls;
        subscription.setRoot(external);
        subscription.project({ interactions: { pending: [pending] } });
        await waitFor(() => subscription.nextCalls > before);
        const restoreContext = {
          ...promptContext(notifications),
          interactions: {
            capabilities: { elicitation: { form: {} } },
            createElicitation: async () => {
              pendingPresented += 1;
              return new Promise<never>(() => undefined);
            },
            requestPermission: async () => assert.fail('Unexpected permission'),
          },
        };
        await registry[method]({ sessionId, cwd: TEST_CWD, mcpServers: [] }, restoreContext);
        assert.equal(opens, 1);
        await waitFor(() => pendingPresented === 1);
        subscription.appendText(turnId, external.runId, 'external live output', true);
        await waitFor(() =>
          notifications.some(
            ({ update }) =>
              update.sessionUpdate === 'agent_message_chunk' &&
              update.content.type === 'text' &&
              update.content.text === 'external live output',
          ),
        );
        await registry.resume({ sessionId, cwd: TEST_CWD }, restoreContext);
        assert.equal(opens, 1);
        assert.equal(pendingPresented, 1);
      } finally {
        subscription.setRoot(null);
        await registry.dispose();
      }
    });
  }

  test('loads durable history, returns configuration, and retains attachment for prompt', async () => {
    const sessionId = 'session-loaded';
    const history: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'old-turn', ts: 1, text: 'earlier' },
      {
        type: 'assistant',
        id: 'assistant-1',
        turnId: 'old-turn',
        ts: 2,
        text: 'answer',
        modelId: 'default',
      },
      {
        type: 'tool_call',
        id: 'tool-1',
        turnId: 'old-turn',
        ts: 3,
        toolName: 'Read',
        args: { path: 'notes.txt' },
      },
      {
        type: 'tool_result',
        id: 'result-1',
        turnId: 'old-turn',
        ts: 4,
        toolUseId: 'tool-1',
        isError: false,
        content: { kind: 'text', text: 'historical tool result' },
      },
      { type: 'turn_state', id: 'state-1', turnId: 'old-turn', ts: 5, status: 'completed' },
    ];
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId),
      Promise.resolve(history),
    );
    subscription.seedBootstrap(history);
    const notifications: SessionNotification[] = [];
    let opens = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.catalog.query') {
              return { kind: 'session', session: catalogSession(sessionId) };
            }
            if (operation === 'turn.start') {
              const turnId = (input as { turnId: string }).turnId;
              const turn = runningTurn(sessionId, turnId);
              subscription.setRoot(turn);
              subscription.appendText(turnId, turn.runId, 'new answer', true);
              subscription.setRoot(completedTurn(sessionId, turnId));
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => {
            opens += 1;
            return subscription;
          },
        }),
      newTurnId: () => 'new-turn',
    });
    try {
      const loaded = await registry.load(
        { sessionId, cwd: TEST_CWD, mcpServers: [] },
        promptContext(notifications),
      );
      assert.deepEqual(loaded.configOptions, DEFAULT_CONFIG_OPTIONS);
      assert.deepEqual(
        notifications.flatMap(({ update }) =>
          (update.sessionUpdate === 'user_message_chunk' ||
            update.sessionUpdate === 'agent_message_chunk') &&
          update.content.type === 'text'
            ? [update.content.text]
            : [],
        ),
        ['earlier', 'answer'],
      );
      assert.ok(
        notifications.some(
          ({ update }) => update.sessionUpdate === 'tool_call' && update.toolCallId === 'tool-1',
        ),
      );
      assert.ok(
        notifications.some(
          ({ update }) =>
            update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'tool-1',
        ),
      );
      assert.deepEqual(
        await registry.prompt(
          { sessionId, prompt: [{ type: 'text', text: 'again' }] },
          promptContext(notifications),
        ),
        { stopReason: 'end_turn' },
      );
      const beforeSecondLoad = notifications.length;
      await registry.load(
        { sessionId, cwd: TEST_CWD, mcpServers: [] },
        promptContext(notifications),
      );
      assert.deepEqual(
        notifications
          .slice(beforeSecondLoad)
          .flatMap(({ update }) =>
            (update.sessionUpdate === 'user_message_chunk' ||
              update.sessionUpdate === 'agent_message_chunk') &&
            update.content.type === 'text'
              ? [update.content.text]
              : [],
          ),
        ['earlier', 'answer'],
      );
      const beforeResume = notifications.length;
      await registry.resume({ sessionId, cwd: TEST_CWD }, promptContext(notifications));
      await registry.resume({ sessionId, cwd: TEST_CWD }, promptContext(notifications));
      assert.equal(notifications.length, beforeResume);
      assert.equal(opens, 1);
      await registry.close({ sessionId });
      assert.equal(subscription.closeCalls, 1);
    } finally {
      await registry.dispose();
    }
  });

  test('close wins a held load catalog read without opening an attachment', async () => {
    const sessionId = 'session-held-load';
    const readStarted = deferred<void>();
    const catalog = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    let opens = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query') {
              readStarted.resolve();
              return catalog.promise;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => {
            opens += 1;
            throw new Error('Attachment must not open after close');
          },
        }),
    });
    try {
      const loading = registry.load(
        { sessionId, cwd: TEST_CWD, mcpServers: [] },
        promptContext([]),
      );
      await readStarted.promise;
      await registry.close({ sessionId });
      catalog.resolve({ kind: 'session', session: catalogSession(sessionId) });
      await assert.rejects(loading);
      assert.equal(opens, 0);
    } finally {
      catalog.resolve({ kind: 'session', session: catalogSession(sessionId) });
      await registry.dispose();
    }
  });

  test('load waits for an in-flight close before restoring the Session', async () => {
    const sessionId = 'session-close-then-load';
    const turnId = 'external-turn';
    const first = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: runningTurn(sessionId, turnId) }),
    );
    const second = new FakeSubscription(continuitySnapshot(sessionId));
    const stopStarted = deferred<void>();
    const stopRelease = deferred<void>();
    let catalogReads = 0;
    let opens = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query') {
              catalogReads += 1;
              return { kind: 'session', session: catalogSession(sessionId) };
            }
            if (operation === 'turn.stop') {
              stopStarted.resolve();
              await stopRelease.promise;
              first.setRoot(completedTurn(sessionId, turnId));
              return {};
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => (++opens === 1 ? first : second),
        }),
    });
    try {
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      await registry.resume({ sessionId, cwd: TEST_CWD }, promptContext([]));
      const closing = registry.close({ sessionId });
      await stopStarted.promise;
      const readsBeforeLoad = catalogReads;
      const loading = registry.load(
        { sessionId, cwd: TEST_CWD, mcpServers: [] },
        promptContext([]),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(catalogReads, readsBeforeLoad);
      stopRelease.resolve();
      await closing;
      await loading;
      assert.equal(opens, 2);
      assert.equal(second.closeCalls, 0);
    } finally {
      stopRelease.resolve();
      await registry.dispose();
    }
  });

  test('load scans every correlated transcript page in order', async () => {
    const sessionId = 'session-paged-load';
    const history: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId: 'old-turn', ts: 1, text: 'first' },
      { type: 'user', id: 'user-2', turnId: 'old-turn', ts: 2, text: 'second' },
      { type: 'user', id: 'user-3', turnId: 'old-turn', ts: 3, text: 'third' },
    ];
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId),
      Promise.resolve(history),
    );
    subscription.seedBootstrap(history);
    subscription.transcriptPageSize = 1;
    subscription.transcriptEmptyFirstPage = true;
    const notifications: SessionNotification[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.load(
        { sessionId, cwd: TEST_CWD, mcpServers: [] },
        promptContext(notifications),
      );
      assert.equal(subscription.transcriptPageReads, 4);
      assert.deepEqual(
        notifications.flatMap(({ update }) =>
          update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text'
            ? [update.content.text]
            : [],
        ),
        ['first', 'second', 'third'],
      );
    } finally {
      await registry.dispose();
    }
  });

  test('retry after a partial history delivery resumes without repeating accepted chunks', async () => {
    const sessionId = 'session-partial-history';
    const history: StoredMessage[] = [
      { type: 'user', id: 'first', turnId: 'old-turn', ts: 1, text: 'first' },
      { type: 'user', id: 'second', turnId: 'old-turn', ts: 2, text: 'second' },
    ];
    const subscriptions = [
      new FakeSubscription(continuitySnapshot(sessionId), Promise.resolve(history)),
      new FakeSubscription(continuitySnapshot(sessionId), Promise.resolve(history)),
    ];
    for (const subscription of subscriptions) subscription.seedBootstrap(history);
    const delivered: string[] = [];
    let failSecond = true;
    let opens = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscriptions[opens++]!,
        }),
    });
    const context = {
      ...promptContext([]),
      notify: async (notification: SessionNotification) => {
        const update = notification.update;
        if (update.sessionUpdate !== 'user_message_chunk' || update.content.type !== 'text') return;
        if (update.content.text === 'second' && failSecond) {
          failSecond = false;
          throw new Error('Client delivery interrupted');
        }
        delivered.push(update.content.text);
      },
    };
    try {
      await assert.rejects(registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, context));
      await registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, context);
      assert.deepEqual(delivered, ['first', 'second']);
      assert.equal(opens, 2);
    } finally {
      await registry.dispose();
    }
  });

  for (const firstChunkBeforeLoad of [false, true])
    test(`history replay omits live output when streaming starts ${firstChunkBeforeLoad ? 'before' : 'during'} load`, async () => {
      const sessionId = 'session-pre-gate-replay';
      const turn = runningTurn(sessionId, 'live-turn');
      const subscription = new FakeSubscription(continuitySnapshot(sessionId, { rootTurn: turn }));
      const catalogHeld = deferred<void>();
      const releaseCatalog = deferred<void>();
      const live: SessionNotification[] = [];
      const replay: SessionNotification[] = [];
      let catalogReads = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.catalog.query') {
                if (++catalogReads === 2) {
                  catalogHeld.resolve();
                  await releaseCatalog.promise;
                }
                return { kind: 'session', session: catalogSession(sessionId) };
              }
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => subscription,
          }),
      });
      try {
        await registry.resume({ sessionId, cwd: TEST_CWD }, promptContext(live));
        if (firstChunkBeforeLoad) {
          subscription.appendText(turn.turnId, turn.runId, 'hel');
          await waitFor(() =>
            live.some(
              ({ update }) =>
                update.sessionUpdate === 'agent_message_chunk' &&
                update.content.type === 'text' &&
                update.content.text === 'hel',
            ),
          );
        }
        const loading = registry.load(
          { sessionId, cwd: TEST_CWD, mcpServers: [] },
          promptContext(replay),
        );
        await catalogHeld.promise;
        if (!firstChunkBeforeLoad) subscription.appendText(turn.turnId, turn.runId, 'hel');
        await waitFor(() =>
          live.some(
            ({ update }) =>
              update.sessionUpdate === 'agent_message_chunk' &&
              update.content.type === 'text' &&
              update.content.text === 'hel',
          ),
        );
        subscription.publishTranscript([
          {
            type: 'assistant',
            id: `message-${turn.turnId}`,
            turnId: turn.turnId,
            ts: 2,
            text: 'hello',
            modelId: 'test-model',
          },
        ]);
        await waitFor(
          () =>
            live
              .flatMap(({ update }) =>
                update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
                  ? [update.content.text]
                  : [],
              )
              .join('') === 'hello',
        );
        releaseCatalog.resolve();
        await loading;
        assert.deepEqual(
          replay.filter(({ update }) => update.sessionUpdate === 'agent_message_chunk'),
          [],
        );
      } finally {
        releaseCatalog.resolve();
        subscription.setRoot(completedTurn(sessionId, turn.turnId));
        await registry.dispose();
      }
    });

  test('load replays a prefix that resume seeded without delivering', async () => {
    const sessionId = 'session-silent-resume-prefix';
    const turn = runningTurn(sessionId, 'live-turn');
    const initial: StoredMessage = {
      type: 'assistant',
      id: `message-${turn.turnId}`,
      turnId: turn.turnId,
      ts: 2,
      text: 'hel',
      modelId: 'test-model',
    };
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: turn }),
      Promise.resolve([initial]),
    );
    subscription.seedBootstrap([initial]);
    const live: SessionNotification[] = [];
    const replay: SessionNotification[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.resume({ sessionId, cwd: TEST_CWD }, promptContext(live));
      subscription.appendText(turn.turnId, turn.runId, 'hello');
      await waitFor(() =>
        live.some(
          ({ update }) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text === 'lo',
        ),
      );
      subscription.publishTranscript([{ ...initial, text: 'hello' }]);
      await registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, promptContext(replay));
      assert.deepEqual(
        replay.flatMap(({ update }) =>
          update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
            ? [update.content.text]
            : [],
        ),
        ['hello'],
      );
    } finally {
      subscription.setRoot(completedTurn(sessionId, turn.turnId));
      await registry.dispose();
    }
  });

  test('load rejects missing, archived, and mismatched Sessions before ownership or attachment', async () => {
    for (const scenario of ['missing', 'archived', 'cwd'] as const) {
      const sessionId = `session-invalid-${scenario}`;
      let opens = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.catalog.query')
                return scenario === 'missing'
                  ? { kind: 'session', session: null }
                  : {
                      kind: 'session',
                      session: catalogSession(sessionId, TEST_CWD, {
                        isArchived: scenario === 'archived',
                      }),
                    };
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => {
              opens += 1;
              throw new Error('Invalid Session must not attach');
            },
          }),
      });
      try {
        await assert.rejects(
          registry.load(
            {
              sessionId,
              cwd: scenario === 'cwd' ? '/other' : TEST_CWD,
              mcpServers: [],
            },
            promptContext([]),
          ),
        );
        await assert.rejects(
          registry.prompt(
            {
              sessionId,
              prompt: [{ type: 'text', text: 'must fail' }],
            },
            promptContext([]),
          ),
          (error: unknown) => error instanceof RequestError && error.code === -32602,
        );
        assert.equal(opens, 0);
      } finally {
        await registry.dispose();
      }
    }
  });

  test('resume attaches to an existing live Turn without replaying history or starting it', async () => {
    const sessionId = 'session-live-resume';
    const turnId = 'turn-existing';
    const turn = runningTurn(sessionId, turnId);
    const history: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId, ts: 1, text: 'earlier' },
      {
        type: 'assistant',
        id: `message-${turnId}`,
        turnId,
        ts: 2,
        text: 'partial',
        modelId: 'default',
      },
    ];
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: turn }),
      Promise.resolve(history),
    );
    subscription.seedBootstrap(history);
    const notifications: SessionNotification[] = [];
    const operations: string[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            operations.push(operation);
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      const result = await registry.resume(
        { sessionId, cwd: TEST_CWD },
        promptContext(notifications),
      );
      assert.deepEqual(result.configOptions, DEFAULT_CONFIG_OPTIONS);
      assert.equal(notifications.length, 0);
      subscription.appendText(turnId, turn.runId, 'partial done', true);
      await waitFor(() =>
        notifications.some(
          ({ update }) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text === ' done',
        ),
      );
      subscription.setRoot(completedTurn(sessionId, turnId));
      assert.deepEqual(operations, ['session.catalog.query']);
    } finally {
      await registry.dispose();
    }
  });

  for (const status of ['completed', 'failed', 'cancelled'] as const) {
    for (const nextTurn of ['none', 'running', 'completed'] as const) {
      test(`restore reports ${status} during readiness with next Turn ${nextTurn}`, {
        timeout: 10_000,
      }, async () => {
        const sessionId = 'initial-terminal';
        const turnId = 'initial-turn';
        const turn = runningTurn(sessionId, turnId);
        const subscription = new FakeSubscription(
          continuitySnapshot(sessionId, { rootTurn: turn }),
        );
        subscription.seedBootstrap([]);
        const ready = subscription.ready.bind(subscription);
        subscription.ready = async () => {
          await ready();
          subscription.appendText(turnId, turn.runId, 'final output', true);
          subscription.setRoot(
            status === 'completed'
              ? completedTurn(sessionId, turnId)
              : {
                  ...turn,
                  terminalEventId: 'terminal',
                  ...(status === 'failed'
                    ? { status: 'failed' as const, failureClass: 'provider_failure' }
                    : { status: 'cancelled' as const, abortSource: 'user' }),
                },
          );
          if (nextTurn !== 'none') {
            const next = runningTurn(sessionId, 'next-turn');
            subscription.setRoot(next);
            if (nextTurn === 'completed') {
              subscription.appendText(next.turnId, next.runId, 'next output', true);
              subscription.setRoot(completedTurn(sessionId, next.turnId));
            }
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        };
        const delivered: string[] = [];
        const terminal = deferred<void>();
        const registry = new AcpSessionRegistry({
          connect: async () =>
            fakeConnection({
              request: async (operation) => {
                if (operation === 'session.catalog.query')
                  return { kind: 'session', session: catalogSession(sessionId) };
                if (operation === 'turn.stop') return {};
                throw new Error(`Unexpected operation ${operation}`);
              },
              openSessionSubscriptionOnce: async () => subscription,
            }),
        });
        try {
          await registry.resume(
            { sessionId, cwd: TEST_CWD, mcpServers: [] },
            {
              signal: new AbortController().signal,
              notify: async ({ update }) => {
                if (
                  update.sessionUpdate === 'agent_message_chunk' &&
                  update.content.type === 'text'
                )
                  delivered.push(update.content.text);
              },
              notifyTurnStatus: async (value) => {
                if (value.turnId === 'next-turn') {
                  assert.deepEqual(value, {
                    sessionId,
                    turnId: 'next-turn',
                    runId: runningTurn(sessionId, 'next-turn').runId,
                    status: 'completed',
                  });
                  delivered.push('next completed');
                  terminal.resolve();
                  return;
                }
                assert.deepEqual(value, {
                  sessionId,
                  turnId,
                  runId: turn.runId,
                  status,
                  ...(status === 'failed' ? { failureClass: 'provider_failure' } : {}),
                });
                delivered.push(status);
                if (nextTurn !== 'completed') terminal.resolve();
              },
            },
          );
          await terminal.promise;
          assert.deepEqual(
            delivered.filter((item) => !item.startsWith('next ')),
            ['final output', status],
          );
          if (nextTurn === 'completed')
            assert.deepEqual(
              delivered.filter((item) => item.startsWith('next ')),
              ['next output', 'next completed'],
            );
        } finally {
          await registry.dispose();
        }
      });
    }
  }

  test('resume restores a pending interaction on the attached Turn', async () => {
    const sessionId = 'session-resumed-interaction';
    const turnId = 'turn-resumed-interaction';
    const turn = runningTurn(sessionId, turnId);
    const pending: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'question-resumed',
      sessionId,
      turnId,
      runId: turn.runId,
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'question',
        toolUseId: 'tool-resumed',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    };
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, {
        rootTurn: turn,
        interactions: { pending: [pending] },
      }),
    );
    const notifications: SessionNotification[] = [];
    let dialogs = 0;
    let answers = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'interaction.query') return pending;
            if (operation === 'interaction.answer') {
              answers += 1;
              return {
                ...pending,
                revision: 2,
                status: 'answered',
                outcome: {
                  kind: 'question_answer',
                  answers: ['Yes'],
                  committedAt: 1,
                },
              };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.resume(
        { sessionId, cwd: TEST_CWD },
        {
          ...promptContext(notifications),
          interactions: {
            capabilities: { elicitation: { form: {} } },
            createElicitation: async () => {
              dialogs += 1;
              return { action: 'accept' as const, content: { q0: 'Yes' } };
            },
            requestPermission: async () => assert.fail('Unexpected permission request'),
          },
        },
      );
      await waitFor(() => answers === 1);
      assert.equal(dialogs, 1);
      assert.ok(
        notifications.some(
          ({ update }) =>
            update.sessionUpdate === 'tool_call' && update.toolCallId === 'tool-resumed',
        ),
      );
    } finally {
      await registry.dispose();
    }
  });

  test('load finishes historical delivery before releasing an existing live Turn', async () => {
    const sessionId = 'session-live-load-order';
    const turnId = 'turn-live-load-order';
    const turn = runningTurn(sessionId, turnId);
    const history: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId, ts: 1, text: 'earlier' },
      {
        type: 'assistant',
        id: `message-${turnId}`,
        turnId,
        ts: 2,
        text: 'partial',
        modelId: 'default',
      },
    ];
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: turn }),
      Promise.resolve(history),
    );
    subscription.seedBootstrap(history);
    const delivered: string[] = [];
    const userSent = deferred<void>();
    const releaseUser = deferred<void>();
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      const loading = registry.load(
        { sessionId, cwd: TEST_CWD, mcpServers: [] },
        {
          signal: new AbortController().signal,
          notify: async ({ update }) => {
            if (
              (update.sessionUpdate === 'user_message_chunk' ||
                update.sessionUpdate === 'agent_message_chunk') &&
              update.content.type === 'text'
            ) {
              delivered.push(update.content.text);
              if (update.sessionUpdate === 'user_message_chunk') {
                userSent.resolve();
                await releaseUser.promise;
              }
            }
          },
        },
      );
      await userSent.promise;
      subscription.appendText(turnId, turn.runId, 'partial live', true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(delivered, ['earlier']);
      releaseUser.resolve();
      await loading;
      await waitFor(() => delivered.includes(' live'));
      assert.deepEqual(delivered, ['earlier', 'partial', ' live']);
    } finally {
      releaseUser.resolve();
      await registry.dispose();
    }
  });

  test('load does not redeliver a live chunk already included in historical replay', async () => {
    const sessionId = 'session-live-replay-overlap';
    const turnId = 'turn-live-replay-overlap';
    const turn = runningTurn(sessionId, turnId);
    const initial: StoredMessage[] = [
      { type: 'user', id: 'user-1', turnId, ts: 1, text: 'earlier' },
      {
        type: 'assistant',
        id: `message-${turnId}`,
        turnId,
        ts: 2,
        text: 'partial',
        modelId: 'default',
      },
    ];
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: turn }),
      Promise.resolve(initial),
    );
    subscription.seedBootstrap(initial);
    const pageGate = deferred<void>();
    const pageRead = deferred<void>();
    subscription.transcriptPageGate = pageGate.promise;
    subscription.onTranscriptPageRead = () => pageRead.resolve();
    const notifications: SessionNotification[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      const loading = registry.load(
        { sessionId, cwd: TEST_CWD, mcpServers: [] },
        promptContext(notifications),
      );
      await pageRead.promise;
      assert.equal(subscription.transcriptPageReads, 1);
      subscription.publishTranscript([
        initial[0],
        {
          type: 'assistant',
          id: `message-${turnId}`,
          turnId,
          ts: 2,
          text: 'partial live',
          modelId: 'default',
        },
      ]);
      subscription.appendText(turnId, turn.runId, 'partial live', true);
      pageGate.resolve();
      await loading;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(
        notifications.flatMap(({ update }) =>
          update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
            ? [update.content.text]
            : [],
        ),
        ['partial live'],
      );
    } finally {
      pageGate.resolve();
      await registry.dispose();
    }
  });

  test('failed historical hydration releases the newly opened attachment', async () => {
    const sessionId = 'session-load-page-failure';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    subscription.seedBootstrap([
      {
        type: 'user',
        id: 'user-before-failure',
        turnId: 'turn-before-failure',
        ts: 1,
        text: 'hello',
      },
    ]);
    subscription.onTranscriptPageRead = () => {
      throw new Error('transcript page unavailable');
    };
    const retrySubscription = new FakeSubscription(continuitySnapshot(sessionId));
    let opens = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () =>
            ++opens === 1 ? subscription : retrySubscription,
        }),
    });
    try {
      await assert.rejects(
        registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, promptContext([])),
        (error: unknown) => error instanceof RequestError,
      );
      assert.equal(subscription.closeCalls, 1);
      await registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, promptContext([]));
      assert.equal(opens, 2);
      assert.equal(retrySubscription.closeCalls, 0);
    } finally {
      await registry.dispose();
    }
  });

  test('failed load of an owned unattached Session releases only its new subscription', async () => {
    const sessionId = 'owned-load-failure';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    subscription.seedBootstrap([{ type: 'user', id: 'u', turnId: 't', ts: 1, text: 'hello' }]);
    subscription.onTranscriptPageRead = () => {
      throw new Error('transcript page unavailable');
    };
    const retrySubscription = new FakeSubscription(continuitySnapshot(sessionId));
    let opens = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () =>
            ++opens === 1 ? subscription : retrySubscription,
        }),
    });
    try {
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      await assert.rejects(
        registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, promptContext([])),
      );
      assert.equal(subscription.closeCalls, 1);
      await registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, promptContext([]));
      assert.equal(opens, 2);
      assert.equal(retrySubscription.closeCalls, 0);
    } finally {
      await registry.dispose();
    }
  });

  test('failed live history load releases its observer without stopping the existing Host Turn', async () => {
    const sessionId = 'live-load-failure';
    const turnId = 'existing-turn';
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: runningTurn(sessionId, turnId) }),
    );
    subscription.seedBootstrap([{ type: 'user', id: 'u', turnId, ts: 1, text: 'hello' }]);
    subscription.onTranscriptPageRead = () => {
      throw new Error('history unavailable');
    };
    const retrySubscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: runningTurn(sessionId, turnId) }),
    );
    const stops: Array<{ sessionId: string; turnId: string; runId: string }> = [];
    let opens = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'turn.stop') {
              stops.push(input as (typeof stops)[number]);
              return completedTurn(sessionId, turnId);
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () =>
            ++opens === 1 ? subscription : retrySubscription,
        }),
    });
    try {
      await assert.rejects(
        registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, promptContext([])),
      );
      for (let attempt = 0; attempt < 10; attempt += 1) await new Promise(setImmediate);
      assert.deepEqual(stops, []);
      assert.equal(subscription.closeCalls, 1);
      await registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, promptContext([]));
      assert.equal(opens, 2);
      assert.equal(retrySubscription.closeCalls, 0);
      assert.deepEqual(stops, []);
    } finally {
      await registry.dispose();
    }
  });

  test('unsupported restored interaction leaves its Host Turn pending', async (t) => {
    t.mock.method(console, 'error', () => undefined);
    const sessionId = 'unsupported-restored',
      turnId = 'restored-turn';
    const turn = runningTurn(sessionId, turnId);
    const pending: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'restored-question',
      sessionId,
      turnId,
      runId: turn.runId,
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'question',
        toolUseId: 'tool',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    };
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: turn, interactions: { pending: [pending] } }),
    );
    const statuses: string[] = [];
    const stops: Array<{ sessionId: string; turnId: string; runId: string }> = [];
    let queries = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'interaction.query') {
              queries += 1;
              return pending;
            }
            if (operation === 'turn.stop') {
              stops.push(input as (typeof stops)[number]);
              subscription.setRoot(completedTurn(sessionId, turnId));
              return completedTurn(sessionId, turnId);
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.resume(
        { sessionId, cwd: TEST_CWD },
        {
          ...promptContext([]),
          notifyTurnStatus: async (status) => {
            statuses.push(status.status);
          },
        },
      );
      await waitFor(() => queries >= 1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(stops, []);
      assert.deepEqual(statuses, []);
    } finally {
      subscription.setRoot(completedTurn(sessionId, turnId));
      await registry.dispose();
    }
  });

  for (const failure of ['unsupported-method', 'invalid-answer', 'output-failure'] as const) {
    test(`restored ${failure} leaves the Host Turn pending without answering`, async (t) => {
      t.mock.method(console, 'error', () => undefined);
      const sessionId = `restored-${failure}`;
      const turnId = `turn-${failure}`;
      const turn = runningTurn(sessionId, turnId);
      const pending: InteractionPendingSnapshot = {
        schemaVersion: 1,
        interactionId: `question-${failure}`,
        sessionId,
        turnId,
        runId: turn.runId,
        revision: 1,
        status: 'pending',
        outcome: null,
        request: {
          kind: 'question',
          toolUseId: 'tool',
          questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
        },
      };
      const subscription = new FakeSubscription(
        continuitySnapshot(sessionId, { rootTurn: turn, interactions: { pending: [pending] } }),
      );
      let stops = 0,
        answers = 0;
      let presentations = 0;
      const statuses: string[] = [];
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.catalog.query')
                return { kind: 'session', session: catalogSession(sessionId) };
              if (operation === 'interaction.query') return pending;
              if (operation === 'interaction.answer') {
                answers += 1;
                return pending;
              }
              if (operation === 'turn.stop') {
                stops += 1;
                subscription.setRoot(completedTurn(sessionId, turnId));
                return completedTurn(sessionId, turnId);
              }
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => subscription,
          }),
      });
      try {
        await registry.resume(
          { sessionId, cwd: TEST_CWD },
          {
            ...promptContext([]),
            notify: async () => {
              presentations += 1;
              if (failure === 'output-failure') throw new Error('Output failed');
            },
            notifyTurnStatus: async (status) => {
              statuses.push(status.status);
            },
            interactions: {
              capabilities: { elicitation: { form: {} } },
              createElicitation: async () => {
                presentations += 1;
                if (failure === 'unsupported-method')
                  throw RequestError.methodNotFound('elicitation/create');
                return { action: 'accept' as const, content: { unexpected: 'answer' } };
              },
              requestPermission: async () => assert.fail('Unexpected permission'),
            },
          },
        );
        await waitFor(() => presentations >= (failure === 'output-failure' ? 1 : 2));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(stops, 0);
        assert.deepEqual(statuses, []);
        assert.equal(answers, 0);
      } finally {
        subscription.setRoot(completedTurn(sessionId, turnId));
        await registry.dispose();
      }
    });
  }

  test('cancelling a restored Turn fences a late answer after Stop fails', async () => {
    const sessionId = 'cancel-restored',
      turnId = 'cancel-restored-turn';
    const turn = runningTurn(sessionId, turnId);
    const pending: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'cancel-question',
      sessionId,
      turnId,
      runId: turn.runId,
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'question',
        toolUseId: 'tool',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    };
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: turn, interactions: { pending: [pending] } }),
    );
    const dialog = deferred<{ action: 'accept'; content: { q0: string } }>();
    const opened = deferred<void>();
    let stops = 0,
      answers = 0;
    const queriedInteractions: string[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'interaction.query') {
              queriedInteractions.push((input as { interactionId: string }).interactionId);
              return pending;
            }
            if (operation === 'interaction.answer') {
              answers += 1;
              return pending;
            }
            if (operation === 'turn.stop') {
              stops += 1;
              throw new Error('Stop failed');
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.resume(
        { sessionId, cwd: TEST_CWD },
        {
          ...promptContext([]),
          interactions: {
            capabilities: { elicitation: { form: {} } },
            createElicitation: async () => {
              opened.resolve();
              return dialog.promise;
            },
            requestPermission: async () => assert.fail('Unexpected permission'),
          },
        },
      );
      await opened.promise;
      await registry.cancel({ sessionId });
      assert.equal(stops, 1);
      dialog.resolve({ action: 'accept', content: { q0: 'Yes' } });
      subscription.project({
        interactions: { pending: [{ ...pending, interactionId: 'later-question' }] },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(answers, 0);
      assert.equal(queriedInteractions.includes('later-question'), false);
    } finally {
      dialog.resolve({ action: 'accept', content: { q0: 'Yes' } });
      await registry.dispose();
    }
  });

  test('cancelling a restored permission fences its late selection', async () => {
    const sessionId = 'cancel-restored-permission';
    const turnId = 'permission-turn';
    const turn = runningTurn(sessionId, turnId);
    const pending: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'permission',
      sessionId,
      turnId,
      runId: turn.runId,
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'permission',
        toolUseId: 'tool',
        prompt: {
          kind: 'tool_permission',
          toolName: 'fixture',
          category: 'read',
          reason: 'custom',
          review: { kind: 'path', operation: 'read', path: '/workspace/file' },
          rememberForTurnAllowed: false,
        },
      },
    };
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: turn, interactions: { pending: [pending] } }),
    );
    const selection = deferred<{ outcome: { outcome: 'selected'; optionId: string } }>();
    const opened = deferred<void>();
    let optionId = '',
      answers = 0,
      stops = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'interaction.query') return pending;
            if (operation === 'interaction.answer') {
              answers += 1;
              return pending;
            }
            if (operation === 'turn.stop') {
              stops += 1;
              throw new Error('Stop failed');
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.resume(
        { sessionId, cwd: TEST_CWD },
        {
          ...promptContext([]),
          interactions: {
            capabilities: {},
            createElicitation: async () => assert.fail('Unexpected elicitation'),
            requestPermission: async (request) => {
              optionId = request.options[0]!.optionId;
              opened.resolve();
              return selection.promise;
            },
          },
        },
      );
      await opened.promise;
      await registry.cancel({ sessionId });
      assert.equal(stops, 1);
      selection.resolve({ outcome: { outcome: 'selected', optionId } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(answers, 0);
    } finally {
      selection.resolve({ outcome: { outcome: 'selected', optionId } });
      await registry.dispose();
    }
  });

  test('load refuses an MCP change while the Host reports an active Turn', {
    timeout: 20_000,
  }, async () => {
    const sessionId = 'session-mcp-active-turn';
    const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-acp-mcp-active-')));
    const fixture = fileURLToPath(import.meta.resolve('@maka/mcp/test-only/stdio-server'));
    const original = {
      name: 'fixture',
      command: process.execPath,
      args: [fixture],
      env: [{ name: 'MAKA_MCP_STDIO_EVENT_LOG', value: join(root, 'fixture.jsonl') }],
    };
    const changed = {
      ...original,
      env: [...original.env, { name: 'MAKA_MCP_STDIO_FIXTURE_VALUE', value: 'changed' }],
    };
    let status: 'active' | 'running' = 'active';
    let publications = 0;
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const base = fakeConnection({
      request: async (operation) => {
        if (operation === 'session.create') return catalogSession(sessionId, root);
        if (operation === 'session.catalog.query')
          return { kind: 'session', session: catalogSession(sessionId, root, { status }) };
        throw new Error(`Unexpected operation ${operation}`);
      },
      openSessionSubscriptionOnce: async () => subscription,
    });
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      connect: async () => ({
        ...base,
        replaceClientCapabilities: async (provider, options) => {
          publications += 1;
          return base.replaceClientCapabilities(provider, options);
        },
      }),
    });
    try {
      await registry.create({ cwd: root, mcpServers: [original] });
      assert.equal(publications, 1);
      status = 'running';
      await assert.rejects(
        registry.load({ sessionId, cwd: root, mcpServers: [changed] }, promptContext([])),
        (error: unknown) =>
          error instanceof RequestError &&
          (error.data as { code?: string })?.code === 'session_busy',
      );
      assert.equal(publications, 1);
      await registry.load({ sessionId, cwd: root, mcpServers: [original] }, promptContext([]));
      assert.equal(publications, 1);
    } finally {
      await registry.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('explicit Turn resume observes before Host admission and reports terminal status', async () => {
    const sessionId = 'session-explicit-resume';
    const turnId = 'continuation-turn';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const notifications: SessionNotification[] = [];
    const statuses: unknown[] = [];
    const operations: string[] = [];
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      newTurnId: () => turnId,
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            operations.push(operation);
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.resume.query')
              return {
                sessionId,
                disposition: 'ready',
                sourceRunId: 'source-run',
                sourceTurnId: 'source-turn',
                sourceRuntimeEventHighWater: 42,
              };
            if (operation === 'turn.resume.start') {
              assert.deepEqual(input, {
                sessionId,
                turnId,
                sourceRunId: 'source-run',
                sourceRuntimeEventHighWater: 42,
              });
              const turn = runningTurn(sessionId, turnId);
              subscription.setRoot(turn);
              subscription.appendText(turnId, turn.runId, 'continued', true);
              subscription.setRoot(completedTurn(sessionId, turnId));
              return { kind: 'started', turn };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const result = await registry.resumeTurn(
        { sessionId },
        {
          ...promptContext(notifications),
          notifyTurnStatus: async (status) => {
            statuses.push(status);
          },
        },
      );
      assert.equal(result.kind, 'started');
      await waitFor(() => statuses.length === 1);
      assert.deepEqual(statuses, [
        {
          sessionId,
          turnId,
          runId: `run-${turnId}`,
          status: 'completed',
        },
      ]);
      assert.ok(
        notifications.some(
          ({ update }) =>
            update.sessionUpdate === 'agent_message_chunk' &&
            update.content.type === 'text' &&
            update.content.text === 'continued',
        ),
      );
      assert.deepEqual(operations, ['session.create', 'turn.resume.query', 'turn.resume.start']);
    } finally {
      await registry.dispose();
    }
  });

  for (const action of ['close', 'dispose'] as const) {
    test(`${action} waits for an explicit resume failure Stop`, async () => {
      const sessionId = 'resume-stop-lifetime';
      const turnId = 'resumed-turn';
      const subscription = new FakeSubscription(continuitySnapshot(sessionId));
      const stop = deferred<void>();
      let stopRequested = false;
      let connectionClosed = false;
      const registry = new AcpSessionRegistry({
        newSessionId: () => sessionId,
        newTurnId: () => turnId,
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'turn.resume.query')
                return {
                  sessionId,
                  disposition: 'ready',
                  sourceRunId: 'source-run',
                  sourceTurnId: 'source-turn',
                  sourceRuntimeEventHighWater: 42,
                };
              if (operation === 'turn.resume.start') {
                const turn = runningTurn(sessionId, turnId);
                subscription.setRoot(turn);
                return { kind: 'started', turn };
              }
              if (operation === 'turn.stop') {
                stopRequested = true;
                subscription.setRoot(completedTurn(sessionId, turnId));
                return stop.promise;
              }
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => subscription,
            close: async () => {
              connectionClosed = true;
            },
          }),
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      await registry.resumeTurn(
        { sessionId },
        {
          ...promptContext([]),
          notify: async () => {
            throw new Error('Client output failed');
          },
        },
      );
      subscription.appendText(turnId, `run-${turnId}`, 'output', true);
      await waitFor(() => stopRequested);
      let cleanupSettled = false;
      const cleaning = (
        action === 'close' ? registry.close({ sessionId }) : registry.dispose()
      ).then(() => {
        cleanupSettled = true;
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(connectionClosed, false);
        assert.equal(cleanupSettled, false);
      } finally {
        stop.resolve();
        await cleaning;
      }
      assert.equal(connectionClosed, action === 'dispose');
      if (action === 'close') {
        assert.equal(subscription.closeCalls, 1);
        await registry.dispose();
      }
    });
  }

  test('explicit Turn resume returns a Host parked plan without opening a subscription', async () => {
    const sessionId = 'session-resume-parked';
    let opens = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.resume.query')
              return {
                sessionId,
                disposition: 'parked',
                reason: 'resume_candidate_missing',
              };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => {
            opens += 1;
            throw new Error('unexpected open');
          },
        }),
    });
    try {
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      assert.deepEqual(await registry.resumeTurn({ sessionId }, promptContext([])), {
        kind: 'parked',
        plan: { sessionId, disposition: 'parked', reason: 'resume_candidate_missing' },
      });
      assert.equal(opens, 0);
    } finally {
      await registry.dispose();
    }
  });

  test('a lost dispatched Turn resume response retains its exact target identity', async () => {
    const sessionId = 'session-resume-unknown';
    const turnId = 'turn-resume-unknown';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      newTurnId: () => turnId,
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.resume.query')
              return {
                sessionId,
                disposition: 'ready',
                sourceRunId: 'source-run',
                sourceTurnId: 'source-turn',
                sourceRuntimeEventHighWater: 42,
              };
            if (operation === 'turn.resume.start')
              throw new RuntimeHostRequestInterruptedError(
                'turn.resume.start',
                'command',
                'dispatched',
                'connection_lost',
              );
            if (operation === 'turn.query')
              throw new RuntimeHostOperationError('turn.query', 'not_found', 'not observed');
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      await assert.rejects(
        registry.resumeTurn({ sessionId }, promptContext([])),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.deepEqual(error.data, {
            source: 'runtime_host',
            operation: 'turn.resume.start',
            code: 'outcome_unknown',
            sessionId,
            turnId,
            sourceRunId: 'source-run',
          });
          return true;
        },
      );
    } finally {
      await registry.dispose();
    }
  });

  test('a rejected Turn resume releases its idle Session for a changed MCP load', async () => {
    const sessionId = 'session-resume-rejected';
    const turnId = 'turn-resume-rejected';
    const root = await realpath(await mkdtemp(join(tmpdir(), 'maka-acp-resume-rejected-')));
    const original = {
      name: 'fixture',
      command: process.execPath,
      args: [fileURLToPath(import.meta.resolve('@maka/mcp/test-only/stdio-server'))],
      env: [{ name: 'MAKA_MCP_STDIO_EVENT_LOG', value: join(root, 'fixture.jsonl') }],
    };
    const changed = {
      ...original,
      env: [...original.env, { name: 'MAKA_MCP_STDIO_FIXTURE_VALUE', value: 'changed' }],
    };
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      newTurnId: () => turnId,
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId, root);
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId, root) };
            if (operation === 'turn.resume.query')
              return {
                sessionId,
                disposition: 'ready',
                sourceRunId: 'source-run',
                sourceTurnId: 'source-turn',
                sourceRuntimeEventHighWater: 42,
              };
            if (operation === 'turn.resume.start')
              throw new RuntimeHostRequestInterruptedError(
                'turn.resume.start',
                'command',
                'dispatched',
                'connection_lost',
              );
            if (operation === 'turn.query')
              throw new RuntimeHostOperationError('turn.query', 'not_found', 'not admitted');
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.create({ cwd: root, mcpServers: [original] });
      await registry.resume({ sessionId, cwd: root, mcpServers: [original] }, promptContext([]));
      await assert.rejects(registry.resumeTurn({ sessionId }, promptContext([])));
      await registry.resume(
        {
          sessionId,
          cwd: root,
          mcpServers: [changed],
        },
        promptContext([]),
      );
    } finally {
      await registry.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const terminalStatus of ['completed', 'failed', 'cancelled'] as const) {
    test(`attached Turn reports ${terminalStatus} after output when a next Turn starts`, async () => {
      const sessionId = 'session-status-next-root';
      const turnId = 'turn-first';
      const turn = runningTurn(sessionId, turnId);
      const subscription = new FakeSubscription(continuitySnapshot(sessionId, { rootTurn: turn }));
      const outputEntered = deferred<void>();
      const releaseOutput = deferred<void>();
      const statuses: unknown[] = [];
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.catalog.query')
                return { kind: 'session', session: catalogSession(sessionId) };
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => subscription,
          }),
      });
      try {
        await registry.resume(
          { sessionId, cwd: TEST_CWD },
          {
            ...promptContext([]),
            notify: async (notification) => {
              if (notification.update.sessionUpdate === 'agent_message_chunk') {
                outputEntered.resolve();
                await releaseOutput.promise;
              }
            },
            notifyTurnStatus: async (status) => {
              statuses.push(status);
            },
          },
        );
        subscription.appendText(turnId, turn.runId, 'hello', true);
        await outputEntered.promise;
        subscription.setRoot(
          terminalStatus === 'completed'
            ? completedTurn(sessionId, turnId)
            : terminalStatus === 'failed'
              ? {
                  sessionId,
                  turnId,
                  runId: turn.runId,
                  status: 'failed',
                  terminalEventId: `terminal-${turnId}`,
                  failureClass: 'provider_failure',
                }
              : {
                  sessionId,
                  turnId,
                  runId: turn.runId,
                  status: 'cancelled',
                  terminalEventId: `terminal-${turnId}`,
                  abortSource: 'user',
                },
        );
        subscription.setRoot(runningTurn(sessionId, 'turn-next'));
        await waitFor(() => subscription.snapshot.rootTurn?.turnId === 'turn-next');
        releaseOutput.resolve();
        await waitFor(() => statuses.length === 1);
        assert.deepEqual(statuses, [
          {
            sessionId,
            turnId,
            runId: turn.runId,
            status: terminalStatus,
            ...(terminalStatus === 'failed' ? { failureClass: 'provider_failure' } : {}),
          },
        ]);
      } finally {
        releaseOutput.resolve();
        await registry.dispose();
      }
    });
  }

  test('cancel fences an in-flight explicit resume and Stops the admitted Turn', async () => {
    const sessionId = 'session-resume-cancel';
    const turnId = 'turn-resume-cancel';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const started = deferred<void>();
    const startResponse = deferred<{ kind: 'started'; turn: ReturnType<typeof runningTurn> }>();
    const stops: unknown[] = [];
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      newTurnId: () => turnId,
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.resume.query')
              return {
                sessionId,
                disposition: 'ready',
                sourceRunId: 'source-run',
                sourceTurnId: 'source-turn',
                sourceRuntimeEventHighWater: 42,
              };
            if (operation === 'turn.resume.start') {
              started.resolve();
              return startResponse.promise;
            }
            if (operation === 'turn.stop') {
              stops.push(input);
              subscription.setRoot({
                sessionId,
                turnId,
                runId: `run-${turnId}`,
                status: 'cancelled',
                terminalEventId: 'terminal',
                abortSource: 'test',
              });
              return {};
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
    });
    try {
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const resuming = registry.resumeTurn({ sessionId }, promptContext([]));
      await started.promise;
      const cancelling = registry.cancel({ sessionId });
      const turn = runningTurn(sessionId, turnId);
      subscription.setRoot(turn);
      startResponse.resolve({ kind: 'started', turn });
      await cancelling;
      assert.equal((await resuming).kind, 'started');
      assert.deepEqual(stops, [{ sessionId, turnId, runId: `run-${turnId}` }]);
    } finally {
      startResponse.resolve({ kind: 'started', turn: runningTurn(sessionId, turnId) });
      await registry.dispose();
    }
  });

  test('copy-source query requires ownership, forwards bounded paging, and captures revision before reading Turns', async () => {
    const sessionId = 'copy-source';
    const queries: unknown[] = [];
    let revision = 3;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query')
              return {
                kind: 'session',
                session: catalogSession(sessionId, TEST_CWD, { revision }),
              };
            if (operation === 'session.turns.query') {
              queries.push(input);
              revision += 1;
              return { sessionId, throughSequence: 20, contributions: [], nextPosition: 2 };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
        }),
    });
    const query = { sessionId, throughSequence: 20, position: 1, maxContributions: 1 };
    try {
      await assert.rejects(registry.queryCopySource(query), RequestError);
      assert.deepEqual(queries, []);
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      assert.deepEqual(await registry.queryCopySource(query), {
        sessionId,
        throughSequence: 20,
        contributions: [],
        nextPosition: 2,
        expectedSourceRevision: 3,
      });
      assert.deepEqual(queries, [query]);
      await registry.close({ sessionId });
      await assert.rejects(registry.queryCopySource(query), RequestError);
      assert.equal(queries.length, 1);
    } finally {
      await registry.dispose();
    }
  });

  test('committed branch and revision targets are immediately owned; retained and abandoned remain distinct', async () => {
    const sourceSessionId = 'source-session';
    const targetSessionId = 'branch-target';
    const revisionId = 'revision-target';
    const operations: string[] = [];
    const registry = new AcpSessionRegistry({
      newSessionId: () => sourceSessionId,
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            operations.push(operation);
            if (operation === 'session.create') return catalogSession(sourceSessionId);
            if (operation === 'session.branch.create')
              return { kind: 'committed', session: catalogSession(targetSessionId) };
            if (operation === 'session.revision.create')
              return { kind: 'committed', session: catalogSession(revisionId) };
            if (operation === 'session.revision.abandon') {
              const id = (input as { targetSessionId: string }).targetSessionId;
              return { kind: id === targetSessionId ? 'retained' : 'abandoned', sessionId: id };
            }
            if (operation === 'session.catalog.query') {
              const id = (input as { sessionId: string }).sessionId;
              return { kind: 'session', session: catalogSession(id) };
            }
            if (operation === 'session.configuration.update') {
              const id = (input as { sessionId: string }).sessionId;
              return { kind: 'committed', session: catalogSession(id) };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
        }),
    });
    try {
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const copy = {
        sourceSessionId,
        targetSessionId,
        sourceTurnId: 'source-turn',
        expectedSourceRevision: 1,
      };
      assert.equal((await registry.branch(copy)).kind, 'committed');
      assert.ok(
        (
          await registry.setConfigOption({
            sessionId: targetSessionId,
            configId: 'collaboration_mode',
            value: 'plan',
          })
        ).configOptions.length > 0,
      );
      assert.equal(
        (await registry.createRevision({ ...copy, targetSessionId: revisionId })).kind,
        'committed',
      );
      assert.deepEqual(await registry.abandonRevision({ targetSessionId }), {
        kind: 'retained',
        sessionId: targetSessionId,
      });
      assert.deepEqual(await registry.abandonRevision({ targetSessionId: revisionId }), {
        kind: 'abandoned',
        sessionId: revisionId,
      });
      await assert.rejects(
        registry.setConfigOption({
          sessionId: revisionId,
          configId: 'collaboration_mode',
          value: 'plan',
        }),
        (error: unknown) => error instanceof RequestError && error.code === -32602,
      );
      assert.ok(operations.includes('session.configuration.update'));
    } finally {
      await registry.dispose();
    }
  });

  test('copy retries an unknown dispatch and does not claim an unverified target', async () => {
    const sourceSessionId = 'source-copy-conflict';
    const conflictedId = 'target-copy-conflict';
    const uncertainId = 'target-copy-uncertain';
    const foreignId = 'target-copy-foreign';
    const operations: string[] = [];
    let foreignAttempts = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sourceSessionId,
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            operations.push(operation);
            if (operation === 'session.create') return catalogSession(sourceSessionId);
            if (operation === 'session.branch.create') {
              const target = (input as { targetSessionId: string }).targetSessionId;
              if (target === conflictedId)
                throw new RuntimeHostOperationError(
                  operation,
                  'operation_conflict',
                  'Source revision changed',
                );
              if (target === foreignId && ++foreignAttempts === 2)
                throw new RuntimeHostOperationError(
                  operation,
                  'operation_conflict',
                  'Target belongs to another request',
                );
              throw new RuntimeHostRequestInterruptedError(
                operation,
                'command',
                'dispatched',
                'connection_lost',
              );
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
        }),
    });
    try {
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const input = {
        sourceSessionId,
        targetSessionId: conflictedId,
        sourceTurnId: 'source-turn',
        expectedSourceRevision: 1,
      };
      await assert.rejects(
        registry.branch(input),
        (error: unknown) =>
          error instanceof RequestError &&
          (error.data as { code?: string })?.code === 'operation_conflict',
      );
      await assert.rejects(
        registry.branch({ ...input, targetSessionId: uncertainId }),
        (error: unknown) =>
          error instanceof RequestError &&
          (error.data as { targetSessionId?: string })?.targetSessionId === uncertainId,
      );
      await assertInvalidParams(
        registry.setConfigOption({
          sessionId: uncertainId,
          configId: 'collaboration_mode',
          value: 'plan',
        }),
        { reason: 'unknown_session' },
      );
      await assert.rejects(
        registry.branch({ ...input, targetSessionId: foreignId }),
        (error: unknown) =>
          error instanceof RequestError &&
          (error.data as { code?: string })?.code === 'operation_conflict',
      );
      await assertInvalidParams(
        registry.setConfigOption({
          sessionId: foreignId,
          configId: 'collaboration_mode',
          value: 'plan',
        }),
        { reason: 'unknown_session' },
      );
      assert.equal(
        operations.filter((operation) => operation === 'session.branch.create').length,
        5,
      );
    } finally {
      await registry.dispose();
    }
  });

  test('copy claims a target only after its exact retry confirms a commit', async () => {
    const sourceSessionId = 'source-copy-retry';
    const targetSessionId = 'target-copy-retry';
    let attempts = 0;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sourceSessionId,
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sourceSessionId);
            if (operation === 'session.branch.create') {
              assert.equal((input as { targetSessionId: string }).targetSessionId, targetSessionId);
              if (++attempts === 1)
                throw new RuntimeHostRequestInterruptedError(
                  operation,
                  'command',
                  'dispatched',
                  'connection_lost',
                );
              return { kind: 'committed', session: catalogSession(targetSessionId) };
            }
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(targetSessionId) };
            if (operation === 'session.configuration.update')
              return { kind: 'committed', session: catalogSession(targetSessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
        }),
    });
    try {
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      assert.equal(
        (
          await registry.branch({
            sourceSessionId,
            targetSessionId,
            sourceTurnId: 'source-turn',
            expectedSourceRevision: 1,
          })
        ).kind,
        'committed',
      );
      assert.equal(attempts, 2);
      assert.ok(
        (
          await registry.setConfigOption({
            sessionId: targetSessionId,
            configId: 'collaboration_mode',
            value: 'plan',
          })
        ).configOptions.length > 0,
      );
    } finally {
      await registry.dispose();
    }
  });

  test('does not connect when disposed before a Session method is used', async () => {
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return fakeConnection();
      },
    });

    await registry.dispose();
    await registry.dispose();

    assert.equal(connectCalls, 0);
  });

  test('reports the requested Session operation after disposal', async () => {
    const registry = new AcpSessionRegistry({
      connect: async () => fakeConnection(),
    });
    await registry.dispose();

    for (const [operation, request] of [
      ['session.create', () => registry.create({ cwd: TEST_CWD, mcpServers: [] })],
      ['session.catalog.query', () => registry.list({})],
      [
        'session.configuration.update',
        () =>
          registry.setConfigOption({
            sessionId: 'session-closed',
            configId: 'permission_mode',
            value: 'bypass',
          }),
      ],
      [
        'turn.start',
        () =>
          registry.prompt(
            { sessionId: 'session-closed', prompt: [{ type: 'text', text: 'hello' }] },
            promptContext([]),
          ),
      ],
      ['session.close', () => registry.close({ sessionId: 'session-closed' })],
    ] as const) {
      await assert.rejects(request(), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, -32603);
        assert.deepEqual(error.data, {
          source: 'runtime_host',
          operation,
          code: 'registry_closed',
        });
        return true;
      });
    }
  });

  test('does not start a queued connection after disposal begins', async () => {
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return fakeConnection();
      },
    });

    const list = registry.list({});
    const dispose = registry.dispose();

    await assert.rejects(
      list,
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32603 &&
        (error.data as { code?: string }).code === 'registry_closed',
    );
    await dispose;
    assert.equal(connectCalls, 0);
  });

  test('aborts an in-flight connection before disposal waits for it', async () => {
    let connectSignal: AbortSignal | undefined;
    const registry = new AcpSessionRegistry({
      connect: async (signal) => {
        connectSignal = signal;
        return new Promise<ReturnType<typeof fakeConnection>>((_, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });

    const list = registry.list({});
    await waitFor(() => connectSignal !== undefined);
    const dispose = registry.dispose();

    await assert.rejects(
      list,
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32603 &&
        (error.data as { code?: string }).code === 'registry_closed',
    );
    await dispose;
    assert.equal(connectSignal?.aborted, true);
  });

  test('shares one in-flight connection across concurrent Session methods', async () => {
    const connecting = deferred<ReturnType<typeof fakeConnection>>();
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return connecting.promise;
      },
      newSessionId: () => 'session-concurrent',
    });
    const create = registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const list = registry.list({});
    await waitFor(() => connectCalls === 1);

    connecting.resolve(
      fakeConnection({
        request: async (operation) =>
          operation === 'session.catalog.query'
            ? {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [],
                nextCursor: null,
              }
            : catalogSession('session-concurrent'),
      }),
    );

    assert.deepEqual(await create, {
      sessionId: 'session-concurrent',
      configOptions: DEFAULT_CONFIG_OPTIONS,
    });
    assert.deepEqual(await list, { sessions: [] });
    assert.equal(connectCalls, 1);
    await registry.dispose();
  });

  test('reports a stable connection error and retries on a later Session request', async () => {
    let connectCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        if (connectCalls === 1) throw new Error('Host unavailable');
        return fakeConnection({
          request: async () => ({
            kind: 'page',
            revision: SESSION_REVISION,
            sessions: [],
            nextCursor: null,
          }),
        });
      },
    });

    await assert.rejects(registry.list({}), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'connect',
        code: 'connection_failed',
      });
      return true;
    });
    assert.deepEqual(await registry.list({}), { sessions: [] });
    assert.equal(connectCalls, 2);
    await registry.dispose();
  });

  test('closes a connection that resolves after disposal starts', async () => {
    const connecting = deferred<ReturnType<typeof fakeConnection>>();
    let connectCalls = 0;
    let closeCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        connectCalls += 1;
        return connecting.promise;
      },
    });
    const list = registry.list({});
    await waitFor(() => connectCalls === 1);
    const dispose = registry.dispose();

    connecting.resolve(
      fakeConnection({
        close: async () => {
          closeCalls += 1;
        },
      }),
    );

    await assert.rejects(list, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.equal((error.data as { code?: string }).code, 'registry_closed');
      return true;
    });
    await dispose;
    assert.equal(closeCalls, 1);
  });

  test('creates more than the Host subscription limit without opening a subscription', async () => {
    const sessionCount = 17;
    const createdSessionIds: string[] = [];
    let subscriptionOpens = 0;
    let nextId = 0;
    const registry = new AcpSessionRegistry({
      connect: async () => {
        const connection = fakeConnection({
          request: async (operation, input) => {
            assert.equal(operation, 'session.create');
            const sessionId = (input as { sessionId: string }).sessionId;
            createdSessionIds.push(sessionId);
            return catalogSession(sessionId);
          },
        });
        return {
          ...connection,
          openSessionSubscriptionOnce: async () => {
            subscriptionOpens += 1;
            throw new Error('PR 2 must not open a subscription');
          },
        } as AcpSessionRegistryConnection;
      },
      newSessionId: () => `session-unattached-${++nextId}`,
    });

    const creates = await Promise.all(
      Array.from({ length: sessionCount }, () =>
        registry.create({ cwd: TEST_CWD, mcpServers: [] }),
      ),
    );

    assert.equal(creates.length, sessionCount);
    assert.equal(createdSessionIds.length, sessionCount);
    assert.equal(subscriptionOpens, 0);
    await registry.dispose();
  });

  test('rejects unsupported prompt content before opening a real Session channel', async () => {
    let subscriptionOpens = 0;
    const turnRequests: string[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            turnRequests.push(operation);
            return catalogSession('session-prompt-validation');
          },
          openSessionSubscriptionOnce: async () => {
            subscriptionOpens += 1;
            return new FakeSubscription(continuitySnapshot('session-prompt-validation'));
          },
        }),
      newSessionId: () => 'session-prompt-validation',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    turnRequests.length = 0;

    await assertInvalidParams(
      registry.prompt(
        {
          sessionId: 'session-prompt-validation',
          prompt: [{ type: 'image', data: '', mimeType: 'image/png' }],
        },
        promptContext([]),
      ),
      { field: 'prompt', reason: 'unsupported_content_type' },
    );

    assert.equal(subscriptionOpens, 0);
    assert.deepEqual(turnRequests, []);
    await registry.dispose();
  });

  test('shares a concurrent first real Session channel and consumes events before turn.start settles', async () => {
    const sessionId = 'session-concurrent-prompt';
    const notifications: SessionNotification[] = [];
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const turnIds = ['turn-a', 'turn-b'];
    const startedTurnIds: string[] = [];
    let subscriptionOpens = 0;
    let turnTail = Promise.resolve();
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation !== 'turn.start') throw new Error(`Unexpected operation ${operation}`);
            const turnId = (input as { turnId: string }).turnId;
            const turn = runningTurn(sessionId, turnId);
            const emit = turnTail.then(async () => {
              startedTurnIds.push(turnId);
              subscription.setRoot(turn);
              subscription.appendText(turnId, turn.runId, turnId, true);
              await waitFor(() =>
                notifications.some(
                  ({ update }) =>
                    update.sessionUpdate === 'agent_message_chunk' &&
                    update.content.type === 'text' &&
                    update.content.text === turnId,
                ),
              );
              subscription.setRoot(completedTurn(sessionId, turnId));
            });
            turnTail = emit.catch(() => undefined);
            await emit;
            return {
              kind: 'started',
              turn,
              skillInvocation: { loaded: [], failed: [], receipts: [] },
            };
          },
          openSessionSubscriptionOnce: async () => {
            subscriptionOpens += 1;
            return subscription;
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turnIds.shift()!,
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });

    const first = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'one' }] },
      promptContext(notifications),
    );
    const second = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'two' }] },
      promptContext(notifications),
    );

    assert.deepEqual(await Promise.all([first, second]), [
      { stopReason: 'end_turn' },
      { stopReason: 'end_turn' },
    ]);
    assert.equal(subscriptionOpens, 1);
    assert.deepEqual(new Set(startedTurnIds), new Set(['turn-a', 'turn-b']));
    await registry.dispose();
    assert.equal(subscription.closeCalls, 1);
  });

  for (const scenario of [
    'complete',
    'completed-without-result',
    'notification-failure',
    'cancel',
    'cancel-stalled-notification',
    'host-failure',
    'host-abort',
  ] as const) {
    test(`tool reconciliation through the real Session channel handles ${scenario}`, async () => {
      const sessionId = `session-tool-${scenario}`;
      const turn = runningTurn(sessionId, 'turn-tool');
      const subscription = new FakeSubscription(continuitySnapshot(sessionId));
      const pageGate = deferred<void>();
      const pageRead = deferred<void>();
      const deliveryGate = deferred<void>();
      subscription.transcriptPageGate = pageGate.promise;
      subscription.onTranscriptPageRead = () => pageRead.resolve();
      let subscriptionOpens = 0;
      let stopped = 0;
      let terminalDeliveryStarted = false;
      let failedToolDelivered = false;
      let settled = false;
      const completesNormally =
        scenario === 'complete' ||
        scenario === 'completed-without-result' ||
        scenario === 'notification-failure' ||
        scenario === 'cancel-stalled-notification';
      const hasResult = scenario !== 'completed-without-result';
      const notifications: SessionNotification[] = [];
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'turn.start') {
                subscription.setRoot(turn);
                if (completesNormally && hasResult)
                  subscription.appendToolResult(turn.turnId, turn.runId, 'tool');
                else subscription.appendToolStart(turn.turnId, turn.runId, 'tool');
                subscription.publishTranscript([
                  ...(hasResult
                    ? [
                        {
                          type: 'tool_result' as const,
                          id: 'stored-result',
                          turnId: turn.turnId,
                          ts: 2,
                          toolUseId: 'tool',
                          isError: false,
                          content: { kind: 'text' as const, text: 'authoritative result' },
                        },
                      ]
                    : []),
                  ...(!completesNormally
                    ? []
                    : [
                        {
                          type: 'turn_state' as const,
                          id: 'stored-terminal',
                          turnId: turn.turnId,
                          ts: 3,
                          status: 'completed' as const,
                        },
                      ]),
                ]);
                if (completesNormally) subscription.setRoot(completedTurn(sessionId, turn.turnId));
                return {
                  kind: 'started',
                  turn,
                  skillInvocation: { loaded: [], failed: [], receipts: [] },
                };
              }
              if (operation === 'turn.stop') {
                stopped += 1;
                subscription.setRoot({
                  ...turn,
                  status: 'cancelled',
                  terminalEventId: 'cancelled',
                  abortSource: 'user',
                });
                return {};
              }
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => {
              subscriptionOpens += 1;
              return subscription;
            },
            openSessionSubscription: async () => {
              throw new Error('Reconciliation must not open another subscription');
            },
          }),
        newSessionId: () => sessionId,
        newTurnId: () => turn.turnId,
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const prompt = registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'use the tool' }] },
        {
          signal: new AbortController().signal,
          notify: async (notification) => {
            if (
              (notification.update.sessionUpdate === 'tool_call' ||
                notification.update.sessionUpdate === 'tool_call_update') &&
              notification.update.status === 'failed'
            ) {
              failedToolDelivered = true;
            }
            if (
              (notification.update.sessionUpdate === 'tool_call' ||
                notification.update.sessionUpdate === 'tool_call_update') &&
              notification.update.rawOutput !== undefined
            ) {
              terminalDeliveryStarted = true;
              if (scenario === 'notification-failure')
                throw new Error('terminal notification rejected');
              await deliveryGate.promise;
            }
            notifications.push(notification);
          },
        },
      );
      void prompt.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await pageRead.promise;
      assert.equal(settled, false);
      if (scenario === 'cancel') {
        await registry.cancel({ sessionId });
        assert.deepEqual(await prompt, { stopReason: 'cancelled' });
        assert.equal(stopped, 1);
        pageGate.resolve();
        deliveryGate.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(terminalDeliveryStarted, false);
      } else if (scenario === 'cancel-stalled-notification') {
        pageGate.resolve();
        await waitFor(() => terminalDeliveryStarted);
        await registry.cancel({ sessionId });
        assert.deepEqual(await prompt, { stopReason: 'cancelled' });
        assert.equal(stopped, 0);
        deliveryGate.reject(new Error('Late transport failure'));
        await new Promise((resolve) => setImmediate(resolve));
      } else if (scenario === 'host-failure' || scenario === 'host-abort') {
        subscription.setRoot(
          scenario === 'host-failure'
            ? {
                ...turn,
                status: 'failed',
                terminalEventId: 'failed',
                failureClass: 'provider_failure',
              }
            : {
                ...turn,
                status: 'cancelled',
                terminalEventId: 'aborted',
                abortSource: 'host',
              },
        );
        assert.deepEqual(await prompt, { stopReason: 'end_turn' });
        assert.equal(stopped, 0);
        pageGate.resolve();
        deliveryGate.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(terminalDeliveryStarted, false);
        assert.equal(failedToolDelivered, true);
      } else {
        pageGate.resolve();
        if (hasResult) await waitFor(() => terminalDeliveryStarted);
        if (scenario === 'complete') {
          assert.equal(settled, false);
          deliveryGate.resolve();
          assert.deepEqual(await prompt, { stopReason: 'end_turn' });
          assert.ok(
            notifications.some(
              ({ update }) =>
                (update.sessionUpdate === 'tool_call_update' ||
                  update.sessionUpdate === 'tool_call') &&
                update.rawOutput !== undefined,
            ),
          );
        } else if (scenario === 'completed-without-result') {
          assert.deepEqual(await prompt, { stopReason: 'end_turn' });
          assert.equal(terminalDeliveryStarted, false);
          assert.equal(failedToolDelivered, true);
        } else await assert.rejects(prompt);
      }
      assert.equal(subscriptionOpens, 1);
      await registry.dispose();
    });
  }

  test('recovers mid-prompt and settles a live tool from the replacement transcript', async () => {
    const sessionId = 'session-tool-recovery';
    const turn = runningTurn(sessionId, 'turn-tool-recovery');
    const first = new FakeSubscription(continuitySnapshot(sessionId));
    const replacement = new FakeSubscription(
      { ...continuitySnapshot(sessionId), rootTurn: turn },
      Promise.resolve([]),
      'subscription-recovered',
    );
    let recoveries = 0;
    const notifications: SessionNotification[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              first.setRoot(turn);
              first.appendToolStart(turn.turnId, turn.runId, 'tool');
              first.publishTranscript([]);
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => first,
          openSessionSubscription: async () => {
            recoveries += 1;
            return replacement;
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turn.turnId,
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'use the tool' }] },
      promptContext(notifications),
    );
    await waitFor(() => notifications.some(({ update }) => update.sessionUpdate === 'tool_call'));
    first.fail(new RuntimeHostSubscriptionError('connection_closed', 'Connection was lost'));
    await waitFor(() => recoveries === 1 && replacement.nextCalls > 0);
    replacement.publishTranscript([
      {
        type: 'tool_result',
        id: 'stored-result',
        turnId: turn.turnId,
        ts: 2,
        toolUseId: 'tool',
        isError: false,
        content: { kind: 'text', text: 'recovered result' },
      },
      {
        type: 'turn_state',
        id: 'stored-terminal',
        turnId: turn.turnId,
        ts: 3,
        status: 'completed',
      },
    ]);
    replacement.setRoot(completedTurn(sessionId, turn.turnId));
    assert.deepEqual(await prompt, { stopReason: 'end_turn' });
    assert.ok(
      notifications.some(
        ({ update }) =>
          (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
          (update.rawOutput as { kind?: string; text?: string } | undefined)?.kind === 'text' &&
          (update.rawOutput as { kind?: string; text?: string } | undefined)?.text ===
            'recovered result',
      ),
    );
    await registry.dispose();
  });

  test('reports an attached Turn terminal status across a replacement with a successor root', async () => {
    const sessionId = 'session-replaced-terminal';
    const turn = runningTurn(sessionId, 'previous-turn');
    const first = new FakeSubscription(continuitySnapshot(sessionId, { rootTurn: turn }));
    const replacement = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: runningTurn(sessionId, 'next-turn') }),
      Promise.resolve([
        {
          type: 'turn_state',
          id: 'stored-terminal',
          turnId: turn.turnId,
          ts: 2,
          status: 'completed',
        },
      ]),
      'subscription-replaced',
    );
    const statuses: AcpAttachedTurnStatus[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => first,
          openSessionSubscription: async () => replacement,
        }),
    });
    try {
      await registry.resume(
        { sessionId, cwd: TEST_CWD },
        { ...promptContext([]), notifyTurnStatus: async (status) => void statuses.push(status) },
      );
      first.fail(new RuntimeHostSubscriptionError('connection_closed', 'Connection was lost'));
      await waitFor(() => statuses.some((status) => status.turnId === turn.turnId));
      assert.deepEqual(
        statuses.find((status) => status.turnId === turn.turnId),
        {
          sessionId,
          turnId: turn.turnId,
          runId: turn.runId,
          status: 'completed',
        },
      );
    } finally {
      replacement.setRoot(completedTurn(sessionId, 'next-turn'));
      await registry.dispose();
    }
  });

  test('explicit cancellation wins after a notification transport failure', async () => {
    const sessionId = 'session-cancel-failed-delivery';
    const turn = runningTurn(sessionId, 'turn-cancel-failed-delivery');
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    let stopped = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              subscription.setRoot(turn);
              subscription.appendToolStart(turn.turnId, turn.runId, 'tool');
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            if (operation === 'turn.stop') {
              stopped += 1;
              subscription.setRoot({
                ...turn,
                status: 'cancelled',
                terminalEventId: 'cancelled',
                abortSource: 'user',
              });
              return {};
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turn.turnId,
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    let cancellation: Promise<void> | undefined;
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'use the tool' }] },
      {
        signal: new AbortController().signal,
        notify: async ({ update }) => {
          if (update.sessionUpdate !== 'tool_call') return;
          cancellation = registry.cancel({ sessionId });
          throw new Error('notification transport failed');
        },
      },
    );
    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    await cancellation;
    assert.equal(stopped, 1);
    await registry.dispose();
  });

  test('latches cancellation while the real Session subscription is opening', async () => {
    const sessionId = 'session-cancel-before-attach';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const opening = deferred<RuntimeHostSessionSubscription>();
    let subscriptionOpens = 0;
    let turnStarts = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') turnStarts += 1;
            return {};
          },
          openSessionSubscriptionOnce: async () => {
            subscriptionOpens += 1;
            return opening.promise;
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => 'turn-cancelled',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'cancel me' }] },
      promptContext([]),
    );
    await waitFor(() => subscriptionOpens === 1);
    const cancellation = registry.cancel({ sessionId });
    opening.resolve(subscription);

    await cancellation;
    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.equal(turnStarts, 0);
    await registry.dispose();
    assert.equal(subscription.closeCalls, 1);
  });

  for (const method of ['load', 'resume', 'resumeTurn'] as const) {
    for (const phase of ['open', 'hydrate'] as const) {
      test(`aborting ${method} during ${phase} releases its attachment and allows retry`, {
        timeout: 10_000,
      }, async () => {
        const sessionId = `cancel-${method}-${phase}`;
        const transcript = deferred<StoredMessage[]>();
        const opening = deferred<RuntimeHostSessionSubscription>();
        const entered = deferred<void>();
        const closed = deferred<void>();
        const initial = new FakeSubscription(
          continuitySnapshot(sessionId),
          phase === 'hydrate' ? transcript.promise : Promise.resolve([]),
          'subscription-1',
          () => closed.resolve(),
        );
        initial.onTranscriptRead = () => entered.resolve();
        const retry = new FakeSubscription(continuitySnapshot(sessionId));
        const controller = new AbortController();
        let opens = 0;
        let starts = 0;
        const registry = new AcpSessionRegistry({
          newSessionId: () => sessionId,
          connect: async () =>
            fakeConnection({
              request: async (operation) => {
                if (operation === 'session.create') return catalogSession(sessionId);
                if (operation === 'session.catalog.query')
                  return { kind: 'session', session: catalogSession(sessionId) };
                if (operation === 'turn.resume.query')
                  return {
                    sessionId,
                    disposition: 'ready',
                    sourceRunId: 'source-run',
                    sourceTurnId: 'source-turn',
                    sourceRuntimeEventHighWater: 42,
                  };
                if (operation === 'turn.start' || operation === 'turn.resume.start') starts += 1;
                throw new Error(`Unexpected operation ${operation}`);
              },
              openSessionSubscriptionOnce: async () => {
                opens += 1;
                if (phase === 'open') entered.resolve();
                return opens > 1 ? retry : phase === 'open' ? opening.promise : initial;
              },
            }),
        });
        await registry.create({ cwd: TEST_CWD, mcpServers: [] });
        const request = registry[method](
          { sessionId, cwd: TEST_CWD, mcpServers: [] },
          { ...promptContext([]), signal: controller.signal },
        );
        const rejected = assert.rejects(request);
        try {
          await entered.promise;
          controller.abort();
          await rejected;
          if (phase === 'hydrate') assert.equal(initial.closeCalls, 1);
          // A late open is closed independently; it cannot occupy the retry slot.
          await registry.load({ sessionId, cwd: TEST_CWD, mcpServers: [] }, promptContext([]));
          assert.equal(opens, 2);
          opening.resolve(initial);
          transcript.resolve([]);
          await closed.promise;
          assert.equal(initial.closeCalls, 1);
          assert.equal(starts, 0);
          assert.equal(retry.closeCalls, 0);
        } finally {
          opening.resolve(initial);
          transcript.resolve([]);
          await registry.dispose();
          await rejected;
        }
      });
    }
  }

  for (const cancelledMethod of ['load', 'prompt'] as const) {
    for (const timing of ['before-wait', 'during-wait'] as const) {
      test(`aborting ${cancelledMethod} preserves a concurrent attachment consumer ${timing}`, async () => {
        const sessionId = `shared-load-${cancelledMethod}`;
        const transcript = deferred<StoredMessage[]>();
        const subscription = new FakeSubscription(
          continuitySnapshot(sessionId),
          transcript.promise,
        );
        const abort = new AbortController();
        let opens = 0;
        let admitted = 0;
        const registry = new AcpSessionRegistry({
          newSessionId: () => sessionId,
          newTurnId: () => 'shared-turn',
          connect: async () =>
            fakeConnection({
              request: async (operation, input) => {
                if (operation === 'session.create') return catalogSession(sessionId);
                if (operation === 'session.catalog.query')
                  return { kind: 'session', session: catalogSession(sessionId) };
                if (operation === 'turn.start') {
                  admitted += 1;
                  const turnId = (input as { turnId: string }).turnId;
                  const turn = runningTurn(sessionId, turnId);
                  subscription.setRoot(turn);
                  subscription.setRoot(completedTurn(sessionId, turnId));
                  return {
                    kind: 'started',
                    turn,
                    skillInvocation: { loaded: [], failed: [], receipts: [] },
                  };
                }
                throw new Error(`Unexpected operation ${operation}`);
              },
              openSessionSubscriptionOnce: async () => {
                opens += 1;
                return subscription;
              },
            }),
        });
        await registry.create({ cwd: TEST_CWD, mcpServers: [] });
        const loading = registry.load(
          { sessionId, cwd: TEST_CWD, mcpServers: [] },
          {
            ...promptContext([]),
            ...(cancelledMethod === 'load' ? { signal: abort.signal } : {}),
          },
        );
        void loading.catch(() => undefined);
        await waitFor(() => subscription.nextCalls > 0);
        const prompt = registry.prompt(
          { sessionId, prompt: [{ type: 'text', text: 'continue' }] },
          {
            ...promptContext([]),
            ...(cancelledMethod === 'prompt' ? { signal: abort.signal } : {}),
          },
        );
        try {
          if (timing === 'during-wait') await new Promise<void>((resolve) => setImmediate(resolve));
          abort.abort();
          if (cancelledMethod === 'load') await assert.rejects(loading);
          else assert.deepEqual(await prompt, { stopReason: 'cancelled' });
          assert.equal(subscription.closeCalls, 0);
          transcript.resolve([]);
          if (cancelledMethod === 'load')
            assert.deepEqual(await prompt, { stopReason: 'end_turn' });
          else await loading;
          assert.equal(opens, 1);
          assert.equal(admitted, cancelledMethod === 'load' ? 1 : 0);
          assert.equal(subscription.closeCalls, 0);
        } finally {
          transcript.resolve([]);
          await registry.dispose();
          await Promise.allSettled([loading, prompt]);
        }
      });
    }
  }
  test('aborting a prompt signal closes its pending initial transcript hydration', async () => {
    const sessionId = 'session-aborted-hydration';
    const transcript = deferred<StoredMessage[]>();
    const subscription = new FakeSubscription(continuitySnapshot(sessionId), transcript.promise);
    const abort = new AbortController();
    let turnStarts = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') turnStarts += 1;
            assert.fail(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
      newSessionId: () => sessionId,
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    let finished = false;
    const prompt = registry
      .prompt(
        { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
        { ...promptContext([]), signal: abort.signal },
      )
      .then((result) => {
        finished = true;
        return result;
      });
    try {
      await waitFor(() => subscription.nextCalls > 0);
      abort.abort();
      await waitFor(() => finished);
      assert.deepEqual(await prompt, { stopReason: 'cancelled' });
      assert.equal(subscription.closeCalls, 1);
      transcript.resolve([]);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(turnStarts, 0, 'late transcript completion must not admit the cancelled prompt');
    } finally {
      transcript.resolve([]);
      await registry.dispose();
      await prompt;
    }
  });

  test('aborting one prompt preserves the shared initial attachment for another prompt', async () => {
    const sessionId = 'session-shared-open-abort';
    const opening = deferred<RuntimeHostSessionSubscription>();
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const abort = new AbortController();
    let opens = 0;
    const starts: string[] = [];
    const turnIds = ['cancelled-turn', 'continuing-turn'];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              const turnId = (input as { turnId: string }).turnId;
              starts.push(turnId);
              const turn = runningTurn(sessionId, turnId);
              subscription.setRoot(turn);
              subscription.setRoot(completedTurn(sessionId, turnId));
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            assert.fail(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => {
            opens += 1;
            return opening.promise;
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turnIds.shift()!,
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const cancelled = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'cancel this one' }] },
      { ...promptContext([]), signal: abort.signal },
    );
    const continuing = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'continue this one' }] },
      promptContext([]),
    );
    try {
      await waitFor(() => opens === 1);
      abort.abort();
      opening.resolve(subscription);
      assert.deepEqual(await cancelled, { stopReason: 'cancelled' });
      assert.deepEqual(await continuing, { stopReason: 'end_turn' });
      assert.equal(opens, 1);
      assert.deepEqual(starts, ['continuing-turn']);
      assert.equal(subscription.closeCalls, 0);
    } finally {
      opening.resolve(subscription);
      await registry.dispose();
      await Promise.allSettled([cancelled, continuing]);
    }
  });

  test('a second prompt settling cannot reopen a cancelled Turn interaction replay', async () => {
    const sessionId = 'session-overlapping-interaction-cancel';
    const turnIds = ['turn-a', 'turn-b'];
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const stopEntered = deferred<void>();
    const stopRelease = deferred<void>();
    const abortA = new AbortController();
    const starts: string[] = [];
    let queries = 0;
    let dialogs = 0;
    let answers = 0;
    const pending: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'question-a',
      sessionId,
      turnId: 'turn-a',
      runId: 'run-turn-a',
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'question',
        toolUseId: 'tool-a',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    };
    const turnA = runningTurn(sessionId, 'turn-a');
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              const turnId = (input as { turnId: string }).turnId;
              starts.push(turnId);
              if (turnId === 'turn-b') {
                return {
                  kind: 'blocked',
                  skillInvocation: { loaded: [], failed: [], receipts: [] },
                };
              }
              subscription.setRoot(turnA);
              return {
                kind: 'started',
                turn: turnA,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            if (operation === 'turn.stop') {
              stopEntered.resolve();
              await stopRelease.promise;
              subscription.setRoot({
                ...turnA,
                status: 'cancelled',
                terminalEventId: 'cancelled-a',
                abortSource: 'user',
              });
              return {};
            }
            if (operation === 'interaction.query') {
              queries += 1;
              return pending;
            }
            if (operation === 'interaction.answer') {
              answers += 1;
              const answer = (input as { answer: { answers: readonly string[] } }).answer;
              return {
                ...pending,
                revision: 2,
                status: 'answered',
                outcome: {
                  kind: 'question_answer',
                  answers: answer.answers,
                  committedAt: 1,
                },
              };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turnIds.shift()!,
    });
    const interactions = {
      capabilities: { elicitation: { form: {} } },
      createElicitation: async () => {
        dialogs += 1;
        return { action: 'accept' as const, content: { q0: 'Yes' } };
      },
      requestPermission: async () => assert.fail('Unexpected permission request'),
    };
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const cancelled = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'cancel A' }] },
      { ...promptContext([]), signal: abortA.signal, interactions },
    );
    try {
      await waitFor(() => starts.includes('turn-a'));
      abortA.abort();
      await stopEntered.promise;
      await assert.rejects(
        registry.prompt(
          { sessionId, prompt: [{ type: 'text', text: 'block B' }] },
          { ...promptContext([]), interactions },
        ),
      );

      subscription.project({ interactions: { pending: [pending] } });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(queries, 0);
      assert.equal(dialogs, 0);
      assert.equal(answers, 0);
    } finally {
      stopRelease.resolve();
      assert.deepEqual(await cancelled, { stopReason: 'cancelled' });
      await registry.dispose();
    }
  });

  test('an externally resolved interaction cannot clear a cancelled Turn fence before settlement', async () => {
    const sessionId = 'session-same-turn-interaction-cancel';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const stopEntered = deferred<void>();
    const stopRelease = deferred<void>();
    const firstDialog = deferred<never>();
    const abort = new AbortController();
    const first: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'question-first',
      sessionId,
      turnId: 'turn-cancelled',
      runId: 'run-cancelled',
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'question',
        toolUseId: 'tool-first',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    };
    const second: InteractionPendingSnapshot = {
      ...first,
      interactionId: 'permission-second',
      request: {
        kind: 'permission',
        toolUseId: 'tool-second',
        prompt: {
          kind: 'tool_permission',
          toolName: 'fixture',
          category: 'read',
          reason: 'custom',
          review: { kind: 'path', operation: 'read', path: '/workspace/file' },
          rememberForTurnAllowed: false,
        },
      },
    };
    let current: InteractionSnapshot = first;
    let dialogs = 0;
    let permissionDialogs = 0;
    let answers = 0;
    const turn = runningTurn(sessionId, first.turnId, first.runId);
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              subscription.setRoot(turn);
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            if (operation === 'turn.stop') {
              stopEntered.resolve();
              await stopRelease.promise;
              subscription.setRoot({
                ...turn,
                status: 'cancelled',
                terminalEventId: 'cancelled',
                abortSource: 'user',
              });
              return {};
            }
            if (operation === 'interaction.query') return current;
            if (operation === 'interaction.answer') {
              answers += 1;
              return current;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turn.turnId,
    });
    const interactions = {
      capabilities: { elicitation: { form: {} } },
      createElicitation: async () => {
        dialogs += 1;
        return firstDialog.promise;
      },
      requestPermission: async (request: { options: readonly { optionId: string }[] }) => {
        permissionDialogs += 1;
        return {
          outcome: { outcome: 'selected' as const, optionId: request.options[0]!.optionId },
        };
      },
    };
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'cancel during interaction' }] },
      { ...promptContext([]), signal: abort.signal, interactions },
    );
    try {
      await waitFor(() => subscription.snapshot.rootTurn?.turnId === turn.turnId);
      subscription.project({ interactions: { pending: [first] } });
      await waitFor(() => dialogs === 1);
      abort.abort();
      await stopEntered.promise;

      current = {
        ...first,
        revision: 2,
        status: 'answered',
        outcome: { kind: 'question_answer', answers: ['External'], committedAt: 1 },
      };
      subscription.project({ interactions: { pending: [] } });
      await new Promise((resolve) => setImmediate(resolve));
      current = second;
      subscription.project({ interactions: { pending: [second] } });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(dialogs, 1);
      assert.equal(permissionDialogs, 0);
      assert.equal(answers, 0);
    } finally {
      stopRelease.resolve();
      assert.deepEqual(await prompt, { stopReason: 'cancelled' });
      await registry.dispose();
    }
  });

  test('a failed Stop keeps a cancelled Turn fenced after the ACP prompt settles', async () => {
    const sessionId = 'session-failed-stop-interaction';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const abort = new AbortController();
    const turn = runningTurn(sessionId, 'turn-failed-stop');
    const first: InteractionPendingSnapshot = {
      schemaVersion: 1,
      interactionId: 'question-before-stop',
      sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
      revision: 1,
      status: 'pending',
      outcome: null,
      request: {
        kind: 'question',
        toolUseId: 'tool-question',
        questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
      },
    };
    const second: InteractionPendingSnapshot = {
      ...first,
      interactionId: 'permission-after-stop',
      request: {
        kind: 'permission',
        toolUseId: 'tool-permission',
        prompt: {
          kind: 'tool_permission',
          toolName: 'fixture',
          category: 'read',
          reason: 'custom',
          review: { kind: 'path', operation: 'read', path: '/workspace/file' },
          rememberForTurnAllowed: false,
        },
      },
    };
    let dialogs = 0;
    let answers = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              subscription.setRoot(turn);
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            if (operation === 'turn.stop') throw new Error('Stop delivery failed');
            if (operation === 'interaction.query')
              return (input as { interactionId: string }).interactionId === first.interactionId
                ? first
                : second;
            if (operation === 'interaction.answer') {
              answers += 1;
              return second;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turn.turnId,
    });
    const interactions = {
      capabilities: { elicitation: { form: {} } },
      createElicitation: async () => {
        dialogs += 1;
        return new Promise<never>(() => undefined);
      },
      requestPermission: async (request: { options: readonly { optionId: string }[] }) => {
        dialogs += 1;
        return {
          outcome: { outcome: 'selected' as const, optionId: request.options[0]!.optionId },
        };
      },
    };
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'cancel while waiting' }] },
      { ...promptContext([]), signal: abort.signal, interactions },
    );
    try {
      await waitFor(() => subscription.snapshot.rootTurn?.turnId === turn.turnId);
      subscription.project({ interactions: { pending: [first] } });
      await waitFor(() => dialogs === 1);
      abort.abort();
      assert.deepEqual(await prompt, { stopReason: 'cancelled' });
      assert.equal(subscription.snapshot.rootTurn?.status, 'running');
      subscription.project({ interactions: { pending: [first, second] } });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(dialogs, 1);
      assert.equal(answers, 0);
    } finally {
      await registry.dispose();
    }
  });

  for (const action of ['close', 'dispose'] as const) {
    test(`${action} during real Session channel open prevents Turn admission`, async () => {
      const sessionId = `session-open-${action}`;
      const subscription = new FakeSubscription(continuitySnapshot(sessionId));
      const opening = deferred<RuntimeHostSessionSubscription>();
      let subscriptionOpens = 0;
      let turnStarts = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'turn.start') turnStarts += 1;
              return {};
            },
            openSessionSubscriptionOnce: async () => {
              subscriptionOpens += 1;
              return opening.promise;
            },
          }),
        newSessionId: () => sessionId,
        newTurnId: () => 'turn-never-admitted',
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const prompt = registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'cancel me' }] },
        promptContext([]),
      );
      await waitFor(() => subscriptionOpens === 1);
      const cleanup = action === 'close' ? registry.close({ sessionId }) : registry.dispose();
      opening.resolve(subscription);

      await cleanup;
      assert.deepEqual(await prompt, { stopReason: 'cancelled' });
      assert.equal(turnStarts, 0);
      assert.equal(subscription.closeCalls, 1);
      await registry.dispose();
    });
  }

  test('waits for the real channel root identity before issuing exactly one turn.stop', async () => {
    const sessionId = 'session-cancel-live';
    const turn = runningTurn(sessionId, 'turn-live', 'run-live');
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const start = deferred<unknown>();
    const stopInputs: unknown[] = [];
    let startRequests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              startRequests += 1;
              return start.promise;
            }
            if (operation === 'turn.stop') {
              stopInputs.push(input);
              subscription.setRoot({
                ...turn,
                status: 'cancelled',
                terminalEventId: 'terminal-live',
                abortSource: 'user',
              });
              return {};
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turn.turnId,
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'run' }] },
      promptContext([]),
    );
    await waitFor(() => startRequests === 1);
    const cancel = registry.cancel({ sessionId });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stopInputs, []);

    subscription.setRoot(turn);
    start.resolve({
      kind: 'started',
      turn,
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    });
    await cancel;
    await registry.cancel({ sessionId });
    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.deepEqual(stopInputs, [{ sessionId, turnId: turn.turnId, runId: turn.runId }]);
    await registry.dispose();
  });

  test('shutdown stops a late admission after closing its real Session channel', async () => {
    const sessionId = 'session-late-start';
    const turn = runningTurn(sessionId, 'turn-late', 'run-late');
    const start = deferred<unknown>();
    const stop = deferred<unknown>();
    const calls: string[] = [];
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    let startRequests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              startRequests += 1;
              return start.promise;
            }
            if (operation === 'turn.stop') {
              assert.deepEqual(input, { sessionId, turnId: turn.turnId, runId: turn.runId });
              calls.push('stop');
              return stop.promise;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
          close: async () => {
            calls.push('connection.close');
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => turn.turnId,
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'run' }] },
      promptContext([]),
    );
    await waitFor(() => startRequests === 1);
    const disposal = registry.dispose();
    await waitFor(() => subscription.closeCalls === 1);
    start.resolve({
      kind: 'started',
      turn,
      skillInvocation: { loaded: [], failed: [], receipts: [] },
    });
    try {
      await waitFor(() => calls.includes('stop'));
      assert.deepEqual(calls, ['stop']);
    } finally {
      stop.resolve({});
      await disposal;
    }

    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.deepEqual(calls, ['stop', 'connection.close']);
  });

  test('shutdown closes the Host when an outcome-unknown query never settles', async () => {
    const sessionId = 'session-pending-query-on-shutdown';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const start = deferred<unknown>();
    const query = deferred<unknown>();
    const calls: string[] = [];
    let startRequests = 0;
    let queries = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              startRequests += 1;
              return start.promise;
            }
            if (operation === 'turn.query') {
              queries += 1;
              return query.promise;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
          close: async () => {
            calls.push('connection.close');
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => 'turn-pending-query',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'run' }] },
      promptContext([]),
    );
    await waitFor(() => startRequests === 1);
    const disposal = registry.dispose();
    start.reject(
      new RuntimeHostRequestInterruptedError(
        'turn.start',
        'command',
        'dispatched',
        'connection_lost',
      ),
    );
    await waitFor(() => queries === 1);

    let settled = false;
    const outcome = Promise.all([disposal, prompt]).then((value) => {
      settled = true;
      return value;
    });
    try {
      await waitFor(() => settled);
      assert.deepEqual(calls, ['connection.close']);
      assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    } finally {
      query.resolve(completedTurn(sessionId, 'turn-pending-query'));
      await outcome;
    }
  });

  for (const admission of ['not_found', 'terminal', 'running'] as const) {
    test(`retries failed admission reads after healthy recovery until ${admission} is authoritative`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const sessionId = `session-admission-retry-${admission}`;
      const turn = runningTurn(sessionId, 'turn-unknown', 'run-authoritative');
      const first = new FakeSubscription(continuitySnapshot(sessionId));
      const replacement = new FakeSubscription(
        continuitySnapshot(sessionId),
        Promise.resolve([]),
        'subscription-recovered',
      );
      let queries = 0;
      let recoveries = 0;
      const stops: unknown[] = [];
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation, input) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'turn.start') {
                throw new RuntimeHostRequestInterruptedError(
                  'turn.start',
                  'command',
                  'dispatched',
                  'connection_lost',
                );
              }
              if (operation === 'turn.query') {
                queries += 1;
                if (queries <= 2) {
                  throw new RuntimeHostOperationError(
                    'turn.query',
                    'internal_failure',
                    'Temporary admission read failure',
                  );
                }
                if (admission === 'not_found') {
                  throw new RuntimeHostOperationError('turn.query', 'not_found', 'Not admitted');
                }
                return admission === 'running'
                  ? turn
                  : completedTurn(sessionId, turn.turnId, turn.runId);
              }
              if (operation === 'turn.stop') {
                stops.push(input);
                return completedTurn(sessionId, turn.turnId, turn.runId);
              }
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => first,
            openSessionSubscription: async () => {
              recoveries += 1;
              return replacement;
            },
          }),
        newSessionId: () => sessionId,
        newTurnId: () => turn.turnId,
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      let outcome: PromiseSettledResult<unknown> | undefined;
      const prompt = registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
        promptContext([]),
      );
      const observed = Promise.allSettled([prompt]).then(([result]) => {
        outcome = result;
      });
      try {
        await waitFor(() => queries === 1);
        first.fail(new RuntimeHostSubscriptionError('connection_closed', 'Connection was lost'));
        await waitFor(() => recoveries === 1 && replacement.nextCalls > 0);
        // No root and no further frames will arrive. Only another admission read
        // can establish whether the lost command ran; recovery itself is healthy.
        for (let attempt = 0; attempt < 12 && !outcome; attempt += 1) {
          t.mock.timers.tick(1_000);
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(outcome, 'a transient read failure must not strand the prompt');
        assert.equal(outcome.status, 'rejected');
        assert.ok(queries >= 3);
        assert.deepEqual(
          stops,
          admission === 'running' ? [{ sessionId, turnId: turn.turnId, runId: turn.runId }] : [],
        );
        await registry.close({ sessionId });
        assert.equal(replacement.closeCalls, 1);
        const settledQueries = queries;
        t.mock.timers.tick(60_000);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(queries, settledQueries, 'settled admission must cancel retry work');
      } finally {
        await registry.dispose();
        await observed;
      }
    });
  }

  for (const cleanup of ['prompt', 'cancel_and_close'] as const) {
    test(`persistent admission read failures let ${cleanup} finish`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      t.mock.method(console, 'error', () => undefined);
      const sessionId = 'session-admission-read-unavailable';
      const first = new FakeSubscription(continuitySnapshot(sessionId));
      const replacement = new FakeSubscription(
        continuitySnapshot(sessionId),
        Promise.resolve([]),
        'subscription-recovered',
      );
      let queries = 0;
      let recoveries = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'turn.start') {
                throw new RuntimeHostRequestInterruptedError(
                  'turn.start',
                  'command',
                  'dispatched',
                  'connection_lost',
                );
              }
              if (operation === 'turn.query') {
                queries += 1;
                throw new RuntimeHostOperationError(
                  'turn.query',
                  'internal_failure',
                  'Admission store unavailable',
                );
              }
              assert.fail(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => first,
            openSessionSubscription: async () => {
              recoveries += 1;
              return replacement;
            },
          }),
        newSessionId: () => sessionId,
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const prompt = registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
        promptContext([]),
      );
      void prompt.catch(() => undefined);
      await waitFor(() => queries === 1);
      first.fail(new RuntimeHostSubscriptionError('connection_closed', 'Connection was lost'));
      await waitFor(() => recoveries === 1 && replacement.nextCalls > 0);
      const operations: Promise<unknown>[] = [prompt];
      if (cleanup === 'cancel_and_close') {
        operations.push(registry.cancel({ sessionId }), registry.close({ sessionId }));
      }
      let outcomes: PromiseSettledResult<unknown>[] | undefined;
      const observed = Promise.allSettled(operations).then((results) => {
        outcomes = results;
      });
      try {
        for (let attempt = 0; attempt < 12 && !outcomes; attempt += 1) {
          t.mock.timers.tick(1_000);
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.ok(outcomes, 'unavailable admission facts need a finite failure outcome');
        if (cleanup === 'cancel_and_close') {
          assert.deepEqual(outcomes[0], {
            status: 'fulfilled',
            value: { stopReason: 'cancelled' },
          });
          assert.equal(outcomes[2]?.status, 'rejected', 'close must report an unconfirmed Stop');
        } else {
          assert.equal(
            outcomes[0]?.status,
            'rejected',
            'unknown admission needs an error response',
          );
          await registry.close({ sessionId });
        }
        assert.equal(replacement.closeCalls, 1, 'close must release its subscription on failure');
        const settledQueries = queries;
        t.mock.timers.tick(60_000);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(queries, settledQueries, 'closed sessions must not retain retry work');
      } finally {
        await registry.dispose();
        await observed;
      }
    });
  }

  for (const action of ['close', 'dispose'] as const) {
    test(`${action} closes the real Session channel when Stop delivery fails`, async (t) => {
      const diagnostic = t.mock.method(console, 'error', () => undefined);
      const sessionId = `session-stop-failure-${action}`;
      const turn = runningTurn(sessionId, 'turn-stop-failure', 'run-stop-failure');
      const subscription = new FakeSubscription(continuitySnapshot(sessionId));
      const stopFailure = new Error('stop failed');
      const stopInputs: unknown[] = [];
      let startResponses = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation, input, timeoutMs) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'turn.start') {
                subscription.setRoot(turn);
                await waitFor(() => subscription.nextCalls >= 2);
                startResponses += 1;
                return {
                  kind: 'started',
                  turn,
                  skillInvocation: { loaded: [], failed: [], receipts: [] },
                };
              }
              if (operation === 'turn.stop') {
                assert.equal(timeoutMs, 30_000);
                stopInputs.push(input);
                throw stopFailure;
              }
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => subscription,
          }),
        newSessionId: () => sessionId,
        newTurnId: () => turn.turnId,
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const prompt = registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'run' }] },
        promptContext([]),
      );
      await waitFor(() => startResponses === 1);

      const cleanup = action === 'close' ? registry.close({ sessionId }) : registry.dispose();
      const [cleanupOutcome] = await Promise.allSettled([cleanup]);
      if (action === 'close') {
        assert.equal(cleanupOutcome?.status, 'rejected');
        if (cleanupOutcome?.status === 'rejected') assert.equal(cleanupOutcome.reason, stopFailure);
        await assertInvalidParams(
          registry.prompt(
            { sessionId, prompt: [{ type: 'text', text: 'late' }] },
            promptContext([]),
          ),
          { reason: 'unknown_session' },
        );
      } else {
        assert.equal(cleanupOutcome?.status, 'fulfilled');
      }
      assert.deepEqual(await prompt, { stopReason: 'cancelled' });
      assert.deepEqual(stopInputs, [{ sessionId, turnId: turn.turnId, runId: turn.runId }]);
      assert.equal(subscription.closeCalls, 1);
      assert.equal(diagnostic.mock.callCount(), 1);
      await registry.dispose();
    });
  }

  test('retains a cancelled prompt until Stop delivery settles after a terminal event', async () => {
    const sessionId = 'cancel-before-stop-response';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const stop = deferred<unknown>();
    let started = false;
    let stopping = false;
    let connectionClosed = false;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              const turn = runningTurn(sessionId, 'turn');
              subscription.setRoot(turn);
              started = true;
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            if (operation === 'turn.stop') {
              stopping = true;
              subscription.setRoot(completedTurn(sessionId, 'turn'));
              return stop.promise;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
          close: async () => {
            connectionClosed = true;
          },
        }),
      newSessionId: () => sessionId,
      newTurnId: () => 'turn',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    let promptSettled = false;
    const prompt = registry
      .prompt({ sessionId, prompt: [{ type: 'text', text: 'run' }] }, promptContext([]))
      .then((result) => {
        promptSettled = true;
        return result;
      });
    await waitFor(() => started && subscription.nextCalls >= 2);
    // Allow the start response to settle before cancellation, as in a live stream.
    await new Promise((resolve) => setImmediate(resolve));
    const cancellation = registry.cancel({ sessionId });
    await waitFor(() => stopping);
    await new Promise((resolve) => setImmediate(resolve));
    const disposal = registry.dispose();
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(promptSettled, false, 'terminal observation must not discard pending Stop');
      assert.equal(connectionClosed, false, 'teardown must keep Stop transport alive');
    } finally {
      stop.resolve({});
      await Promise.all([cancellation, disposal]);
    }
    assert.deepEqual(await prompt, { stopReason: 'cancelled' });
    assert.equal(connectionClosed, true);
  });

  test('close and dispose retain an adopted Turn Stop after terminal observation', async () => {
    const sessionId = 'adopted-close-stop';
    const turnId = 'external-turn';
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: runningTurn(sessionId, turnId) }),
    );
    const stop = deferred<unknown>();
    let stopping = false;
    let connectionClosed = false;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'turn.stop') {
              stopping = true;
              subscription.setRoot(completedTurn(sessionId, turnId));
              return stop.promise;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
          close: async () => {
            connectionClosed = true;
          },
        }),
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    await registry.resume(
      { sessionId, cwd: TEST_CWD },
      {
        signal: new AbortController().signal,
        notify: async () => {
          throw new Error('Client notification delivery failed');
        },
      },
    );
    subscription.appendText(turnId, `run-${turnId}`, 'output', true);
    await waitFor(() => stopping);
    await new Promise<void>((resolve) => setImmediate(resolve));
    let closeSettled = false;
    const closing = registry.close({ sessionId }).then(() => {
      closeSettled = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(closeSettled, false, 'close must wait for the existing Stop response');
      const disposal = registry.dispose();
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(connectionClosed, false, 'Stop response must settle before transport close');
      void disposal.catch(() => undefined);
    } finally {
      stop.resolve({});
      await closing;
      await registry.dispose();
    }
    assert.equal(connectionClosed, true);
  });

  test('an adopted Turn Stop failure settles before close releases the connection', async () => {
    const sessionId = 'adopted-stop-failure';
    const turnId = 'external-turn';
    const subscription = new FakeSubscription(
      continuitySnapshot(sessionId, { rootTurn: runningTurn(sessionId, turnId) }),
    );
    const stop = deferred<unknown>();
    const stopFailure = new Error('Host connection lost during Stop');
    let stopping = false;
    let connectionClosed = false;
    const registry = new AcpSessionRegistry({
      newSessionId: () => sessionId,
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query')
              return { kind: 'session', session: catalogSession(sessionId) };
            if (operation === 'turn.stop') {
              stopping = true;
              subscription.setRoot(completedTurn(sessionId, turnId));
              return stop.promise;
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
          close: async () => {
            connectionClosed = true;
          },
        }),
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    await registry.resume(
      { sessionId, cwd: TEST_CWD },
      {
        signal: new AbortController().signal,
        notify: async () => {
          throw new Error('Client notification delivery failed');
        },
      },
    );
    subscription.appendText(turnId, `run-${turnId}`, 'output', true);
    await waitFor(() => stopping);
    const closing = registry.close({ sessionId });
    void closing.catch(() => undefined);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(connectionClosed, false);
    } finally {
      stop.reject(stopFailure);
      await assert.rejects(closing, (error) => error === stopFailure);
      await registry.dispose();
    }
    assert.equal(connectionClosed, true);
  });

  test('retires a failed real Session channel so the next prompt opens a fresh one', async () => {
    const sessionId = 'session-reattach';
    const first = new FakeSubscription(continuitySnapshot(sessionId));
    const second = new FakeSubscription(
      continuitySnapshot(sessionId),
      Promise.resolve([]),
      'subscription-2',
    );
    const subscriptions = [first, second];
    const stops: unknown[] = [];
    let opens = 0;
    let starts = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.stop') {
              stops.push(input);
              return {};
            }
            if (operation !== 'turn.start') throw new Error(`Unexpected operation ${operation}`);
            starts += 1;
            const turnId = (input as { turnId: string }).turnId;
            const turn = runningTurn(sessionId, turnId);
            const subscription = starts === 1 ? first : second;
            subscription.setRoot(turn);
            await waitFor(() => subscription.nextCalls >= 2);
            if (starts === 1) subscription.fail(new Error('subscription failed'));
            else subscription.setRoot(completedTurn(sessionId, turnId));
            return {
              kind: 'started',
              turn,
              skillInvocation: { loaded: [], failed: [], receipts: [] },
            };
          },
          openSessionSubscriptionOnce: async () => subscriptions[opens++]!,
        }),
      newSessionId: () => sessionId,
      newTurnId: (() => {
        const ids = ['turn-first', 'turn-second'];
        return () => ids.shift()!;
      })(),
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });

    await assert.rejects(
      registry.prompt({ sessionId, prompt: [{ type: 'text', text: 'first' }] }, promptContext([])),
      {
        data: { source: 'runtime_host', operation: 'subscription.open', code: 'internal_failure' },
      },
    );
    assert.deepEqual(
      await registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'second' }] },
        promptContext([]),
      ),
      { stopReason: 'end_turn' },
    );
    assert.equal(opens, 2);
    assert.equal(first.closeCalls, 1);
    assert.deepEqual(stops, [{ sessionId, turnId: 'turn-first', runId: 'run-turn-first' }]);
    await registry.dispose();
    assert.equal(second.closeCalls, 1);
  });

  for (const action of ['cancel', 'close', 'dispose'] as const) {
    test(`${action} stops an externally started root observed by an idle real channel`, async () => {
      const sessionId = `external-root-${action}`;
      const subscription = new FakeSubscription(continuitySnapshot(sessionId));
      const stops: unknown[] = [];
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation, input) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'turn.start') {
                const local = runningTurn(sessionId, 'local');
                subscription.setRoot(local);
                subscription.setRoot(completedTurn(sessionId, 'local'));
                return {
                  kind: 'started',
                  turn: local,
                  skillInvocation: { loaded: [], failed: [], receipts: [] },
                };
              }
              if (operation === 'turn.stop') {
                stops.push(input);
                return {};
              }
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => subscription,
          }),
        newSessionId: () => sessionId,
        newTurnId: () => 'local',
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      await registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
        promptContext([]),
      );
      const priorNextCalls = subscription.nextCalls;
      subscription.setRoot(runningTurn(sessionId, 'external', 'external-run'));
      await waitFor(() => subscription.nextCalls > priorNextCalls);

      if (action === 'dispose') await registry.dispose();
      else await registry[action]({ sessionId });
      assert.deepEqual(stops, [
        {
          sessionId,
          turnId: 'external',
          runId: 'external-run',
        },
      ]);
      subscription.setRoot(null);
      await registry.dispose();
    });
  }

  for (const action of ['cancel', 'close'] as const) {
    for (const stopFails of [false, true]) {
      test(`${action} retains the external root with a pending interaction when Stop ${stopFails ? 'fails' : 'succeeds'}`, async () => {
        const sessionId = `external-interaction-${action}-${stopFails}`;
        const subscription = new FakeSubscription(continuitySnapshot(sessionId));
        const external = runningTurn(sessionId, 'external', 'external-run');
        const stopFailure = new Error('External Stop failed');
        const stops: unknown[] = [];
        let failStop = stopFails;
        const registry = new AcpSessionRegistry({
          connect: async () =>
            fakeConnection({
              request: async (operation, input) => {
                if (operation === 'session.create') return catalogSession(sessionId);
                if (operation === 'turn.start') {
                  const local = runningTurn(sessionId, 'local');
                  subscription.setRoot(local);
                  subscription.setRoot(completedTurn(sessionId, 'local'));
                  return {
                    kind: 'started',
                    turn: local,
                    skillInvocation: { loaded: [], failed: [], receipts: [] },
                  };
                }
                if (operation === 'turn.stop') {
                  stops.push(input);
                  if (failStop) throw stopFailure;
                  subscription.project({
                    rootTurn: completedTurn(sessionId, external.turnId, external.runId),
                    interactions: { pending: [] },
                  });
                  return completedTurn(sessionId, external.turnId, external.runId);
                }
                throw new Error(`Unexpected operation ${operation}`);
              },
              openSessionSubscriptionOnce: async () => subscription,
            }),
          newSessionId: () => sessionId,
          newTurnId: () => 'local',
        });
        await registry.create({ cwd: TEST_CWD, mcpServers: [] });
        try {
          await registry.prompt(
            { sessionId, prompt: [{ type: 'text', text: 'attach' }] },
            promptContext([]),
          );
          const nextCalls = subscription.nextCalls;
          subscription.project({
            rootTurn: external,
            interactions: {
              pending: [
                {
                  schemaVersion: 1,
                  interactionId: 'external-question',
                  sessionId,
                  turnId: external.turnId,
                  runId: external.runId,
                  revision: 1,
                  status: 'pending',
                  outcome: null,
                  request: {
                    kind: 'question',
                    toolUseId: 'external-tool',
                    questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
                  },
                },
              ],
            },
          });
          await waitFor(() => subscription.nextCalls > nextCalls);
          if (action === 'close' && stopFails) {
            await assert.rejects(registry.close({ sessionId }), (error) => error === stopFailure);
          } else {
            await registry[action]({ sessionId });
          }
          assert.deepEqual(stops, [{ sessionId, turnId: external.turnId, runId: external.runId }]);
          assert.equal(subscription.closeCalls, action === 'close' ? 1 : 0);
          if (action === 'cancel') {
            // A failed notification cannot erase the identity needed by a later close.
            failStop = false;
            await registry.close({ sessionId });
            assert.equal(stops.length, stopFails ? 2 : 1);
            assert.equal(subscription.closeCalls, 1);
          }
        } finally {
          failStop = false;
          await registry.dispose();
        }
      });
    }
  }

  for (const failure of ['failed', 'stalled'] as const) {
    test(`keeps a real channel prompt streaming after a ${failure} configuration refresh`, async (t) => {
      t.mock.method(console, 'error', () => undefined);
      const sessionId = `refresh-live-${failure}`;
      const subscription = new FakeSubscription(continuitySnapshot(sessionId));
      const read = deferred<unknown>();
      const notifications: SessionNotification[] = [];
      let reads = 0;
      let startResponses = 0;
      let stops = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              if (operation === 'session.create') return catalogSession(sessionId);
              if (operation === 'session.catalog.query') {
                reads += 1;
                if (reads === 1) return read.promise;
                return {
                  kind: 'session',
                  session: catalogSession(sessionId, TEST_CWD, {
                    revision: 3,
                    permissionMode: 'bypass',
                  }),
                };
              }
              if (operation === 'turn.stop') {
                stops += 1;
                return {};
              }
              if (operation === 'turn.start') {
                const turn = runningTurn(sessionId, 'turn', 'run');
                subscription.setRoot(turn);
                startResponses += 1;
                return {
                  kind: 'started',
                  turn,
                  skillInvocation: { loaded: [], failed: [], receipts: [] },
                };
              }
              throw new Error(`Unexpected operation ${operation}`);
            },
            openSessionSubscriptionOnce: async () => subscription,
          }),
        newSessionId: () => sessionId,
        newTurnId: () => 'turn',
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });
      const prompt = registry.prompt(
        { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
        promptContext(notifications),
      );
      await waitFor(() => startResponses === 1);
      subscription.setMetadataRevision(2);
      await waitFor(() => reads === 1);
      if (failure === 'failed') read.reject(new Error('catalog unavailable'));
      subscription.appendText('turn', 'run', 'still streaming');
      await waitFor(() =>
        notifications.some(({ update }) => update.sessionUpdate === 'agent_message_chunk'),
      );
      assert.equal(stops, 0);
      assert.equal(subscription.closeCalls, 0);
      subscription.setRoot(completedTurn(sessionId, 'turn', 'run'));
      assert.deepEqual(await prompt, { stopReason: 'end_turn' });
      if (failure === 'failed') {
        subscription.setMetadataRevision(3);
        await waitFor(() =>
          notifications.some(({ update }) => update.sessionUpdate === 'config_option_update'),
        );
        assert.equal(reads, 2);
      } else {
        read.resolve({ kind: 'session', session: catalogSession(sessionId) });
      }
      await registry.dispose();
    });
  }

  test('suppresses a real channel configuration projection that finishes after close', async () => {
    const sessionId = 'closing-options';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const read = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    const notifications: SessionNotification[] = [];
    let reading = false;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query') {
              reading = true;
              return read.promise;
            }
            if (operation === 'turn.start') {
              const turn = runningTurn(sessionId, 'turn');
              subscription.setRoot(turn);
              subscription.setRoot(completedTurn(sessionId, 'turn'));
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
      newSessionId: () => sessionId,
      newTurnId: () => 'turn',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    await registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
      promptContext(notifications),
    );
    subscription.setMetadataRevision(2);
    await waitFor(() => reading);
    await registry.close({ sessionId });
    read.resolve({
      kind: 'session',
      session: catalogSession(sessionId, TEST_CWD, { revision: 2, permissionMode: 'bypass' }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(notifications, []);
    assert.equal(subscription.closeCalls, 1);
    await registry.dispose();
  });

  test('closing an active real channel prompt does not wait for a stalled configuration read', async () => {
    const sessionId = 'stalled-options';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    const read = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    const notifications: SessionNotification[] = [];
    let reading = false;
    let startResponses = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'session.catalog.query') {
              reading = true;
              return read.promise;
            }
            if (operation === 'turn.stop') return {};
            if (operation === 'turn.start') {
              const turn = runningTurn(sessionId, 'turn', 'run');
              subscription.setRoot(turn);
              subscription.setMetadataRevision(2);
              subscription.appendText('turn', 'run', 'pending');
              startResponses += 1;
              return {
                kind: 'started',
                turn,
                skillInvocation: { loaded: [], failed: [], receipts: [] },
              };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
      newSessionId: () => sessionId,
      newTurnId: () => 'turn',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
      promptContext(notifications),
    );
    await waitFor(() => reading && startResponses === 1);
    let closed = false;
    const closing = registry.close({ sessionId }).then(() => {
      closed = true;
    });
    try {
      await waitFor(() => closed);
      assert.deepEqual(await prompt, { stopReason: 'cancelled' });
      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]?.update.sessionUpdate, 'agent_message_chunk');
    } finally {
      read.resolve({
        kind: 'session',
        session: catalogSession(sessionId, TEST_CWD, { revision: 2 }),
      });
      await closing;
      await registry.dispose();
    }
  });

  test('maps real Session channel observation failures to stable ACP errors', async () => {
    const sessionId = 'observation-failure';
    const subscription = new FakeSubscription(continuitySnapshot(sessionId));
    let startRequests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession(sessionId);
            if (operation === 'turn.start') {
              startRequests += 1;
              return { kind: 'started' };
            }
            throw new Error(`Unexpected operation ${operation}`);
          },
          openSessionSubscriptionOnce: async () => subscription,
        }),
      newSessionId: () => sessionId,
      newTurnId: () => 'turn',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const prompt = registry.prompt(
      { sessionId, prompt: [{ type: 'text', text: 'hello' }] },
      promptContext([]),
    );
    await waitFor(() => startRequests === 1);
    subscription.fail(
      new RuntimeHostSubscriptionError('host_epoch_changed', 'Host identity changed'),
    );
    await assert.rejects(prompt, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'subscription.open',
        code: 'subscription_failure',
        reason: 'host_epoch_changed',
      });
      return true;
    });
    assert.equal(subscription.closeCalls, 1);
    await registry.dispose();
  });

  test('returns projected configuration and owns only a representable successful create', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    let subscriptionOpens = 0;
    const created = catalogSession('session-configured', TEST_CWD, {
      thinkingLevel: 'high',
      permissionMode: 'explore',
      collaborationMode: 'plan',
      orchestrationMode: 'swarm',
    });
    const registry = new AcpSessionRegistry({
      connect: async () => {
        const connection = fakeConnection({
          thinkingLevels: ['low', 'high'],
          request: async (operation, input) => {
            requests.push({ operation, input });
            return created;
          },
        });
        return {
          ...connection,
          openSessionSubscriptionOnce: async () => {
            subscriptionOpens += 1;
            throw new Error('PR 2 must not open a subscription');
          },
        } as AcpSessionRegistryConnection;
      },
      newSessionId: () => 'session-configured',
    });

    const response = await registry.create({ cwd: TEST_CWD, mcpServers: [] });

    assert.deepEqual(response, {
      sessionId: 'session-configured',
      configOptions: configOptions(
        {
          permission_mode: 'explore',
          thinking_level: 'high',
          collaboration_mode: 'plan',
          orchestration_mode: 'swarm',
        },
        ['low', 'high'],
      ),
    });
    assert.deepEqual(requests, [
      {
        operation: 'session.create',
        input: {
          sessionId: 'session-configured',
          workspace: { kind: 'host_path', path: TEST_CWD },
          modelTarget: { kind: 'default' },
        },
      },
    ]);
    assert.equal(subscriptionOpens, 0);
    await registry.dispose();
  });

  test('omits thinking configuration when the selected model declares no levels', async () => {
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          thinkingLevels: [],
          request: async (operation) => {
            assert.equal(operation, 'session.create');
            return catalogSession('session-no-thinking');
          },
        }),
      newSessionId: () => 'session-no-thinking',
    });

    const response = await registry.create({ cwd: TEST_CWD, mcpServers: [] });

    assert.deepEqual(
      response.configOptions?.map(({ id }) => id),
      ['permission_mode', 'collaboration_mode', 'orchestration_mode'],
    );
    await registry.dispose();
  });

  test('does not grant ownership by listing a Session', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {
              kind: 'page',
              revision: SESSION_REVISION,
              sessions: [catalogSession('listed-session')],
              nextCursor: null,
            };
          },
        }),
    });
    await registry.list({});

    await assertInvalidParams(
      registry.setConfigOption({
        sessionId: 'listed-session',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      { reason: 'unknown_session' },
    );
    assert.equal(requests, 1);
    await registry.dispose();
  });

  test('keeps failed creates unowned and returns committed IDs even for unsupported projections', async () => {
    for (const [name, createOutcome] of [
      [
        'failed',
        new RuntimeHostOperationError('session.create', 'operation_conflict', 'create failed'),
      ],
      [
        'legacy',
        {
          kind: 'unsupported_legacy_record',
          id: 'session-legacy',
          revision: 1,
          reason: 'not_wire_representable',
        },
      ],
    ] as const) {
      let requests = 0;
      const sessionId = `session-${name}`;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              requests += 1;
              if (createOutcome instanceof Error) throw createOutcome;
              return createOutcome;
            },
          }),
        newSessionId: () => sessionId,
      });

      if (!(createOutcome instanceof Error)) {
        assert.deepEqual(await registry.create({ cwd: TEST_CWD, mcpServers: [] }), {
          sessionId,
        });
        await registry.close({ sessionId });
        assert.equal(requests, 1);
        await registry.dispose();
        continue;
      }
      await assert.rejects(registry.create({ cwd: TEST_CWD, mcpServers: [] }));
      await assertInvalidParams(
        registry.setConfigOption({
          sessionId,
          configId: 'permission_mode',
          value: 'bypass',
        }),
        { reason: 'unknown_session' },
      );
      assert.equal(requests, 1);
      await registry.dispose();
    }
  });

  test('returns the committed ID on catalog failure without admitting mutations during projection', async () => {
    const catalog = deferred<never>();
    let projecting = false;
    const connection = fakeConnection({ request: async () => catalogSession('created') });
    const request = connection.request;
    connection.request = (async (operation, input) => {
      if (operation === 'connection.catalog.query') {
        projecting = true;
        return catalog.promise;
      }
      return request(operation, input);
    }) as AcpSessionRegistryConnection['request'];
    const registry = new AcpSessionRegistry({
      connect: async () => connection,
      newSessionId: () => 'created',
    });
    const creation = registry.create({ cwd: TEST_CWD, mcpServers: [] });
    await waitFor(() => projecting);
    await assertInvalidParams(
      registry.setConfigOption({
        sessionId: 'created',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      { reason: 'unknown_session' },
    );
    catalog.reject(new Error('catalog unavailable'));
    assert.deepEqual(await creation, { sessionId: 'created' });
    assert.deepEqual(await registry.close({ sessionId: 'created' }), {});
    await registry.dispose();
  });

  test('rejects non-owned and invalid configuration requests before Host I/O', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return catalogSession('session-owned');
          },
        }),
      newSessionId: () => 'session-owned',
    });

    await assertInvalidParams(
      registry.setConfigOption({
        sessionId: 'session-unowned',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      { reason: 'unknown_session' },
    );
    assert.equal(requests, 0);

    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    assert.equal(requests, 1);
    for (const [request, data] of [
      [
        { sessionId: 'session-owned', configId: 'unknown', value: 'bypass' },
        { field: 'configId', reason: 'unsupported' },
      ],
      [
        {
          sessionId: 'session-owned',
          configId: 'permission_mode',
          value: true,
          type: 'boolean',
        },
        { field: 'value', reason: 'invalid_type' },
      ],
      [
        { sessionId: 'session-owned', configId: 'permission_mode', value: 'maybe' },
        { field: 'value', reason: 'unsupported' },
      ],
    ] as const) {
      await assertInvalidParams(
        registry.setConfigOption(request as SetSessionConfigOptionRequest),
        data,
      );
      assert.equal(requests, 1);
    }
    await registry.dispose();
  });

  test('updates one configuration field with the latest revision and returns committed options', async () => {
    const current = catalogSession('session-cas', TEST_CWD, {
      revision: 7,
      thinkingLevel: 'minimal',
    });
    const committed = catalogSession('session-cas', TEST_CWD, {
      revision: 8,
      permissionMode: 'bypass',
      thinkingLevel: 'high',
    });
    const requests: Array<{ operation: string; input: unknown }> = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-cas');
            if (operation === 'session.catalog.query') {
              return { kind: 'session', session: current };
            }
            return { kind: 'committed', session: committed };
          },
        }),
      newSessionId: () => 'session-cas',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });

    const response = await registry.setConfigOption({
      sessionId: 'session-cas',
      configId: 'permission_mode',
      value: 'bypass',
    });

    assert.deepEqual(requests.slice(1), [
      {
        operation: 'session.catalog.query',
        input: { kind: 'get', sessionId: 'session-cas' },
      },
      {
        operation: 'session.configuration.update',
        input: {
          sessionId: 'session-cas',
          expectedRevision: 7,
          patch: { permissionMode: 'bypass' },
        },
      },
    ]);
    assert.deepEqual(response, {
      configOptions: configOptions({ permission_mode: 'bypass', thinking_level: 'high' }),
    });
    await registry.dispose();
  });

  test('rereads the Session after one revision conflict before retrying', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    let reads = 0;
    let updates = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-retry');
            if (operation === 'session.catalog.query') {
              reads += 1;
              return {
                kind: 'session',
                session: catalogSession('session-retry', TEST_CWD, {
                  revision: reads,
                  collaborationMode: reads === 1 ? 'agent' : 'plan',
                }),
              };
            }
            updates += 1;
            return updates === 1
              ? { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 }
              : {
                  kind: 'committed',
                  session: catalogSession('session-retry', TEST_CWD, {
                    revision: 3,
                    permissionMode: 'bypass',
                    collaborationMode: 'plan',
                  }),
                };
          },
        }),
      newSessionId: () => 'session-retry',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });

    await registry.setConfigOption({
      sessionId: 'session-retry',
      configId: 'permission_mode',
      value: 'bypass',
    });

    assert.deepEqual(
      requests.slice(1).map(({ operation }) => operation),
      [
        'session.catalog.query',
        'session.configuration.update',
        'session.catalog.query',
        'session.configuration.update',
      ],
    );
    assert.deepEqual(requests[4]?.input, {
      sessionId: 'session-retry',
      expectedRevision: 2,
      patch: { permissionMode: 'bypass' },
    });
    await registry.dispose();
  });

  test('concurrent different-field changes converge through one-field CAS patches', async () => {
    const firstReads = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    const requests: Array<{ operation: string; input: unknown }> = [];
    let reads = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-converge');
            if (operation === 'session.catalog.query') {
              reads += 1;
              if (reads <= 2) {
                if (reads === 2) {
                  firstReads.resolve({
                    kind: 'session',
                    session: catalogSession('session-converge'),
                  });
                }
                return firstReads.promise;
              }
              return {
                kind: 'session',
                session: catalogSession('session-converge', TEST_CWD, {
                  revision: 2,
                  permissionMode: 'bypass',
                }),
              };
            }
            const patch = (input as { patch: Record<string, unknown> }).patch;
            if ('permissionMode' in patch) {
              return {
                kind: 'committed',
                session: catalogSession('session-converge', TEST_CWD, {
                  revision: 2,
                  permissionMode: 'bypass',
                }),
              };
            }
            if ((input as { expectedRevision: number }).expectedRevision === 1) {
              return { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 };
            }
            return {
              kind: 'committed',
              session: catalogSession('session-converge', TEST_CWD, {
                revision: 3,
                permissionMode: 'bypass',
                collaborationMode: 'plan',
              }),
            };
          },
        }),
      newSessionId: () => 'session-converge',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });

    const [permission, collaboration] = await Promise.all([
      registry.setConfigOption({
        sessionId: 'session-converge',
        configId: 'permission_mode',
        value: 'bypass',
      }),
      registry.setConfigOption({
        sessionId: 'session-converge',
        configId: 'collaboration_mode',
        value: 'plan',
      }),
    ]);

    const updates = requests.filter(
      ({ operation }) => operation === 'session.configuration.update',
    );
    assert.deepEqual(
      updates.map(({ input }) => (input as { patch: unknown }).patch),
      [{ permissionMode: 'bypass' }, { collaborationMode: 'plan' }, { collaborationMode: 'plan' }],
    );
    assert.deepEqual(permission, {
      configOptions: configOptions({ permission_mode: 'bypass' }),
    });
    assert.deepEqual(collaboration, {
      configOptions: configOptions({
        permission_mode: 'bypass',
        collaboration_mode: 'plan',
      }),
    });
    await registry.dispose();
  });

  test('stops after three revision conflicts without a fourth Host operation', async () => {
    const requests: Array<{ operation: string; input: unknown }> = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            requests.push({ operation, input });
            if (operation === 'session.create') return catalogSession('session-conflicts');
            if (operation === 'session.catalog.query') {
              return { kind: 'session', session: catalogSession('session-conflicts') };
            }
            return { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 };
          },
        }),
      newSessionId: () => 'session-conflicts',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });

    await assert.rejects(
      registry.setConfigOption({
        sessionId: 'session-conflicts',
        configId: 'thinking_level',
        value: 'off',
      }),
      (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, -32603);
        assert.deepEqual(error.data, {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'revision_conflict',
          attempts: 3,
        });
        return true;
      },
    );
    assert.deepEqual(
      requests.slice(1).map(({ operation }) => operation),
      [
        'session.catalog.query',
        'session.configuration.update',
        'session.catalog.query',
        'session.configuration.update',
        'session.catalog.query',
        'session.configuration.update',
      ],
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 7);
    await registry.dispose();
  });

  test('rejects invalid, missing, and legacy catalog lookup results with stable errors', async () => {
    for (const [name, result, acpCode, data] of [
      [
        'invalid',
        {
          kind: 'page',
          revision: SESSION_REVISION,
          sessions: [],
          nextCursor: null,
        },
        -32603,
        {
          source: 'runtime_host',
          operation: 'session.catalog.query',
          code: 'catalog_read_failure',
          reason: 'invalid_projection',
        },
      ],
      [
        'missing',
        { kind: 'session', session: null },
        -32602,
        {
          source: 'runtime_host',
          operation: 'session.catalog.query',
          code: 'not_found',
        },
      ],
      [
        'legacy',
        {
          kind: 'session',
          session: {
            kind: 'unsupported_legacy_record',
            id: 'session-legacy',
            revision: 1,
            reason: 'not_wire_representable',
          },
        },
        -32603,
        {
          source: 'runtime_host',
          operation: 'session.catalog.query',
          code: 'unsupported_session_projection',
        },
      ],
    ] as const) {
      const sessionId = `session-${name}`;
      let requests = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              requests += 1;
              return operation === 'session.create' ? catalogSession(sessionId) : result;
            },
          }),
        newSessionId: () => sessionId,
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });

      await assert.rejects(
        registry.setConfigOption({
          sessionId,
          configId: 'permission_mode',
          value: 'bypass',
        }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.code, acpCode);
          assert.deepEqual(error.data, data);
          return true;
        },
      );
      assert.equal(requests, 2);
      await registry.dispose();
    }
  });

  test('maps configuration Host failures without retrying them', async () => {
    for (const [hostError, acpCode, data] of [
      [
        new RuntimeHostOperationError(
          'session.configuration.update',
          'invalid_request',
          'invalid update',
        ),
        -32602,
        {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'invalid_request',
        },
      ],
      [
        new RuntimeHostOperationError(
          'session.configuration.update',
          'not_found',
          'missing Session',
        ),
        -32602,
        {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'not_found',
        },
      ],
      ...(['session_busy', 'operation_conflict', 'commit_outcome_unknown'] as const).map(
        (code) =>
          [
            new RuntimeHostOperationError('session.configuration.update', code, 'update failed'),
            -32603,
            {
              source: 'runtime_host',
              operation: 'session.configuration.update',
              code,
            },
          ] as const,
      ),
      [
        new RuntimeHostRequestInterruptedError(
          'session.configuration.update',
          'command',
          'dispatched',
          'connection_lost',
        ),
        -32603,
        {
          source: 'runtime_host',
          operation: 'session.configuration.update',
          code: 'request_interrupted',
          reason: 'connection_lost',
          dispatch: 'dispatched',
        },
      ],
    ] as const) {
      let requests = 0;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation) => {
              requests += 1;
              if (operation === 'session.create') return catalogSession('session-errors');
              if (operation === 'session.catalog.query') {
                return { kind: 'session', session: catalogSession('session-errors') };
              }
              throw hostError;
            },
          }),
        newSessionId: () => 'session-errors',
      });
      await registry.create({ cwd: TEST_CWD, mcpServers: [] });

      await assert.rejects(
        registry.setConfigOption({
          sessionId: 'session-errors',
          configId: 'permission_mode',
          value: 'bypass',
        }),
        (error: unknown) => {
          assert.ok(error instanceof RequestError);
          assert.equal(error.code, acpCode);
          assert.deepEqual(error.data, data);
          return true;
        },
      );
      assert.equal(requests, 3);
      await registry.dispose();
    }
  });

  test('does not start an update after disposal begins during its catalog read', async () => {
    const catalogRead = deferred<{ kind: 'session'; session: SessionCatalogProjection }>();
    let catalogReads = 0;
    let updates = 0;
    let closeCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('session-closing');
            if (operation === 'session.catalog.query') {
              catalogReads += 1;
              return catalogRead.promise;
            }
            updates += 1;
            return {
              kind: 'committed',
              session: catalogSession('session-closing', TEST_CWD, { revision: 2 }),
            };
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      newSessionId: () => 'session-closing',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const update = registry.setConfigOption({
      sessionId: 'session-closing',
      configId: 'permission_mode',
      value: 'bypass',
    });
    await waitFor(() => catalogReads === 1);

    const dispose = registry.dispose();
    catalogRead.resolve({
      kind: 'session',
      session: catalogSession('session-closing'),
    });

    await assert.rejects(update, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'session.configuration.update',
        code: 'registry_closed',
      });
      return true;
    });
    await dispose;
    assert.equal(updates, 0);
    assert.equal(closeCalls, 1);
  });

  test('does not reread after a held update conflicts during disposal', async () => {
    const heldUpdate = deferred<{
      kind: 'revision_conflict';
      expectedRevision: number;
      actualRevision: number;
    }>();
    let catalogReads = 0;
    let updates = 0;
    let closeCalls = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation) => {
            if (operation === 'session.create') return catalogSession('session-conflict-closing');
            if (operation === 'session.catalog.query') {
              catalogReads += 1;
              if (catalogReads === 1) {
                return {
                  kind: 'session',
                  session: catalogSession('session-conflict-closing'),
                };
              }
              throw new RuntimeHostRequestInterruptedError(
                'session.catalog.query',
                'query',
                'dispatched',
                'connection_lost',
              );
            }
            updates += 1;
            return heldUpdate.promise;
          },
          close: async () => {
            closeCalls += 1;
          },
        }),
      newSessionId: () => 'session-conflict-closing',
    });
    await registry.create({ cwd: TEST_CWD, mcpServers: [] });
    const update = registry.setConfigOption({
      sessionId: 'session-conflict-closing',
      configId: 'permission_mode',
      value: 'bypass',
    });
    await waitFor(() => updates === 1);

    const dispose = registry.dispose();
    heldUpdate.resolve({ kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 });

    await assert.rejects(update, (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32603);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'session.configuration.update',
        code: 'registry_closed',
      });
      return true;
    });
    await dispose;
    assert.equal(catalogReads, 1);
    assert.equal(updates, 1);
    assert.equal(closeCalls, 1);
  });

  test('rejects unsupported creation inputs before touching Runtime Host', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {};
          },
        }),
    });

    const cases: Array<readonly [string, NewSessionRequest]> = [
      [
        'mcpServers',
        {
          cwd: TEST_CWD,
          mcpServers: [{ name: 'server', command: 'server', args: [], env: [] }],
        },
      ],
      [
        'additionalDirectories',
        {
          cwd: TEST_CWD,
          mcpServers: [],
          additionalDirectories: ['/other'],
        },
      ],
      ['cwd', { cwd: 'relative', mcpServers: [] }],
      [
        'cwd',
        {
          cwd: `/${'x'.repeat(SESSION_CATALOG_CWD_MAX_BYTES)}`,
          mcpServers: [],
        },
      ],
    ];
    for (const [field, input] of cases) {
      await assert.rejects(
        registry.create(input),
        (error: unknown) =>
          error instanceof RequestError &&
          error.code === -32602 &&
          (error.data as { field?: string }).field === field,
      );
    }
    assert.equal(requests, 0);
    await registry.dispose();
  });

  test('keeps failed and outcome-unknown creates distinct', async () => {
    for (const [hostCode, acpCode] of [
      ['invalid_request', -32602],
      ['commit_outcome_unknown', -32603],
    ] as const) {
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              throw new RuntimeHostOperationError('session.create', hostCode, 'create failed');
            },
          }),
        newSessionId: () => `session-${hostCode}`,
      });

      await assert.rejects(registry.create({ cwd: TEST_CWD, mcpServers: [] }), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, acpCode);
        assert.deepEqual(error.data, {
          source: 'runtime_host',
          operation: 'session.create',
          code: hostCode,
          sessionId: `session-${hostCode}`,
        });
        return true;
      });
      await registry.dispose();
    }
  });

  test('maps one filtered Host catalog page per ACP page and carries cwd across pages', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'maka-acp-list-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace');
    const alias = join(root, 'workspace-alias');
    await mkdir(workspace);
    await symlink(workspace, alias);
    const canonicalWorkspace = await realpath(workspace);
    const inputs: unknown[] = [];
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async (operation, input) => {
            assert.equal(operation, 'session.catalog.query');
            inputs.push(input);
            if ((input as { kind: string }).kind === 'list_start') {
              return {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [
                  catalogSession('other', join(root, 'other'), {
                    name: 'Other',
                    activityAt: 1_000,
                  }),
                  {
                    kind: 'unsupported_legacy_record',
                    id: 'legacy',
                    revision: 1,
                    reason: 'not_wire_representable',
                  },
                ],
                nextCursor: 'page-2',
              };
            }
            return {
              kind: 'page',
              revision: SESSION_REVISION,
              sessions: [
                catalogSession('matching', canonicalWorkspace, {
                  name: 'Matching session',
                  activityAt: 2_000,
                }),
                catalogSession('undated', canonicalWorkspace, {
                  name: 'Out-of-range activity',
                  activityAt: Number.MAX_SAFE_INTEGER,
                }),
              ],
              nextCursor: null,
            };
          },
        }),
    });

    const first = await registry.list({ cwd: alias });
    assert.deepEqual(first.sessions, []);
    assert.equal(typeof first.nextCursor, 'string');
    const second = await registry.list({ cursor: first.nextCursor });
    assert.deepEqual(second, {
      sessions: [
        {
          sessionId: 'matching',
          cwd: canonicalWorkspace,
          title: 'Matching session',
          updatedAt: '1970-01-01T00:00:02.000Z',
        },
        {
          sessionId: 'undated',
          cwd: canonicalWorkspace,
          title: 'Out-of-range activity',
        },
      ],
    });
    assert.deepEqual(inputs, [
      { kind: 'list_start' },
      { kind: 'list_continue', revision: SESSION_REVISION, cursor: 'page-2' },
    ]);
    await registry.dispose();
  });

  test('rejects a cursor reused with a different normalized cwd before Host I/O', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {
              kind: 'page',
              revision: SESSION_REVISION,
              sessions: [],
              nextCursor: 'page-2',
            };
          },
        }),
    });
    const first = await registry.list({ cwd: '/workspace/one/../one' });

    await assert.rejects(
      registry.list({ cwd: '/workspace/two', cursor: first.nextCursor }),
      (error: unknown) =>
        error instanceof RequestError &&
        error.code === -32602 &&
        (error.data as { reason?: string }).reason === 'cursor_cwd_mismatch',
    );
    assert.equal(requests, 1);
    await registry.dispose();
  });

  test('rejects malformed and oversized ACP cursors as invalid params', async () => {
    let requests = 0;
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            requests += 1;
            return {};
          },
        }),
    });
    const invalidRevisionCursor = Buffer.from(
      JSON.stringify({
        revision: 'sha256:bad',
        cursor: 'page-2',
        cwd: null,
      }),
      'utf8',
    ).toString('base64url');
    const versionedCursor = Buffer.from(
      JSON.stringify({
        v: 1,
        revision: SESSION_REVISION,
        cursor: 'page-2',
        cwd: null,
      }),
      'utf8',
    ).toString('base64url');
    for (const cursor of [
      'not-a-cursor',
      'x'.repeat(8 * 1024 + 1),
      invalidRevisionCursor,
      versionedCursor,
    ]) {
      await assert.rejects(
        registry.list({ cursor }),
        (error: unknown) =>
          error instanceof RequestError &&
          error.code === -32602 &&
          (error.data as { reason?: string }).reason === 'invalid_cursor',
      );
    }
    assert.equal(requests, 0);
    await registry.dispose();
  });

  test('translates stale and repeated Host cursors into stable ACP errors', async () => {
    for (const [nextResult, expectedCode, expectedReason] of [
      [
        {
          kind: 'revision_changed',
          expectedRevision: SESSION_REVISION,
          actualRevision: NEW_SESSION_REVISION,
        },
        -32602,
        'stale_cursor',
      ],
      [
        {
          kind: 'page',
          revision: SESSION_REVISION,
          sessions: [],
          nextCursor: 'page-2',
        },
        -32603,
        'repeated_cursor',
      ],
    ] as const) {
      let first = true;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async () => {
              if (!first) return nextResult;
              first = false;
              return {
                kind: 'page',
                revision: SESSION_REVISION,
                sessions: [],
                nextCursor: 'page-2',
              };
            },
          }),
      });
      const page = await registry.list({});
      await assert.rejects(registry.list({ cursor: page.nextCursor }), (error: unknown) => {
        assert.ok(error instanceof RequestError);
        assert.equal(error.code, expectedCode);
        assert.equal((error.data as { reason?: string; code?: string }).reason, expectedReason);
        return true;
      });
      await registry.dispose();
    }
  });

  test('maps Runtime Host invalid_request from session/list to invalid params', async () => {
    const registry = new AcpSessionRegistry({
      connect: async () =>
        fakeConnection({
          request: async () => {
            throw new RuntimeHostOperationError(
              'session.catalog.query',
              'invalid_request',
              'invalid query',
            );
          },
        }),
    });

    await assert.rejects(registry.list({}), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.code, -32602);
      assert.deepEqual(error.data, {
        source: 'runtime_host',
        operation: 'session.catalog.query',
        code: 'invalid_request',
      });
      return true;
    });
    await registry.dispose();
  });
  for (const action of ['cancel', 'close', 'abort'] as const) {
    test(`${action} during resource upload aborts staging without starting a Turn`, async () => {
      const workspace = await mkdtemp(join(tmpdir(), 'maka-acp-upload-lifecycle-'));
      const file = join(workspace, 'notes.txt');
      await writeFile(file, 'read this file');
      const sessionId = `session-upload-${action}`;
      const subscription = new FakeSubscription(continuitySnapshot(sessionId));
      const uploadStarted = deferred<void>();
      const upload = deferred<unknown>();
      const operations: string[] = [];
      let uploadId: string | undefined;
      const registry = new AcpSessionRegistry({
        connect: async () =>
          fakeConnection({
            request: async (operation, input) => {
              if (operation === 'session.create') return catalogSession(sessionId, workspace);
              assert.equal(
                operation,
                'artifact.ingest',
                'upload cancellation must prevent turn.start',
              );
              const request = input as { kind: string; uploadId: string };
              operations.push(request.kind);
              if (request.kind === 'begin') {
                uploadId = request.uploadId;
                uploadStarted.resolve();
                return upload.promise;
              }
              assert.equal(request.kind, 'abort');
              assert.equal(request.uploadId, uploadId);
              return { kind: 'upload_aborted', uploadId };
            },
            openSessionSubscriptionOnce: async () => subscription,
          }),
        newSessionId: () => sessionId,
      });
      const abort = new AbortController();
      let prompt: Promise<unknown> | undefined;
      try {
        await registry.create({ cwd: workspace, mcpServers: [] });
        prompt = registry.prompt(
          {
            sessionId,
            prompt: [{ type: 'resource_link', uri: pathToFileURL(file).href, name: 'notes.txt' }],
          },
          { signal: abort.signal, notify: async () => undefined },
        );
        void prompt.catch(() => undefined);
        await uploadStarted.promise;
        if (action === 'abort') abort.abort();
        else await registry[action]({ sessionId });
        upload.resolve({ kind: 'upload_opened', uploadId, nextOffset: 0 });
        assert.deepEqual(await prompt, { stopReason: 'cancelled' });
        assert.deepEqual(operations, ['begin', 'abort']);
      } finally {
        upload.resolve({ kind: 'upload_opened', uploadId, nextOffset: 0 });
        await registry.dispose();
        await prompt?.catch(() => undefined);
        await rm(workspace, { recursive: true, force: true });
      }
    });
  }
});

function fakeConnection(
  overrides: {
    request?: (operation: string, input: unknown, timeoutMs?: number) => Promise<unknown>;
    close?: () => Promise<void>;
    thinkingLevels?: readonly ThinkingLevel[];
    openSessionSubscription?: AcpSessionRegistryConnection['openSessionSubscription'];
    openSessionSubscriptionOnce?: AcpSessionRegistryConnection['openSessionSubscriptionOnce'];
    subscribeConnectionAvailability?: AcpSessionRegistryConnection['subscribeConnectionAvailability'];
  } = {},
): AcpSessionRegistryConnection {
  return {
    reconnecting: true,
    replaceClientCapabilities: async () => ({ registrationId: 'registration-1', revision: 1 }),
    unregisterClientCapabilities: async () => ({ registrationId: 'registration-1', revision: 2 }),
    subscribeConnectionAvailability:
      overrides.subscribeConnectionAvailability ??
      ((listener) => {
        listener({ kind: 'connected', hostEpoch: 'host-1', connectionId: 'connection-1' });
        return () => undefined;
      }),
    request: async (operation: string, input: unknown, timeoutMs?: number) =>
      operation === 'connection.catalog.query'
        ? connectionCatalogPage(overrides.thinkingLevels ?? THINKING_LEVELS)
        : (overrides.request?.(operation, input, timeoutMs) ?? {}),
    openSessionSubscription:
      overrides.openSessionSubscription ??
      (async () => {
        throw new Error('Unexpected recoverable subscription open');
      }),
    openSessionSubscriptionOnce:
      overrides.openSessionSubscriptionOnce ??
      overrides.openSessionSubscription ??
      (async () => {
        throw new Error('Unexpected initial subscription open');
      }),
    close: overrides.close ?? (async () => undefined),
  } as unknown as AcpSessionRegistryConnection;
}

function promptContext(notifications: SessionNotification[]) {
  return {
    signal: new AbortController().signal,
    notify: async (notification: SessionNotification) => void notifications.push(notification),
  };
}

class FakeSubscription implements RuntimeHostSessionSubscription, AsyncIterator<SubscriptionFrame> {
  readonly hostEpoch = 'host-1';
  readonly activeAssistantStreams = [];
  transcriptBootstrap: SessionTranscriptBootstrap | null = null;
  #transcriptWatermark: number | null = null;
  readonly #frames: SubscriptionFrame[] = [];
  readonly #waiters: Array<{
    resolve(result: IteratorResult<SubscriptionFrame>): void;
    reject(error: Error): void;
  }> = [];
  #readied = false;
  #openGate: () => void = () => undefined;
  readonly #readyGate = new Promise<void>((resolve) => {
    this.#openGate = resolve;
  });
  #sequence = 0;
  #closed = false;
  #failure: Error | undefined;
  closeCalls = 0;
  nextCalls = 0;
  transcriptPageReads = 0;
  onTranscriptPageRead?: () => void;
  onTranscriptRead?: () => void;
  transcriptPageSize = Number.POSITIVE_INFINITY;
  transcriptEmptyFirstPage = false;
  transcriptPageGate?: Promise<void>;
  #liveTranscript: StoredMessage[] = [];
  readonly #decodedPages = new WeakMap<SessionTranscriptPage, readonly StoredMessage[]>();

  constructor(
    public snapshot: SessionContinuitySnapshot,
    private readonly transcript: Promise<StoredMessage[]> = Promise.resolve([]),
    readonly subscriptionId = 'subscription-1',
    private readonly onClose: () => void = () => undefined,
  ) {}

  seedBootstrap(messages: StoredMessage[]): void {
    this.#liveTranscript = messages;
    this.transcriptBootstrap = {
      durable: {
        kind: 'page',
        sessionId: this.snapshot.session.sessionId,
        direction: 'older',
        throughSequence: messages.length * 8 + 7,
        rawBytes: 0,
        fragments: [],
        nextCursor: null,
        endsAtTurnBoundary: true,
      },
    };
  }

  get transcriptWatermark(): number | null {
    return this.#transcriptWatermark;
  }

  subscribePtyData(): () => void {
    return () => undefined;
  }

  subscribeSessionDomainChanges(): () => void {
    return () => undefined;
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return this;
  }

  async ready(): Promise<void> {
    this.#readied = true;
    this.#openGate();
  }

  next(): Promise<IteratorResult<SubscriptionFrame>> {
    this.nextCalls += 1;
    // The Host holds frames until the subscriber declares readiness, so a fake
    // that hands them over earlier would let an ordering bug pass.
    return this.#readied ? this.#deliver() : this.#readyGate.then(() => this.#deliver());
  }

  #deliver(): Promise<IteratorResult<SubscriptionFrame>> {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve({ done: false, value: frame });
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  push(frame: SubscriptionFrame): void {
    if (frame.kind === 'subscription.transcript_advanced') {
      this.#transcriptWatermark = frame.throughSequence;
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: frame });
    else this.#frames.push(frame);
  }

  setRoot(rootTurn: SessionContinuitySnapshot['rootTurn']): void {
    this.project({
      rootTurn,
      session: {
        ...this.snapshot.session,
        status: rootTurn && rootTurn.status === 'running' ? 'running' : 'active',
      },
    });
  }

  setMetadataRevision(metadataRevision: number): void {
    this.project({
      session: { ...this.snapshot.session, metadataRevision },
    });
  }

  appendText(turnId: string, runId: string, text: string, complete = false): void {
    this.push({
      kind: 'subscription.session_delta',
      hostEpoch: this.hostEpoch,
      subscriptionId: this.subscriptionId,
      sequence: ++this.#sequence,
      sessionId: this.snapshot.session.sessionId,
      delta: {
        kind: 'text',
        turnId,
        runId,
        messageId: `message-${turnId}`,
        startOffset: 0,
        text,
        ...(complete ? { complete: true as const } : {}),
      },
    });
  }

  appendToolResult(turnId: string, runId: string, toolUseId: string): void {
    this.push({
      kind: 'subscription.session_event',
      hostEpoch: this.hostEpoch,
      subscriptionId: this.subscriptionId,
      sequence: ++this.#sequence,
      sessionId: this.snapshot.session.sessionId,
      runId,
      event: {
        type: 'tool_result',
        id: `tool-result-${toolUseId}`,
        turnId,
        ts: 2,
        toolUseId,
        status: 'completed',
      },
    });
  }

  appendToolStart(turnId: string, runId: string, toolUseId: string): void {
    this.push({
      kind: 'subscription.session_event',
      hostEpoch: this.hostEpoch,
      subscriptionId: this.subscriptionId,
      sequence: ++this.#sequence,
      sessionId: this.snapshot.session.sessionId,
      runId,
      event: {
        type: 'tool_start',
        id: `tool-start-${toolUseId}`,
        turnId,
        ts: 1,
        toolUseId,
        toolName: 'fixture',
      },
    });
  }

  publishTranscript(messages: StoredMessage[]): void {
    this.#liveTranscript = messages;
    this.push({
      kind: 'subscription.transcript_advanced',
      hostEpoch: this.hostEpoch,
      subscriptionId: this.subscriptionId,
      sequence: ++this.#sequence,
      sessionId: this.snapshot.session.sessionId,
      throughSequence: messages.length * 8 + 7,
    });
  }

  project(overrides: Partial<SessionContinuitySnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...overrides,
      projectionRevision: this.snapshot.projectionRevision + 1,
    };
    this.push({
      kind: 'subscription.session_projection',
      hostEpoch: this.hostEpoch,
      subscriptionId: this.subscriptionId,
      sequence: ++this.#sequence,
      snapshot: structuredClone(this.snapshot),
    });
  }

  fail(error: Error): void {
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async loadTranscript<T>(decodeMessage: (value: unknown) => T): Promise<T[]> {
    this.onTranscriptRead?.();
    return (await this.transcript).map(decodeMessage);
  }

  async loadTranscriptOverlay<T>(_decodeMessage: (value: unknown) => T): Promise<T[]> {
    return [];
  }

  async decodeTranscriptPage<T>(
    page: SessionTranscriptPage,
    decodeMessage: (value: unknown) => T,
  ): Promise<DecodedSessionTranscriptPage<T>> {
    return {
      messages: (this.#decodedPages.get(page) ?? []).map((message, index) => ({
        identity: index * 8,
        message: decodeMessage(message),
      })),
      nextCursor: page.nextCursor,
    };
  }

  async loadTranscriptPage(
    input: Omit<SessionTranscriptPageInput, 'subscriptionId'>,
  ): Promise<SessionTranscriptPage> {
    this.transcriptPageReads += 1;
    this.onTranscriptPageRead?.();
    await this.transcriptPageGate;
    if (this.transcriptEmptyFirstPage && input.cursor === null) {
      const empty: SessionTranscriptPage = {
        kind: 'page',
        sessionId: this.snapshot.session.sessionId,
        direction: input.direction,
        throughSequence: input.throughSequence,
        rawBytes: 0,
        fragments: [],
        nextCursor: '0',
        endsAtTurnBoundary: false,
      };
      this.#decodedPages.set(empty, []);
      return empty;
    }
    const start = input.cursor === null ? 0 : Number(input.cursor);
    const end = Math.min(start + this.transcriptPageSize, this.#liveTranscript.length);
    const page: SessionTranscriptPage = {
      kind: 'page',
      sessionId: this.snapshot.session.sessionId,
      direction: input.direction,
      throughSequence: input.throughSequence,
      rawBytes: 0,
      fragments: [],
      nextCursor: end < this.#liveTranscript.length ? String(end) : null,
      endsAtTurnBoundary: true,
    };
    this.#decodedPages.set(page, this.#liveTranscript.slice(start, end));
    return page;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.#closed) return;
    this.#closed = true;
    this.onClose();
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }
}

function continuitySnapshot(
  sessionId: string,
  overrides: Partial<SessionContinuitySnapshot> = {},
): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId,
      metadataRevision: 1,
      status: 'active',
      createdAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: null,
    goal: null,
    queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
    interactions: { pending: [] },
    ...overrides,
  };
}

function runningTurn(sessionId: string, turnId: string, runId = `run-${turnId}`) {
  return { sessionId, turnId, runId, status: 'running' as const };
}

function completedTurn(sessionId: string, turnId: string, runId = `run-${turnId}`) {
  return {
    sessionId,
    turnId,
    runId,
    status: 'completed' as const,
    completedAt: 2,
    terminalEventId: `terminal-${turnId}`,
  };
}

function connectionCatalogPage(thinkingLevels: readonly ThinkingLevel[]) {
  return {
    kind: 'page' as const,
    revision: 1,
    defaultTarget: { connectionId: 'connection-1', model: 'default' },
    connectionCount: 1,
    items: [
      {
        kind: 'connection' as const,
        connectionIndex: 0,
        connectionId: 'connection-1',
        revision: 1,
        slug: 'default',
        name: 'Default',
        providerType: 'openai' as const,
        enabled: true,
        enabledModelIdCount: 1,
        modelCount: 0,
        catalogEntryCount: 1,
      },
      {
        kind: 'enabled_model_id' as const,
        connectionIndex: 0,
        itemIndex: 0,
        modelId: 'default',
      },
      {
        kind: 'catalog_entry' as const,
        connectionIndex: 0,
        itemIndex: 0,
        entry: {
          id: 'default',
          canUseAsChatDefault: true,
          isDefault: true,
          supportsVision: false,
          thinkingLevels,
        },
      },
    ],
    nextCursor: null,
  };
}

function catalogSession(
  id: string,
  cwd = TEST_CWD,
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id,
    revision: 1,
    workspace: { target: { kind: 'host_path', path: cwd }, hostCwd: cwd },
    createdAt: 1,
    activityAt: 1,
    name: id,
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'default',
    connectionLocked: false,
    model: 'default',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  };
}

function configOptions(
  values: Partial<
    Record<
      'permission_mode' | 'thinking_level' | 'collaboration_mode' | 'orchestration_mode',
      string
    >
  >,
  thinkingLevels: readonly ThinkingLevel[] = THINKING_LEVELS,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = structuredClone(DEFAULT_CONFIG_OPTIONS);
  const thinking = options.find(({ id }) => id === 'thinking_level');
  if (thinking?.type === 'select') {
    thinking.options = thinking.options.flatMap((option) =>
      'value' in option &&
      (option.value === 'default' || thinkingLevels.includes(option.value as ThinkingLevel))
        ? [option]
        : [],
    );
  }
  for (const option of options) {
    if (option.type !== 'select') continue;
    option.currentValue = values[option.id as keyof typeof values] ?? option.currentValue;
  }
  return options;
}

async function assertInvalidParams(
  promise: Promise<unknown>,
  data: Record<string, unknown>,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.code, -32602);
    assert.deepEqual(error.data, data);
    return true;
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
