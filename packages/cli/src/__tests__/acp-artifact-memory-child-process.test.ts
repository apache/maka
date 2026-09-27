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
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { methods, RequestError, type SessionNotification } from '@agentclientprotocol/sdk';
import type {
  ArtifactIngestInput,
  ArtifactIngestResult,
  ArtifactQueryInput,
  ArtifactQueryResult,
  MemoryQueryResult,
  MemoryMutateInput,
  MemoryMutateResult,
} from '@maka/runtime-host/protocol';
import { withAcpChildProcessHarness } from './acp-child-process-harness.js';

test('same ACP client reconnects to a real replacement Host without replaying staged upload bytes', {
  timeout: 90_000,
}, async () => {
  await withAcpChildProcessHarness(
    async (harness) => {
      await harness.withClient(async ({ context }) => {
        await context.request(methods.agent.initialize, { protocolVersion: 1 });
        const { sessionId } = await context.request(methods.agent.session.new, {
          cwd: harness.workspaceRoot,
          mcpServers: [],
        });
        const uploadId = randomUUID();
        const payload = Buffer.from('upload lost across Host epoch');
        assert.deepEqual(
          await context.request<ArtifactIngestResult>('_maka/artifact/ingest', {
            kind: 'begin',
            sessionId,
            uploadId,
            name: 'interrupted.txt',
            mimeType: 'text/plain',
            totalBytes: payload.length,
            contentSha256: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
          }),
          { kind: 'upload_opened', uploadId, nextOffset: 0 },
        );
        await harness.stopRuntimeHost();
        const recovered = await context.request<ArtifactQueryResult>('_maka/artifact/query', {
          kind: 'list_start',
          sessionId,
        });
        assert.equal(recovered.kind, 'page');
        await assert.rejects(
          context.request('_maka/artifact/ingest', {
            kind: 'chunk',
            sessionId,
            uploadId,
            offset: 0,
            chunkBase64: payload.toString('base64'),
          }),
          (error: unknown) =>
            error instanceof RequestError && (error.data as { code?: string }).code === 'not_found',
        );
        const memory = await context.request<MemoryQueryResult>('_maka/memory/query', {
          kind: 'state',
        });
        assert.ok(memory.kind === 'state' || memory.kind === 'blocked');
        await context.request(methods.agent.session.close, { sessionId });
      });
    },
    {
      startRuntimeHost: true,
      timeoutMs: 45_000,
      model: { id: 'acp-reconnect-fixture', thinkingLevels: [] },
    },
  );
});

test('a real Read tool Artifact reference remains readable by the same ACP client', {
  timeout: 60_000,
}, async () => {
  let step = 0;
  let artifactId = '';
  const server = createServer((request, response) => {
    void readBody(request)
      .then((body) => {
        const input = JSON.parse(body) as {
          stream?: boolean;
          tools?: { function?: { name?: string } }[];
        };
        if (input.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'summary',
              object: 'chat.completion',
              created: 1,
              model: 'acp-artifact-tool-fixture',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Summary' },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
          return;
        }
        step += 1;
        const tool = step === 1 ? 'tool_search' : 'Read';
        if (step <= 2) {
          assert.ok(
            input.tools?.some(({ function: value }) => value?.name === tool),
            body,
          );
          const args =
            step === 1 ? { query: 'Read' } : { path: `maka://runtime/attachments/${artifactId}` };
          respondEvents(response, [
            modelChunk(
              'acp-artifact-tool-fixture',
              {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: `read-call-${step}`,
                    type: 'function',
                    function: { name: tool, arguments: JSON.stringify(args) },
                  },
                ],
              },
              null,
            ),
            modelChunk('acp-artifact-tool-fixture', {}, 'tool_calls'),
          ]);
        } else {
          respondEvents(response, [
            modelChunk(
              'acp-artifact-tool-fixture',
              { role: 'assistant', content: 'Read complete.' },
              null,
            ),
            modelChunk('acp-artifact-tool-fixture', {}, 'stop'),
          ]);
        }
      })
      .catch((error: unknown) => response.destroy(error as Error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await withAcpChildProcessHarness(
      async (harness) => {
        const updates: SessionNotification[] = [];
        await harness.withClient(
          async ({ context }) => {
            await context.request(methods.agent.initialize, { protocolVersion: 1 });
            const { sessionId } = await context.request(methods.agent.session.new, {
              cwd: harness.workspaceRoot,
              mcpServers: [],
            });
            const image = Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=',
              'base64',
            );
            const uploadId = randomUUID();
            const ingest = (input: ArtifactIngestInput) =>
              context.request<ArtifactIngestResult, ArtifactIngestInput>(
                '_maka/artifact/ingest',
                input,
              );
            await ingest({
              kind: 'begin',
              sessionId,
              uploadId,
              name: 'pixel.png',
              mimeType: 'image/png',
              totalBytes: image.length,
              contentSha256: `sha256:${createHash('sha256').update(image).digest('hex')}`,
            });
            await ingest({
              kind: 'chunk',
              sessionId,
              uploadId,
              offset: 0,
              chunkBase64: image.toString('base64'),
            });
            const committed = await ingest({ kind: 'commit', sessionId, uploadId });
            assert.equal(committed.kind, 'committed');
            if (committed.kind !== 'committed' || committed.attachment.ref.kind !== 'session_file')
              throw new Error('Expected uploaded image Artifact');
            artifactId = committed.attachment.ref.relativePath;
            assert.deepEqual(
              await context.request(methods.agent.session.prompt, {
                sessionId,
                prompt: [{ type: 'text', text: 'Use Read on the image' }],
              }),
              { stopReason: 'end_turn' },
            );
            const result = updates.find(
              ({ update }) =>
                update.sessionUpdate === 'tool_call_update' &&
                update.status === 'completed' &&
                JSON.stringify(update._meta).includes(artifactId),
            );
            assert.ok(result, JSON.stringify(updates));
            assert.match(JSON.stringify(result.update), /_maka\/artifact\/query/);
            const read = await context.request<ArtifactQueryResult>('_maka/artifact/query', {
              kind: 'read_chunk',
              sessionId,
              artifactId,
              offset: 0,
            });
            assert.equal(read.kind, 'chunk');
            if (read.kind === 'chunk')
              assert.deepEqual(Buffer.from(read.chunkBase64, 'base64'), image);
          },
          (app) =>
            app.onNotification(methods.client.session.update, ({ params }) => {
              updates.push(params);
            }),
        );
      },
      {
        startRuntimeHost: true,
        model: {
          id: 'acp-artifact-tool-fixture',
          thinkingLevels: [],
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

function modelChunk(
  model: string,
  delta: Record<string, unknown>,
  finishReason: 'tool_calls' | 'stop' | null,
) {
  return {
    id: model,
    object: 'chat.completion.chunk',
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason
      ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      : {}),
  };
}

function respondEvents(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

test('official ACP SDK exports and deletes a multipart Artifact through the real Host', {
  timeout: 60_000,
}, async () => {
  await withAcpChildProcessHarness(
    async (harness) => {
      await harness.withClient(async ({ context }) => {
        await context.request(methods.agent.initialize, { protocolVersion: 1 });
        const { sessionId } = await context.request(methods.agent.session.new, {
          cwd: harness.workspaceRoot,
          mcpServers: [],
        });
        const bytes = Buffer.alloc(102_401);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
        const uploadId = randomUUID();
        const ingest = (input: ArtifactIngestInput) =>
          context.request<ArtifactIngestResult, ArtifactIngestInput>(
            '_maka/artifact/ingest',
            input,
          );
        const query = (input: ArtifactQueryInput) =>
          context.request<ArtifactQueryResult, ArtifactQueryInput>('_maka/artifact/query', input);
        const opened = await ingest({
          kind: 'begin',
          sessionId,
          uploadId,
          name: 'payload.bin',
          mimeType: 'application/octet-stream',
          totalBytes: bytes.length,
          contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        });
        assert.deepEqual(opened, { kind: 'upload_opened', uploadId, nextOffset: 0 });
        await assert.rejects(
          ingest({
            kind: 'chunk',
            sessionId,
            uploadId,
            offset: 1,
            chunkBase64: bytes.subarray(0, 1).toString('base64'),
          }),
          (error: unknown) =>
            error instanceof RequestError &&
            (error.data as { code?: string }).code === 'operation_conflict',
        );
        for (let offset = 0; offset < bytes.length; offset += 32_000) {
          const chunk = await ingest({
            kind: 'chunk',
            sessionId,
            uploadId,
            offset,
            chunkBase64: bytes.subarray(offset, offset + 32_000).toString('base64'),
          });
          assert.equal(chunk.kind, 'chunk_accepted');
          if (offset === 0) {
            const replay = await ingest({
              kind: 'chunk',
              sessionId,
              uploadId,
              offset,
              chunkBase64: bytes.subarray(0, 32_000).toString('base64'),
            });
            assert.deepEqual(replay, chunk);
          }
        }
        const committed = await ingest({ kind: 'commit', sessionId, uploadId });
        assert.equal(committed.kind, 'committed');
        if (committed.kind !== 'committed' || committed.attachment.ref.kind !== 'session_file')
          throw new Error('Expected canonical Session Artifact');
        const artifactId = committed.attachment.ref.relativePath;
        assert.equal(committed.attachment.ref.sessionId, sessionId);
        assert.deepEqual(await ingest({ kind: 'commit', sessionId, uploadId }), committed);
        const badUploadId = randomUUID();
        await ingest({
          kind: 'begin',
          sessionId,
          uploadId: badUploadId,
          name: 'bad.txt',
          mimeType: 'text/plain',
          totalBytes: 1,
          contentSha256: `sha256:${'0'.repeat(64)}`,
        });
        await ingest({
          kind: 'chunk',
          sessionId,
          uploadId: badUploadId,
          offset: 0,
          chunkBase64: 'YQ==',
        });
        await assert.rejects(
          ingest({ kind: 'commit', sessionId, uploadId: badUploadId }),
          (error: unknown) =>
            error instanceof RequestError &&
            (error.data as { code?: string }).code === 'operation_conflict',
        );
        const emptySha =
          `sha256:${createHash('sha256').update(Buffer.alloc(0)).digest('hex')}` as const;
        const uploadEmpty = async (index: number): Promise<string> => {
          const emptyUploadId = randomUUID();
          await ingest({
            kind: 'begin',
            sessionId,
            uploadId: emptyUploadId,
            name: `empty-${index}.txt`,
            mimeType: 'text/plain',
            totalBytes: 0,
            contentSha256: emptySha,
          });
          const empty = await ingest({ kind: 'commit', sessionId, uploadId: emptyUploadId });
          assert.equal(empty.kind, 'committed');
          if (empty.kind !== 'committed' || empty.attachment.ref.kind !== 'session_file')
            throw new Error('Expected empty Artifact');
          return empty.attachment.ref.relativePath;
        };
        let emptyId = '';
        for (let index = 0; index < 128; index += 1) emptyId = await uploadEmpty(index);
        const listed = await query({ kind: 'list_start', sessionId });
        assert.equal(listed.kind, 'page');
        assert.ok(listed.kind === 'page' && listed.nextCursor);
        if (listed.kind !== 'page' || !listed.nextCursor)
          throw new Error('Expected Artifact cursor');
        const continuation = {
          kind: 'list_continue' as const,
          sessionId,
          revision: listed.revision,
          cursor: listed.nextCursor,
        };
        const next = await query(continuation);
        assert.equal(next.kind, 'page');
        const emptyRead = await query({
          kind: 'read_chunk',
          sessionId,
          artifactId: emptyId,
          offset: 0,
        });
        assert.equal(emptyRead.kind, 'chunk');
        if (emptyRead.kind === 'chunk') {
          assert.equal(emptyRead.chunkBase64, '');
          assert.equal(emptyRead.nextOffset, null);
        }
        await uploadEmpty(129);
        const changed = await query(continuation);
        assert.equal(changed.kind, 'revision_changed');
        const metadata = await query({ kind: 'get', sessionId, artifactId });
        assert.equal(metadata.kind, 'artifact');
        if (metadata.kind === 'artifact') assert.equal(metadata.artifact?.sizeBytes, bytes.length);
        const preview = await query({ kind: 'read_binary', sessionId, artifactId });
        assert.equal(preview.kind, 'binary');
        if (preview.kind === 'binary') assert.equal(preview.preview.ok, false);
        const parts: Buffer[] = [];
        let offset = 0;
        while (true) {
          const result = await query({ kind: 'read_chunk', sessionId, artifactId, offset });
          assert.equal(result.kind, 'chunk');
          if (result.kind !== 'chunk') throw new Error('Expected Artifact chunk');
          assert.equal(result.offset, offset);
          parts.push(Buffer.from(result.chunkBase64, 'base64'));
          if (result.nextOffset === null) break;
          offset = result.nextOffset;
        }
        assert.deepEqual(Buffer.concat(parts), bytes);
        assert.deepEqual(
          await context.request('_maka/artifact/delete', { sessionId, artifactId }),
          { kind: 'deleted' },
        );
        const missing = await query({ kind: 'get', sessionId, artifactId });
        assert.equal(missing.kind, 'artifact');
        if (missing.kind === 'artifact') assert.equal(missing.artifact, null);
        await assert.rejects(
          context.request('_maka/artifact/query', {
            kind: 'read_chunk',
            sessionId,
            artifactId,
            offset: -1,
          }),
          (error: unknown) => error instanceof RequestError && error.code === -32602,
        );
        await context.request(methods.agent.session.close, { sessionId });
        await assert.rejects(
          query({ kind: 'list_start', sessionId }),
          (error: unknown) => error instanceof RequestError && error.code === -32602,
        );
      });
    },
    { startRuntimeHost: true, model: { id: 'artifact-fixture', thinkingLevels: [] } },
  );
});

test('Memory mutation reaches the next applicable real provider request', {
  timeout: 60_000,
}, async () => {
  const sentinel = 'ACP_SESSION_MEMORY_SENTINEL_3132';
  const modelInputs: string[] = [];
  const server = createServer((request, response) => {
    void readBody(request)
      .then((body) => {
        const input = JSON.parse(body) as { stream?: boolean };
        if (input.stream === true) {
          modelInputs.push(body);
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(
            `data: ${JSON.stringify({
              id: 'memory-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'acp-memory-fixture',
              choices: [
                { index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null },
              ],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              id: 'memory-fixture',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'acp-memory-fixture',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            })}\n\n`,
          );
          response.end('data: [DONE]\n\n');
        } else {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'memory-summary',
              object: 'chat.completion',
              created: 1,
              model: 'acp-memory-fixture',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Summary' },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
        }
      })
      .catch((error: unknown) => response.destroy(error as Error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await withAcpChildProcessHarness(
      async (harness) => {
        await harness.withClient(async ({ context }) => {
          await context.request(methods.agent.initialize, { protocolVersion: 1 });
          const first = await context.request(methods.agent.session.new, {
            cwd: harness.workspaceRoot,
            mcpServers: [],
          });
          const second = await context.request(methods.agent.session.new, {
            cwd: harness.workspaceRoot,
            mcpServers: [],
          });
          const state = await context.request<MemoryQueryResult>('_maka/memory/query', {
            kind: 'state',
          });
          assert.equal(state.kind, 'state');
          if (state.kind !== 'state') throw new Error('Expected enabled Memory state');
          const mutate = (input: MemoryMutateInput) =>
            context.request<MemoryMutateResult, MemoryMutateInput>('_maka/memory/mutate', input);
          const saved = await mutate({
            kind: 'remember',
            expectedRevision: state.revision,
            title: 'ACP integration memory',
            content: sentinel,
            scope: { kind: 'session', sessionId: first.sessionId },
          });
          assert.equal(saved.kind, 'committed');
          const stale = await mutate({
            kind: 'remember',
            expectedRevision: state.revision,
            title: 'Stale ACP memory',
            content: 'SHOULD_NOT_COMMIT',
            scope: { kind: 'workspace' },
          });
          assert.equal(stale.kind, 'revision_conflict');
          const entries = await context.request<MemoryQueryResult>('_maka/memory/query', {
            kind: 'entries_start',
            view: 'active',
          });
          assert.equal(entries.kind, 'entries_page');
          if (entries.kind === 'entries_page') {
            assert.ok(entries.items.some((item) => item.content.includes(sentinel)));
          }
          const document = await context.request<MemoryQueryResult>('_maka/memory/query', {
            kind: 'document_start',
            document: 'memory',
          });
          assert.equal(document.kind, 'document_page');
          if (document.kind === 'document_page') {
            assert.ok(
              Buffer.from(document.chunkBase64, 'base64').toString('utf8').includes(sentinel),
            );
          }
          assert.deepEqual(
            await context.request(methods.agent.session.prompt, {
              sessionId: first.sessionId,
              prompt: [{ type: 'text', text: 'FIRST_SESSION_PROMPT' }],
            }),
            { stopReason: 'end_turn' },
          );
          assert.deepEqual(
            await context.request(methods.agent.session.prompt, {
              sessionId: second.sessionId,
              prompt: [{ type: 'text', text: 'SECOND_SESSION_PROMPT' }],
            }),
            { stopReason: 'end_turn' },
          );
          const firstInput = modelInputs.find((body) => body.includes('FIRST_SESSION_PROMPT'));
          const secondInput = modelInputs.find((body) => body.includes('SECOND_SESSION_PROMPT'));
          assert.ok(firstInput?.includes(sentinel), JSON.stringify(modelInputs));
          assert.ok(secondInput && !secondInput.includes(sentinel), JSON.stringify(modelInputs));
          const beforeReplace = await context.request<MemoryQueryResult>('_maka/memory/query', {
            kind: 'state',
          });
          assert.equal(beforeReplace.kind, 'state');
          if (beforeReplace.kind !== 'state') throw new Error('Expected Memory state');
          const currentDocument = await context.request<MemoryQueryResult>('_maka/memory/query', {
            kind: 'document_start',
            document: 'memory',
          });
          assert.equal(currentDocument.kind, 'document_page');
          if (currentDocument.kind !== 'document_page' || currentDocument.nextCursor !== null)
            throw new Error('Expected one Memory document chunk');
          const bytes = Buffer.from(currentDocument.chunkBase64, 'base64');
          const opened = await mutate({
            kind: 'replace_begin',
            expectedRevision: beforeReplace.revision,
            totalBytes: bytes.length,
            contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          });
          assert.equal(opened.kind, 'upload_opened');
          if (opened.kind !== 'upload_opened') throw new Error('Expected Memory upload');
          await mutate({
            kind: 'replace_chunk',
            uploadId: opened.uploadId,
            offset: 0,
            chunkBase64: bytes.subarray(0, 1).toString('base64'),
          });
          await mutate({
            kind: 'replace_chunk',
            uploadId: opened.uploadId,
            offset: 1,
            chunkBase64: bytes.subarray(1).toString('base64'),
          });
          const replaced = await mutate({ kind: 'replace_commit', uploadId: opened.uploadId });
          assert.ok(replaced.kind === 'committed' || replaced.kind === 'unchanged');
          const afterReplace = await context.request<MemoryQueryResult>('_maka/memory/query', {
            kind: 'state',
          });
          assert.equal(afterReplace.kind, 'state');
          if (afterReplace.kind !== 'state') throw new Error('Expected Memory state');
          const bad = await mutate({
            kind: 'replace_begin',
            expectedRevision: afterReplace.revision,
            totalBytes: bytes.length,
            contentSha256: `sha256:${'0'.repeat(64)}`,
          });
          assert.equal(bad.kind, 'upload_opened');
          if (bad.kind !== 'upload_opened') throw new Error('Expected Memory upload');
          for (let offset = 0; offset < bytes.length; offset += 32_000) {
            await mutate({
              kind: 'replace_chunk',
              uploadId: bad.uploadId,
              offset,
              chunkBase64: bytes.subarray(offset, offset + 32_000).toString('base64'),
            });
          }
          assert.deepEqual(await mutate({ kind: 'replace_commit', uploadId: bad.uploadId }), {
            kind: 'rejected',
            reason: 'invalid_content',
          });
          await context.request(methods.agent.session.close, { sessionId: first.sessionId });
          const current = await context.request<MemoryQueryResult>('_maka/memory/query', {
            kind: 'state',
          });
          assert.equal(current.kind, 'state');
          if (current.kind !== 'state') throw new Error('Expected Memory state');
          await assert.rejects(
            mutate({
              kind: 'remember',
              expectedRevision: current.revision,
              title: 'Closed Session',
              content: 'SHOULD_NOT_COMMIT',
              scope: { kind: 'session', sessionId: first.sessionId },
            }),
            (error: unknown) => error instanceof RequestError && error.code === -32602,
          );
        });
      },
      {
        startRuntimeHost: true,
        memoryEnabled: true,
        model: {
          id: 'acp-memory-fixture',
          thinkingLevels: [],
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
        },
      },
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('Memory private route preserves Host policy result and validates custom params', {
  timeout: 60_000,
}, async () => {
  await withAcpChildProcessHarness(
    async (harness) => {
      await harness.withClient(async ({ context }) => {
        await context.request(methods.agent.initialize, { protocolVersion: 1 });
        const state = await context.request<MemoryQueryResult>('_maka/memory/query', {
          kind: 'state',
          _meta: { client: 'sdk-test' },
        });
        assert.deepEqual(state, { kind: 'blocked', reason: 'disabled' });
        await assert.rejects(
          context.request('_maka/memory/query', { kind: 'state', _meta: 42 }),
          (error: unknown) => error instanceof RequestError && error.code === -32602,
        );
        await assert.rejects(
          context.request('_maka/memory/query', { kind: 'state', extra: 1 }),
          (error: unknown) => error instanceof RequestError && error.code === -32602,
        );
        await assert.rejects(
          context.request('_maka/unknown', {}),
          (error: unknown) => error instanceof RequestError && error.code === -32601,
        );
      });
    },
    {
      startRuntimeHost: true,
      memoryEnabled: false,
      model: { id: 'acp-disabled-memory-fixture', thinkingLevels: [] },
    },
  );
});
