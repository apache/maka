import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import assert from 'node:assert/strict';
import { createAgentRunStore, createRuntimeEventStore } from '../agent-run-store.js';
import {
  DurableStoreWriteError,
  type AgentRunEvent,
  type AgentRunHeader,
  type RuntimeEvent,
} from '@maka/core';

describe('AgentRunStore', () => {
  it('creates, reads, updates, and lists runs under a session', async () => {
    await withStore(async (store, root) => {
      const first = makeHeader({
        runId: 'run-1',
        invocationId: 'invocation-1',
        createdAt: 1,
        updatedAt: 1,
      });
      const second = makeHeader({
        runId: 'run-2',
        turnId: 'turn-2',
        status: 'waiting_for_user',
        createdAt: 2,
        updatedAt: 2,
      });

      await store.createRun(second);
      await store.createRun(first);
      await store.updateRun('session-1', 'run-1', {
        status: 'completed',
        completedAt: 10,
        updatedAt: 10,
      });

      const read = await store.readRun('session-1', 'run-1');
      assert.equal(read.status, 'completed');
      assert.equal(read.completedAt, 10);
      assert.equal(read.invocationId, 'invocation-1');
      assert.equal((await store.readRun('session-1', 'run-2')).status, 'waiting_for_user');
      assert.deepEqual(
        (await store.listSessionRuns('session-1')).map((run) => run.runId),
        ['run-1', 'run-2'],
      );
      assert.equal(
        JSON.parse(
          await readFile(join(root, 'sessions', 'session-1', 'runs', 'run-1', 'run.json'), 'utf8'),
        ).runId,
        'run-1',
      );
    });
  });

  it('rejects duplicate run creation without replacing the existing header', async () => {
    await withStore(async (store) => {
      const original = makeHeader({ invocationId: 'invocation-original' });
      await store.createRun(original);

      await assert.rejects(
        () => store.createRun(makeHeader({ invocationId: 'invocation-replacement', updatedAt: 2 })),
        /already exists/i,
      );

      assert.deepEqual(await store.readRun('session-1', 'run-1'), original);
    });
  });

  it('rejects malformed run headers instead of returning partial records', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const runPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'run.json');
      await writeFile(
        runPath,
        JSON.stringify({ runId: 'run-1', sessionId: 'session-1' }) + '\n',
        'utf8',
      );

      await assert.rejects(
        () => store.readRun('session-1', 'run-1'),
        /Invalid AgentRun header for run run-1: malformed fields/,
      );
      assert.deepEqual(await store.listSessionRuns('session-1'), []);
    });
  });

  it('decodes and lists legacy waiting_permission headers as waiting_for_user', async () => {
    await withStore(async (store, root) => {
      const runPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'run.json');
      await mkdir(dirname(runPath), { recursive: true });
      await writeFile(
        runPath,
        JSON.stringify({ ...makeHeader(), status: 'waiting_permission' }) + '\n',
        'utf8',
      );

      assert.equal((await store.readRun('session-1', 'run-1')).status, 'waiting_for_user');
      assert.deepEqual(
        (await store.listSessionRuns('session-1')).map((run) => [run.runId, run.status]),
        [['run-1', 'waiting_for_user']],
      );
      assert.deepEqual(
        (await store.listSessionRunsForRecovery('session-1')).map((run) => [run.runId, run.status]),
        [['run-1', 'waiting_for_user']],
      );
      assert.equal(
        JSON.parse(await readFile(runPath, 'utf8')).status,
        'waiting_permission',
        'read recovery must not rewrite legacy bytes',
      );
    });
  });

  it('rejects malformed run headers on update without overwriting bytes', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const runPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'run.json');
      const invalid =
        JSON.stringify(
          {
            runId: 'run-1',
            sessionId: 'session-1',
            turnId: 'turn-1',
            status: 'running',
            backendKind: 'fake',
            llmConnectionSlug: 'fake',
            modelId: 'fake-model',
            cwd: '/tmp/cwd',
            permissionMode: 'ask',
            createdAt: 1,
            updatedAt: 'soon',
          },
          null,
          2,
        ) + '\n';
      await writeFile(runPath, invalid, 'utf8');

      await assert.rejects(
        () =>
          store.updateRun('session-1', 'run-1', {
            status: 'completed',
            completedAt: 10,
            updatedAt: 10,
          }),
        /Invalid AgentRun header for run run-1: malformed fields/,
      );
      assert.equal(await readFile(runPath, 'utf8'), invalid);
    });
  });

  it('rejects malformed optional run header fields', async () => {
    await withStore(async (store, root) => {
      const runPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'run.json');
      for (const patch of [{ automationId: 42 }, { abortSource: false }]) {
        await mkdir(dirname(runPath), { recursive: true });
        await writeFile(runPath, JSON.stringify({ ...makeHeader(), ...patch }) + '\n', 'utf8');
        await assert.rejects(
          () => store.readRun('session-1', 'run-1'),
          /Invalid AgentRun header for run run-1: malformed fields/,
        );
      }
    });
  });

  it('serializes same-run event appends', async () => {
    await withStore(async (store) => {
      await store.createRun(makeHeader());

      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.appendEvent('session-1', 'run-1', makeEvent({ id: `event-${index}`, ts: index })),
        ),
      );

      const events = await store.readEvents('session-1', 'run-1');
      assert.equal(events.length, 20);
      assert.equal(new Set(events.map((event) => event.id)).size, 20);
    });
  });

  it('writes a bounded projection for accepted history compact checkpoints', async () => {
    await withStore(async (store) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
      };
      await store.createRun(makeHeader({ runId: 'run-accepted' }));
      const checkpointEvent = (runId: string, eventCount: number): AgentRunEvent =>
        makeEvent({
          type: 'history_compact_checkpoint_recorded',
          id: `checkpoint-${runId}`,
          runId,
          turnId: `turn-${runId}`,
          data: {
            checkpoint: {
              kind: 'maka.history_compact_checkpoint',
              version: 2,
              checkpointId: `hcheckpoint-${runId}`,
              sessionId: 'session-1',
              coverage: { eventCount },
            },
          },
        });

      await store.appendEvent('session-1', 'run-accepted', checkpointEvent('run-accepted', 3));

      const projected = await projectionStore.readEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
      );
      assert.equal(
        projected?.data?.checkpoint &&
          (projected.data.checkpoint as { checkpointId?: string }).checkpointId,
        'hcheckpoint-run-accepted',
      );
    });
  });

  it('initializes an empty checkpoint projection for a new session', async () => {
    await withStore(async (store) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
      };

      await store.createRun(makeHeader());

      assert.equal(
        await projectionStore.readEventProjection(
          'session-1',
          'history_compact_checkpoint_recorded',
        ),
        null,
      );
    });
  });

  it('preserves a missing checkpoint projection when prior runs require recovery', async () => {
    await withStore(async (store, root) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
      };
      await store.createRun(makeHeader({ runId: 'run-before-crash' }));
      await rm(
        join(
          root,
          'sessions',
          'session-1',
          'projections',
          'history_compact_checkpoint_recorded.json',
        ),
      );

      await store.createRun(makeHeader({ runId: 'run-after-restart' }));

      assert.equal(
        await projectionStore.readEventProjection(
          'session-1',
          'history_compact_checkpoint_recorded',
        ),
        undefined,
      );
    });
  });

  it('does not let a stale repair overwrite a further checkpoint projection', async () => {
    await withStore(async (store, root) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
        repairEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
          event: AgentRunEvent | null,
        ): Promise<void>;
      };
      const checkpointEvent = (runId: string, eventCount: number): AgentRunEvent =>
        makeEvent({
          type: 'history_compact_checkpoint_recorded',
          id: `checkpoint-${runId}`,
          runId,
          turnId: `turn-${runId}`,
          data: {
            checkpoint: {
              kind: 'maka.history_compact_checkpoint',
              version: 2,
              checkpointId: `hcheckpoint-${runId}`,
              sessionId: 'session-1',
              coverage: { eventCount },
            },
          },
        });
      const stale = checkpointEvent('run-stale-repair', 1);
      const further = checkpointEvent('run-further-write', 2);
      await store.createRun(makeHeader({ runId: stale.runId }));
      await store.createRun(makeHeader({ runId: further.runId }));
      await store.appendEvent('session-1', stale.runId, stale);
      await rm(
        join(
          root,
          'sessions',
          'session-1',
          'projections',
          'history_compact_checkpoint_recorded.json',
        ),
      );

      await store.appendEvent('session-1', further.runId, further);
      await projectionStore.repairEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
        stale,
      );

      const projected = await projectionStore.readEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
      );
      assert.equal(projected?.id, further.id);
    });
  });

  it('does not let a legacy append or repair downgrade a source-bound checkpoint projection', async () => {
    await withStore(async (store) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
        repairEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
          event: AgentRunEvent | null,
        ): Promise<void>;
      };
      const sourceBound = makeEvent({
        type: 'history_compact_checkpoint_recorded',
        id: 'checkpoint-source-bound',
        data: {
          checkpoint: {
            coverage: { eventCount: 2 },
            source: { kind: 'runtime_event_projection' },
          },
        },
      });
      const legacy = makeEvent({
        type: 'history_compact_checkpoint_recorded',
        id: 'checkpoint-legacy',
        data: { checkpoint: { coverage: { eventCount: 99 } } },
      });
      await store.createRun(makeHeader());
      await store.appendEvent('session-1', sourceBound.runId, sourceBound);
      await store.appendEvent('session-1', legacy.runId, legacy);

      assert.equal(
        (
          await projectionStore.readEventProjection(
            'session-1',
            'history_compact_checkpoint_recorded',
          )
        )?.id,
        sourceBound.id,
      );

      await projectionStore.repairEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
        legacy,
      );

      const projected = await projectionStore.readEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
      );
      assert.equal(projected?.id, sourceBound.id);
    });
  });

  it('replaces the same parseable but semantically invalid projection during repair', async () => {
    await withStore(async (store, root) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
        repairEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
          event: AgentRunEvent | null,
          options?: { replaceEventId?: string },
        ): Promise<void>;
      };
      await store.createRun(makeHeader());
      const invalidProjection = makeEvent({
        type: 'history_compact_checkpoint_recorded',
        id: 'invalid-projection-event',
        data: { checkpoint: { coverage: { eventCount: 999 } } },
      });
      const canonicalEvent = makeEvent({
        type: 'history_compact_checkpoint_recorded',
        id: 'canonical-projection-event',
        data: {
          checkpoint: {
            kind: 'maka.history_compact_checkpoint',
            version: 2,
            checkpointId: 'hcheckpoint-canonical',
            sessionId: 'session-1',
            coverage: { eventCount: 1 },
          },
        },
      });
      await writeFile(
        join(
          root,
          'sessions',
          'session-1',
          'projections',
          'history_compact_checkpoint_recorded.json',
        ),
        JSON.stringify({ version: 1, event: invalidProjection }) + '\n',
      );

      await projectionStore.repairEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
        canonicalEvent,
        { replaceEventId: invalidProjection.id },
      );

      const projected = await projectionStore.readEventProjection(
        'session-1',
        'history_compact_checkpoint_recorded',
      );
      assert.equal(projected?.id, canonicalEvent.id);
    });
  });

  it('does not retain a checkpoint projection when the canonical ledger append fails', async () => {
    await withStore(async (store, root) => {
      const projectionStore = store as typeof store & {
        readEventProjection(
          sessionId: string,
          type: AgentRunEvent['type'],
        ): Promise<AgentRunEvent | null | undefined>;
      };
      await store.createRun(makeHeader());
      const checkpointEvent = (checkpointId: string, eventCount: number): AgentRunEvent =>
        makeEvent({
          type: 'history_compact_checkpoint_recorded',
          data: {
            checkpoint: {
              kind: 'maka.history_compact_checkpoint',
              version: 2,
              checkpointId,
              sessionId: 'session-1',
              coverage: { eventCount },
            },
          },
        });
      await store.appendEvent('session-1', 'run-1', checkpointEvent('hcheckpoint-previous', 1));
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      await rm(eventsPath);
      await mkdir(eventsPath);

      await assert.rejects(() =>
        store.appendEvent('session-1', 'run-1', checkpointEvent('hcheckpoint-orphan', 2)),
      );

      assert.equal(
        await projectionStore.readEventProjection(
          'session-1',
          'history_compact_checkpoint_recorded',
        ),
        undefined,
      );
    });
  });

  it('recovers corrupt event lines without hiding later events', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      await store.appendEvent('session-1', 'run-1', makeEvent({ id: 'good-1', ts: 1 }));
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      await writeFile(
        eventsPath,
        '{"type":"run_started"\n' + JSON.stringify(makeEvent({ id: 'good-2', ts: 2 })) + '\n',
        {
          flag: 'a',
        },
      );

      const events = await store.readEvents('session-1', 'run-1');
      assert.equal(events[0]?.id, 'good-1');
      assert.equal(events[1]?.type, 'event_corrupt');
      assert.equal(events[2]?.id, 'good-2');
    });
  });

  it('drops an unterminated corrupt tail event', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      await mkdir(join(root, 'sessions', 'session-1', 'runs', 'run-1'), { recursive: true });
      await writeFile(
        eventsPath,
        JSON.stringify(makeEvent({ id: 'good-1', ts: 1 })) + '\n{"type":"run_started"',
      );

      const events = await store.readEvents('session-1', 'run-1');
      assert.deepEqual(
        events.map((event) => event.id),
        ['good-1'],
      );
    });
  });

  it('does not mistake an invalid unterminated tail for a crash prefix', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      const bytes = JSON.stringify(makeEvent({ id: 'good-1', ts: 1 })) + '\n{"type":]';
      await writeFile(eventsPath, bytes, 'utf8');

      const events = await store.readEvents('session-1', 'run-1');
      assert.deepEqual(
        events.map((event) => event.type),
        ['run_started', 'event_corrupt'],
      );
      await assert.rejects(
        () => store.readEventsForRecovery('session-1', 'run-1'),
        /AgentRun run-1 has a corrupt JSONL record at line 2/,
      );
      assert.equal(await readFile(eventsPath, 'utf8'), bytes);
    });
  });

  it('keeps newline-terminated corrupt tail events as durable corruption notes', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      await mkdir(join(root, 'sessions', 'session-1', 'runs', 'run-1'), { recursive: true });
      await writeFile(
        eventsPath,
        JSON.stringify(makeEvent({ id: 'good-1', ts: 1 })) + '\n{"type":"run_started"\n',
      );

      const events = await store.readEvents('session-1', 'run-1');
      assert.deepEqual(
        events.map((event) => event.type),
        ['run_started', 'event_corrupt'],
      );
      assert.equal(events[1]?.data?.lineNumber, 2);
    });
  });

  it('rejects complete schema-invalid and identity-mismatched events during recovery', async () => {
    await withStore(async (store, root) => {
      await store.createRun(makeHeader());
      const eventsPath = join(root, 'sessions', 'session-1', 'runs', 'run-1', 'events.jsonl');
      for (const record of [
        {},
        makeEvent({ sessionId: 'other-session' }),
        makeEvent({ runId: 'other-run' }),
        makeEvent({ turnId: 'other-turn' }),
      ]) {
        await writeFile(eventsPath, JSON.stringify(record));
        await assert.rejects(
          () => store.readEventsForRecovery('session-1', 'run-1'),
          /AgentRun run-1 has a corrupt JSONL record at line 1/,
        );
      }
    });
  });

  it('appends and reads runtime events from a separate per-run ledger', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader({ invocationId: 'turn-1' }));
      await runStore.appendEvent('session-1', 'run-1', makeEvent({ id: 'operational-event' }));
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({ id: 'runtime-1', role: 'user' }),
      );
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({ id: 'runtime-2', role: 'model' }),
      );

      const runtimeEvents = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(
        runtimeEvents.map((event) => event.id),
        ['runtime-1', 'runtime-2'],
      );
      assert.deepEqual(
        runtimeEvents.map((event) => event.role),
        ['user', 'model'],
      );
      assert.deepEqual(
        (await runStore.readEvents('session-1', 'run-1')).map((event) => event.id),
        ['operational-event'],
      );

      const runtimeEventsPath = join(
        root,
        'sessions',
        'session-1',
        'runs',
        'run-1',
        'runtime-events.jsonl',
      );
      const operationalEventsPath = join(
        root,
        'sessions',
        'session-1',
        'runs',
        'run-1',
        'events.jsonl',
      );
      assert.match(await readFile(runtimeEventsPath, 'utf8'), /"id":"runtime-1"/);
      assert.match(await readFile(operationalEventsPath, 'utf8'), /"id":"operational-event"/);
    });
  });

  it('keeps authoritative tool facts out of the JSONL generic writer', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      const dispatch = makeRuntimeEvent({
        id: 'dispatch-reserved',
        role: 'system',
        author: 'system',
        content: undefined,
        actions: {
          toolDispatch: {
            protocol: 't1_after_preflight_v1',
            operationId: 'operation-1',
            providerToolCallId: 'call-1',
            toolName: 'Write',
            canonicalArgsHash: 'sha256:reserved',
            recoveryMode: 'reconcile',
          },
        },
        refs: { operationId: 'operation-1', toolCallId: 'call-1' },
      });
      const outcome = makeRuntimeEvent({
        id: 'outcome-reserved',
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'call-1',
          name: 'Write',
          result: 'ok',
        },
        refs: { operationId: 'operation-1', toolCallId: 'call-1' },
      });
      const recovery = makeRuntimeEvent({
        id: 'recovery-reserved',
        role: 'system',
        author: 'system',
        content: undefined,
        actions: {
          toolRecovery: {
            kind: 'maka.tool.reconcile_result',
            version: 1,
            payload: {
              protocol: 'tool_reconcile_v1',
              operationId: 'operation-1',
              observation: 'unreadable',
              observationSchema: 'state_identity_v1',
              observationDigest:
                'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            },
          },
        },
        refs: { operationId: 'operation-1', toolCallId: 'call-1' },
      });

      for (const event of [dispatch, outcome, recovery]) {
        await assert.rejects(
          runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', event),
          /atomic tool|atomic recovery/,
        );
      }
      assert.deepEqual(
        await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1'),
        [],
      );
    });
  });

  it('keeps an exact ordinary RuntimeEvent retry idempotent in JSONL', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      const event = makeRuntimeEvent({ id: 'ordinary-event-1' });

      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', event);
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', event);

      assert.deepEqual(
        (await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1')).map(
          (item) => item.id,
        ),
        ['ordinary-event-1'],
      );
    });
  });

  it('re-establishes stable storage on an exact durable RuntimeEvent retry', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      const event = makeRuntimeEvent({ id: 'ordinary-event-1' });
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', event);

      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', event, {
        durable: true,
      });

      assert.deepEqual(
        (await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1')).map(
          (item) => item.id,
        ),
        ['ordinary-event-1'],
      );
    });
  });

  it('keeps an exact tool call retry idempotent in JSONL', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      const call = makeRuntimeEvent({
        id: 'call-event-1',
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'provider-call-1',
          name: 'Write',
          args: { path: 'note.txt', content: 'hello' },
        },
        refs: { toolCallId: 'provider-call-1' },
      });

      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', call);
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', call);

      assert.deepEqual(
        (await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1')).map(
          (item) => item.id,
        ),
        ['call-event-1'],
      );
    });
  });

  it('rejects a conflicting RuntimeEvent retry without changing JSONL', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      const original = makeRuntimeEvent({ id: 'ordinary-event-1' });
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', original);

      await assert.rejects(
        runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', {
          ...original,
          ts: original.ts + 1,
        }),
        /RuntimeEvent identity conflict/,
      );
      assert.deepEqual(await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1'), [
        original,
      ]);
    });
  });

  it('rejects a RuntimeEvent whose identity does not match the target run header', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader({ invocationId: 'turn-1' }));

      for (const event of [
        makeRuntimeEvent({ sessionId: 'other-session' }),
        makeRuntimeEvent({ runId: 'other-run' }),
        makeRuntimeEvent({ turnId: 'other-turn' }),
        makeRuntimeEvent({ invocationId: 'other-invocation' }),
      ]) {
        await assert.rejects(
          runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', event),
          /RuntimeEvent identity does not match its run/,
        );
      }
      assert.deepEqual(
        await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1'),
        [],
      );
    });
  });

  it('rejects a duplicate provider call identity in the JSONL ledger', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      const call = makeRuntimeEvent({
        id: 'call-event-1',
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'provider-call-1',
          name: 'Write',
          args: { path: 'notes.txt', content: 'after' },
        },
      });
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', call);

      await assert.rejects(
        runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', {
          ...call,
          id: 'call-event-duplicate',
        }),
        /duplicate_call/,
      );
      assert.deepEqual(
        (await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1')).map(
          ({ id }) => id,
        ),
        ['call-event-1'],
      );
    });
  });

  it('returns an empty runtime event list when the runtime ledger is missing', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());

      assert.deepEqual(await runtimeEventStore.readRuntimeEvents('session-1', 'run-1'), []);
    });
  });

  it('coalesces text stream chunks into one recoverable partial snapshot', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      for (const [index, text] of ['hel', 'lo', '!'].entries()) {
        await runtimeEventStore.appendRuntimeEvent(
          'session-1',
          'run-1',
          makeRuntimeEvent({
            id: `runtime-partial-${index}`,
            ts: index + 1,
            partial: true,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text },
            refs: { providerEventId: 'message-1' },
          }),
        );
      }

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      const readImmutable = runtimeEventStore.readImmutableRuntimeEvents;
      assert.ok(readImmutable);
      const immutableEvents = await readImmutable.call(runtimeEventStore, 'session-1', 'run-1');

      assert.equal(events.length, 1);
      assert.equal(events[0]?.partial, true);
      assert.deepEqual(events[0]?.content, { kind: 'text', text: 'hello!' });
      assert.deepEqual(immutableEvents, []);
    });
  });

  it('does not merge partial streams across branch lineage', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-branch-a',
          ts: 1,
          branch: 'agent-a',
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'alpha' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-branch-b',
          ts: 2,
          branch: 'agent-b',
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'beta' },
          refs: { providerEventId: 'message-1' },
        }),
      );

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');

      assert.deepEqual(
        events.map((event) => ({
          branch: event.branch,
          text: event.content?.kind === 'text' ? event.content.text : undefined,
        })),
        [
          { branch: 'agent-a', text: 'alpha' },
          { branch: 'agent-b', text: 'beta' },
        ],
      );
    });
  });

  it('recovers the accumulated partial snapshot after reopening the store', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      for (const [index, text] of ['still ', 'working'].entries()) {
        await runtimeEventStore.appendRuntimeEvent(
          'session-1',
          'run-1',
          makeRuntimeEvent({
            id: `runtime-partial-${index}`,
            partial: true,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text },
            refs: { providerEventId: 'message-1' },
          }),
        );
      }

      const reopened = createRuntimeEventStore(root);
      const events = await reopened.readRuntimeEvents('session-1', 'run-1');

      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.content, { kind: 'text', text: 'still working' });
    });
  });

  it('keeps a 10K-chunk text stream bounded to one durable partial snapshot', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      for (let index = 0; index < 10_000; index += 1) {
        await runtimeEventStore.appendRuntimeEvent(
          'session-1',
          'run-1',
          makeRuntimeEvent({
            id: `runtime-partial-${index}`,
            partial: true,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text: 'x' },
            refs: { providerEventId: 'message-1' },
          }),
        );
      }

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      const partialFiles = await readdir(
        join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-partials'),
      );

      assert.equal(events.length, 1);
      assert.equal(events[0]?.content?.kind === 'text' && events[0].content.text.length, 10_000);
      assert.equal(partialFiles.filter((name) => name.endsWith('.partial')).length, 1);
      assert.equal(partialFiles.length, 1);
      const immutableLedger = await readFile(
        join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-events.jsonl'),
        'utf8',
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      });
      assert.equal(immutableLedger, '');
    });
  });

  it('coalesces thinking chunks into one recoverable partial snapshot', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      for (const [index, text] of ['reason', 'ing ', 'continues'].entries()) {
        await runtimeEventStore.appendRuntimeEvent(
          'session-1',
          'run-1',
          makeRuntimeEvent({
            id: `runtime-thinking-${index}`,
            partial: true,
            role: 'model',
            author: 'agent',
            content: { kind: 'thinking', text },
            refs: { providerEventId: 'message-1' },
          }),
        );
      }

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');

      assert.equal(events.length, 1);
      assert.deepEqual(events[0]?.content, { kind: 'thinking', text: 'reasoning continues' });
    });
  });

  it('coalesces tool stream heartbeats until the durable tool result arrives', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-tool-call',
          role: 'model',
          author: 'agent',
          content: {
            kind: 'function_call',
            id: 'tool-call-1',
            name: 'Bash',
            args: { command: 'echo done' },
          },
          refs: { toolCallId: 'tool-call-1' },
        }),
      );
      for (let index = 0; index < 100; index += 1) {
        await runtimeEventStore.appendRuntimeEvent(
          'session-1',
          'run-1',
          makeRuntimeEvent({
            id: `runtime-tool-progress-${index}`,
            partial: true,
            role: 'tool',
            author: 'tool',
            content: undefined,
            refs: { toolCallId: 'tool-call-1' },
          }),
        );
      }

      assert.equal((await runtimeEventStore.readRuntimeEvents('session-1', 'run-1')).length, 2);

      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-tool-result',
          ts: 2,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-call-1',
            name: 'Bash',
            result: 'done',
          },
          refs: { toolCallId: 'tool-call-1' },
        }),
      );

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(
        events.map((event) => event.id),
        ['runtime-tool-call', 'runtime-tool-result'],
      );
    });
  });

  it('keeps partial events with lifecycle actions as immutable facts', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      for (let index = 0; index < 2; index += 1) {
        await runtimeEventStore.appendRuntimeEvent(
          'session-1',
          'run-1',
          makeRuntimeEvent({
            id: `runtime-lifecycle-${index}`,
            partial: true,
            role: 'system',
            author: 'system',
            content: undefined,
            actions: { stateDelta: { progress: index } },
            refs: { toolCallId: 'tool-call-1' },
          }),
        );
      }

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      const readImmutable = runtimeEventStore.readImmutableRuntimeEvents;
      assert.ok(readImmutable);
      const immutableEvents = await readImmutable.call(runtimeEventStore, 'session-1', 'run-1');

      assert.deepEqual(
        events.map((event) => event.id),
        ['runtime-lifecycle-0', 'runtime-lifecycle-1'],
      );
      assert.deepEqual(
        immutableEvents.map((event) => event.id),
        ['runtime-lifecycle-0', 'runtime-lifecycle-1'],
      );
    });
  });

  it('replaces a text partial snapshot with the durable final event', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-partial',
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'hello' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-final',
          ts: 2,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'hello world' },
          refs: { providerEventId: 'message-1' },
        }),
      );

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');

      assert.deepEqual(
        events.map((event) => event.id),
        ['runtime-final'],
      );
      assert.deepEqual(events[0]?.content, { kind: 'text', text: 'hello world' });
    });
  });

  it('cleans a retained partial snapshot on an exact final-event retry', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      const partial = makeRuntimeEvent({
        id: 'runtime-partial',
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'hello' },
        refs: { providerEventId: 'message-1' },
      });
      const final = makeRuntimeEvent({
        id: 'runtime-final',
        ts: 2,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'hello world' },
        refs: { providerEventId: 'message-1' },
      });
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', partial);
      const partialsDirectory = join(
        root,
        'sessions',
        'session-1',
        'runs',
        'run-1',
        'runtime-partials',
      );
      const [partialFilename] = await readdir(partialsDirectory);
      assert.ok(partialFilename);
      const partialPath = join(partialsDirectory, partialFilename);
      const retainedSnapshot = await readFile(partialPath);
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', final);

      // Simulate a crash after the immutable append but before replaceable
      // partial cleanup, then drive recovery through the public exact retry.
      await writeFile(partialPath, retainedSnapshot);
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', final);

      assert.deepEqual(await readdir(partialsDirectory), []);
      assert.deepEqual(
        (await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1')).map(
          (event) => event.id,
        ),
        ['runtime-final'],
      );
    });
  });

  it('produces equivalent durable replay for differently chunked final output', async () => {
    const replayFor = async (chunks: readonly string[]) => {
      let replay: RuntimeEvent[] = [];
      await withStores(async (runStore, runtimeEventStore) => {
        await runStore.createRun(makeHeader());
        for (const [index, text] of chunks.entries()) {
          await runtimeEventStore.appendRuntimeEvent(
            'session-1',
            'run-1',
            makeRuntimeEvent({
              id: `runtime-partial-${index}`,
              ts: index + 1,
              partial: true,
              role: 'model',
              author: 'agent',
              content: { kind: 'text', text },
              refs: { providerEventId: 'message-1' },
            }),
          );
        }
        await runtimeEventStore.appendRuntimeEvent(
          'session-1',
          'run-1',
          makeRuntimeEvent({
            id: 'runtime-final',
            ts: 10,
            role: 'model',
            author: 'agent',
            content: { kind: 'text', text: 'same final output' },
            refs: { providerEventId: 'message-1' },
          }),
        );
        replay = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      });
      return replay;
    };

    const finelyChunked = await replayFor(['same ', 'final ', 'output']);
    const coarselyChunked = await replayFor(['same final output']);

    assert.deepEqual(finelyChunked, coarselyChunked);
    assert.deepEqual(
      finelyChunked.map((event) => event.id),
      ['runtime-final'],
    );
  });

  it('ignores a stale partial snapshot when its final event is already durable', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-final',
          ts: 2,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'complete' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-stale-partial',
          ts: 1,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'stale' },
          refs: { providerEventId: 'message-1' },
        }),
      );

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      const partialFiles = await readdir(
        join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-partials'),
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      });

      assert.deepEqual(
        events.map((event) => event.id),
        ['runtime-final'],
      );
      assert.deepEqual(partialFiles, []);
    });
  });

  it('restores a retained partial snapshot before a later terminal event', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader());
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-user',
          ts: 1,
        }),
      );
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-partial',
          ts: 2,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'retained output' },
          refs: { providerEventId: 'message-1' },
        }),
      );
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({
          id: 'runtime-terminal',
          ts: 1,
          role: 'system',
          author: 'system',
          status: 'failed',
          content: { kind: 'error', message: 'provider failed' },
        }),
      );

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');

      assert.deepEqual(
        events.map((event) => event.id),
        ['runtime-user', 'runtime-partial', 'runtime-terminal'],
      );
    });
  });

  it('rejects durable corrupt runtime event lines instead of shortening the canonical ledger', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      const runtimeEventsPath = join(
        root,
        'sessions',
        'session-1',
        'runs',
        'run-1',
        'runtime-events.jsonl',
      );
      await writeFile(
        runtimeEventsPath,
        JSON.stringify(makeRuntimeEvent({ id: 'runtime-1' })) +
          '\n{"id":"corrupt"\n' +
          JSON.stringify(makeRuntimeEvent({ id: 'runtime-2' })) +
          '\n',
      );

      await assert.rejects(
        () => runtimeEventStore.readRuntimeEvents('session-1', 'run-1'),
        /Invalid RuntimeEvent JSONL line 2 for run run-1/,
      );
    });
  });

  it('re-establishes a terminal durability barrier without duplicating the event', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader({ invocationId: 'turn-1' }));
      const terminal = makeRuntimeEvent({
        id: 'runtime-terminal',
        role: 'system',
        author: 'system',
        status: 'completed',
        content: undefined,
        actions: { endInvocation: true },
      });
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', terminal);

      await runtimeEventStore.ensureTerminalRuntimeEventDurable('session-1', 'run-1', terminal);
      await runtimeEventStore.ensureTerminalRuntimeEventDurable('session-1', 'run-1', terminal);

      const events = await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(
        events.map((event) => event.id),
        ['runtime-terminal'],
      );
      await assert.rejects(
        () =>
          runtimeEventStore.ensureTerminalRuntimeEventDurable('session-1', 'run-1', {
            ...terminal,
            ts: terminal.ts + 1,
          }),
        /does not match the durable ledger record/,
      );
      await assert.rejects(
        () =>
          runtimeEventStore.ensureTerminalRuntimeEventDurable('session-1', 'run-1', {
            ...terminal,
            id: 'runtime-terminal-2',
          }),
        /already has terminal RuntimeEvent runtime-terminal/,
      );
      assert.deepEqual(
        (await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1')).map(
          (event) => event.id,
        ),
        ['runtime-terminal'],
      );
    });
  });

  it('rejects a terminal event whose identity does not match the target run', async () => {
    for (const mismatch of [
      { sessionId: 'other-session' },
      { runId: 'other-run' },
      { turnId: 'other-turn' },
      { invocationId: 'other-invocation' },
    ] satisfies Array<Partial<RuntimeEvent>>) {
      await withStores(async (runStore, runtimeEventStore, root) => {
        await runStore.createRun(makeHeader({ invocationId: 'turn-1' }));
        const terminal = makeRuntimeEvent({
          id: 'runtime-terminal',
          role: 'system',
          author: 'system',
          status: 'completed',
          content: undefined,
          actions: { endInvocation: true },
          ...mismatch,
        });

        await assert.rejects(
          runtimeEventStore.ensureTerminalRuntimeEventDurable('session-1', 'run-1', terminal),
          /RuntimeEvent identity does not match its run/,
        );
        const ledger = await readFile(
          join(root, 'sessions', 'session-1', 'runs', 'run-1', 'runtime-events.jsonl'),
          'utf8',
        ).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
          throw error;
        });
        assert.equal(ledger, '');
      });
    }
  });

  it('rejects complete schema-invalid and path-mismatched runtime events', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader({ invocationId: 'turn-1' }));
      const runtimeEventsPath = join(
        root,
        'sessions',
        'session-1',
        'runs',
        'run-1',
        'runtime-events.jsonl',
      );
      for (const record of [
        {},
        makeRuntimeEvent({ sessionId: 'other-session' }),
        makeRuntimeEvent({ runId: 'other-run' }),
        makeRuntimeEvent({ turnId: 'other-turn' }),
        makeRuntimeEvent({ invocationId: 'other-invocation' }),
      ]) {
        await writeFile(runtimeEventsPath, JSON.stringify(record));
        await assert.rejects(
          () => runtimeEventStore.readRuntimeEvents('session-1', 'run-1'),
          /Invalid RuntimeEvent JSONL line 1 for run run-1/,
        );
      }
    });
  });

  it('ignores an unterminated partial runtime event tail', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      const runtimeEventsPath = join(
        root,
        'sessions',
        'session-1',
        'runs',
        'run-1',
        'runtime-events.jsonl',
      );
      await writeFile(
        runtimeEventsPath,
        JSON.stringify(makeRuntimeEvent({ id: 'runtime-1' })) + '\n{"id":"partial"',
      );

      const events = await runtimeEventStore.readRuntimeEvents('session-1', 'run-1');
      assert.deepEqual(
        events.map((event) => event.id),
        ['runtime-1'],
      );
    });
  });

  it('rejects an invalid unterminated runtime event tail without changing it', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      const runtimeEventsPath = join(
        root,
        'sessions',
        'session-1',
        'runs',
        'run-1',
        'runtime-events.jsonl',
      );
      const bytes = JSON.stringify(makeRuntimeEvent({ id: 'runtime-1' })) + '\n{"id":]';
      await writeFile(runtimeEventsPath, bytes, 'utf8');

      await assert.rejects(
        () => runtimeEventStore.readRuntimeEvents('session-1', 'run-1'),
        /Invalid RuntimeEvent JSONL line 2 for run run-1/,
      );
      assert.equal(await readFile(runtimeEventsPath, 'utf8'), bytes);
    });
  });

  it('reads session runtime events through RuntimeEventStore in stable chronology', async () => {
    await withStores(async (runStore, runtimeEventStore) => {
      await runStore.createRun(makeHeader({ runId: 'run-2', turnId: 'turn-2' }));
      await runStore.createRun(makeHeader({ runId: 'run-1', turnId: 'turn-1' }));
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-2',
        makeRuntimeEvent({ id: 'runtime-2', runId: 'run-2', turnId: 'turn-2', ts: 20 }),
      );
      await runtimeEventStore.appendRuntimeEvent(
        'session-1',
        'run-1',
        makeRuntimeEvent({ id: 'runtime-1', runId: 'run-1', turnId: 'turn-1', ts: 10 }),
      );

      const events = await runtimeEventStore.readSessionRuntimeEvents('session-1');

      assert.deepEqual(
        events.map((event) => event.id),
        ['runtime-1', 'runtime-2'],
      );
    });
  });

  it('preflights durable steering identity before append and repairs a missing proof', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      await runStore.createRun(makeHeader({ runId: 'run-2', turnId: 'turn-2' }));
      const steering = makeRuntimeEvent({
        id: 'runtime-steering',
        content: { kind: 'text', text: 'original steering', steering: true },
        refs: { providerEventId: 'message-steering' },
      });

      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', steering);
      await runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', steering);
      assert.deepEqual(await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1'), [
        steering,
      ]);

      await rm(
        join(root, 'sessions', 'session-1', 'message-proofs', 'steering', 'message-steering.json'),
      );
      const reopened = createRuntimeEventStore(root);
      await reopened.appendRuntimeEvent('session-1', 'run-1', steering);
      assert.deepEqual(
        await reopened.readImmutableSteeringMessageProof('session-1', 'message-steering'),
        { event: steering },
      );

      const conflicting = makeRuntimeEvent({
        ...steering,
        id: 'runtime-conflicting-steering',
        runId: 'run-2',
        turnId: 'turn-2',
        content: { kind: 'text', text: 'conflicting steering', steering: true },
      });
      await assert.rejects(
        () => reopened.appendRuntimeEvent('session-1', 'run-2', conflicting),
        /Immutable steering message identity conflict: message-steering/,
      );

      const recovered = createRuntimeEventStore(root);
      await recovered.repairImmutableSteeringMessageProofsForRecovery('session-1');
      assert.deepEqual(
        await recovered.readImmutableSteeringMessageProof('session-1', 'message-steering'),
        { event: steering },
      );
      assert.deepEqual(await recovered.readImmutableRuntimeEvents('session-1', 'run-1'), [
        steering,
      ]);
      assert.deepEqual(await recovered.readImmutableRuntimeEvents('session-1', 'run-2'), []);
    });
  });

  it('reports a durable canonical steering event when proof publication fails', {
    skip: process.platform === 'win32',
  }, async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      const steering = makeRuntimeEvent({
        id: 'runtime-steering',
        content: { kind: 'text', text: 'persisted before proof', steering: true },
        refs: { providerEventId: 'message-steering' },
      });
      const proofDirectory = join(root, 'sessions', 'session-1', 'message-proofs', 'steering');
      await mkdir(proofDirectory, { recursive: true });
      await chmod(proofDirectory, 0o500);

      await assert.rejects(
        () => runtimeEventStore.appendRuntimeEvent('session-1', 'run-1', steering),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error.name, 'RuntimeEventPostEffectError');
          assert.match(error.message, /RuntimeEvent runtime-steering is durable/);
          assert.ok(!(error instanceof DurableStoreWriteError));
          assert.ok(error.cause instanceof DurableStoreWriteError);
          return true;
        },
      );
      assert.deepEqual(await runtimeEventStore.readImmutableRuntimeEvents('session-1', 'run-1'), [
        steering,
      ]);

      await chmod(proofDirectory, 0o700);
      await rm(proofDirectory, { recursive: true });
      const recovered = createRuntimeEventStore(root);
      await recovered.repairImmutableSteeringMessageProofsForRecovery('session-1');

      assert.deepEqual(
        await recovered.readImmutableSteeringMessageProof('session-1', 'message-steering'),
        { event: steering },
      );
      assert.deepEqual(await recovered.readImmutableRuntimeEvents('session-1', 'run-1'), [
        steering,
      ]);
    });
  });

  it('linearizes competing steering identities across runs in one session', async () => {
    await withStores(async (runStore, runtimeEventStore, root) => {
      await runStore.createRun(makeHeader());
      await runStore.createRun(makeHeader({ runId: 'run-2', turnId: 'turn-2' }));
      const candidates = [
        makeRuntimeEvent({
          id: 'runtime-steering-1',
          content: { kind: 'text', text: 'first candidate', steering: true },
          refs: { providerEventId: 'message-shared' },
        }),
        makeRuntimeEvent({
          id: 'runtime-steering-2',
          runId: 'run-2',
          turnId: 'turn-2',
          content: { kind: 'text', text: 'second candidate', steering: true },
          refs: { providerEventId: 'message-shared' },
        }),
      ] as const;

      const results = await Promise.allSettled(
        candidates.map((event) =>
          runtimeEventStore.appendRuntimeEvent('session-1', event.runId, event),
        ),
      );
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);

      const reopened = createRuntimeEventStore(root);
      await reopened.repairImmutableSteeringMessageProofsForRecovery('session-1');
      const ledger = (
        await Promise.all(
          ['run-1', 'run-2'].map((runId) =>
            reopened.readImmutableRuntimeEvents('session-1', runId),
          ),
        )
      ).flat();
      const proof = await reopened.readImmutableSteeringMessageProof('session-1', 'message-shared');
      assert.equal(ledger.length, 1);
      assert.deepEqual(proof, { event: ledger[0] });
      assert.ok(candidates.some((candidate) => isDeepStrictEqual(candidate, ledger[0])));
    });
  });
});

async function withStore(
  fn: (store: ReturnType<typeof createAgentRunStore>, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-store-'));
  try {
    await fn(createAgentRunStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withStores(
  fn: (
    runStore: ReturnType<typeof createAgentRunStore>,
    runtimeEventStore: ReturnType<typeof createRuntimeEventStore>,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-run-store-'));
  try {
    await fn(createAgentRunStore(root), createRuntimeEventStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeHeader(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<AgentRunEvent> = {}): AgentRunEvent {
  return {
    type: 'run_started',
    id: 'event-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    ...overrides,
  };
}

function makeRuntimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'runtime-1',
    invocationId: 'turn-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text: 'hello' },
    ...overrides,
  };
}
