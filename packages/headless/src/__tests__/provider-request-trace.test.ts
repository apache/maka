import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentRunHeader, EmittedAgentRunEvent } from '@maka/core';
import type { InvocationResult } from '@maka/runtime';
import { acquireOperationalStateDatabase } from '@maka/storage';

import { writeHarborTaskRunTrace } from '../harbor-cell.js';
import { openHeadlessStorageForWrite } from '../headless-storage.js';
import * as traceAnalysis from '../provider-request-trace.js';

test('derives the first changed cacheable segment from the existing AgentRun trace', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const base = {
    type: 'provider_request_captured',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
  };
  const capture = (id: string, step: number, messageHashes: string[]): Record<string, unknown> => ({
    ...base,
    id,
    ts: step + 1,
    data: {
      schemaVersion: 1,
      traceId: 'provider-trace-1',
      captureId: id,
      artifactId: `artifact-${id}`,
      step,
      providerId: 'openai',
      modelId: 'gpt-test',
      requestHash: `sha256:request-${step}`,
      requestBytes: 100 + step,
      segments: [
        {
          kind: 'system_prompt',
          index: 0,
          cacheable: true,
          hash: 'sha256:system',
          bytes: 10,
        },
        ...messageHashes.map((hash, index) => ({
          kind: 'message',
          index,
          role: index === 0 ? 'user' : 'assistant',
          cacheable: true,
          hash,
          bytes: 10,
        })),
      ],
    },
  });
  await writeFile(
    traceEventsPath,
    `${[
      capture('capture-1', 0, ['sha256:user']),
      capture('capture-2', 1, ['sha256:user', 'sha256:assistant']),
    ]
      .map((event) => JSON.stringify(event))
      .join('\n')}\n`,
  );

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.equal(result.traceId, 'provider-trace-1');
  assert.deepEqual(result.identity, {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
  });
  assert.equal(result.captures.length, 2);
  assert.equal(result.captures[0]?.schemaVersion, 1);
  assert.equal(result.captures[0]?.requestPayloadWithoutProviderOptionsHash, undefined);
  assert.deepEqual(result.attempts, []);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.captures[1]?.firstChangedCacheableSegment, {
    kind: 'message',
    index: 1,
    role: 'assistant',
  });
});

test('keeps complete provider captures when the AgentRun trace ends with a torn record', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  await writeFile(
    traceEventsPath,
    `${JSON.stringify({
      type: 'provider_request_captured',
      id: 'capture-1',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 1,
      data: {
        schemaVersion: 1,
        traceId: 'provider-trace-1',
        captureId: 'capture-1',
        artifactId: 'artifact-capture-1',
        step: 0,
        providerId: 'openai',
        modelId: 'gpt-test',
        requestHash: 'sha256:request-1',
        requestBytes: 100,
        segments: [],
      },
    })}\n{"type":"provider_request_captured"`,
  );

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.deepEqual(
    result.captures.map((capture) => capture.captureId),
    ['capture-1'],
  );
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['invalid_json'],
  );
  assert.throws(
    () => traceAnalysis.assertProviderRequestTraceComplete(result),
    /line 2.*valid JSON/i,
  );
});

test('exports the Run-header trace failure latch when its sentinel event is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-trace-export-'));
  const storageRoot = join(root, 'storage');
  const outputDir = join(root, 'output');
  const identity = { runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1' };
  const header: AgentRunHeader = {
    ...identity,
    status: 'completed',
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'kimi-coding-plan',
    modelId: 'k3',
    cwd: root,
    permissionMode: 'execute',
    createdAt: 1,
    updatedAt: 4,
    completedAt: 4,
  };
  const invocation: InvocationResult = {
    invocationId: 'invocation-1',
    ...identity,
    status: 'completed',
    events: [],
    startedAt: 1,
    finishedAt: 4,
  };

  try {
    await mkdir(outputDir, { recursive: true });
    const storage = await openHeadlessStorageForWrite(storageRoot);
    const runStore = storage.executionStores.agentRunStore;
    await runStore.createRun(header);
    await runStore.appendEvent(identity.sessionId, identity.runId, {
      type: 'provider_request_captured',
      id: 'capture-event-1',
      ...identity,
      ts: 2,
      data: {
        schemaVersion: 2,
        traceId: 'provider-trace-1',
        captureId: 'capture-1',
        artifactId: 'artifact-capture-1',
        turnId: identity.turnId,
        step: 0,
        providerId: 'openai',
        modelId: 'k3',
        requestHash: 'sha256:request-1',
        requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request-1',
        requestBytes: 100,
        segments: [],
      },
    });
    await runStore.appendEvent(identity.sessionId, identity.runId, {
      type: 'provider_request_attempt_recorded',
      id: 'attempt-event-1',
      ...identity,
      ts: 3,
      data: {
        traceId: 'provider-trace-1',
        attemptId: 'attempt-1',
        turnId: identity.turnId,
        step: 0,
        attempt: 1,
        captureId: 'capture-1',
        captureArtifactId: 'artifact-capture-1',
        providerId: 'openai',
        modelId: 'k3',
        contextWindow: 200_000,
        requestHash: 'sha256:request-1',
        requestBytes: 100,
        segments: [],
        startedAt: 2,
        completedAt: 3,
        status: 'completed',
        latencyMs: 1,
      },
    });
    await runStore.updateRun(identity.sessionId, identity.runId, {
      traceWriteError: 'append provider request attempt: disk full',
      updatedAt: 4,
    });

    const traceEventsPath = await writeHarborTaskRunTrace({
      outputDir,
      storage,
      invocations: [invocation],
    });
    const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

    assert.equal(result.attempts[0]?.contextWindow, 200_000);
    assert.throws(
      () => traceAnalysis.assertProviderRequestTraceComplete(result),
      /trace write failed evidence/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exports a torn AgentRun tail as incomplete provider-request evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-trace-export-'));
  const storageRoot = join(root, 'storage');
  const outputDir = join(root, 'output');
  const runId = 'run-torn-export';
  const identity = {
    runId,
    sessionId: `session-${runId}`,
    turnId: `turn-${runId}`,
  };
  const header: AgentRunHeader = {
    ...identity,
    status: 'completed',
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'kimi-coding-plan',
    modelId: 'k3',
    cwd: root,
    permissionMode: 'execute',
    createdAt: 1,
    updatedAt: 4,
    completedAt: 4,
  };
  const invocation: InvocationResult = {
    invocationId: 'invocation-torn-export',
    ...identity,
    status: 'completed',
    events: [],
    startedAt: 1,
    finishedAt: 4,
  };
  const { capture, attempt } = completeTraceRows(runId);

  try {
    await mkdir(outputDir, { recursive: true });
    const storage = await openHeadlessStorageForWrite(storageRoot);
    const runStore = storage.executionStores.agentRunStore;
    await runStore.createRun(header);
    await runStore.appendEvent(identity.sessionId, identity.runId, capture as EmittedAgentRunEvent);
    await runStore.appendEvent(identity.sessionId, identity.runId, attempt as EmittedAgentRunEvent);
    corruptAgentRunEvent(storageRoot, identity.sessionId, identity.runId, 1);

    const traceEventsPath = await writeHarborTaskRunTrace({
      outputDir,
      storage,
      invocations: [invocation],
    });
    const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      ['event_corrupt'],
    );
    assert.throws(
      () => traceAnalysis.assertProviderRequestTraceComplete(result),
      /event corrupt evidence/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('also diagnoses missing provider evidence when the only run event is corrupt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-trace-export-'));
  const storageRoot = join(root, 'storage');
  const outputDir = join(root, 'output');
  const identity = {
    runId: 'run-only-corrupt',
    sessionId: 'session-only-corrupt',
    turnId: 'turn-only-corrupt',
  };
  const invocation: InvocationResult = {
    invocationId: 'invocation-only-corrupt',
    ...identity,
    status: 'completed',
    events: [],
    startedAt: 1,
    finishedAt: 4,
  };

  try {
    await mkdir(outputDir, { recursive: true });
    const storage = await openHeadlessStorageForWrite(storageRoot);
    await storage.executionStores.agentRunStore.createRun({
      ...identity,
      status: 'completed',
      backendKind: 'ai-sdk',
      llmConnectionSlug: 'kimi-coding-plan',
      modelId: 'k3',
      cwd: root,
      permissionMode: 'execute',
      createdAt: 1,
      updatedAt: 4,
      completedAt: 4,
    });
    await storage.executionStores.agentRunStore.appendEvent(identity.sessionId, identity.runId, {
      type: 'tool_failed',
      id: 'corrupt-event',
      ...identity,
      ts: 2,
      message: 'will be corrupted',
    });
    corruptAgentRunEvent(storageRoot, identity.sessionId, identity.runId, 0);

    const traceEventsPath = await writeHarborTaskRunTrace({
      outputDir,
      storage,
      invocations: [invocation],
    });
    const exportedEvents = (await readFile(traceEventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EmittedAgentRunEvent);

    assert.deepEqual(
      exportedEvents.map((event) => event.type),
      ['event_corrupt', 'event_corrupt'],
    );
    assert.equal(exportedEvents[1]?.data?.reason, 'missing_provider_request_evidence');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function corruptAgentRunEvent(
  storageRoot: string,
  sessionId: string,
  runId: string,
  sequence: number,
): void {
  const lease = acquireOperationalStateDatabase(storageRoot);
  try {
    const result = lease.database
      .prepare(`
        UPDATE core_agent_run_events
        SET record_json = ?
        WHERE session_id = ? AND run_id = ? AND sequence = ?
      `)
      .run('{"type":"corrupt"', sessionId, runId, sequence);
    assert.equal(result.changes, 1);
  } finally {
    lease.close();
  }
}

test('exports missing provider-request evidence for every continuation invocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-trace-export-'));
  const storageRoot = join(root, 'storage');
  const outputDir = join(root, 'output');
  const identities = [
    { runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1' },
    { runId: 'run-2', sessionId: 'session-1', turnId: 'turn-2' },
  ];
  const invocations: InvocationResult[] = identities.map((identity, index) => ({
    invocationId: `invocation-${index + 1}`,
    ...identity,
    status: 'completed',
    events: [],
    startedAt: index * 10 + 1,
    finishedAt: index * 10 + 4,
  }));

  try {
    await mkdir(outputDir, { recursive: true });
    const storage = await openHeadlessStorageForWrite(storageRoot);
    const runStore = storage.executionStores.agentRunStore;
    for (const [index, identity] of identities.entries()) {
      const timestamp = index * 10 + 1;
      await runStore.createRun({
        ...identity,
        status: 'completed',
        backendKind: 'ai-sdk',
        llmConnectionSlug: 'kimi-coding-plan',
        modelId: 'k3',
        cwd: root,
        permissionMode: 'execute',
        createdAt: timestamp,
        updatedAt: timestamp + 3,
        completedAt: timestamp + 3,
      });
    }

    const completeIdentity = identities[1]!;
    const { capture, attempt } = completeTraceRows(completeIdentity.runId);
    Object.assign(capture, completeIdentity);
    Object.assign(attempt, completeIdentity);
    capture.data.turnId = completeIdentity.turnId;
    attempt.data.turnId = completeIdentity.turnId;
    await runStore.appendEvent(
      completeIdentity.sessionId,
      completeIdentity.runId,
      capture as EmittedAgentRunEvent,
    );
    await runStore.appendEvent(
      completeIdentity.sessionId,
      completeIdentity.runId,
      attempt as EmittedAgentRunEvent,
    );

    const traceEventsPath = await writeHarborTaskRunTrace({
      outputDir,
      storage,
      invocations,
    });
    const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

    assert.deepEqual(result.identities, identities);
    assert.throws(
      () =>
        traceAnalysis.assertProviderRequestTraceComplete(result, {
          expectedIdentity: completeIdentity,
        }),
      /event corrupt evidence/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves existing run events when exporting a missing-evidence diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-provider-trace-export-'));
  const storageRoot = join(root, 'storage');
  const outputDir = join(root, 'output');
  const identity = { runId: 'run-tool-failed', sessionId: 'session-1', turnId: 'turn-1' };
  const invocation: InvocationResult = {
    invocationId: 'invocation-tool-failed',
    ...identity,
    status: 'completed',
    events: [],
    startedAt: 1,
    finishedAt: 4,
  };

  try {
    await mkdir(outputDir, { recursive: true });
    const storage = await openHeadlessStorageForWrite(storageRoot);
    const runStore = storage.executionStores.agentRunStore;
    await runStore.createRun({
      ...identity,
      status: 'completed',
      backendKind: 'ai-sdk',
      llmConnectionSlug: 'kimi-coding-plan',
      modelId: 'k3',
      cwd: root,
      permissionMode: 'execute',
      createdAt: 1,
      updatedAt: 4,
      completedAt: 4,
    });
    await runStore.appendEvent(identity.sessionId, identity.runId, {
      type: 'tool_failed',
      id: 'tool-failed-1',
      ...identity,
      ts: 3,
      message: 'tool failed before the provider trace was recorded',
    });

    const traceEventsPath = await writeHarborTaskRunTrace({
      outputDir,
      storage,
      invocations: [invocation],
    });
    const exportedEvents = (await readFile(traceEventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as EmittedAgentRunEvent);

    assert.deepEqual(
      exportedEvents.map((event) => event.type),
      ['tool_failed', 'event_corrupt'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const backendKind of ['fake', 'pi-agent'] as const) {
  test(`does not diagnose missing provider-request evidence for ${backendKind} runs`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-provider-trace-export-'));
    const storageRoot = join(root, 'storage');
    const outputDir = join(root, 'output');
    const identity = {
      runId: `run-${backendKind}`,
      sessionId: 'session-1',
      turnId: 'turn-1',
    };
    const invocation: InvocationResult = {
      invocationId: `invocation-${backendKind}`,
      ...identity,
      status: 'completed',
      events: [],
      startedAt: 1,
      finishedAt: 4,
    };

    try {
      await mkdir(outputDir, { recursive: true });
      const storage = await openHeadlessStorageForWrite(storageRoot);
      await storage.executionStores.agentRunStore.createRun({
        ...identity,
        status: 'completed',
        backendKind,
        llmConnectionSlug: 'test-connection',
        modelId: 'test-model',
        cwd: root,
        permissionMode: 'execute',
        createdAt: 1,
        updatedAt: 4,
        completedAt: 4,
      });

      const traceEventsPath = await writeHarborTaskRunTrace({
        outputDir,
        storage,
        invocations: [invocation],
      });

      assert.equal(await readFile(traceEventsPath, 'utf8'), '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('reads a v2 capture and attempt and binds them to the expected execution identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const identity = { runId: 'run-2', sessionId: 'session-2', turnId: 'turn-2' };
  const capture = {
    type: 'provider_request_captured',
    id: 'capture-event-1',
    ...identity,
    ts: 1,
    data: {
      schemaVersion: 2,
      traceId: 'provider-trace-2',
      captureId: 'capture-1',
      artifactId: 'artifact-capture-1',
      turnId: identity.turnId,
      step: 0,
      providerId: 'openai',
      modelId: 'k3',
      requestHash: 'sha256:request-1',
      requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request-1',
      requestBytes: 100,
      segments: [],
    },
  };
  const attempt = {
    type: 'provider_request_attempt_recorded',
    id: 'attempt-event-1',
    ...identity,
    ts: 4,
    data: {
      traceId: 'provider-trace-2',
      attemptId: 'attempt-1',
      turnId: identity.turnId,
      step: 0,
      attempt: 1,
      captureId: 'capture-1',
      captureArtifactId: 'artifact-capture-1',
      providerId: 'openai',
      modelId: 'k3',
      requestHash: 'sha256:request-1',
      requestBytes: 100,
      segments: [],
      startedAt: 2,
      completedAt: 4,
      status: 'completed',
      finishReason: 'stop',
      latencyMs: 2,
      inputTokens: 12,
      outputTokens: 3,
    },
  };
  await writeFile(traceEventsPath, `${JSON.stringify(capture)}\n${JSON.stringify(attempt)}\n`);

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.equal(result.captures[0]?.schemaVersion, 2);
  assert.equal(
    result.captures[0]?.requestPayloadWithoutProviderOptionsHash,
    'sha256:shared-request-1',
  );
  assert.equal(result.attempts.length, 1);
  assert.doesNotThrow(() =>
    traceAnalysis.assertProviderRequestTraceComplete(result, { expectedIdentity: identity }),
  );
  assert.throws(
    () =>
      traceAnalysis.assertProviderRequestTraceComplete(result, {
        expectedIdentity: { ...identity, runId: 'run-unrelated' },
      }),
    /runId.*run-unrelated.*run-2/i,
  );
});

test('validates every request across same-session continuation executions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-continuation-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const rows: Record<string, unknown>[] = [];
  const identities = [
    { runId: 'run-1', sessionId: 'session-1', turnId: 'turn-1' },
    { runId: 'run-2', sessionId: 'session-1', turnId: 'turn-2' },
  ];
  for (const [index, identity] of identities.entries()) {
    const suffix = String(index + 1);
    const traceId = `provider-trace-${suffix}`;
    const captureId = `capture-${suffix}`;
    const artifactId = `artifact-${suffix}`;
    rows.push(
      {
        type: 'provider_request_captured',
        id: `capture-event-${suffix}`,
        ...identity,
        ts: index * 10 + 1,
        data: {
          schemaVersion: 2,
          traceId,
          captureId,
          artifactId,
          turnId: identity.turnId,
          step: 0,
          providerId: 'openai',
          modelId: 'k3',
          requestHash: `sha256:request-${suffix}`,
          requestPayloadWithoutProviderOptionsHash: `sha256:shared-request-${suffix}`,
          requestBytes: 100,
          segments: [
            {
              kind: 'message',
              index: 0,
              role: 'user',
              cacheable: true,
              hash: `sha256:message-${suffix}`,
              bytes: 10,
            },
          ],
        },
      },
      {
        type: 'provider_request_attempt_recorded',
        id: `attempt-event-${suffix}`,
        ...identity,
        ts: index * 10 + 3,
        data: {
          traceId,
          attemptId: `attempt-${suffix}`,
          turnId: identity.turnId,
          step: 0,
          attempt: 1,
          captureId,
          captureArtifactId: artifactId,
          providerId: 'openai',
          modelId: 'k3',
          requestHash: `sha256:request-${suffix}`,
          requestBytes: 100,
          segments: [
            {
              kind: 'message',
              index: 0,
              role: 'user',
              cacheable: true,
              hash: `sha256:message-${suffix}`,
              bytes: 10,
            },
          ],
          startedAt: index * 10 + 2,
          completedAt: index * 10 + 3,
          status: 'completed',
          latencyMs: 1,
        },
      },
    );
  }
  await writeFile(traceEventsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.equal(result.captures.length, 2);
  assert.equal(result.captures[1]?.firstChangedCacheableSegment, undefined);
  assert.doesNotThrow(() =>
    traceAnalysis.assertProviderRequestTraceComplete(result, {
      expectedIdentity: identities[1],
    }),
  );
});

test('reads autonomous retry traces across distinct session identities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-retries-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const identities = [
    { runId: 'run-retry-1', sessionId: 'session-retry-1', turnId: 'turn-retry-1' },
    { runId: 'run-retry-2', sessionId: 'session-retry-2', turnId: 'turn-retry-2' },
  ];
  const rows = identities.flatMap((identity, index) => {
    const suffix = String(index + 1);
    const { capture, attempt } = completeTraceRows(identity.runId);
    Object.assign(capture, identity, { id: `capture-event-retry-${suffix}` });
    Object.assign(attempt, identity, { id: `attempt-event-retry-${suffix}` });
    capture.data.captureId = `capture-retry-${suffix}`;
    capture.data.artifactId = `artifact-retry-${suffix}`;
    capture.data.turnId = identity.turnId;
    attempt.data.attemptId = `attempt-retry-${suffix}`;
    attempt.data.captureId = capture.data.captureId;
    attempt.data.captureArtifactId = capture.data.artifactId;
    attempt.data.turnId = identity.turnId;
    return [capture, attempt];
  });
  await writeFile(traceEventsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.deepEqual(result.identities, identities);
  assert.deepEqual(result.diagnostics, []);
  assert.doesNotThrow(() =>
    traceAnalysis.assertProviderRequestTraceComplete(result, { expectedIdentities: identities }),
  );
  assert.throws(
    () =>
      traceAnalysis.assertProviderRequestTraceComplete(result, {
        expectedIdentities: [identities[1]!],
      }),
    /execution identity set.*run-retry-1/i,
  );
});

test('fails completeness when a later request attempt record is torn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const identity = { runId: 'run-3', sessionId: 'session-3', turnId: 'turn-3' };
  const capture = {
    type: 'provider_request_captured',
    id: 'capture-event-1',
    ...identity,
    ts: 1,
    data: {
      schemaVersion: 2,
      traceId: 'provider-trace-3',
      captureId: 'capture-1',
      artifactId: 'artifact-capture-1',
      turnId: identity.turnId,
      step: 0,
      providerId: 'openai',
      modelId: 'k3',
      requestHash: 'sha256:request-1',
      requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request-1',
      requestBytes: 100,
      segments: [],
    },
  };
  const firstAttempt = {
    type: 'provider_request_attempt_recorded',
    id: 'attempt-event-1',
    ...identity,
    ts: 3,
    data: {
      traceId: 'provider-trace-3',
      attemptId: 'attempt-1',
      turnId: identity.turnId,
      step: 0,
      attempt: 1,
      captureId: 'capture-1',
      captureArtifactId: 'artifact-capture-1',
      providerId: 'openai',
      modelId: 'k3',
      requestHash: 'sha256:request-1',
      requestBytes: 100,
      segments: [],
      startedAt: 2,
      completedAt: 3,
      status: 'failed',
      latencyMs: 1,
    },
  };
  await writeFile(
    traceEventsPath,
    `${JSON.stringify(capture)}\n${JSON.stringify(firstAttempt)}\n{"type":"provider_request_attempt_recorded"`,
  );

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.equal(result.attempts.length, 1);
  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['invalid_json'],
  );
  assert.throws(
    () => traceAnalysis.assertProviderRequestTraceComplete(result),
    /line 3.*valid JSON/i,
  );
});

test('diagnoses a complete but malformed request attempt row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const { capture, attempt } = completeTraceRows('run-4');
  Reflect.deleteProperty(attempt.data, 'requestHash');
  await writeFile(traceEventsPath, `${JSON.stringify(capture)}\n${JSON.stringify(attempt)}\n`);

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['invalid_attempt'],
  );
  assert.throws(
    () => traceAnalysis.assertProviderRequestTraceComplete(result),
    /line 2.*attempt data is invalid/i,
  );
});

test('accepts request attempt timing emitted across a non-monotonic clock adjustment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const { capture, attempt } = completeTraceRows('run-clock-adjustment');
  attempt.data.startedAt = 4;
  attempt.data.completedAt = 3;
  attempt.data.latencyMs = 0;
  await writeFile(traceEventsPath, `${JSON.stringify(capture)}\n${JSON.stringify(attempt)}\n`);

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.deepEqual(result.diagnostics, []);
  assert.doesNotThrow(() => traceAnalysis.assertProviderRequestTraceComplete(result));
});

test('accepts finite fractional timing emitted by the Runtime attempt contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const { capture, attempt } = completeTraceRows('run-fractional-clock');
  attempt.data.startedAt = 2.25;
  attempt.data.completedAt = 4.75;
  attempt.data.latencyMs = 2.5;
  Reflect.set(attempt.data, 'timeToFirstTokenMs', 0.5);
  await writeFile(traceEventsPath, `${JSON.stringify(capture)}\n${JSON.stringify(attempt)}\n`);

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.deepEqual(result.diagnostics, []);
  assert.doesNotThrow(() => traceAnalysis.assertProviderRequestTraceComplete(result));
});

test('fails completeness when the execution contains a trace failure sentinel', async () => {
  for (const type of ['trace_write_failed', 'event_corrupt'] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
    const traceEventsPath = join(dir, 'events.jsonl');
    const { capture, attempt } = completeTraceRows(`run-${type}`);
    const sentinel = {
      type,
      id: `${type}-event`,
      runId: capture.runId,
      sessionId: capture.sessionId,
      turnId: capture.turnId,
      ts: 5,
      message: `${type} fixture`,
    };
    await writeFile(
      traceEventsPath,
      `${[capture, attempt, sentinel].map((event) => JSON.stringify(event)).join('\n')}\n`,
    );

    const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code),
      [type],
    );
    assert.throws(
      () => traceAnalysis.assertProviderRequestTraceComplete(result),
      new RegExp(`line 3.*${type.replaceAll('_', ' ')}`, 'i'),
    );
  }
});

test('fails completeness when provider request rows mix execution identities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const { capture, attempt } = completeTraceRows('run-identity-a');
  attempt.runId = 'run-identity-b';
  await writeFile(traceEventsPath, `${JSON.stringify(capture)}\n${JSON.stringify(attempt)}\n`);

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.deepEqual(
    result.diagnostics.map((diagnostic) => diagnostic.code),
    ['mixed_identity'],
  );
  assert.throws(
    () => traceAnalysis.assertProviderRequestTraceComplete(result),
    /line 2.*identity.*run-identity-b.*run-identity-a/i,
  );
});

test('fails completeness when an attempt does not match its request capture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const { capture, attempt } = completeTraceRows('run-mismatched-capture');
  attempt.data.requestHash = 'sha256:another-request';
  await writeFile(traceEventsPath, `${JSON.stringify(capture)}\n${JSON.stringify(attempt)}\n`);

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.deepEqual(result.diagnostics, []);
  assert.throws(
    () => traceAnalysis.assertProviderRequestTraceComplete(result),
    /attempt attempt-1 does not match its request capture/i,
  );
});

test('fails completeness when capture ids are duplicated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const { capture, attempt } = completeTraceRows('run-duplicate-capture');
  const duplicateCapture = structuredClone(capture);
  duplicateCapture.id = 'capture-event-2';
  await writeFile(
    traceEventsPath,
    `${[capture, duplicateCapture, attempt].map((event) => JSON.stringify(event)).join('\n')}\n`,
  );

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.throws(
    () => traceAnalysis.assertProviderRequestTraceComplete(result),
    /duplicate capture id capture-1/i,
  );
});

test('fails completeness when attempt ids are duplicated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const { capture, attempt } = completeTraceRows('run-duplicate-attempt');
  const duplicateAttempt = structuredClone(attempt);
  duplicateAttempt.id = 'attempt-event-2';
  duplicateAttempt.data.attempt = 2;
  await writeFile(
    traceEventsPath,
    `${[capture, attempt, duplicateAttempt].map((event) => JSON.stringify(event)).join('\n')}\n`,
  );

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.throws(
    () => traceAnalysis.assertProviderRequestTraceComplete(result),
    /duplicate attempt id attempt-1/i,
  );
});

test('fails completeness when a capture has no request attempt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const { capture, attempt } = completeTraceRows('run-unattempted-capture');
  const unattemptedCapture = structuredClone(capture);
  unattemptedCapture.id = 'capture-event-2';
  unattemptedCapture.ts = 5;
  unattemptedCapture.data.captureId = 'capture-2';
  unattemptedCapture.data.artifactId = 'artifact-capture-2';
  unattemptedCapture.data.step = 1;
  unattemptedCapture.data.requestHash = 'sha256:request-2';
  await writeFile(
    traceEventsPath,
    `${[capture, attempt, unattemptedCapture].map((event) => JSON.stringify(event)).join('\n')}\n`,
  );

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.throws(
    () => traceAnalysis.assertProviderRequestTraceComplete(result),
    /capture capture-2 has no request attempt/i,
  );
});

test('fails completeness when individually valid attempts have an ordinal gap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-provider-trace-'));
  const traceEventsPath = join(dir, 'events.jsonl');
  const { capture, attempt } = completeTraceRows('run-5');
  const thirdAttempt = structuredClone(attempt);
  thirdAttempt.id = 'attempt-event-3';
  thirdAttempt.ts = 6;
  thirdAttempt.data.attemptId = 'attempt-3';
  thirdAttempt.data.attempt = 3;
  thirdAttempt.data.startedAt = 5;
  thirdAttempt.data.completedAt = 6;
  thirdAttempt.data.latencyMs = 1;
  await writeFile(
    traceEventsPath,
    `${[capture, attempt, thirdAttempt].map((event) => JSON.stringify(event)).join('\n')}\n`,
  );

  const result = await traceAnalysis.readProviderRequestTrace(traceEventsPath);

  assert.deepEqual(result.diagnostics, []);
  assert.throws(
    () => traceAnalysis.assertProviderRequestTraceComplete(result),
    /step 0 request attempt sequence is incomplete/i,
  );
});

function completeTraceRows(runId: string) {
  const identity = { runId, sessionId: `session-${runId}`, turnId: `turn-${runId}` };
  const capture = {
    type: 'provider_request_captured',
    id: 'capture-event-1',
    ...identity,
    ts: 1,
    data: {
      schemaVersion: 2,
      traceId: `trace-${runId}`,
      captureId: 'capture-1',
      artifactId: 'artifact-capture-1',
      turnId: identity.turnId,
      step: 0,
      providerId: 'openai',
      modelId: 'k3',
      requestHash: 'sha256:request-1',
      requestPayloadWithoutProviderOptionsHash: 'sha256:shared-request-1',
      requestBytes: 100,
      segments: [],
    },
  };
  const attempt = {
    type: 'provider_request_attempt_recorded',
    id: 'attempt-event-1',
    ...identity,
    ts: 4,
    data: {
      traceId: `trace-${runId}`,
      attemptId: 'attempt-1',
      turnId: identity.turnId,
      step: 0,
      attempt: 1,
      captureId: 'capture-1',
      captureArtifactId: 'artifact-capture-1',
      providerId: 'openai',
      modelId: 'k3',
      requestHash: 'sha256:request-1',
      requestBytes: 100,
      segments: [],
      startedAt: 2,
      completedAt: 4,
      status: 'completed',
      latencyMs: 2,
    },
  };
  return { capture, attempt };
}
