import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { describe, test } from 'node:test';

import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createSqliteAgentRunStore, createWorkspaceRuntimeStore } from '@maka/storage';

import {
  RUNTIME_RESUME_FAILPOINTS,
  buildResumePlanFromRuntimeEvents,
  type RuntimeResumeCommittedPrefix,
} from '../runtime-resume.js';
import { terminateChildProcessTree } from '../process-tree-terminator.js';

const CRASH_CHILD_ENV = 'MAKA_RUNTIME_RESUME_CRASH_CHILD';
const CRASH_HARNESS_TIMEOUT_MS = process.platform === 'win32' ? 120_000 : 60_000;

if (process.env[CRASH_CHILD_ENV] === '1') {
  await runCrashChild();
} else {
  describe('runtime resume phase 0 process crash harness', () => {
    test('reopens every fully committed P0-P11 ledger prefix after SIGKILL', {
      timeout: CRASH_HARNESS_TIMEOUT_MS,
    }, async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-runtime-resume-crash-'));
      try {
        for (const failpoint of RUNTIME_RESUME_FAILPOINTS) {
          const workspaceRoot = join(root, failpoint.id);
          const sessionId = `session-${failpoint.id}`;
          const runId = `run-${failpoint.id}`;
          const markerPath = join(workspaceRoot, 'child-finally-ran');
          const allEvents = ledgerEvents(sessionId, runId);
          const committedEvents = allEvents.slice(
            0,
            committedEventCount(failpoint.committedPrefix),
          );

          // Production creates the run header before any RuntimeEvent append. Keep the
          // crash boundary focused on the child event writer while preserving the
          // storage identity contract used when the ledger is reopened.
          const runStore = createSqliteAgentRunStore(workspaceRoot);
          await runStore.createRun({
            runId,
            invocationId: `invocation-${runId}`,
            sessionId,
            turnId: `turn-${runId}`,
            status: 'running',
            backendKind: 'fake',
            llmConnectionSlug: 'fake',
            modelId: 'fake-model',
            cwd: workspaceRoot,
            permissionMode: 'ask',
            createdAt: 1,
            updatedAt: 1,
          });
          runStore.close?.();

          await crashWriterAfterCommit({
            workspaceRoot,
            sessionId,
            runId,
            markerPath,
            events: committedEvents,
          });

          assert.equal(
            await pathExists(markerPath),
            false,
            `${failpoint.id} unexpectedly ran finally`,
          );
          const reopened = createWorkspaceRuntimeStore(workspaceRoot);
          const recoveredEvents = await reopened.readRuntimeEvents(sessionId, runId);
          assert.deepEqual(
            recoveredEvents.map((event) => event.id),
            committedEvents.map((event) => event.id),
            `${failpoint.id} reopened a different committed prefix`,
          );

          const first = buildResumePlanFromRuntimeEvents(recoveredEvents);
          const second = buildResumePlanFromRuntimeEvents(recoveredEvents);
          assert.deepEqual(second, first, `${failpoint.id} projection was not deterministic`);
          assertResumePlanForPrefix(failpoint.committedPrefix, first);
          assert.deepEqual(
            await reopened.readRuntimeEvents(sessionId, runId),
            recoveredEvents,
            `${failpoint.id} projection mutated the durable ledger`,
          );
          reopened.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}

async function runCrashChild(): Promise<void> {
  const workspaceRoot = requiredEnv('MAKA_RUNTIME_RESUME_WORKSPACE');
  const sessionId = requiredEnv('MAKA_RUNTIME_RESUME_SESSION');
  const runId = requiredEnv('MAKA_RUNTIME_RESUME_RUN');
  const markerPath = requiredEnv('MAKA_RUNTIME_RESUME_FINALLY_MARKER');
  const events = JSON.parse(
    Buffer.from(requiredEnv('MAKA_RUNTIME_RESUME_EVENTS'), 'base64').toString('utf8'),
  ) as RuntimeEvent[];
  const store = createWorkspaceRuntimeStore(workspaceRoot);

  try {
    for (const event of events) {
      await store.appendRuntimeEvent(sessionId, runId, event);
    }
    process.stdout.write('READY\n');
    await new Promise<never>(() => {
      setInterval(() => {}, 1_000);
    });
  } finally {
    await writeFile(markerPath, 'finally ran\n', 'utf8');
  }
}

async function crashWriterAfterCommit(input: {
  workspaceRoot: string;
  sessionId: string;
  runId: string;
  markerPath: string;
  events: readonly RuntimeEvent[];
}): Promise<void> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    cwd: dirname(fileURLToPath(import.meta.url)),
    env: {
      ...process.env,
      [CRASH_CHILD_ENV]: '1',
      MAKA_RUNTIME_RESUME_WORKSPACE: input.workspaceRoot,
      MAKA_RUNTIME_RESUME_SESSION: input.sessionId,
      MAKA_RUNTIME_RESUME_RUN: input.runId,
      MAKA_RUNTIME_RESUME_FINALLY_MARKER: input.markerPath,
      MAKA_RUNTIME_RESUME_EVENTS: Buffer.from(JSON.stringify(input.events), 'utf8').toString(
        'base64',
      ),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const closed = once(child, 'close') as Promise<[number | null, NodeJS.Signals | null]>;
  const deadline = Date.now() + 10_000;
  while (!stdout.includes('READY\n') && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!stdout.includes('READY\n')) {
    await killCrashChild(child);
    await closed;
    throw new Error(`crash child did not reach committed boundary: ${stderr || stdout}`);
  }

  assert.equal(await killCrashChild(child), true);
  const [exitCode, signal] = await closed;
  assert.ok(
    exitCode !== 0 || signal !== null,
    'crash child exited successfully instead of being killed',
  );
}

function killCrashChild(child: ReturnType<typeof spawn>): Promise<boolean> {
  if (process.platform === 'win32') return terminateChildProcessTree(child, 'SIGKILL');
  return Promise.resolve(child.kill('SIGKILL'));
}

function ledgerEvents(sessionId: string, runId: string): RuntimeEvent[] {
  const identity = {
    sessionId,
    invocationId: `invocation-${runId}`,
    runId,
    turnId: `turn-${runId}`,
  };
  return [
    {
      ...identity,
      id: 'user',
      ts: 1,
      partial: false,
      author: 'user',
      role: 'user',
      content: { kind: 'text', text: 'run the tool' },
    },
    {
      ...identity,
      id: 'call',
      ts: 2,
      partial: false,
      author: 'agent',
      role: 'model',
      content: {
        kind: 'function_call',
        id: 'tool-1',
        name: 'Bash',
        args: { command: 'touch marker' },
      },
    },
    {
      ...identity,
      id: 'response',
      ts: 3,
      partial: false,
      author: 'tool',
      role: 'tool',
      content: { kind: 'function_response', id: 'tool-1', name: 'Bash', result: { exitCode: 0 } },
    },
    {
      ...identity,
      id: 'terminal',
      ts: 4,
      partial: false,
      author: 'system',
      role: 'system',
      status: 'failed',
      actions: { endInvocation: true },
    },
  ];
}

function committedEventCount(prefix: RuntimeResumeCommittedPrefix): number {
  switch (prefix) {
    case 'before_function_call':
      return 1;
    case 'after_function_call':
      return 2;
    case 'after_function_response':
      return 3;
    case 'after_terminal_event':
      return 4;
  }
}

function assertResumePlanForPrefix(
  prefix: RuntimeResumeCommittedPrefix,
  plan: ReturnType<typeof buildResumePlanFromRuntimeEvents>,
): void {
  if (prefix === 'after_function_call') {
    assert.equal(plan.disposition, 'blocked');
    assert.equal(plan.operations[0]?.status, 'indeterminate');
    assert.deepEqual(plan.rejectionReasons, ['dangling_tool_state']);
    assert.deepEqual(
      plan.replayRuntimeEvents.map((event) => event.id),
      ['user'],
    );
    return;
  }

  assert.equal(plan.disposition, 'safe_replay');
  assert.deepEqual(plan.rejectionReasons, []);
  if (prefix === 'before_function_call') {
    assert.deepEqual(plan.operations, []);
    assert.deepEqual(
      plan.replayRuntimeEvents.map((event) => event.id),
      ['user'],
    );
    return;
  }
  assert.equal(plan.operations[0]?.status, 'succeeded');
  assert.deepEqual(
    plan.replayRuntimeEvents.map((event) => event.id),
    prefix === 'after_terminal_event'
      ? ['user', 'call', 'response', 'terminal']
      : ['user', 'call', 'response'],
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
