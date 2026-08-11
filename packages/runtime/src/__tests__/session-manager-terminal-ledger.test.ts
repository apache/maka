import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as timerDelay } from 'node:timers/promises';
import { deriveTurnRecords } from '@maka/core/session';
import { DurableStoreWriteError, RunSealedError } from '@maka/core/runtime-event-store';
import { isTerminalRuntimeEvent } from '@maka/core/runtime-event';
import {
  ToolLedgerCorruptionError,
  ToolLedgerRejectionError,
} from '@maka/core/tool-ledger-scanner';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { AgentRunEvent, AgentRunHeader, AgentRunStore } from '@maka/core/agent-run';
import type { CreateSessionInput, SessionListFilter } from '@maka/core/runtime-inputs';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { RuntimeEventStore } from '@maka/core/runtime-event-store';
import type { SessionHeader, SessionSummary, StoredMessage, TurnRecord } from '@maka/core/session';
import type { BackendSendInput } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import { expect } from '../test-helpers.js';
import { AgentRun } from '../agent-run.js';
import {
  BackendRegistry,
  SessionManager,
  type BackendFactoryContext,
  type SessionStore,
} from '../session-manager.js';
import type { AgentBackend } from '@maka/core/backend-types';
import {
  buildRecoveredTerminalRuntimeEvent,
  buildSyntheticTerminalRuntimeEvent,
  classifyTerminalRuntimeLedger,
  commitOrCreateTerminalRunFact,
  commitTerminalRunWithRuntimeFact,
} from '../terminal-run-commit.js';
import { RuntimeReadModel } from '../runtime-read-model.js';
import { RuntimeKernel } from '../runtime-kernel.js';
import type { RuntimeInteractionAuthority } from '../interaction-authority.js';

describe('SessionManager terminal ledger invariants', () => {
  test('coalesces one partial stream and flushes it before the final model event', async () => {
    const store = new TinySessionStore();
    const session = await store.create(makeInput());
    const runtimeEventStore = new BatchingRuntimeEventStore();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runtimeEventStore,
      newId: nextId(),
      now: nextNow(10_000),
      hooks: inertAgentRunHooks(store),
    });
    const acceptDelta = async (id: string, ts: number, text: string): Promise<void> => {
      await run.acceptMappedEvent(
        { type: 'text_delta', id, turnId: 'turn-1', ts, messageId: 'message-1', text },
        runtimeEvent({
          id: `runtime-${id}`,
          sessionId: session.id,
          invocationId: run.invocationId,
          runId: run.runId,
          turnId: run.turnId,
          ts,
          partial: true,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text },
          refs: { providerEventId: 'message-1' },
        }),
      );
    };

    await acceptDelta('delta-1', 1, 'a');
    await acceptDelta('delta-2', 2, 'b');
    await acceptDelta('delta-3', 3, 'c');
    expect(runtimeEventStore.order).toEqual(['append:runtime-delta-1']);

    await run.acceptMappedEvent(
      {
        type: 'text_complete',
        id: 'complete-1',
        turnId: 'turn-1',
        ts: 4,
        messageId: 'message-1',
        text: 'abc',
      },
      runtimeEvent({
        id: 'runtime-complete-1',
        sessionId: session.id,
        invocationId: run.invocationId,
        runId: run.runId,
        turnId: run.turnId,
        ts: 4,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'abc' },
        refs: { providerEventId: 'message-1' },
      }),
    );

    expect(runtimeEventStore.order).toEqual([
      'append:runtime-delta-1',
      'batch:runtime-delta-2,runtime-delta-3',
      'append:runtime-complete-1',
    ]);
  });

  test('fails a model boundary closed when its pending partial batch cannot be stored', async () => {
    const store = new TinySessionStore();
    const session = await store.create(makeInput());
    const runtimeEventStore = new BatchingRuntimeEventStore(true);
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runtimeEventStore,
      newId: nextId(),
      now: nextNow(10_100),
      hooks: inertAgentRunHooks(store),
    });
    const partial = (id: string, ts: number, text: string): RuntimeEvent =>
      runtimeEvent({
        id,
        sessionId: session.id,
        invocationId: run.invocationId,
        runId: run.runId,
        turnId: run.turnId,
        ts,
        partial: true,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text },
        refs: { providerEventId: 'message-1' },
      });
    await run.acceptMappedEvent(
      {
        type: 'text_delta',
        id: 'delta-1',
        turnId: 'turn-1',
        ts: 1,
        messageId: 'message-1',
        text: 'a',
      },
      partial('runtime-delta-1', 1, 'a'),
    );
    await run.acceptMappedEvent(
      {
        type: 'text_delta',
        id: 'delta-2',
        turnId: 'turn-1',
        ts: 2,
        messageId: 'message-1',
        text: 'b',
      },
      partial('runtime-delta-2', 2, 'b'),
    );

    await assert.rejects(
      run.acceptMappedEvent(
        {
          type: 'text_complete',
          id: 'complete-1',
          turnId: 'turn-1',
          ts: 3,
          messageId: 'message-1',
          text: 'ab',
        },
        runtimeEvent({
          id: 'runtime-complete-1',
          sessionId: session.id,
          invocationId: run.invocationId,
          runId: run.runId,
          turnId: run.turnId,
          ts: 3,
          role: 'model',
          author: 'agent',
          content: { kind: 'text', text: 'ab' },
        }),
      ),
      /partial batch failed/,
    );
    expect(runtimeEventStore.order).toEqual(['append:runtime-delta-1', 'batch:runtime-delta-2']);
  });

  test('error streams persist a failed terminal fact without non-terminal error ledger rows', async () => {
    const { manager, runStore, session } = await makeHarness([
      { type: 'error', recoverable: false, reason: 'tool_failed', message: 'Tool failed' },
      { type: 'complete', stopReason: 'end_turn' },
    ]);

    await drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('run was not recorded');
    expect(run.status).toBe('failed');
    expect(run.failureClass).toBe('tool_failed');
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run.runId);
    expect(
      runtimeEvents.some(
        (event) => event.content?.kind === 'error' && !isTerminalRuntimeEvent(event),
      ),
    ).toBe(false);
    const terminalEvents = runtimeEvents.filter(isTerminalRuntimeEvent);
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('tool_failed');

    const messages = await manager.getMessages(session.id);
    const turnState = messages.find(
      (message) => message.type === 'turn_state' && message.turnId === 'turn-1',
    );
    if (turnState?.type !== 'turn_state') throw new Error('failed turn_state was not projected');
    expect(turnState.status).toBe('failed');
    expect(turnState.errorClass).toBe('tool_failed');
  });

  test('stopSession keeps renderer abortSource on terminal facts and run headers', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const backends = new BackendRegistry();
    let backend: StopDuringSendBackend | undefined;
    backends.register('fake', (ctx) => {
      backend = new StopDuringSendBackend(ctx);
      return backend;
    });
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(20_000),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe('text_delta');
    const pendingAbort = iterator.next();
    const stopPromise = manager.stopSession(session.id, { source: 'stop_button' });
    const abort = await pendingAbort;
    expect(abort.value?.type).toBe('abort');
    backend?.allowStopReturn();
    await stopPromise;
    while (!(await iterator.next()).done) {}

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('run was not recorded');
    expect(run.status).toBe('cancelled');
    expect(run.abortSource).toBe('renderer.stop_button');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('aborted');
    expect(terminalEvents[0]?.actions?.stateDelta?.abortSource).toBe('renderer.stop_button');
  });

  test('stopSession commits a terminal fact when the backend stream never ends', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new NeverEndingBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(21_000),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('text_delta');
    await manager.stopSession(session.id, { source: 'stop_button' });

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('run was not recorded');
    expect(run.status).toBe('cancelled');
    expect(run.abortSource).toBe('renderer.stop_button');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('aborted');
    expect(terminalEvents[0]?.actions?.stateDelta?.abortSource).toBe('renderer.stop_button');
  });

  test('a stop whose terminal settlement fails stays retryable', async () => {
    let failNextTerminalAppend = true;
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore({
      beforeTerminalRuntimeEventAppend: async () => {
        if (!failNextTerminalAppend) return;
        failNextTerminalAppend = false;
        throw new Error('terminal runtime event append failed');
      },
    });
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new NeverEndingBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(21_500),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('text_delta');

    await assert.rejects(() => manager.stopSession(session.id, { source: 'stop_button' }));
    await manager.stopSession(session.id, { source: 'stop_button' });

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('run was not recorded');
    expect(run.status).toBe('cancelled');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
  });

  test('a hosted stop leaves the terminal fact to the Host', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const backends = new BackendRegistry();
    backends.register('fake', (ctx) => new NeverEndingBackend(ctx));
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(21_700),
      runtimeSource: 'test',
      interactionAuthority: hostedInteractionAuthority(),
      canonicalPermissionOutcomes: { readPermissionOutcome: async () => undefined },
    });
    const session = await manager.createSession(makeInput());

    const iterator = manager
      .sendMessage(session.id, { turnId: 'turn-1', text: 'hello' })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe('text_delta');
    await manager.stopSession(session.id, { source: 'stop_button' });

    const [run] = await runStore.listSessionRuns(session.id);
    if (!run) throw new Error('run was not recorded');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(0);
  });

  test('terminal acceptance wins over a later stop during terminal persistence', async () => {
    const terminalAppendStarted = deferred<void>();
    const releaseTerminalAppend = deferred<void>();
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore({
      beforeTerminalRuntimeEventAppend: async () => {
        terminalAppendStarted.resolve();
        await releaseTerminalAppend.promise;
      },
    });
    const backends = new BackendRegistry();
    backends.register(
      'fake',
      (ctx) => new ScriptBackend(ctx, [{ type: 'complete', stopReason: 'step_limit' }]),
    );
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends,
      newId: nextId(),
      now: nextNow(21_000),
      runtimeSource: 'test',
    });
    const session = await manager.createSession(makeInput());

    const sendPromise = drain(manager.sendMessage(session.id, { turnId: 'turn-1', text: 'hello' }));
    await terminalAppendStarted.promise;
    await manager.stopSession(session.id, { source: 'stop_button' });
    releaseTerminalAppend.resolve();
    await sendPromise;

    expect((await store.readHeader(session.id)).status).toBe('active');
    const [run] = await runStore.listSessionRuns(session.id);
    expect(run?.status).toBe('failed');
    expect(run?.failureClass).toBe('tool_step_cap_reached');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run!.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
  });

  test('concurrent terminal writes reserve exactly one terminal fact', async () => {
    const terminalAppendStarted = deferred<void>();
    const releaseTerminalAppend = deferred<void>();
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore({
      beforeTerminalRuntimeEventAppend: async () => {
        terminalAppendStarted.resolve();
        await releaseTerminalAppend.promise;
      },
    });
    const session = await store.create(makeInput());
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(22_000),
      hooks: inertAgentRunHooks(store),
    });
    await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
      }),
    );
    const first = run.recordRuntimeEvents([
      runtimeEvent({
        id: 'terminal-one',
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'completed',
        actions: { endInvocation: true },
      }),
    ]);
    await terminalAppendStarted.promise;
    const second = run.recordRuntimeEvents([
      runtimeEvent({
        id: 'terminal-two',
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'failed',
        actions: { endInvocation: true },
      }),
    ]);
    releaseTerminalAppend.resolve();
    await Promise.all([first, second]);

    const terminals = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminals.map((event) => event.id)).toEqual(['terminal-one']);
  });

  test('a ledger rejection does not cost the run its terminal write', async () => {
    // The store latch exists for a store that went away. A rejection means the
    // opposite — the ledger is healthy and refused one malformed event — so
    // latching only guaranteed that this run could never write its own terminal
    // fact: `commitTerminalRun` returns early on an unavailable store, which is
    // how a refused tool result left a run reading `running` forever (#2234).
    const store = new TinySessionStore();
    // `canonical` is the only durability production ships (SqliteRuntimeStore
    // declares it), and it is what makes a rejected append rethrow. A
    // best-effort double would swallow the rejection instead and prove a
    // weaker thing than production actually does.
    const runStore = new TinyAgentRunStore({
      rejectRuntimeEventIds: ['refused-event'],
      durability: 'canonical',
    });
    const session = await store.create(makeInput());
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(23_000),
      hooks: inertAgentRunHooks(store),
    });
    await runStore.createRun(
      makeRunHeader({ sessionId: session.id, runId: run.runId, turnId: run.turnId }),
    );

    // The rejection still fails the caller — a producer bug must not pass
    // quietly — and it is recorded on the run.
    await assert.rejects(
      run.recordRuntimeEvents([
        runtimeEvent({
          id: 'refused-event',
          sessionId: session.id,
          runId: run.runId,
          turnId: run.turnId,
        }),
      ]),
      (error: unknown) => error instanceof ToolLedgerRejectionError,
    );
    expect((await runStore.readRun(session.id, run.runId)).traceWriteError).toMatch(
      /Tool ledger transition rejected: orphan_response/,
    );

    // The ledger is still open, so the turn can still end.
    await run.recordRuntimeEvents([
      runtimeEvent({
        id: 'terminal-after-rejection',
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'failed',
        actions: { endInvocation: true },
      }),
    ]);

    const terminals = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminals.map((event) => event.id)).toEqual(['terminal-after-rejection']);
    expect(
      (await runStore.readRuntimeEvents(session.id, run.runId)).some(
        (event) => event.id === 'refused-event',
      ),
    ).toBe(false);
  });

  test('a corrupt ledger keeps stream writes closed but still lets the run say it ended', async () => {
    // The exemption is for a bad candidate against a healthy store; a ledger
    // that is already damaged keeps failing closed for stream writes. What
    // the latch must not cost is the terminal fact (#2313): production gates
    // the health scan behind `isToolLedgerBearingEvent`, so the damaged
    // ledger would accept the terminal event, and before the finalize-time
    // probe the latch alone kept it out and parked the run at `running`
    // forever. Assert all three parts: the tool fact is refused, stream
    // writes stay closed under the latch, and finalization still lands the
    // terminal fact.
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore({ corruptLedger: true, durability: 'canonical' });
    const session = await store.create(makeInput());
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(24_000),
      hooks: inertAgentRunHooks(store),
    });
    await runStore.createRun(
      makeRunHeader({ sessionId: session.id, runId: run.runId, turnId: run.turnId }),
    );

    // A tool fact is what a damaged ledger refuses.
    await assert.rejects(
      run.recordRuntimeEvents([
        runtimeEvent({
          id: 'well-formed-tool-fact',
          sessionId: session.id,
          runId: run.runId,
          turnId: run.turnId,
          content: { kind: 'function_call', id: 'call-1', name: 'noop', args: {} },
        }),
      ]),
      (error: unknown) => error instanceof ToolLedgerCorruptionError,
    );
    expect((await runStore.readRun(session.id, run.runId)).traceWriteError).toMatch(
      /Tool ledger is corrupt: duplicate_call/,
    );

    // Stream writes stay fail-closed: under a canonical store the latched
    // failure replays without reaching the append, so the mid-run path
    // cannot smuggle facts past a damaged ledger.
    await assert.rejects(
      run.recordRuntimeEvents([
        runtimeEvent({
          id: 'stream-write-after-corruption',
          sessionId: session.id,
          runId: run.runId,
          turnId: run.turnId,
          content: { kind: 'text', text: 'late stream text' },
        }),
      ]),
      (error: unknown) => error instanceof ToolLedgerCorruptionError,
    );

    // The terminal fact is the exception: commitTerminalRun probes the
    // latched store with a read, the store answers (only its tool lanes are
    // refused), and the run ends instead of parking at `running`.
    await run.finalize();

    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect((await runStore.readRun(session.id, run.runId)).status).toBe('failed');
  });

  test('finalization keeps the silent skip when even the terminal barrier is refused', async () => {
    // The terminal durability barrier is the corruption path's own scoped
    // probe; when the store refuses even that write, the finalize path
    // keeps its historical behaviour: skip quietly, change nothing.
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore({
      corruptLedger: true,
      failTerminalRuntimeEventAppends: true,
      durability: 'canonical',
    });
    const session = await store.create(makeInput());
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(24_100),
      hooks: inertAgentRunHooks(store),
    });
    await runStore.createRun(
      makeRunHeader({ sessionId: session.id, runId: run.runId, turnId: run.turnId }),
    );
    await run
      .recordRuntimeEvents([
        runtimeEvent({
          id: 'latching-tool-fact',
          sessionId: session.id,
          runId: run.runId,
          turnId: run.turnId,
          content: { kind: 'function_call', id: 'call-1', name: 'noop', args: {} },
        }),
      ])
      .catch(() => {});

    await run.finalize();

    expect(
      (await runStore.readRuntimeEvents(session.id, run.runId)).some(isTerminalRuntimeEvent),
    ).toBe(false);
    expect((await runStore.readRun(session.id, run.runId)).status).toBe('running');
  });

  test('a sealed-run refusal neither latches the store nor stamps a trace failure', async () => {
    // Pressing stop seals the run ahead of the still-draining stream, so the
    // straggler window is open by construction and refusing what lands in it
    // is the store doing its job (#2311). The refusal must stay a refusal:
    // no store latch, no trace-write failure on a run whose history is
    // exactly as durable as it should be.
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore({ durability: 'canonical' });
    const session = await store.create(makeInput());
    const newId = nextId();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId,
      now: nextNow(24_200),
      hooks: inertAgentRunHooks(store),
    });
    await runStore.createRun(
      makeRunHeader({ sessionId: session.id, runId: run.runId, turnId: run.turnId }),
    );
    run.stop('stop_button');
    await run.settleStopTerminal();
    expect(
      (await runStore.readRuntimeEvents(session.id, run.runId)).filter(isTerminalRuntimeEvent),
    ).toHaveLength(1);

    runStore.sealedRuns.add(run.runId);
    await assert.rejects(
      run.recordRuntimeEvents([
        runtimeEvent({
          id: 'straggler-after-seal',
          sessionId: session.id,
          runId: run.runId,
          turnId: run.turnId,
          content: { kind: 'text', text: 'late stream text' },
        }),
      ]),
      (error: unknown) => error instanceof RunSealedError,
    );

    expect((await runStore.readRun(session.id, run.runId)).traceWriteError).toBeUndefined();
    // The seal is per run and permanent, the way SqliteRuntimeStore keeps
    // refusing; the store stays healthy for everything else, so a second
    // run on the same store still writes.
    const second = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-2', text: 'again' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId,
      now: nextNow(24_300),
      hooks: inertAgentRunHooks(store),
    });
    await runStore.createRun(
      makeRunHeader({ sessionId: session.id, runId: second.runId, turnId: second.turnId }),
    );
    await second.recordRuntimeEvents([
      runtimeEvent({
        id: 'post-seal-probe',
        sessionId: session.id,
        runId: second.runId,
        turnId: second.turnId,
        content: { kind: 'text', text: 'still landing' },
      }),
    ]);
    expect(
      (await runStore.readRuntimeEvents(session.id, second.runId)).some(
        (event) => event.id === 'post-seal-probe',
      ),
    ).toBe(true);
  });

  test('the continuation boundary hook fires between the terminal barrier and the header', async () => {
    // The #2313 recovery path defers 'after_terminal_event_committed' into
    // this hook because the claimed event's own write never ran; a crash at
    // the boundary must always find the terminal fact durable first.
    const order: string[] = [];
    class OrderRecordingStore extends TinyAgentRunStore {
      override async updateRun(
        sessionId: string,
        runId: string,
        patch: Partial<AgentRunHeader>,
      ): Promise<AgentRunHeader> {
        order.push('header');
        return super.updateRun(sessionId, runId, patch);
      }
    }
    const runStore = new OrderRecordingStore({
      beforeTerminalRuntimeEventAppend: async () => {
        order.push('barrier');
      },
    });
    await runStore.createRun(
      makeRunHeader({ sessionId: 'session-1', runId: 'run-1', turnId: 'turn-1' }),
    );

    await commitOrCreateTerminalRunFact({
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      ts: 24_400,
      fallbackStatus: 'cancelled',
      fallbackInvocationId: 'run-1',
      allowHeaderCommitFailure: false,
      afterTerminalDurable: async () => {
        order.push('boundary');
      },
    });

    expect(order.slice(0, 3)).toEqual(['barrier', 'boundary', 'header']);
  });

  test('synthetic finalization claims its terminal outcome before its first await', async () => {
    const headerUpdateStarted = deferred<void>();
    const releaseHeaderUpdate = deferred<void>();
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const hooks = inertAgentRunHooks(store);
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(23_000),
      hooks: {
        ...hooks,
        updateHeader: async (sessionId, patch) => {
          headerUpdateStarted.resolve();
          await releaseHeaderUpdate.promise;
          return store.updateHeader(sessionId, patch);
        },
      },
    });
    await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
      }),
    );

    const finalization = run.finalize();
    await headerUpdateStarted.promise;
    expect(run.stop('stop_button')).toBe(false);
    releaseHeaderUpdate.resolve();
    await finalization;

    const header = await runStore.readRun(session.id, run.runId);
    expect(header.status).toBe('failed');
    expect(header.failureClass).toBe('missing_terminal_event');
    const terminals = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.status).toBe('failed');
  });

  test('terminal run commits reject mismatched terminal RuntimeEvent statuses', async () => {
    const runStore = new TinyAgentRunStore();
    const run = makeRunHeader({ status: 'running' });
    const completedTerminal = runtimeEvent({
      id: 'rt-completed',
      status: 'completed',
      actions: { endInvocation: true },
    });
    await runStore.createRun(run);
    await runStore.appendRuntimeEvent(run.sessionId, run.runId, completedTerminal);

    await assert.rejects(
      commitTerminalRunWithRuntimeFact({
        runStore,
        runtimeEventStore: runStore,
        newId: nextId(),
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        status: 'failed',
        ts: 3,
        terminalEvent: completedTerminal,
        failureClass: 'tool_failed',
      }),
      /terminal RuntimeEvent status completed cannot commit failed run header/,
    );
    expect((await runStore.readRun(run.sessionId, run.runId)).status).toBe('running');
  });

  test('terminal run commits reject terminal RuntimeEvents from another run', async () => {
    const runStore = new TinyAgentRunStore();
    const run = makeRunHeader({ status: 'running' });
    const foreignTerminal = runtimeEvent({
      id: 'rt-foreign-completed',
      runId: 'another-run',
      status: 'completed',
      actions: { endInvocation: true },
    });
    await runStore.createRun(run);

    await assert.rejects(
      commitTerminalRunWithRuntimeFact({
        runStore,
        runtimeEventStore: runStore,
        newId: nextId(),
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        status: 'completed',
        ts: 3,
        terminalEvent: foreignTerminal,
      }),
      /terminal RuntimeEvent identity does not match run header commit/,
    );
    expect((await runStore.readRun(run.sessionId, run.runId)).status).toBe('running');
  });

  test('terminal run commits reject partial terminal RuntimeEvents', async () => {
    const runStore = new TinyAgentRunStore();
    const run = makeRunHeader({ status: 'running' });
    const partialTerminal = runtimeEvent({
      id: 'rt-partial-completed',
      status: 'completed',
      partial: true,
      actions: { endInvocation: true },
    });
    await runStore.createRun(run);

    await assert.rejects(
      commitTerminalRunWithRuntimeFact({
        runStore,
        runtimeEventStore: runStore,
        newId: nextId(),
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        status: 'completed',
        ts: 3,
        terminalEvent: partialTerminal,
      }),
      /terminal RuntimeEvent must be final before terminal run header/,
    );
    expect((await runStore.readRun(run.sessionId, run.runId)).status).toBe('running');
  });

  test('synthetic cancelled terminal commits the fallback abortSource to the run header', async () => {
    const runStore = new TinyAgentRunStore();
    const run = makeRunHeader({ status: 'running' });
    await runStore.createRun(run);

    await commitOrCreateTerminalRunFact({
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      sessionId: run.sessionId,
      runId: run.runId,
      turnId: run.turnId,
      ts: 3,
      fallbackStatus: 'cancelled',
      fallbackInvocationId: run.runId,
    });

    const header = await runStore.readRun(run.sessionId, run.runId);
    expect(header.status).toBe('cancelled');
    expect(header.abortSource).toBe('user_stop');
    const terminalEvents = (await runStore.readRuntimeEvents(run.sessionId, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('aborted');
    expect(terminalEvents[0]?.actions?.stateDelta?.abortSource).toBe('user_stop');
    expect(terminalEvents[0]?.actions?.stateDelta?.recovered).toBeUndefined();
  });

  test('synthetic terminal durability failures are not tolerated as header failures', async () => {
    const runStore = new TinyAgentRunStore({
      failTerminalRuntimeEventDurabilityAfterAppend: true,
    });
    const run = makeRunHeader({ status: 'running' });
    await runStore.createRun(run);

    await assert.rejects(
      commitOrCreateTerminalRunFact({
        runStore,
        runtimeEventStore: runStore,
        newId: nextId(),
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        ts: 3,
        fallbackStatus: 'failed',
        fallbackInvocationId: run.runId,
        fallbackFailureClass: 'missing_terminal_event',
        allowHeaderCommitFailure: true,
      }),
      DurableStoreWriteError,
    );

    expect((await runStore.readRun(run.sessionId, run.runId)).status).toBe('running');
    expect(await runStore.readRuntimeEvents(run.sessionId, run.runId)).toHaveLength(1);
    expect(await runStore.readEvents(run.sessionId, run.runId)).toHaveLength(0);
  });

  test('synthetic terminal builder keeps live and recovered metadata distinct', () => {
    const run = makeRunHeader({ status: 'running' });
    const live = buildSyntheticTerminalRuntimeEvent({
      id: 'live-terminal',
      invocationId: run.runId,
      run,
      status: 'failed',
      ts: 3,
      failureClass: 'missing_terminal_event',
    });
    expect(live.invocationId).toBe(run.runId);
    expect(live.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    expect(live.actions?.stateDelta?.recovered).toBeUndefined();
    expect(live.actions?.stateDelta?.recoveryReason).toBeUndefined();

    const recovered = buildRecoveredTerminalRuntimeEvent({
      id: 'recovered-terminal',
      run,
      status: 'failed',
      ts: 4,
      failureClass: 'missing_terminal_event',
      recoveryReason: 'run_interrupted',
    });
    expect(recovered.invocationId).toBe(`recovery-${run.runId}`);
    expect(recovered.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    expect(recovered.actions?.stateDelta?.recovered).toBe(true);
    expect(recovered.actions?.stateDelta?.recoveryReason).toBe('run_interrupted');
  });

  test('terminal ledger classification rejects multiple terminal RuntimeEvent signals', () => {
    const run = makeRunHeader({ status: 'running' });

    const result = classifyTerminalRuntimeLedger(run, [
      runtimeEvent({
        id: 'rt-completed',
        status: 'completed',
        actions: { endInvocation: true },
      }),
      runtimeEvent({
        id: 'rt-failed',
        status: 'failed',
        content: {
          kind: 'error',
          code: 'tool_failed',
          reason: 'tool_failed',
          message: 'Tool failed',
        },
        actions: {
          endInvocation: true,
          stateDelta: { failureClass: 'tool_failed' },
        },
      }),
    ]);

    expect(result.kind).toBe('ambiguous');
    expect(result.terminalEvents.map((event) => event.id)).toEqual(['rt-completed', 'rt-failed']);
  });

  test('runtime constructors reject AgentRunStore without a RuntimeEventStore', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const backends = new BackendRegistry();

    assert.throws(
      () =>
        new SessionManager({
          store,
          runStore,
          backends,
          newId: nextId(),
          now: nextNow(25_000),
        }),
      /RuntimeEventStore/,
    );
    assert.throws(
      () =>
        new RuntimeKernel({
          store,
          runStore,
          backends,
          newId: nextId(),
          now: nextNow(25_100),
        }),
      /RuntimeEventStore/,
    );
    assert.throws(
      () =>
        new AgentRun({
          sessionId: 'session-1',
          header: {
            id: 'session-1',
            workspaceRoot: '/tmp/workspace',
            cwd: '/tmp/cwd',
            createdAt: 1,
            lastUsedAt: 1,
            name: 'Session',
            titleIsManual: true,
            isFlagged: false,
            labels: [],
            isArchived: false,
            status: 'active',
            statusUpdatedAt: 1,
            hasUnread: false,
            backend: 'fake',
            llmConnectionSlug: 'fake',
            connectionLocked: false,
            model: 'fake-model',
            permissionMode: 'ask',
            schemaVersion: 1,
          },
          userInput: { turnId: 'turn-1', text: 'hello' },
          store,
          runStore,
          newId: nextId(),
          now: nextNow(25_200),
          hooks: {
            reserveRun: async () => {
              throw new Error('reserveRun should not be called');
            },
            unregisterRun: () => {},
            updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
            updateStatus: async () => {},
            appendTurnState: async () => {},
          },
        }),
      /RuntimeEventStore/,
    );
  });

  test('direct AgentRun terminal writes fail before terminal headers can commit', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore({ failTerminalRuntimeEventAppends: true });
    const session = await store.create(makeInput());
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(30_000),
      hooks: {
        reserveRun: async () => {
          throw new Error('reserveRun should not be called');
        },
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'running',
      }),
    );
    const terminalEvent = runtimeEvent({
      id: 'rt-completed',
      sessionId: session.id,
      runId: run.runId,
      turnId: run.turnId,
      status: 'completed',
      actions: { endInvocation: true },
    });

    await assert.rejects(
      run.recordRuntimeEvents([terminalEvent]),
      /terminal runtime event append failed/,
    );
    await run.recordSessionEvent({
      type: 'complete',
      id: 'complete',
      turnId: run.turnId,
      ts: 3,
      stopReason: 'end_turn',
    });
    await run.finalize();

    expect((await runStore.readRun(session.id, run.runId)).status).toBe('running');
    expect(
      (await runStore.readRuntimeEvents(session.id, run.runId)).some(isTerminalRuntimeEvent),
    ).toBe(false);
  });

  test('direct AgentRun execute records terminal RuntimeEvents before terminal headers', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const backend = new ScriptBackend({ sessionId: session.id } as BackendFactoryContext, [
      { type: 'complete', stopReason: 'end_turn' },
    ]);
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(40_000),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });

    await drain(run.execute());

    const header = await runStore.readRun(session.id, run.runId);
    expect(header.status).toBe('completed');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('completed');
  });

  test('direct AgentRun execute ignores backend events after the terminal event', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const backend = new ScriptBackend({ sessionId: session.id } as BackendFactoryContext, [
      { type: 'complete', stopReason: 'end_turn' },
      { type: 'text_delta', messageId: 'message-after-terminal', text: 'after-terminal' },
    ]);
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(40_500),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });

    const yielded: SessionEvent[] = [];
    for await (const event of run.execute()) {
      yielded.push(event);
    }

    expect(yielded.map((event) => event.type)).toEqual(['complete']);
    const runtimeEvents = await runStore.readRuntimeEvents(session.id, run.runId);
    expect(
      runtimeEvents.map((event) =>
        event.content?.kind === 'text' ? event.content.text : event.status,
      ),
    ).toEqual(['hello', 'completed']);
  });

  test('direct AgentRun execute forwards the effective tool mode to the Flow', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    let observedToolMode: BackendSendInput['toolMode'];
    const backend = new ScriptBackend(
      { sessionId: session.id } as BackendFactoryContext,
      [{ type: 'complete', stopReason: 'end_turn' }],
      (input) => {
        observedToolMode = input.toolMode;
      },
    );
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-code-mode', text: 'hello', toolMode: 'code_mode' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(40_750),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });

    await drain(run.execute());

    expect(observedToolMode).toBe('code_mode');
  });

  test('direct AgentRun finalize synthesizes a failed terminal fact when no terminal event was recorded', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(41_000),
      hooks: {
        reserveRun: async () => {
          throw new Error('reserveRun should not be called');
        },
        unregisterRun: () => {},
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'running',
      }),
    );

    await run.finalize();

    const header = await runStore.readRun(session.id, run.runId);
    expect(header.status).toBe('failed');
    expect(header.failureClass).toBe('missing_terminal_event');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
    expect(terminalEvents[0]?.invocationId).toBe(run.runId);
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    expect(terminalEvents[0]?.actions?.stateDelta?.recovered).toBeUndefined();
    await new RuntimeReadModel({ runStore, runtimeEventStore: runStore }).getSessionView(
      session.id,
    );
  });

  test('direct AgentRun stop synthesizes a cancelled terminal fact when no terminal event was recorded', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const backend = new ScriptBackend({ sessionId: session.id } as BackendFactoryContext, []);
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(41_250),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });

    const begin = await run.begin();
    run.stop('stop_button');
    await run.finalize();

    const header = await runStore.readRun(session.id, run.runId);
    expect(header.status).toBe('cancelled');
    expect(header.failureClass).toBeUndefined();
    expect(header.abortSource).toBe('renderer.stop_button');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('aborted');
    expect(terminalEvents[0]?.invocationId).toBe(begin.initialRuntimeEvent.invocationId);
    expect(terminalEvents[0]?.actions?.stateDelta?.abortSource).toBe('renderer.stop_button');
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBeUndefined();
    expect(terminalEvents[0]?.actions?.stateDelta?.recovered).toBeUndefined();
    await new RuntimeReadModel({ runStore, runtimeEventStore: runStore }).getSessionView(
      session.id,
    );
  });

  test('a stop settlement racing finalize commits exactly one terminal run event', async () => {
    const store = new TinySessionStore();
    const settleReachedAppend = deferred<void>();
    const releaseTerminalAppend = deferred<void>();
    const runStore = new TinyAgentRunStore({
      beforeTerminalRuntimeEventAppend: async () => {
        settleReachedAppend.resolve();
        await releaseTerminalAppend.promise;
      },
    });
    const session = await store.create(makeInput());
    const backend = new ScriptBackend({ sessionId: session.id } as BackendFactoryContext, []);
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(41_500),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });

    await run.begin();
    run.stop('stop_button');
    // The stop settles the claim while the backend stream is still unwinding,
    // so both settlement paths queue behind the same in-flight terminal write.
    const settled = run.settleStopTerminal();
    await settleReachedAppend.promise;
    await timerDelay(0);
    const finalized = run.finalize();
    await timerDelay(0);
    releaseTerminalAppend.resolve();
    await Promise.all([settled, finalized]);

    const runEvents = (await runStore.readEvents(session.id, run.runId)).filter(
      (event) => event.type === 'run_cancelled',
    );
    expect(runEvents).toHaveLength(1);
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
  });

  test('a stop settlement leaves an already sealed ledger untouched', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const backend = new ScriptBackend({ sessionId: session.id } as BackendFactoryContext, []);
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(41_700),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    await run.begin();
    run.stop('stop_button');
    // Another owner — a Host recovery, a resumed continuation — sealed the run
    // before this stop got to settle it.
    await runStore.appendRuntimeEvent(
      session.id,
      run.runId,
      runtimeEvent({
        id: 'rt-foreign-terminal',
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'aborted',
        actions: { endInvocation: true },
      }),
    );

    await run.settleStopTerminal();

    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.id).toBe('rt-foreign-terminal');
  });

  test('stop settlement probes a latched store and settles when it answers', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const backend = new ScriptBackend({ sessionId: session.id } as BackendFactoryContext, []);
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(41_900),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    await run.begin();
    // One rejected write latches store availability. #2253 reached this
    // state through the ledger refusing an aborted question's outcome; the
    // store itself stayed healthy the whole time.
    runStore.failNextRuntimeEventAppends = 1;
    await run.acceptMappedEvent(
      {
        type: 'text_complete',
        id: 'complete-1',
        turnId: 'turn-1',
        ts: 5,
        messageId: 'm1',
        text: 'a',
      },
      runtimeEvent({
        id: 'rt-rejected',
        sessionId: session.id,
        invocationId: run.invocationId,
        runId: run.runId,
        turnId: run.turnId,
        ts: 5,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'a' },
      }),
    );
    run.stop('stop_button');

    // The latch says a write failed once, not that the store is gone. The
    // settlement's own durable read is the probe; a store that answers
    // lifts the latch and the terminal fact lands on the first stop.
    await run.settleStopTerminal();

    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('aborted');
    expect(terminalEvents[0]?.actions?.stateDelta?.abortSource).toBe('renderer.stop_button');
  });

  test('a retried stop settles once a latched store answers again', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const backend = new ScriptBackend({ sessionId: session.id } as BackendFactoryContext, []);
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(42_000),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    await run.begin();
    runStore.failNextRuntimeEventAppends = 1;
    await run.acceptMappedEvent(
      {
        type: 'text_complete',
        id: 'complete-1',
        turnId: 'turn-1',
        ts: 5,
        messageId: 'm1',
        text: 'a',
      },
      runtimeEvent({
        id: 'rt-rejected',
        sessionId: session.id,
        invocationId: run.invocationId,
        runId: run.runId,
        turnId: run.turnId,
        ts: 5,
        role: 'model',
        author: 'agent',
        content: { kind: 'text', text: 'a' },
      }),
    );
    run.stop('stop_button');

    // While the store cannot answer, the settlement keeps failing and the
    // stop operation stays retryable rather than reporting a success the
    // ledger does not carry.
    runStore.failRuntimeEventReads = true;
    await assert.rejects(run.settleStopTerminal(), /RuntimeEvent store is unavailable/);

    runStore.failRuntimeEventReads = false;
    await run.settleStopTerminal();

    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('aborted');
    expect(terminalEvents[0]?.actions?.stateDelta?.abortSource).toBe('renderer.stop_button');
  });

  test('stop settlement probes a latched run store instead of skipping the header commit', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const backend = new ScriptBackend({ sessionId: session.id } as BackendFactoryContext, []);
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(42_100),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async () => {},
      },
    });
    await run.begin();
    // One best-effort trace append failure latches the Run store. Nothing
    // surfaces to the user, which is what made the pre-fix behaviour a
    // silent stop success: commitTerminalRun skips under the latch and the
    // run stays non-terminal with no error to retry on.
    runStore.failNextRunEventAppends = 1;
    run.recordRunTrace({
      id: 'trace-1',
      sessionId: session.id,
      turnId: 'turn-1',
      ts: 1,
      phase: 'turn',
      type: 'abort_requested',
      message: 'trace append that latches the store',
    });
    await timerDelay(0);
    await timerDelay(0);
    run.stop('stop_button');

    await run.settleStopTerminal();

    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('aborted');
    const cancelled = (await runStore.readEvents(session.id, run.runId)).filter(
      (event) => event.type === 'run_cancelled',
    );
    expect(cancelled).toHaveLength(1);
  });

  test('direct AgentRun error events still commit failed terminal facts when failed turn projection fails', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const session = await store.create(makeInput());
    const backend = new ScriptBackend({ sessionId: session.id } as BackendFactoryContext, [
      { type: 'error', recoverable: false, reason: 'tool_failed', message: 'Tool failed' },
    ]);
    const activeRuns = new Map<string, AgentRun>();
    const turnToRunId = new Map<string, string>();
    const run = new AgentRun({
      sessionId: session.id,
      header: session,
      userInput: { turnId: 'turn-1', text: 'hello' },
      store,
      runStore,
      runtimeEventStore: runStore,
      newId: nextId(),
      now: nextNow(41_500),
      hooks: {
        reserveRun: async (_sessionId, _header, activeRun) => {
          activeRuns.set(activeRun.runId, activeRun);
          turnToRunId.set(activeRun.turnId, activeRun.runId);
          return {
            sessionId: session.id,
            backend,
            cachedHeader: session,
            activeRuns,
            turnToRunId,
          };
        },
        unregisterRun: (_active, activeRun) => {
          activeRuns.delete(activeRun.runId);
          turnToRunId.delete(activeRun.turnId);
        },
        updateHeader: (sessionId, patch) => store.updateHeader(sessionId, patch),
        updateStatus: async () => {},
        appendTurnState: async (_sessionId, _turnId, status) => {
          if (status === 'failed') throw new Error('turn state write failed');
        },
      },
    });

    await drain(run.execute());

    const header = await runStore.readRun(session.id, run.runId);
    expect(header.status).toBe('failed');
    expect(header.failureClass).toBe('tool_failed');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.status).toBe('failed');
    expect(terminalEvents[0]?.actions?.stateDelta?.failureClass).toBe('tool_failed');
  });

  test('startup recovery reuses an incomplete existing terminal RuntimeEvent instead of appending another', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(50_000),
      runtimeSource: 'test',
    });
    const session = await store.create(makeInput({ status: 'active' }));
    const run = await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-incomplete-terminal',
        turnId: 'turn-incomplete-terminal',
        status: 'running',
      }),
    );
    await runStore.appendEvent(session.id, run.runId, {
      type: 'run_started',
      id: 'run-started',
      sessionId: session.id,
      runId: run.runId,
      turnId: run.turnId,
      ts: 2,
    });
    await runStore.appendRuntimeEvent(
      session.id,
      run.runId,
      runtimeEvent({
        id: 'rt-failed-without-class',
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'failed',
        actions: { endInvocation: true },
      }),
    );

    await manager.recoverInterruptedSessions();

    const header = await runStore.readRun(session.id, run.runId);
    expect(header.status).toBe('failed');
    expect(header.failureClass).toBe('app_restarted');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.id).toBe('rt-failed-without-class');
    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(session.id);
    expect(view.terminalFacts).toHaveLength(1);
    expect(view.terminalFacts[0]?.failureClass).toBe('app_restarted');
  });

  test('startup recovery completes an existing aborted terminal RuntimeEvent without appending another', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(60_000),
      runtimeSource: 'test',
    });
    const session = await store.create(makeInput({ status: 'active' }));
    const run = await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-incomplete-abort',
        turnId: 'turn-incomplete-abort',
        status: 'running',
      }),
    );
    await runStore.appendEvent(session.id, run.runId, {
      type: 'run_started',
      id: 'run-started',
      sessionId: session.id,
      runId: run.runId,
      turnId: run.turnId,
      ts: 2,
    });
    await runStore.appendRuntimeEvent(
      session.id,
      run.runId,
      runtimeEvent({
        id: 'rt-aborted-without-source',
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'aborted',
        actions: { endInvocation: true },
      }),
    );

    await manager.recoverInterruptedSessions();

    const header = await runStore.readRun(session.id, run.runId);
    expect(header.status).toBe('cancelled');
    expect(header.abortSource).toBe('unknown');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.id).toBe('rt-aborted-without-source');
    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(session.id);
    expect(view.terminalFacts).toHaveLength(1);
    expect(view.terminalFacts[0]?.abortSource).toBe('unknown');
  });

  test('RuntimeReadModel reads a non-terminal header when a terminal RuntimeEvent fact exists', async () => {
    const runStore = new TinyAgentRunStore();
    const run = makeRunHeader({
      sessionId: 'session-read-model',
      runId: 'run-read-model',
      turnId: 'turn-read-model',
      status: 'running',
    });
    await runStore.createRun(run);
    await runStore.appendRuntimeEvent(
      run.sessionId,
      run.runId,
      runtimeEvent({
        id: 'rt-failed-fact',
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        status: 'failed',
        content: {
          kind: 'error',
          code: 'tool_failed',
          reason: 'tool_failed',
          message: 'Tool failed',
        },
        actions: {
          endInvocation: true,
          stateDelta: { failureClass: 'tool_failed' },
        },
      }),
    );

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(run.sessionId);

    expect(view.runs[0]?.status).toBe('failed');
    expect(view.runs[0]?.failureClass).toBe('tool_failed');
    expect(view.terminalFacts).toHaveLength(1);
    expect(view.terminalFacts[0]?.failureClass).toBe('tool_failed');
    const turnState = view.messages.find((message) => message.type === 'turn_state');
    if (turnState?.type !== 'turn_state') throw new Error('turn_state was not projected');
    expect(turnState.status).toBe('failed');
    expect(turnState.errorClass).toBe('tool_failed');
  });

  test('RuntimeReadModel treats the terminal RuntimeEvent as the failure fact when the header is stale', async () => {
    const runStore = new TinyAgentRunStore();
    const run = makeRunHeader({
      sessionId: 'session-stale-failure-class',
      runId: 'run-stale-failure-class',
      turnId: 'turn-stale-failure-class',
      status: 'failed',
      completedAt: 10,
      failureClass: 'stale_header_failure',
    });
    await runStore.createRun(run);
    await runStore.appendRuntimeEvent(
      run.sessionId,
      run.runId,
      runtimeEvent({
        id: 'rt-user-stale-failure',
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        ts: 8,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'hello' },
      }),
    );
    await runStore.appendRuntimeEvent(
      run.sessionId,
      run.runId,
      runtimeEvent({
        id: 'rt-failed-runtime-fact',
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        ts: 10,
        status: 'failed',
        content: {
          kind: 'error',
          code: 'runtime_failure',
          reason: 'runtime_failure',
          message: 'Runtime failed',
        },
        actions: {
          endInvocation: true,
          stateDelta: { failureClass: 'runtime_failure' },
        },
      }),
    );

    const view = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(run.sessionId);

    expect(view.terminalFacts[0]?.failureClass).toBe('runtime_failure');
    expect(view.runs[0]?.failureClass).toBe('runtime_failure');
    const turnState = view.messages.find((message) => message.type === 'turn_state');
    if (turnState?.type !== 'turn_state') throw new Error('turn_state was not projected');
    expect(turnState.errorClass).toBe('runtime_failure');
    expect(
      view.diagnostics.some(
        (diagnostic) =>
          diagnostic.message === 'terminal run header does not match RuntimeEvent terminal fact',
      ),
    ).toBe(true);
  });

  test('RuntimeReadModel rejects terminal headers when the ledger has no valid terminal fact', async () => {
    const runStore = new TinyAgentRunStore();
    const run = makeRunHeader({
      sessionId: 'session-ambiguous-terminal-read',
      runId: 'run-ambiguous-terminal-read',
      turnId: 'turn-ambiguous-terminal-read',
      status: 'completed',
      completedAt: 10,
    });
    await runStore.createRun(run);
    await runStore.appendRuntimeEvent(
      run.sessionId,
      run.runId,
      runtimeEvent({
        id: 'rt-user',
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        ts: 8,
        role: 'user',
        author: 'user',
        content: { kind: 'text', text: 'hello' },
      }),
    );
    await runStore.appendRuntimeEvent(
      run.sessionId,
      run.runId,
      runtimeEvent({
        id: 'rt-completed-a',
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        ts: 10,
        status: 'completed',
        actions: { endInvocation: true },
      }),
    );
    await runStore.appendRuntimeEvent(
      run.sessionId,
      run.runId,
      runtimeEvent({
        id: 'rt-completed-b',
        sessionId: run.sessionId,
        runId: run.runId,
        turnId: run.turnId,
        ts: 11,
        status: 'completed',
        actions: { endInvocation: true },
      }),
    );

    await assert.rejects(
      new RuntimeReadModel({ runStore, runtimeEventStore: runStore }).getSessionView(run.sessionId),
      /valid terminal fact/,
    );
  });

  test('startup recovery does not append another terminal RuntimeEvent when the ledger is ambiguous', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(70_000),
      runtimeSource: 'test',
    });
    const session = await store.create(makeInput({ status: 'active' }));
    const run = await runStore.createRun(
      makeRunHeader({
        sessionId: session.id,
        runId: 'run-ambiguous-terminal',
        turnId: 'turn-ambiguous-terminal',
        status: 'running',
      }),
    );
    await runStore.appendEvent(session.id, run.runId, {
      type: 'run_started',
      id: 'run-started',
      sessionId: session.id,
      runId: run.runId,
      turnId: run.turnId,
      ts: 2,
    });
    await runStore.appendRuntimeEvent(
      session.id,
      run.runId,
      runtimeEvent({
        id: 'rt-completed',
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'completed',
        actions: { endInvocation: true },
      }),
    );
    await runStore.appendRuntimeEvent(
      session.id,
      run.runId,
      runtimeEvent({
        id: 'rt-failed',
        sessionId: session.id,
        runId: run.runId,
        turnId: run.turnId,
        status: 'failed',
        content: {
          kind: 'error',
          code: 'tool_failed',
          reason: 'tool_failed',
          message: 'Tool failed',
        },
        actions: {
          endInvocation: true,
          stateDelta: { failureClass: 'tool_failed' },
        },
      }),
    );

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([]);
    expect((await runStore.readRun(session.id, run.runId)).status).toBe('running');
    const terminalEvents = (await runStore.readRuntimeEvents(session.id, run.runId)).filter(
      isTerminalRuntimeEvent,
    );
    expect(terminalEvents.map((event) => event.id)).toEqual(['rt-completed', 'rt-failed']);
  });

  test('startup recovery treats terminal headers without ledger facts as missing terminal events', async () => {
    const store = new TinySessionStore();
    const runStore = new TinyAgentRunStore();
    const manager = new SessionManager({
      store,
      runStore,
      runtimeEventStore: runStore,
      backends: new BackendRegistry(),
      newId: nextId(),
      now: nextNow(80_000),
      runtimeSource: 'test',
    });
    const completedSession = await store.create(makeInput({ status: 'active' }));
    const failedSession = await store.create(makeInput({ status: 'active' }));
    const cancelledSession = await store.create(makeInput({ status: 'active' }));
    await runStore.createRun(
      makeRunHeader({
        sessionId: completedSession.id,
        runId: 'run-completed-empty-ledger',
        turnId: 'turn-completed-empty-ledger',
        status: 'completed',
        completedAt: 20,
      }),
    );
    await runStore.appendEvent(completedSession.id, 'run-completed-empty-ledger', {
      type: 'run_completed',
      id: 'run-completed-event',
      sessionId: completedSession.id,
      runId: 'run-completed-empty-ledger',
      turnId: 'turn-completed-empty-ledger',
      ts: 20,
    });
    await runStore.createRun(
      makeRunHeader({
        sessionId: failedSession.id,
        runId: 'run-failed-empty-ledger',
        turnId: 'turn-failed-empty-ledger',
        status: 'failed',
        failureClass: 'tool_failed',
        completedAt: 21,
      }),
    );
    await runStore.appendEvent(failedSession.id, 'run-failed-empty-ledger', {
      type: 'run_failed',
      id: 'run-failed-event',
      sessionId: failedSession.id,
      runId: 'run-failed-empty-ledger',
      turnId: 'turn-failed-empty-ledger',
      ts: 21,
      data: { failureClass: 'tool_failed' },
    });
    await runStore.createRun(
      makeRunHeader({
        sessionId: cancelledSession.id,
        runId: 'run-cancelled-empty-ledger',
        turnId: 'turn-cancelled-empty-ledger',
        status: 'cancelled',
        abortSource: 'user_stop',
        completedAt: 22,
      }),
    );
    await runStore.appendEvent(cancelledSession.id, 'run-cancelled-empty-ledger', {
      type: 'run_cancelled',
      id: 'run-cancelled-event',
      sessionId: cancelledSession.id,
      runId: 'run-cancelled-empty-ledger',
      turnId: 'turn-cancelled-empty-ledger',
      ts: 22,
    });

    const recovered = await manager.recoverInterruptedSessions();

    expect(recovered).toEqual([completedSession.id, failedSession.id, cancelledSession.id]);
    const completedEvents = (
      await runStore.readRuntimeEvents(completedSession.id, 'run-completed-empty-ledger')
    ).filter(isTerminalRuntimeEvent);
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]?.status).toBe('failed');
    expect(completedEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    const failedEvents = (
      await runStore.readRuntimeEvents(failedSession.id, 'run-failed-empty-ledger')
    ).filter(isTerminalRuntimeEvent);
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0]?.status).toBe('failed');
    expect(failedEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');
    const cancelledEvents = (
      await runStore.readRuntimeEvents(cancelledSession.id, 'run-cancelled-empty-ledger')
    ).filter(isTerminalRuntimeEvent);
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]?.status).toBe('failed');
    expect(cancelledEvents[0]?.actions?.stateDelta?.failureClass).toBe('missing_terminal_event');

    const completedView = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(completedSession.id);
    expect(completedView.terminalFacts[0]?.runStatus).toBe('failed');
    expect(completedView.terminalFacts[0]?.failureClass).toBe('missing_terminal_event');
    const failedView = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(failedSession.id);
    expect(failedView.terminalFacts[0]?.failureClass).toBe('missing_terminal_event');
    const cancelledView = await new RuntimeReadModel({
      runStore,
      runtimeEventStore: runStore,
    }).getSessionView(cancelledSession.id);
    expect(cancelledView.terminalFacts[0]?.failureClass).toBe('missing_terminal_event');
  });
});

type ScriptEvent =
  | Omit<Extract<SessionEvent, { type: 'text_delta' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'error' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'abort' }>, 'id' | 'turnId' | 'ts'>
  | Omit<Extract<SessionEvent, { type: 'complete' }>, 'id' | 'turnId' | 'ts'>;

async function makeHarness(events: readonly ScriptEvent[]): Promise<{
  manager: SessionManager;
  runStore: TinyAgentRunStore;
  session: SessionSummary;
}> {
  const store = new TinySessionStore();
  const runStore = new TinyAgentRunStore();
  const backends = new BackendRegistry();
  backends.register('fake', (ctx) => new ScriptBackend(ctx, events));
  const manager = new SessionManager({
    store,
    runStore,
    runtimeEventStore: runStore,
    backends,
    newId: nextId(),
    now: nextNow(10_000),
    runtimeSource: 'test',
  });
  const session = await manager.createSession(makeInput());
  return { manager, runStore, session };
}

class ScriptBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(
    ctx: BackendFactoryContext,
    private readonly events: readonly ScriptEvent[],
    private readonly onInput?: (input: BackendSendInput) => void,
  ) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    this.onInput?.(input);
    let index = 0;
    for (const event of this.events) {
      index += 1;
      yield {
        ...event,
        id: `${input.turnId}-${index}`,
        turnId: input.turnId,
        ts: index,
      } as SessionEvent;
    }
  }

  async stop(): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class StopDuringSendBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;
  private readonly stopStarted = deferred<void>();
  private readonly stopReturned = deferred<void>();

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: `${input.turnId}-text`,
      turnId: input.turnId,
      ts: 1,
      messageId: 'message-1',
      text: 'before stop',
    };
    await this.stopStarted.promise;
    yield {
      type: 'abort',
      id: `${input.turnId}-abort`,
      turnId: input.turnId,
      ts: 2,
      reason: 'user_stop',
    };
  }

  async stop(_reason: 'user_stop' | 'redirect'): Promise<void> {
    this.stopStarted.resolve();
    await this.stopReturned.promise;
  }

  allowStopReturn(): void {
    this.stopReturned.resolve();
  }

  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

/**
 * A turn parked on an unanswered interaction: `stop()` returns, but the event
 * stream never produces another event and never ends, so nothing downstream
 * can finalize the run.
 */
class NeverEndingBackend implements AgentBackend {
  readonly kind = 'fake' as const;
  readonly sessionId: string;

  constructor(ctx: BackendFactoryContext) {
    this.sessionId = ctx.sessionId;
  }

  async *send(input: BackendSendInput): AsyncIterable<SessionEvent> {
    yield {
      type: 'text_delta',
      id: `${input.turnId}-text`,
      turnId: input.turnId,
      ts: 1,
      messageId: 'message-1',
      text: 'before the question',
    };
    await new Promise<never>(() => {});
  }

  async stop(_reason: 'user_stop' | 'redirect'): Promise<void> {}
  async respondToSandboxBoundary(_decision: SandboxBoundaryResponse): Promise<void> {}
  async dispose(): Promise<void> {}
}

class TinySessionStore implements SessionStore {
  private headers = new Map<string, SessionHeader>();
  private messages = new Map<string, StoredMessage[]>();

  async createSubagent(
    _input: CreateSessionInput,
  ): Promise<{ header: SessionHeader; created: boolean }> {
    throw new Error('not implemented');
  }

  async create(input: CreateSessionInput): Promise<SessionHeader> {
    const header: SessionHeader = {
      id: `session-${this.headers.size + 1}`,
      workspaceRoot: '/tmp/workspace',
      cwd: input.cwd,
      createdAt: 1,
      lastUsedAt: 1,
      name: input.name ?? 'Session',
      titleIsManual: true,
      isFlagged: false,
      labels: input.labels ?? [],
      isArchived: false,
      status: input.status ?? 'active',
      ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
      statusUpdatedAt: 1,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.branchOfTurnId ? { branchOfTurnId: input.branchOfTurnId } : {}),
      hasUnread: false,
      backend: input.backend,
      llmConnectionSlug: input.llmConnectionSlug,
      connectionLocked: false,
      model: input.model ?? 'fake-model',
      permissionMode: input.permissionMode,
      schemaVersion: 1,
    };
    this.headers.set(header.id, header);
    this.messages.set(header.id, []);
    return clone(header);
  }

  async setExecutionBoundaryKind(): Promise<never> {
    throw new Error('not implemented');
  }

  async readExecutionBoundary(): Promise<never> {
    throw new Error('not implemented');
  }

  async list(_filter?: SessionListFilter): Promise<SessionSummary[]> {
    return Array.from(this.headers.values()).map((header) => ({
      id: header.id,
      name: header.name,
      isFlagged: header.isFlagged,
      isArchived: header.isArchived,
      connectionLocked: header.connectionLocked,
      labels: header.labels,
      hasUnread: header.hasUnread,
      ...(header.lastMessageAt !== undefined ? { lastMessageAt: header.lastMessageAt } : {}),
      status: header.status,
      ...(header.blockedReason ? { blockedReason: header.blockedReason } : {}),
      ...(header.statusUpdatedAt !== undefined ? { statusUpdatedAt: header.statusUpdatedAt } : {}),
      ...(header.parentSessionId ? { parentSessionId: header.parentSessionId } : {}),
      ...(header.branchOfTurnId ? { branchOfTurnId: header.branchOfTurnId } : {}),
      backend: header.backend,
      llmConnectionSlug: header.llmConnectionSlug,
      model: header.model,
      permissionMode: header.permissionMode,
    }));
  }

  async readHeader(sessionId: string): Promise<SessionHeader> {
    const header = this.headers.get(sessionId);
    if (!header) throw new Error(`Unknown session ${sessionId}`);
    return clone(header);
  }

  async readMessages(sessionId: string): Promise<StoredMessage[]> {
    return clone(this.messages.get(sessionId) ?? []);
  }

  async listTurns(sessionId: string): Promise<TurnRecord[]> {
    return deriveTurnRecords(await this.readMessages(sessionId));
  }

  async appendMessage(sessionId: string, message: StoredMessage): Promise<void> {
    await this.appendMessages(sessionId, [message]);
  }

  async appendMessages(sessionId: string, messages: StoredMessage[]): Promise<void> {
    this.messages.set(sessionId, [...(this.messages.get(sessionId) ?? []), ...clone(messages)]);
  }

  async updateHeader(sessionId: string, patch: Partial<SessionHeader>): Promise<SessionHeader> {
    const current = await this.readHeader(sessionId);
    const next = { ...current, ...patch };
    this.headers.set(sessionId, next);
    return clone(next);
  }

  async markSessionReadThrough(sessionId: string, _readThroughTs: number): Promise<SessionHeader> {
    return this.readHeader(sessionId);
  }

  async archive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, { isArchived: true, status: 'archived' });
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.updateHeader(sessionId, { isArchived: false, status: 'active' });
  }

  async setFlagged(sessionId: string, isFlagged: boolean): Promise<void> {
    await this.updateHeader(sessionId, { isFlagged });
  }

  async rename(sessionId: string, name: string): Promise<void> {
    await this.updateHeader(sessionId, { name });
  }

  async remove(sessionId: string): Promise<void> {
    this.headers.delete(sessionId);
    this.messages.delete(sessionId);
  }
}

class TinyAgentRunStore implements AgentRunStore, RuntimeEventStore {
  private headers = new Map<string, AgentRunHeader>();
  private events = new Map<string, AgentRunEvent[]>();
  private runtimeEvents = new Map<string, RuntimeEvent[]>();
  /** One-shot append rejections, for latching the store availability. */
  failNextRuntimeEventAppends = 0;
  /** While true every runtime-event read rejects, a store that is down. */
  failRuntimeEventReads = false;
  /** One-shot run-event append rejections, for latching the Run store. */
  failNextRunEventAppends = 0;
  /** Runs whose appends refuse persistently, the way assertRunNotSealed answers. */
  readonly sealedRuns = new Set<string>();

  constructor(
    private readonly options: {
      failTerminalRuntimeEventAppends?: boolean;
      failTerminalRuntimeEventDurabilityAfterAppend?: boolean;
      beforeTerminalRuntimeEventAppend?: () => Promise<void>;
      /** Event ids the ledger refuses the way a real transition check would. */
      rejectRuntimeEventIds?: readonly string[];
      /** Refuse every append the way an already-corrupt ledger does. */
      corruptLedger?: boolean;
      /** SqliteRuntimeStore is `canonical`; declare it when a test needs that shape. */
      durability?: 'best_effort' | 'canonical';
    } = {},
  ) {}

  get durability(): 'best_effort' | 'canonical' | undefined {
    return this.options.durability;
  }

  async createRun(header: AgentRunHeader): Promise<AgentRunHeader> {
    this.headers.set(key(header.sessionId, header.runId), clone(header));
    return clone(header);
  }

  async updateRun(
    sessionId: string,
    runId: string,
    patch: Partial<AgentRunHeader>,
  ): Promise<AgentRunHeader> {
    const current = await this.readRun(sessionId, runId);
    const next = { ...current, ...patch, sessionId, runId };
    this.headers.set(key(sessionId, runId), clone(next));
    return clone(next);
  }

  async readRun(sessionId: string, runId: string): Promise<AgentRunHeader> {
    const header = this.headers.get(key(sessionId, runId));
    if (!header) throw new Error(`Unknown run ${runId}`);
    return clone(header);
  }

  async listSessionRuns(sessionId: string): Promise<AgentRunHeader[]> {
    return Array.from(this.headers.values())
      .filter((header) => header.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt || a.runId.localeCompare(b.runId))
      .map(clone);
  }

  async appendEvent(sessionId: string, runId: string, event: AgentRunEvent): Promise<void> {
    if (this.failNextRunEventAppends > 0) {
      this.failNextRunEventAppends -= 1;
      throw new Error('run event append rejected');
    }
    const eventKey = key(sessionId, runId);
    this.events.set(eventKey, [...(this.events.get(eventKey) ?? []), clone(event)]);
  }

  async readEvents(sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return clone(this.events.get(key(sessionId, runId)) ?? []);
  }

  async appendRuntimeEvent(sessionId: string, runId: string, event: RuntimeEvent): Promise<void> {
    if (this.sealedRuns.has(runId)) {
      throw new RunSealedError(runId);
    }
    if (this.failNextRuntimeEventAppends > 0) {
      this.failNextRuntimeEventAppends -= 1;
      throw new Error('runtime event append rejected');
    }
    if (this.options.failTerminalRuntimeEventAppends && isTerminalRuntimeEvent(event)) {
      throw new Error('terminal runtime event append failed');
    }
    if (this.options.corruptLedger && isToolLedgerBearingEvent(event)) {
      // Production gates the health scan behind `isToolLedgerBearingEvent`
      // (sqlite-runtime-store.ts), so a corrupt ledger refuses tool facts and
      // nothing else. A double that refuses EVERY append cannot tell the latch
      // apart from the refusal, and the test built on it passes with latching
      // deleted outright.
      throw new ToolLedgerCorruptionError('duplicate_call', 'some-older-event');
    }
    if (this.options.rejectRuntimeEventIds?.includes(event.id)) {
      throw new ToolLedgerRejectionError('orphan_response', event.id);
    }
    if (isTerminalRuntimeEvent(event)) await this.options.beforeTerminalRuntimeEventAppend?.();
    const eventKey = key(sessionId, runId);
    this.runtimeEvents.set(eventKey, [...(this.runtimeEvents.get(eventKey) ?? []), clone(event)]);
  }

  async ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    const existing = (this.runtimeEvents.get(key(sessionId, runId)) ?? []).find(
      (candidate) => candidate.id === event.id,
    );
    if (!existing) {
      await this.appendRuntimeEvent(sessionId, runId, event);
    } else if (JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error(`RuntimeEvent ${event.id} does not match the durable ledger record`);
    }
    if (this.options.failTerminalRuntimeEventDurabilityAfterAppend) {
      throw new DurableStoreWriteError(
        'terminal runtime event did not reach stable storage',
        new Error('simulated fsync failure'),
      );
    }
  }

  async readRuntimeEvents(sessionId: string, runId: string): Promise<RuntimeEvent[]> {
    if (this.failRuntimeEventReads) throw new Error('runtime event read rejected');
    return clone(this.runtimeEvents.get(key(sessionId, runId)) ?? []);
  }

  async readSessionRuntimeEvents(sessionId: string): Promise<RuntimeEvent[]> {
    const ordered: Array<{ event: RuntimeEvent; runId: string; eventIndex: number }> = [];
    for (const [eventKey, events] of this.runtimeEvents.entries()) {
      const [eventSessionId, runId] = eventKey.split(':');
      if (eventSessionId !== sessionId || !runId) continue;
      events.forEach((event, eventIndex) =>
        ordered.push({ event: clone(event), runId, eventIndex }),
      );
    }
    ordered.sort(
      (a, b) =>
        a.event.ts - b.event.ts ||
        a.runId.localeCompare(b.runId) ||
        a.eventIndex - b.eventIndex ||
        a.event.id.localeCompare(b.event.id),
    );
    return ordered.map((item) => item.event);
  }
}

class BatchingRuntimeEventStore implements RuntimeEventStore {
  readonly durability = 'canonical' as const;
  readonly order: string[] = [];
  private readonly events: RuntimeEvent[] = [];

  constructor(private readonly failPartialBatch = false) {}

  async appendRuntimeEvent(_sessionId: string, _runId: string, event: RuntimeEvent): Promise<void> {
    this.order.push(`append:${event.id}`);
    this.events.push(clone(event));
  }

  async appendRuntimePartialBatch(
    _sessionId: string,
    _runId: string,
    events: readonly RuntimeEvent[],
  ): Promise<void> {
    this.order.push(`batch:${events.map((event) => event.id).join(',')}`);
    if (this.failPartialBatch) throw new Error('partial batch failed');
    this.events.push(...clone(events));
  }

  async ensureTerminalRuntimeEventDurable(
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    if (!this.events.some((candidate) => candidate.id === event.id)) {
      await this.appendRuntimeEvent(sessionId, runId, event);
    }
  }

  async readRuntimeEvents(): Promise<RuntimeEvent[]> {
    return clone(this.events);
  }

  async readSessionRuntimeEvents(): Promise<RuntimeEvent[]> {
    return clone(this.events);
  }
}

function makeInput(overrides: Partial<CreateSessionInput> = {}): CreateSessionInput {
  return {
    cwd: '/tmp/cwd',
    backend: 'fake',
    llmConnectionSlug: 'fake',
    model: 'fake-model',
    permissionMode: 'ask',
    name: 'Session',
    labels: [],
    ...overrides,
  };
}

function makeRunHeader(overrides: Partial<AgentRunHeader> = {}): AgentRunHeader {
  return {
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
    updatedAt: 1,
    ...overrides,
  };
}

/** Mirrors the private predicate in `sqlite-runtime-store.ts` that gates the
 *  workspace tool-ledger health scan. Kept here so the corrupt-ledger double
 *  refuses exactly what production refuses, and accepts what it accepts. */
function isToolLedgerBearingEvent(event: RuntimeEvent): boolean {
  return (
    event.content?.kind === 'function_call' ||
    event.content?.kind === 'function_response' ||
    event.actions?.toolDispatch !== undefined ||
    event.actions?.toolRecovery !== undefined
  );
}

function runtimeEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'rt-event',
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function nextId(): () => string {
  let id = 0;
  return () => `id-${++id}`;
}

function nextNow(start: number): () => number {
  let ts = start;
  return () => ++ts;
}

function hostedInteractionAuthority(): RuntimeInteractionAuthority {
  return {
    bindRun: (identity) => ({
      ...identity,
      acceptSandboxBoundaryRequest: async () => {},
      acceptUserQuestionRequest: async () => {},
      close: async () => {},
      release: () => {},
    }),
  };
}

function inertAgentRunHooks(store: TinySessionStore) {
  return {
    reserveRun: async () => {
      throw new Error('reserveRun should not be called');
    },
    unregisterRun: () => {},
    updateHeader: (sessionId: string, patch: Partial<SessionHeader>) =>
      store.updateHeader(sessionId, patch),
    updateStatus: async () => {},
    appendTurnState: async () => {},
  };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of iterable) {
    // consume
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function key(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
