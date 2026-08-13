import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES } from '@maka/core/shell-run';
import {
  type ShellRunSnapshotResult,
  type ShellRunStateResult,
  type ShellRunUpdate,
} from '@maka/core/events';
import type { ShellRunBashInput, ShellRunWriteInput } from '@maka/runtime/shell-run-contract';
import { SessionNotFoundError } from '@maka/storage';
import { RUNTIME_RESOURCE_RESULT_MAX_BYTES } from '../protocol/runtime-resource.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';
import {
  HostRuntimeResourceCoordinator,
  type HostRuntimeResourceCoordinatorInput,
} from '../server/runtime-resource-coordinator.js';
import { SessionAdmissionGate } from '../server/session-admission-gate.js';

const SESSION_ID = 'session-1';
const RUNTIME_REF = 'maka://runtime/background-tasks/shell-1';

describe('Host Runtime Resource coordinator', () => {
  test('pages one stable bounded projection and rejects stale continuation revisions', async () => {
    const harness = createHarness();
    harness.updates = Array.from({ length: 65 }, (_, index) => resourceUpdate(index));
    const first = await harness.coordinator.handlers['runtime.resource.query'](
      { kind: 'list_start', sessionId: SESSION_ID },
      connection('connection-1'),
    );
    assert.equal(first.ok, true);
    if (!first.ok || first.result.kind !== 'page') return;
    assert.equal(first.result.resources.length, 64);
    assert.equal(first.result.nextCursor, '64');

    harness.updates.reverse();
    const reordered = await harness.coordinator.handlers['runtime.resource.query'](
      { kind: 'list_start', sessionId: SESSION_ID },
      connection('connection-1'),
    );
    assert.deepEqual(reordered, first);

    const second = await harness.coordinator.handlers['runtime.resource.query'](
      {
        kind: 'list_continue',
        sessionId: SESSION_ID,
        revision: first.result.revision,
        cursor: first.result.nextCursor,
      },
      connection('connection-1'),
    );
    assert.equal(second.ok, true);
    assert.equal(second.ok && second.result.kind === 'page' && second.result.resources.length, 1);

    harness.updates = [...harness.updates, resourceUpdate(65)];
    const stale = await harness.coordinator.handlers['runtime.resource.query'](
      {
        kind: 'list_continue',
        sessionId: SESSION_ID,
        revision: first.result.revision,
        cursor: first.result.nextCursor,
      },
      connection('connection-1'),
    );
    assert.equal(stale.ok, true);
    assert.equal(stale.ok && stale.result.kind, 'revision_changed');

    const currentRevision =
      stale.ok && stale.result.kind === 'revision_changed'
        ? stale.result.actual
        : first.result.revision;
    const invalid = await harness.coordinator.handlers['runtime.resource.query'](
      {
        kind: 'list_continue',
        sessionId: SESSION_ID,
        revision: currentRevision,
        cursor: '0',
      },
      connection('connection-1'),
    );
    assert.equal(invalid.ok, false);
    assert.equal(!invalid.ok && invalid.error.code, 'invalid_request');
  });

  test('keeps inherited unavailable state honest and bounds adversarial output encoding', async () => {
    const harness = createHarness();
    const compact = compactState(0);
    harness.updates = [
      resourceUpdate(0, {
        ownership: { kind: 'source_unavailable', sourceSessionId: 'source-session' },
        sourceToolCallId: 'call.1/part',
        result: compact,
      }),
      resourceUpdate(1, {
        result: pipeSnapshot(1, '"\n'.repeat(100_000)),
      }),
    ];

    const inherited = await harness.coordinator.handlers['runtime.resource.query'](
      { kind: 'get', sessionId: SESSION_ID, ref: compact.ref },
      connection('connection-1'),
    );
    assert.deepEqual(
      inherited.ok && inherited.result.kind === 'resource'
        ? inherited.result.resource?.result
        : undefined,
      compact,
    );

    const heavy = await harness.coordinator.handlers['runtime.resource.query'](
      { kind: 'get', sessionId: SESSION_ID, ref: shellRef(1) },
      connection('connection-1'),
    );
    assert.equal(heavy.ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(heavy), 'utf8') < RUNTIME_RESOURCE_RESULT_MAX_BYTES);
    assert.equal(harness.listReadCount, 0);
    assert.equal(harness.pointReadCount, 2);
    if (!heavy.ok || heavy.result.kind !== 'resource') return;
    const output = heavy.result.resource?.result.output;
    assert.equal(output?.mode, 'pipes');
    assert.equal(output?.mode === 'pipes' && output.stdoutTruncated, true);
  });

  test('uses point reads for a full invalidation batch without rebuilding the list', async () => {
    const harness = createHarness();
    harness.updates = Array.from({ length: 64 }, (_, index) => resourceUpdate(index));

    const results = await Promise.all(
      harness.updates.map((update) =>
        harness.coordinator.handlers['runtime.resource.query'](
          { kind: 'get', sessionId: SESSION_ID, ref: update.result.ref },
          connection('connection-1'),
        ),
      ),
    );

    assert.equal(
      results.every((result) => result.ok && result.result.kind === 'resource'),
      true,
    );
    assert.equal(harness.pointReadCount, 64);
    assert.equal(harness.listReadCount, 0);
  });

  test('drains for canonical state failure but keeps projection failure scoped to its query', async () => {
    const harness = createHarness();
    harness.updates = [
      resourceUpdate(0, {
        sourceToolCallId: 'x'.repeat(SHELL_RUN_SOURCE_TOOL_CALL_ID_MAX_BYTES + 1),
      }),
    ];

    const result = await harness.coordinator.handlers['runtime.resource.query'](
      { kind: 'list_start', sessionId: SESSION_ID },
      connection('connection-1'),
    );

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.code, 'internal_failure');
    assert.equal(harness.drainCount, 0);
    assert.equal(harness.terminateCount, 0);

    harness.updates = [resourceUpdate(0)];
    harness.stateReadFailure = new Error('canonical state unavailable');
    const unavailable = await harness.coordinator.handlers['runtime.resource.query'](
      { kind: 'list_start', sessionId: SESSION_ID },
      connection('connection-1'),
    );
    assert.equal(unavailable.ok, false);
    assert.equal(!unavailable.ok && unavailable.error.code, 'internal_failure');
    assert.equal(harness.drainCount, 1);
    assert.equal(harness.terminateCount, 0);
  });

  test('fences PTY control by connection and retains only exact sequence retries', async () => {
    const harness = createHarness();
    const firstConnection = connection('connection-1');
    const secondConnection = connection('connection-2');
    const identity = { sessionId: SESSION_ID, ref: RUNTIME_REF, controllerId: 'controller-1' };

    const acquired = await harness.coordinator.handlers['runtime.resource.controller.acquire'](
      identity,
      firstConnection,
    );
    assert.equal(acquired.ok, true);
    assert.equal(acquired.ok && acquired.result.nextSequence, 1);

    const contested = await harness.coordinator.handlers['runtime.resource.controller.acquire'](
      { ...identity, controllerId: 'controller-2' },
      secondConnection,
    );
    assert.equal(contested.ok, false);
    assert.equal(!contested.ok && contested.error.code, 'operation_conflict');
    await assert.rejects(
      () =>
        harness.coordinator.writeStdin({
          sessionId: SESSION_ID,
          ref: RUNTIME_REF,
          input: 'model input',
        }),
      /controlled by a connected Client/,
    );

    const control = {
      ...identity,
      sequence: 1,
      control: { kind: 'input' as const, input: 'client input' },
    };
    const applied = await harness.coordinator.handlers['runtime.resource.controller.control'](
      control,
      firstConnection,
    );
    assert.equal(applied.ok, true);
    assert.equal(harness.writeCount, 1);
    const retry = await harness.coordinator.handlers['runtime.resource.controller.control'](
      control,
      firstConnection,
    );
    assert.deepEqual(retry, applied);
    assert.equal(harness.writeCount, 1);

    const conflictingRetry = await harness.coordinator.handlers[
      'runtime.resource.controller.control'
    ]({ ...control, control: { kind: 'input', input: 'different' } }, firstConnection);
    assert.equal(conflictingRetry.ok, false);
    assert.equal(!conflictingRetry.ok && conflictingRetry.error.code, 'operation_conflict');
    const outOfOrder = await harness.coordinator.handlers['runtime.resource.controller.control'](
      { ...control, sequence: 3 },
      firstConnection,
    );
    assert.equal(outOfOrder.ok, false);
    assert.equal(!outOfOrder.ok && outOfOrder.error.code, 'operation_conflict');

    const released = await harness.coordinator.handlers['runtime.resource.controller.release'](
      identity,
      firstConnection,
    );
    assert.deepEqual(released, {
      ok: true,
      result: { controllerId: 'controller-1', released: true },
    });
    await harness.coordinator.writeStdin({
      sessionId: SESSION_ID,
      ref: RUNTIME_REF,
      input: 'model input',
    });
    assert.equal(harness.writeCount, 2);
  });

  test('starts an interactive login shell inside the canonical Session workspace', async () => {
    const harness = createHarness();
    const started = await harness.coordinator.handlers['runtime.resource.start'](
      { sessionId: SESSION_ID, launchId: 'desktop-launch-1' },
      connection('connection-1'),
    );

    assert.equal(started.ok, true);
    assert.equal(started.ok && started.result.resource.mode, 'pty');
    assert.deepEqual(
      harness.lastBackgroundInput && {
        sessionId: harness.lastBackgroundInput.sessionId,
        sourceTurnId: harness.lastBackgroundInput.sourceTurnId,
        sourceToolCallId: harness.lastBackgroundInput.sourceToolCallId,
        cwd: harness.lastBackgroundInput.cwd,
        pty: harness.lastBackgroundInput.pty,
      },
      {
        sessionId: SESSION_ID,
        sourceTurnId: 'desktop-launch-1',
        sourceToolCallId: 'desktop-launch-1',
        cwd: '/workspace',
        pty: true,
      },
    );
    harness.finishBackground({ successful: true });
    assert.equal(harness.activeResidencies, 0);
  });

  test('lets stop bypass the controller, releases terminal ownership, and keeps control replay safe', async () => {
    const harness = createHarness();
    const firstConnection = connection('connection-1');
    const secondConnection = connection('connection-2');
    const identity = { sessionId: SESSION_ID, ref: RUNTIME_REF, controllerId: 'controller-1' };
    await harness.coordinator.handlers['runtime.resource.controller.acquire'](
      identity,
      firstConnection,
    );
    const control = {
      ...identity,
      sequence: 1,
      control: { kind: 'input' as const, input: 'exit\r' },
    };
    const controlled = await harness.coordinator.handlers['runtime.resource.controller.control'](
      control,
      firstConnection,
    );
    assert.equal(controlled.ok, true);

    const stopped = await harness.coordinator.handlers['runtime.resource.stop'](
      { sessionId: SESSION_ID, ref: RUNTIME_REF },
      secondConnection,
    );
    assert.equal(stopped.ok, true);
    assert.equal(stopped.ok && stopped.result.resource.status, 'cancelled');
    const retried = await harness.coordinator.handlers['runtime.resource.controller.control'](
      control,
      firstConnection,
    );
    assert.deepEqual(retried, controlled);
    assert.equal(harness.writeCount, 1);

    const releasedAfterStop = await harness.coordinator.handlers[
      'runtime.resource.controller.release'
    ](identity, firstConnection);
    assert.deepEqual(releasedAfterStop, {
      ok: true,
      result: { controllerId: 'controller-1', released: false },
    });
    harness.coordinator.releaseConnection('connection-1');
    const retryAfterDisconnect = await harness.coordinator.handlers[
      'runtime.resource.controller.control'
    ](control, firstConnection);
    assert.equal(retryAfterDisconnect.ok, false);
    assert.equal(!retryAfterDisconnect.ok && retryAfterDisconnect.error.code, 'operation_conflict');
  });

  test('holds Host residency for a live background process and closes startup on drain', async () => {
    const harness = createHarness();
    assert.equal(await harness.coordinator.hasLiveSessionResources(SESSION_ID), true);
    let callerCompletion = 0;
    const result = await harness.coordinator.runBackgroundBash(
      backgroundInput(() => {
        callerCompletion += 1;
      }),
    );
    assert.equal(result.status, 'running');
    assert.equal(harness.activeResidencies, 1);
    harness.finishBackground({ successful: true });
    assert.equal(harness.activeResidencies, 0);
    assert.equal(callerCompletion, 1);
    harness.updates = [
      resourceUpdate(0, {
        result: {
          ...pipeSnapshot(0),
          status: 'completed',
          exitCode: 0,
          completedAt: 2,
        },
      }),
    ];
    assert.equal(await harness.coordinator.hasLiveSessionResources(SESSION_ID), false);

    harness.coordinator.beginDrain();
    assert.equal(harness.terminateCount, 1);
    await assert.rejects(
      () => harness.coordinator.runBackgroundBash(backgroundInput()),
      /Runtime resources are draining/,
    );
    await harness.coordinator.close();
    assert.equal(harness.terminateCount, 1);
  });

  test('releases Session admission while a foreground process holds Host residency', async () => {
    const harness = createHarness();
    let announceStart!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStart = resolve;
    });
    let finishForeground!: (result: ReturnType<typeof foregroundResult>) => void;
    const completion = new Promise<ReturnType<typeof foregroundResult>>((resolve) => {
      finishForeground = resolve;
    });
    harness.foregroundRun = () => {
      announceStart();
      return completion;
    };

    const foreground = harness.coordinator.runForegroundBash(backgroundInput());
    await started;
    assert.equal(harness.activeResidencies, 1);

    let eventAdmitted = false;
    const event = harness.sessionAdmission.run(SESSION_ID, () => {
      eventAdmitted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      assert.equal(eventAdmitted, true);
    } finally {
      finishForeground(foregroundResult());
      await Promise.all([foreground, event]);
    }
    assert.equal(harness.activeResidencies, 0);
  });

  test('reports archived and missing Sessions without touching a Runtime Resource', async () => {
    const harness = createHarness();
    harness.sessionState = 'archived';
    const archived = await harness.coordinator.handlers['runtime.resource.controller.acquire'](
      { sessionId: SESSION_ID, ref: RUNTIME_REF, controllerId: 'controller-1' },
      connection('connection-1'),
    );
    assert.equal(archived.ok, false);
    assert.equal(!archived.ok && archived.error.code, 'session_archived');

    harness.sessionState = 'missing';
    const missing = await harness.coordinator.handlers['runtime.resource.stop'](
      { sessionId: SESSION_ID, ref: RUNTIME_REF },
      connection('connection-1'),
    );
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.code, 'not_found');
    assert.equal(harness.stopCount, 0);
  });
});

function createHarness() {
  let backgroundCompletion: ShellRunBashInput['onCompletion'];
  let currentSnapshot = ptySnapshot();
  const state = {
    updates: [resourceUpdate(0)],
    sessionState: 'active' as 'active' | 'archived' | 'missing',
    writeCount: 0,
    stopCount: 0,
    terminateCount: 0,
    drainCount: 0,
    listReadCount: 0,
    pointReadCount: 0,
    stateReadFailure: undefined as Error | undefined,
    activeResidencies: 0,
    lastBackgroundInput: undefined as ShellRunBashInput | undefined,
    foregroundRun: undefined as
      | HostRuntimeResourceCoordinatorInput['manager']['runForegroundBash']
      | undefined,
  };
  const manager: HostRuntimeResourceCoordinatorInput['manager'] = {
    runForegroundBash: (input) =>
      state.foregroundRun?.(input) ?? Promise.resolve(foregroundResult()),
    runBackgroundBash: async (input) => {
      state.lastBackgroundInput = input;
      backgroundCompletion = input.onCompletion;
      if (input.pty) {
        const { output: _output, ...snapshot } = currentSnapshot;
        return snapshot;
      }
      return compactState(0);
    },
    readRuntimeResource: async () => currentSnapshot,
    stopBackgroundTask: async () => {
      state.stopCount += 1;
      return {
        ...currentSnapshot,
        status: 'cancelled',
        exitCode: 130,
        completedAt: 2,
        updatedAt: 2,
        revision: 2,
        operation: { kind: 'stop', applied: state.stopCount === 1 },
      };
    },
    writeStdin: async (input: ShellRunWriteInput) => {
      state.writeCount += 1;
      if (input.size) {
        currentSnapshot = {
          ...currentSnapshot,
          output: { ...currentSnapshot.output, ...input.size },
        };
      }
      currentSnapshot = {
        ...currentSnapshot,
        updatedAt: currentSnapshot.updatedAt + 1,
        revision: currentSnapshot.revision + 1,
      };
      return {
        ...currentSnapshot,
        operation: {
          kind: 'pty_control',
          failed: false,
          ...(input.input
            ? { input: { bytes: Buffer.byteLength(input.input, 'utf8'), queued: true } }
            : {}),
          ...(input.size
            ? {
                resize: {
                  ...input.size,
                  applied: true,
                  changed: true,
                },
              }
            : {}),
        },
      };
    },
    inspectResource: async () => structuredClone(currentSnapshot),
    getLivePtySnapshot: (sessionId, ref) => ({
      sessionId,
      ref,
      sequence: 0,
      buffer: '',
      size: { cols: currentSnapshot.output.cols, rows: currentSnapshot.output.rows },
    }),
    terminateAll: async () => {
      state.terminateCount += 1;
    },
  };
  const sessionAdmission = new SessionAdmissionGate();
  const coordinator = new HostRuntimeResourceCoordinator({
    manager,
    sessions: {
      listShellRunUpdates: async () => {
        state.listReadCount += 1;
        if (state.stateReadFailure) throw state.stateReadFailure;
        return structuredClone(state.updates);
      },
      getShellRunUpdate: async (_sessionId, ref) => {
        state.pointReadCount += 1;
        if (state.stateReadFailure) throw state.stateReadFailure;
        return structuredClone(state.updates.find((update) => update.result.ref === ref) ?? null);
      },
    },
    sessionHeaders: {
      readHeader: async (sessionId) => {
        if (state.sessionState === 'missing') throw new SessionNotFoundError(sessionId);
        return {
          cwd: '/workspace',
          status: state.sessionState === 'archived' ? 'archived' : 'idle',
          isArchived: state.sessionState === 'archived',
        };
      },
    },
    sessionAdmission,
    acquireResidency: () => {
      state.activeResidencies += 1;
      let active = true;
      return {
        release: () => {
          if (!active) return;
          active = false;
          state.activeResidencies -= 1;
        },
      };
    },
    requestDrain: () => {
      state.drainCount += 1;
    },
  });
  return Object.assign(state, {
    coordinator,
    sessionAdmission,
    finishBackground: (outcome: { successful: boolean }) => backgroundCompletion?.(outcome),
  });
}

function foregroundResult() {
  return {
    kind: 'terminal' as const,
    cwd: '/workspace',
    cmd: 'true',
    status: 'completed' as const,
    exitCode: 0,
    output: pipeOutput(''),
  };
}

function connection(connectionId: string): ConnectionContext {
  return {
    hostEpoch: 'host-1',
    connectionId,
    surface: 'tui',
    principal: 'local_os_user',
    acquireResidency: () => ({ release: () => {} }),
  };
}

function backgroundInput(onCompletion?: ShellRunBashInput['onCompletion']): ShellRunBashInput {
  return {
    sessionId: SESSION_ID,
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/workspace',
    command: 'sleep 60',
    emitOutput: () => {},
    ...(onCompletion ? { onCompletion } : {}),
  };
}

function resourceUpdate(index: number, overrides: Partial<ShellRunUpdate> = {}): ShellRunUpdate {
  return {
    sessionId: SESSION_ID,
    ownership: { kind: 'local' },
    sourceTurnId: `turn-${index}`,
    sourceToolCallId: `tool-${index}`,
    result: pipeSnapshot(index),
    ...overrides,
  };
}

function compactState(index: number): ShellRunStateResult {
  const { output: _output, ...state } = pipeSnapshot(index);
  return state;
}

function pipeSnapshot(index: number, stdout = ''): ShellRunSnapshotResult {
  return {
    kind: 'shell_run',
    ref: shellRef(index),
    mode: 'pipes',
    status: 'running',
    cwd: '/workspace',
    cmd: 'sleep 60',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: pipeOutput(stdout),
  };
}

function ptySnapshot(): Extract<ShellRunSnapshotResult, { mode: 'pty' }> {
  return {
    kind: 'shell_run',
    ref: RUNTIME_REF,
    mode: 'pty',
    status: 'running',
    cwd: '/workspace',
    cmd: 'sh',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pty',
      screen: '$ ',
      scrollback: '',
      cols: 80,
      rows: 24,
      cursor: { x: 2, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
  };
}

function pipeOutput(stdout: string): Extract<ShellRunSnapshotResult['output'], { mode: 'pipes' }> {
  return {
    mode: 'pipes',
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}

function shellRef(index: number): string {
  return `maka://runtime/background-tasks/shell-${index}`;
}
