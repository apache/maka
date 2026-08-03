import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { AgentRunHeader, EmittedAgentRunEvent } from '@maka/core';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  EXECUTION_INSPECT_EVIDENCE_MAX_BYTES,
  EXECUTION_INSPECT_SESSION_MAX_RUNS,
} from '../protocol/index.js';
import { HostExecutionInspectCoordinator } from '../server/execution-inspect-coordinator.js';

describe('HostExecutionInspectCoordinator', () => {
  test('resolves duplicate AgentRun identities and returns canonical evidence documents', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const first = await stores.sessionStore.create(sessionInput('First'));
      const second = await stores.sessionStore.create(sessionInput('Second'));
      await stores.agentRunStore.createRun(runHeader(first.id, 'shared-run', 1));
      await stores.agentRunStore.createRun(runHeader(second.id, 'shared-run', 2));
      await stores.agentRunStore.createRun(runHeader(second.id, first.id, 3));

      const crossKind = await coordinator.handlers['execution.inspect.resolve'](
        { id: first.id },
        connectionContext(),
      );
      assert.equal(crossKind.ok, true);
      if (!crossKind.ok) return;
      assert.equal(crossKind.result.status, 'ambiguous');
      assert.deepEqual(
        crossKind.result.candidates.map((candidate) => candidate.kind),
        ['agent_run', 'session'],
      );

      const ambiguous = await coordinator.handlers['execution.inspect.resolve'](
        { id: 'shared-run', requestedKind: 'agent_run' },
        connectionContext(),
      );
      assert.equal(ambiguous.ok, true);
      if (!ambiguous.ok) return;
      assert.equal(ambiguous.result.status, 'ambiguous');
      assert.deepEqual(
        ambiguous.result.candidates.map((candidate) =>
          candidate.kind === 'agent_run' ? candidate.sessionId : undefined,
        ),
        [first.id, second.id].sort(),
      );

      const resolved = await coordinator.handlers['execution.inspect.resolve'](
        { id: 'shared-run', requestedKind: 'agent_run', sessionId: second.id },
        connectionContext(),
      );
      assert.equal(resolved.ok, true);
      if (!resolved.ok) return;
      assert.equal(resolved.result.status, 'resolved');

      const run = await coordinator.handlers['execution.inspect.query'](
        { kind: 'agent_run', sessionId: second.id, agentRunId: 'shared-run' },
        connectionContext(),
      );
      assert.equal(run.ok, true);
      if (!run.ok || run.result.kind !== 'agent_run') return;
      assert.equal(run.result.document.agentRun.sessionId, second.id);
      assert.equal(run.result.document.agentRun.agentRunId, 'shared-run');

      const session = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session', sessionId: first.id },
        connectionContext(),
      );
      assert.equal(session.ok, true);
      if (!session.ok || session.result.kind !== 'session') return;
      assert.equal(session.result.document.session.sessionId, first.id);
      assert.deepEqual(
        session.result.document.agentRuns.map((document) => document.agentRun.agentRunId),
        ['shared-run'],
      );
    });
  });

  test('bounds live Session inspection and reports missing evidence without mutation', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Large'));
      for (let index = 0; index <= EXECUTION_INSPECT_SESSION_MAX_RUNS; index += 1) {
        await stores.agentRunStore.createRun(runHeader(session.id, `run-${index}`, index));
      }

      const oversized = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session', sessionId: session.id },
        connectionContext(),
      );
      assert.deepEqual(oversized, {
        ok: false,
        error: {
          code: 'invalid_request',
          message:
            'Session inspection exceeds the live Host run limit; inspect one AgentRun instead',
        },
      });
      const missing = await coordinator.handlers['execution.inspect.query'](
        { kind: 'agent_run', sessionId: session.id, agentRunId: 'missing' },
        connectionContext(),
      );
      assert.equal(missing.ok, false);
      if (missing.ok) return;
      assert.equal(missing.error.code, 'not_found');
    });
  });

  test('rejects oversized evidence at the bounded Store read boundary', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Large evidence'));
      await stores.agentRunStore.createRun(runHeader(session.id, 'large-run', 1));
      await stores.agentRunStore.appendEvent(session.id, 'large-run', {
        type: 'run_started',
        id: 'large-event',
        sessionId: session.id,
        runId: 'large-run',
        turnId: 'turn-large-run',
        ts: 1,
        data: { payload: 'x'.repeat(EXECUTION_INSPECT_EVIDENCE_MAX_BYTES) },
      });

      const result = await coordinator.handlers['execution.inspect.query'](
        { kind: 'agent_run', sessionId: session.id, agentRunId: 'large-run' },
        connectionContext(),
      );

      assert.deepEqual(result, {
        ok: false,
        error: {
          code: 'invalid_request',
          message:
            'AgentRun inspection exceeds the live Host evidence limit; stop the Host to inspect it offline',
        },
      });
    });
  });

  test('accepts evidence that exactly consumes the shared byte budget before an empty ledger', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Exact evidence budget'));
      await stores.agentRunStore.createRun(runHeader(session.id, 'exact-run', 1));
      const baseEvent: EmittedAgentRunEvent = {
        type: 'run_started',
        id: 'exact-event',
        sessionId: session.id,
        runId: 'exact-run',
        turnId: 'turn-exact-run',
        ts: 1,
        data: { payload: '' },
      };
      const baseBytes = Buffer.byteLength(JSON.stringify(baseEvent), 'utf8');
      assert.ok(baseBytes < EXECUTION_INSPECT_EVIDENCE_MAX_BYTES);
      const event = {
        ...baseEvent,
        data: {
          payload: 'x'.repeat(EXECUTION_INSPECT_EVIDENCE_MAX_BYTES - baseBytes),
        },
      };
      await stores.agentRunStore.appendEvent(session.id, 'exact-run', event);

      const exact = await stores.agentRunStore.readEventsBounded(session.id, 'exact-run', {
        maxRecords: 1,
        maxBytes: EXECUTION_INSPECT_EVIDENCE_MAX_BYTES,
      });
      assert.equal(exact.status, 'complete');
      const oneByteShort = await stores.agentRunStore.readEventsBounded(session.id, 'exact-run', {
        maxRecords: 1,
        maxBytes: EXECUTION_INSPECT_EVIDENCE_MAX_BYTES - 1,
      });
      assert.equal(oneByteShort.status, 'limit_exceeded');

      const result = await coordinator.handlers['execution.inspect.query'](
        { kind: 'agent_run', sessionId: session.id, agentRunId: 'exact-run' },
        connectionContext(),
      );
      assert.equal(result.ok, true);
    });
  });

  test('shares one evidence budget across every AgentRun in a Session query', async () => {
    await withCoordinator(async ({ stores, coordinator }) => {
      const session = await stores.sessionStore.create(sessionInput('Aggregate evidence'));
      const payload = 'x'.repeat(Math.ceil(EXECUTION_INSPECT_EVIDENCE_MAX_BYTES / 2));
      for (const [index, runId] of ['aggregate-run-1', 'aggregate-run-2'].entries()) {
        await stores.agentRunStore.createRun(runHeader(session.id, runId, index + 1));
        await stores.agentRunStore.appendEvent(session.id, runId, {
          type: 'run_started',
          id: `aggregate-event-${index + 1}`,
          sessionId: session.id,
          runId,
          turnId: `turn-${runId}`,
          ts: index + 1,
          data: { payload },
        });
      }

      const individual = await coordinator.handlers['execution.inspect.query'](
        { kind: 'agent_run', sessionId: session.id, agentRunId: 'aggregate-run-1' },
        connectionContext(),
      );
      assert.equal(individual.ok, true);

      const aggregate = await coordinator.handlers['execution.inspect.query'](
        { kind: 'session', sessionId: session.id },
        connectionContext(),
      );
      assert.deepEqual(aggregate, {
        ok: false,
        error: {
          code: 'invalid_request',
          message:
            'Session inspection exceeds the live Host evidence limit; stop the Host to inspect it offline',
        },
      });
    });
  });
});

function sessionInput(name: string) {
  return {
    cwd: '/tmp/workspace',
    name,
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
  } as const;
}

function runHeader(sessionId: string, runId: string, createdAt: number): AgentRunHeader {
  return {
    sessionId,
    runId,
    turnId: `turn-${runId}`,
    status: 'completed',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/workspace',
    permissionMode: 'ask',
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
  };
}

function connectionContext() {
  return {
    hostEpoch: 'host-1',
    connectionId: 'connection-1',
    surface: 'inspect' as const,
    principal: 'local_os_user' as const,
    acquireResidency: () => ({ release: () => undefined }),
  };
}

async function withCoordinator(
  run: (input: {
    stores: Awaited<ReturnType<typeof openInteractiveExecutionStoresForWrite>>;
    coordinator: HostExecutionInspectCoordinator;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-host-inspect-'));
  const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const stores = await openInteractiveExecutionStoresForWrite(owner.lease);
  try {
    await run({ stores, coordinator: new HostExecutionInspectCoordinator(stores) });
  } finally {
    await stores.sessionStore.close?.();
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}
