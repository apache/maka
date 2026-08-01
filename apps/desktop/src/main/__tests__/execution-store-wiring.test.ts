import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentRunEvent, AgentRunHeader, ShellRunRecord } from '@maka/core';
import { createAgentRunStore, createShellRunStore } from '@maka/storage';
import { openDesktopExecutionStoreWiring } from '../execution-store-wiring.js';

test('Desktop cuts legacy execution state over before use and keeps later writes SQLite-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-desktop-execution-stores-'));
  try {
    const legacyRuns = createAgentRunStore(root);
    const firstRun = runHeader('run-1', 'turn-1');
    await legacyRuns.createRun(firstRun);
    await legacyRuns.appendEvent('session-1', 'run-1', runEvent('event-1', 'run-1', 'turn-1', 1));
    const legacyRunEventsPath = join(
      root,
      'sessions',
      'session-1',
      'runs',
      'run-1',
      'events.jsonl',
    );
    const legacyRunBytes = await readFile(legacyRunEventsPath);

    const legacyShellRuns = createShellRunStore(root);
    await legacyShellRuns.createShellRun(shellRun('shell-1'));
    const legacyShellPath = join(
      root,
      'sessions',
      'session-1',
      'shell-runs',
      'shell-1',
      'shell-run.json',
    );
    const legacyShellBytes = await readFile(legacyShellPath);

    const wiring = await openDesktopExecutionStoreWiring(root);
    assert.equal((await wiring.runStore.readRun('session-1', 'run-1')).runId, 'run-1');
    assert.equal(
      (await wiring.shellRunStore.readShellRun('session-1', 'shell-1')).shellRunId,
      'shell-1',
    );

    await wiring.runStore.appendEvent(
      'session-1',
      'run-1',
      runEvent('event-2', 'run-1', 'turn-1', 2),
    );
    await wiring.runStore.createRun(runHeader('run-2', 'turn-2'));
    await wiring.shellRunStore.updateShellRun('session-1', 'shell-1', {
      status: 'completed',
      completedAt: 2,
      exitCode: 0,
      updatedAt: 2,
    });
    await wiring.shellRunStore.createShellRun(shellRun('shell-2'));

    assert.deepEqual(await readFile(legacyRunEventsPath), legacyRunBytes);
    assert.deepEqual(await readFile(legacyShellPath), legacyShellBytes);
    await assert.rejects(
      () => stat(join(root, 'sessions', 'session-1', 'runs', 'run-2', 'run.json')),
      { code: 'ENOENT' },
    );
    await assert.rejects(
      () =>
        stat(
          join(root, 'sessions', 'session-1', 'shell-runs', 'shell-2', 'shell-run.json'),
        ),
      { code: 'ENOENT' },
    );
    wiring.close();
    wiring.close();

    const reopened = await openDesktopExecutionStoreWiring(root);
    try {
      assert.deepEqual(
        (await reopened.runStore.readEvents('session-1', 'run-1')).map((event) => event.id),
        ['event-1', 'event-2'],
      );
      assert.equal((await reopened.runStore.readRun('session-1', 'run-2')).turnId, 'turn-2');
      assert.equal(
        (await reopened.shellRunStore.readShellRun('session-1', 'shell-1')).status,
        'completed',
      );
      assert.equal(
        (await reopened.shellRunStore.readShellRun('session-1', 'shell-2')).status,
        'running',
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runHeader(runId: string, turnId: string): AgentRunHeader {
  return {
    runId,
    sessionId: 'session-1',
    turnId,
    status: 'created',
    backendKind: 'fake',
    llmConnectionSlug: 'fake',
    modelId: 'fake-model',
    cwd: '/tmp/cwd',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 1,
  };
}

function runEvent(
  id: string,
  runId: string,
  turnId: string,
  ts: number,
): AgentRunEvent {
  return {
    type: 'run_started',
    id,
    runId,
    sessionId: 'session-1',
    turnId,
    ts,
  };
}

function shellRun(shellRunId: string): ShellRunRecord {
  return {
    shellRunId,
    sessionId: 'session-1',
    sourceRunId: 'run-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: `tool-${shellRunId}`,
    cwd: '/workspace',
    command: 'printf "ok"',
    status: 'running',
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}
