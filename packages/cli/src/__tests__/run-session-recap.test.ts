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
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deferred, waitFor } from '@maka/core/test-only/async-primitives';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { connectRuntimeHost, type RuntimeHostConnection } from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import { startExecutionRuntimeHostService } from '@maka/runtime-host/server';

const fixturePath = fileURLToPath(new URL('./run-session-process-fixture.js', import.meta.url));

test('external CLI combines queries and persists model changes before explicit continuation', {
  timeout: 90_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-cli-recap-'));
  const children = new Set<ChildProcess>();
  let host: Awaited<ReturnType<typeof startExecutionRuntimeHostService>> | undefined;
  let connection: RuntimeHostConnection | undefined;
  const recapText = 'You asked for a review; the agent is still working on it.';
  const requests: string[] = [];
  const modelRequests: Array<{ model: string; messages: unknown[] }> = [];
  let holdFirstRun = true;
  let requestArrived = deferred<void>();
  let releaseResponse = deferred<void>();
  let emptyResponse = false;
  const provider = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      if (input.stream) {
        modelRequests.push(input);
        response.setHeader('content-type', 'text/event-stream');
        const chunk = (delta: object, finishReason: string | null) =>
          `data: ${JSON.stringify({
            id: 'model-response',
            object: 'chat.completion.chunk',
            created: 1,
            model: input.model,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`;
        response.write(
          chunk(
            {
              role: 'assistant',
              content: holdFirstRun
                ? 'Inspected the parser; verification is pending.'
                : `Ran using ${input.model}.`,
            },
            null,
          ),
        );
        if (holdFirstRun) {
          holdFirstRun = false;
          return; // The original provider request stays active until the caller explicitly stops it.
        }
        response.write(chunk({}, 'stop'));
        response.end('data: [DONE]\n\n');
        return;
      }
      requests.push(body);
      requestArrived.resolve();
      await releaseResponse.promise;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'recap-response',
          object: 'chat.completion',
          created: 1,
          model: 'fake-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: emptyResponse ? '' : recapText },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
        }),
      );
    })().catch((error) => response.destroy(error as Error));
  });
  t.after(async () => {
    releaseResponse.resolve();
    for (const child of children) child.kill('SIGTERM');
    try {
      await connection?.close();
      await host?.close();
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  let sessionId: string;
  try {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    let connectionId = '';
    for (const slug of ['fake', 'alternate']) {
      const catalog = await policy.connectionCatalog.getSnapshot();
      const created = await policy.connectionCatalog.create({
        expectedCatalogRevision: catalog.revision,
        connection: {
          slug,
          name: slug,
          providerType: 'custom',
          defaultApiProtocol: 'openai-chat',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          enabled: true,
          enabledModelIds: ['fake-model', 'other-model'],
          modelOverrides: { 'fake-model': { thinkingLevels: ['high'] } },
        },
      });
      assert.equal(created.kind, 'committed');
      if (created.kind !== 'committed') throw new Error('Connection setup failed');
      const selectedId = created.snapshot.connections.find(
        (item) => item.slug === slug,
      )!.connectionId;
      if (slug === 'fake') connectionId = selectedId;
      await policy.credentialVault.set({
        locator: { scope: 'connection', connectionId: selectedId, kind: 'api_key' },
        expected: null,
        secret: 'test-only-key',
      });
      const fetch = await policy.operations.beginModelFetch(selectedId);
      assert.equal(fetch.kind, 'ready');
      if (fetch.kind !== 'ready') throw new Error('Model setup failed');
      assert.equal(
        (
          await policy.operations.completeModelFetch(fetch.ticket, {
            models: [{ id: 'fake-model' }, { id: 'other-model' }],
            source: 'fetched',
            fetchedAt: Date.now(),
          })
        ).kind,
        'committed',
      );
    }
    const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
    try {
      sessionId = (
        await stores.sessionStore.create({
          cwd: root,
          llmConnectionId: connectionId,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          permissionMode: 'ask',
        })
      ).id;
    } finally {
      await stores.sessionStore.close?.();
    }
  } finally {
    await owner.close();
  }
  const { createExecutionRuntimeHostComposition } = await import(
    new URL('./execution-composition.js', import.meta.resolve('@maka/runtime-host/server')).href
  );
  host = await startExecutionRuntimeHostService(
    { rootPath: root },
    {
      createComposition: (context, options) =>
        createExecutionRuntimeHostComposition(
          context,
          { ...options, bootstrapRuntimePolicy: false },
          {
            generateSessionTitle: async () => undefined,
          },
        ),
    },
  );
  const connected = await connectRuntimeHost({
    rootPath: root,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  });
  assert.equal(connected.kind, 'connected');
  if (connected.kind !== 'connected') throw new Error('Unable to connect to Host');
  const probe = connected.connection;
  connection = probe;
  const readSnapshot = async () => {
    const subscription = await probe.openSessionSubscription({
      sessionId,
      transcript: { kind: 'none' },
    });
    try {
      await subscription.ready();
      return {
        snapshot: subscription.snapshot,
        activeStreams: subscription.activeAssistantStreams.length,
      };
    } finally {
      await subscription.close();
    }
  };
  const cli = (...args: string[]) => {
    // Node 22 emits node:sqlite's experimental warning; keep stderr assertions
    // strict for application errors across all supported Node versions.
    const child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', fixturePath, root, '--session', sessionId, ...args],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (data) => {
      stdout += data;
    });
    child.stderr!.setEncoding('utf8').on('data', (data) => {
      stderr += data;
    });
    const result = new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => {
          children.delete(child);
          resolve({ code, stdout, stderr });
        });
      },
    );
    return { child, result };
  };
  const started = await cli('Inspect the parser and verify it.', '--no-wait').result;
  assert.equal(started.code, 0, started.stderr);
  await waitFor(
    async () => {
      const current = await readSnapshot();
      return current.snapshot.rootTurn?.status === 'running' && current.activeStreams > 0;
    },
    { timeoutMs: 10_000, pollMs: 10 },
  );
  const turn = (await readSnapshot()).snapshot.rootTurn!;
  const boundary = await probe.request('session.execution_boundary.query', { sessionId });
  const busyChange = await cli('--model', 'other-model').result;
  assert.equal(busyChange.code, 1);
  assert.match(busyChange.stderr, /configuration cannot change while a linked Turn is active/);
  assert.equal((await readSnapshot()).snapshot.rootTurn?.runId, turn.runId);
  const pendingRecap = cli('--recap', '--json').result;
  await requestArrived.promise;
  const during = await cli('--status', '--json').result;
  assert.equal(during.code, 0, during.stderr);
  assert.equal(JSON.parse(during.stdout).status, 'running');
  releaseResponse.resolve();
  const recap = await pendingRecap;
  assert.equal(recap.code, 0, recap.stderr);
  assert.deepEqual(JSON.parse(recap.stdout), {
    sessionId,
    status: 'running',
    queued: 0,
    recap: recapText,
  });
  assert.match(requests[0]!, /Inspected the parser/);
  assert.match(requests[0]!, /ONE sentence/);
  const afterRecap = (await readSnapshot()).snapshot;
  assert.equal(afterRecap.rootTurn?.turnId, turn.turnId);
  assert.equal(afterRecap.rootTurn?.runId, turn.runId);
  assert.equal(afterRecap.rootTurn?.status, 'running');
  assert.deepEqual(afterRecap.queue.followup, []);
  assert.deepEqual(afterRecap.queue.steering, []);
  assert.deepEqual(
    await probe.request('session.execution_boundary.query', { sessionId }),
    boundary,
  );
  const plain = await cli('--recap').result;
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(plain.stdout, `${recapText}\n`);
  assert.equal(requests.length, 2, 'each invocation requests a fresh recap');
  const combined = await cli('--status', '--recap').result;
  assert.equal(combined.code, 0, combined.stderr);
  assert.deepEqual(JSON.parse(combined.stdout), {
    sessionId,
    status: 'running',
    queued: 0,
    recap: recapText,
    executionBoundary: boundary,
  });
  emptyResponse = true;
  const failed = await cli('--recap', '--json').result;
  assert.equal(failed.code, 1);
  assert.deepEqual(JSON.parse(failed.stdout), {
    sessionId,
    error: 'Session recap failed: empty_response',
  });
  assert.equal(failed.stderr, '');
  assert.equal((await readSnapshot()).snapshot.rootTurn?.status, 'running');
  emptyResponse = false;
  requestArrived = deferred<void>();
  releaseResponse = deferred<void>();
  const interrupted = cli('--recap', '--json');
  await requestArrived.promise;
  interrupted.child.kill('SIGINT');
  const cancelled = await interrupted.result;
  assert.equal(cancelled.code, 130, cancelled.stderr);
  assert.match(JSON.parse(cancelled.stdout).error, /observation interrupted/);
  assert.equal(cancelled.stderr, '');
  assert.equal((await readSnapshot()).snapshot.rootTurn?.status, 'running');
  releaseResponse.resolve();
  await cli('--stop', '--json').result;
  await waitFor(async () => (await readSnapshot()).snapshot.rootTurn?.status === 'cancelled', {
    timeoutMs: 10_000,
  });
  const stopped = await cli('--recap', '--json').result;
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).status, 'failed');
  assert.equal(JSON.parse(stopped.stdout).recap, recapText);
  const invalidModel = await cli('--model', 'missing-model', '--json').result;
  assert.equal(invalidModel.code, 1);
  assert.deepEqual(JSON.parse(invalidModel.stdout), {
    sessionId,
    error: 'Session model is not enabled',
    code: 'invalid_request',
  });
  assert.equal(invalidModel.stderr, '');
  const thinking = await cli('--thinking', 'high').result;
  assert.equal(thinking.code, 0, thinking.stderr);
  assert.equal(JSON.parse(thinking.stdout).configuration.thinking, 'high');
  const unchanged = await cli('--model', 'fake-model').result;
  assert.equal(unchanged.code, 0, unchanged.stderr);
  assert.equal(JSON.parse(unchanged.stdout).configuration.thinking, 'high');
  const changed = await cli('--model', 'other-model').result;
  assert.equal(changed.code, 0, changed.stderr);
  assert.deepEqual(JSON.parse(changed.stdout).configuration, {
    connection: 'fake',
    model: 'other-model',
    thinking: null,
  });
  assert.equal(
    (await readSnapshot()).snapshot.rootTurn?.runId,
    turn.runId,
    'model change alone does not resume',
  );
  assert.equal(
    modelRequests.length,
    1,
    'no model request is dispatched by a configuration-only command',
  );
  const saved = await probe.request('session.catalog.query', { kind: 'get', sessionId });
  assert.equal(saved.kind, 'session');
  assert.equal(
    saved.kind === 'session' && saved.session && 'model' in saved.session && saved.session.model,
    'other-model',
  );
  const resumed = await cli('--model', 'other-model', '--resume', '--json').result;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).sessionId, sessionId);
  assert.match(JSON.parse(resumed.stdout).finalOutput, /Ran using other-model/);
  assert.equal(modelRequests.at(-1)?.model, 'other-model');
  const newInput = await cli('--model', 'fake-model', 'Continue the review.', '--json').result;
  assert.equal(newInput.code, 0, newInput.stderr);
  assert.match(JSON.parse(newInput.stdout).finalOutput, /Ran using fake-model/);
  assert.equal(modelRequests.at(-1)?.model, 'fake-model');
  const moved = await cli('--connection', 'alternate', '--model', 'other-model').result;
  assert.equal(moved.code, 0, moved.stderr);
  assert.deepEqual(JSON.parse(moved.stdout).configuration, {
    connection: 'alternate',
    model: 'other-model',
    thinking: null,
  });
  const afterMove = await cli('Use the saved settings.', '--json').result;
  assert.equal(afterMove.code, 0, afterMove.stderr);
  assert.match(JSON.parse(afterMove.stdout).finalOutput, /Ran using other-model/);
  const persisted = await probe.request('session.catalog.query', { kind: 'get', sessionId });
  assert.equal(
    persisted.kind === 'session' &&
      persisted.session &&
      'llmConnectionSlug' in persisted.session &&
      persisted.session.llmConnectionSlug,
    'alternate',
  );
});
