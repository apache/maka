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
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { waitFor, withTimeout } from '@maka/core/test-only/async-primitives';
import { runtimeInvocationOutcome } from '@maka/core/runtime-invocation';
import { runtimeInvocationFailureClass } from '@maka/runtime/runtime-event-read-model';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  resolveRootControlNamespace,
  resolveRootOwnershipNamespace,
} from '@maka/storage/root-authority';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { removePosixEndpointDirectories } from './fixtures/endpoint-hygiene.js';

const MODEL = 'wait-crash-model';
const LIMIT = 20_000;
class HostProcess {
  readonly child: ChildProcess;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly ready: Promise<string>;
  constructor(root: string, rootId: string) {
    this.child = fork(
      new URL('./fixtures/event-wait-crash-host.js', import.meta.url),
      [root, rootId],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    this.closed = new Promise((resolve, reject) => {
      this.child.once('error', reject);
      this.child.once('close', (code, signal) => resolve({ code, signal }));
    });
    this.ready = withTimeout(
      Promise.race([
        new Promise<string>((resolve) =>
          this.child.on('message', (message: { type: string; hostEpoch: string }) => {
            if (message.type === 'ready') resolve(message.hostEpoch);
          }),
        ),
        this.closed.then((exit) => {
          throw new Error(`Host exited before ready: ${JSON.stringify(exit)}`);
        }),
      ]),
      LIMIT,
      'Host readiness timed out',
    );
  }
  async stop(signal?: 'SIGKILL') {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      if (signal) this.child.kill(signal);
      else this.child.send({ type: 'shutdown' });
    }
    const result = await withTimeout(this.closed, LIMIT, 'Host shutdown timed out');
    if (signal) assert.equal(result.signal, signal);
    else assert.deepEqual(result, { code: 0, signal: null });
  }
}
async function connect(rootPath: string) {
  const connected = await connectRuntimeHost({
    rootPath,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  });
  assert.equal(connected.kind, 'connected');
  if (connected.kind !== 'connected') throw new Error('Unable to connect');
  return connected.connection;
}

test('production Host SIGKILL after in-turn registration retires the original tool without replay or successor', {
  timeout: 60_000,
}, async () => {
  const base = await mkdtemp(join(tmpdir(), 'maka-wait-host-crash-'));
  const root = join(base, 'root');
  const stopFile = join(root, 'stop-background-job');
  const launchesFile = join(root, 'background-job-launches');
  await mkdir(root, { recursive: true });
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const script = `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(launchesFile)},'started\\n');const stop=()=>{if(fs.existsSync(${JSON.stringify(stopFile)}))process.exit(0)};fs.watch(${JSON.stringify(root)},stop);stop();setTimeout(()=>process.exit(0),60000);`;
  const command = `${quote(process.execPath)} -e ${quote(script)}`;
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const hosts: HostProcess[] = [];
  const clients: RuntimeHostConnection[] = [];
  let modelCalls = 0;
  let lastModelTools: string[] = [];
  let lastToolResults: unknown;
  let backgroundRef: string | undefined;
  const providerErrors: unknown[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const part of request) body += part;
      const input = JSON.parse(body);
      modelCalls++;
      lastModelTools = (input.tools ?? []).map(
        (tool: { function?: { name?: string } }) => tool.function?.name ?? '',
      );
      lastToolResults = Array.isArray(input.messages)
        ? input.messages.filter((message: { role?: string }) => message.role === 'tool').slice(-2)
        : undefined;
      if (modelCalls > 1)
        backgroundRef ??= JSON.stringify(lastToolResults).match(
          /maka:\/\/runtime\/background-tasks\/[A-Za-z0-9_-]+/,
        )?.[0];
      const toolName =
        modelCalls === 1 ? 'Bash' : modelCalls === 2 ? 'tool_search' : 'WaitForEvent';
      if (modelCalls === 3) assert.ok(backgroundRef, 'Bash returns its canonical background ref');
      assert.ok(lastModelTools.includes(toolName), 'production Run exposes the selected tool');
      assert.ok(modelCalls <= 3, 'the pending wait does not request another model step');
      response.setHeader('content-type', 'text/event-stream');
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion.chunk',
          created: 1,
          model: MODEL,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.write(
        chunk(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id:
                  modelCalls === 1
                    ? 'background-bash'
                    : modelCalls === 2
                      ? 'discover-host-wait'
                      : 'original-wait-call',
                type: 'function',
                function: {
                  name: toolName,
                  arguments: JSON.stringify(
                    modelCalls === 1
                      ? { command, run_in_background: true }
                      : modelCalls === 2
                        ? { query: 'WaitForEvent' }
                        : {
                            resource: {
                              providerId: 'shell_run',
                              connectionId: null,
                              resourceType: 'background_task',
                              resourceId: backgroundRef,
                            },
                            condition: {
                              typeId: 'terminal',
                              version: 1,
                              parameters: {},
                            },
                            reason: 'Wait for the existing background job',
                          },
                  ),
                },
              },
            ],
          },
          null,
        ),
      );
      response.write(chunk({}, 'tool_calls'));
      response.end('data: [DONE]\n\n');
    })().catch((error) => {
      providerErrors.push(error);
      response.destroy(error as Error);
    });
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  let connectionId: string;
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  try {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'local',
        name: 'Crash provider',
        providerType: 'ollama',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        enabled: true,
        enabledModelIds: [MODEL],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') throw new Error('Configuration failed');
    connectionId = created.snapshot.connections[0]!.connectionId;
    const fetch = await policy.operations.beginModelFetch(connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') throw new Error('Discovery failed');
    assert.equal(
      (
        await policy.operations.completeModelFetch(fetch.ticket, {
          models: [{ id: MODEL }],
          source: 'fetched',
          fetchedAt: Date.now(),
        })
      ).kind,
      'committed',
    );
  } finally {
    await owner.close();
  }
  try {
    const first = new HostProcess(root, capability.rootId);
    hosts.push(first);
    await first.ready;
    const client = await connect(root);
    clients.push(client);
    const sessionId = randomUUID(),
      turnId = randomUUID();
    await client.request('session.create', {
      sessionId,
      workspace: { kind: 'host_path', path: root },
      modelTarget: { kind: 'explicit', connectionId, connectionSlug: 'local', model: MODEL },
    });
    await client.request('goal.arm', {
      sessionId,
      condition: 'Inspect the background job result',
      maxIterations: 1,
      tokenBudget: null,
    });
    await client.request('turn.start', {
      sessionId,
      turnId,
      content: { text: 'Run the background job and wait for its result' },
    });
    let waitId = '';
    await waitFor(
      async () => {
        const page = await client.request('session.event-waits.query', { sessionId });
        if (page.items.length !== 1) {
          const turn = await client.request('turn.query', { sessionId, turnId });
          if (providerErrors.length || turn.status === 'failed' || turn.status === 'completed')
            throw new Error(
              `Wait was never registered: ${JSON.stringify({
                turn,
                modelCalls,
                providerErrors: providerErrors.map(String),
                tools: lastModelTools,
                toolResults: lastToolResults,
              })}`,
            );
          return false;
        }
        waitId = page.items[0]!.waitId;
        assert.equal(page.items[0]!.consumer.kind, 'tool_invocation');
        assert.equal(page.items[0]!.sourceTurnId, turnId);
        return page.items[0]!.phase === 'observing';
      },
      { timeoutMs: LIMIT },
    ).catch(async (cause) => {
      throw new Error(
        `Wait registration failed: ${JSON.stringify({
          modelCalls,
          providerErrors: providerErrors.map(String),
          tools: lastModelTools,
          toolResults: lastToolResults,
          turn: await client.request('turn.query', { sessionId, turnId }),
        })}`,
        { cause },
      );
    });
    assert.equal(modelCalls, 3);
    assert.equal((await client.request('turn.query', { sessionId, turnId })).status, 'running');
    const goalBeforeCrash = (await client.request('goal.query', { sessionId })).goal;
    assert.equal(goalBeforeCrash?.status, 'active');
    assert.equal(goalBeforeCrash?.iterations, 0);
    await first.stop('SIGKILL');
    await client.close();
    const successor = new HostProcess(root, capability.rootId);
    hosts.push(successor);
    assert.notEqual(await successor.ready, await first.ready);
    const restored = await connect(root);
    clients.push(restored);
    await waitFor(
      async () =>
        (await restored.request('session.event-waits.query', { sessionId })).items.length === 0,
      { timeoutMs: LIMIT },
    );
    // As before Host observation, the first external Turn has no durable Goal
    // execution or settled iteration. Recovery preserves the armed Goal; an
    // in-turn wait must not introduce its own pause or continuation policy.
    assert.deepEqual((await restored.request('goal.query', { sessionId })).goal, goalBeforeCrash);
    assert.equal((await restored.request('turn.query', { sessionId, turnId })).status, 'failed');
    assert.equal(modelCalls, 3, 'recovery never requests a model successor');
    assert.deepEqual(providerErrors, []);
    await restored.close();
    await successor.stop();
    const recoveredOwner = await tryAcquireInteractiveRootOwner(capability);
    assert.ok(recoveredOwner);
    const stores = await openInteractiveExecutionStoresForWrite(recoveredOwner.lease);
    try {
      const admissions = await stores.agentRunStore.listRootTurnAdmissionsForRecovery(sessionId);
      assert.equal(admissions.length, 1);
      assert.equal(admissions[0]!.turnId, turnId);
      assert.equal(await readFile(launchesFile, 'utf8'), 'started\n');
      const invocation = await stores.runtimeEventStore.readRunInvocation(
        sessionId,
        admissions[0]!.runId,
      );
      assert.ok(invocation);
      assert.equal(runtimeInvocationOutcome(invocation), 'failed');
      assert.equal(runtimeInvocationFailureClass(invocation), 'outcome_unknown');
      assert.equal(
        invocation.terminalEvent?.actions?.stateDelta?.recoveryReason,
        'outcome_unknown',
      );
      const events = await stores.runtimeEventStore.readImmutableRuntimeEvents(
        sessionId,
        admissions[0]!.runId,
      );
      assert.equal(
        events.filter(
          (event) =>
            event.content?.kind === 'function_call' && event.content.name === 'WaitForEvent',
        ).length,
        1,
      );
      const responses = events.filter(
        (event) =>
          event.content?.kind === 'function_response' && event.content.name === 'WaitForEvent',
      );
      assert.equal(
        responses.length,
        0,
        'restart preserves the unknown T1 outcome without inventing a T2',
      );
      const wait = await stores.eventWaitStore.readAny({ sessionId, waitId });
      assert.equal(wait?.record.delivery?.kind, 'retired');
    } finally {
      await stores.sessionStore.close?.();
      await recoveredOwner.close();
    }
  } finally {
    await writeFile(stopFile, 'stop');
    for (const client of clients) await client.close();
    for (const host of hosts)
      if (host.child.exitCode === null && host.child.signalCode === null)
        await host.stop('SIGKILL');
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await removePosixEndpointDirectories(capability.rootId);
    await rm(join(resolveRootControlNamespace(), capability.rootId), {
      recursive: true,
      force: true,
    });
    await rm(join(resolveRootOwnershipNamespace(), `${capability.rootId}.lock`), { force: true });
    await rm(base, { recursive: true, force: true });
  }
});
