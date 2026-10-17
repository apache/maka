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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { UserMessageInput } from '@maka/core/runtime-inputs';
import type { SessionSummary } from '@maka/core/session';
import { parseMakaRunArgs, runMakaTextCliCore, type MakaRunAdapter } from '../run-command-core.js';
import type { CreateSessionRequest } from '../session-driver.js';

const fixturePath = fileURLToPath(new URL('./run-command-fixture.js', import.meta.url));

describe('maka run argument parsing', () => {
  test('recognizes stdin prompt mode and rejects malformed limits', () => {
    assert.deepEqual(parseMakaRunArgs(['-']), {
      kind: 'run',
      options: { stdinPrompt: true },
    });
    assert.equal(parseMakaRunArgs(['x', '--timeout', '0']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--max-steps', '1.5']).kind, 'error');
  });

  test('parses session controls while preserving the legacy resume selector', () => {
    const parsed = parseMakaRunArgs(['--session', 'session-1', '--resume', '--wait', '--json']);
    assert.equal(parsed.kind, 'run');
    if (parsed.kind !== 'run') return;
    assert.equal(parsed.options.sessionId, 'session-1');
    assert.equal(parsed.options.resumeExecution, true);
    assert.equal(parsed.options.resumeId, undefined);
    assert.deepEqual(parseMakaRunArgs(['--session', 'session-1', '--answer', '["Yes",null]']), {
      kind: 'run',
      options: { stdinPrompt: false, sessionId: 'session-1', answers: ['Yes', null] },
    });
    for (const [flag, decision] of [
      ['--approve', 'allow'],
      ['--deny', 'deny'],
    ] as const) {
      const parsedDecision = parseMakaRunArgs(['--session', 's', flag, '--wait', '--json']);
      assert.equal(parsedDecision.kind, 'run');
      if (parsedDecision.kind === 'run')
        assert.equal(parsedDecision.options.sandboxDecision, decision);
    }
    for (const args of [
      ['--status'],
      ['--stop'],
      ['--approve'],
      ['--deny'],
      ['--session', 's', '--approve', '--deny'],
      ['--session', 's', '--approve', '--answer', '["Yes"]'],
      ['--session', 's', '--approve', '--yolo'],
      ['--session', 's', '--deny', '--yolo'],
      ['--session', 's', '--approve', 'prompt'],
      ['--session', 's', '--stop', '--wait'],
      ['--session', 's', '--stop', '--no-wait'],
      ['--session', 's', '--stop', '--answer', '["Yes"]'],
      ['--session', 's', '--answer', 'yes'],
      ['--session', 's', '--answer', '[1]'],
      ['--session', 's', '--status', '--result'],
      ['--session', 's', 'x', '--queue', '--steer'],
      ['x', '--wait', '--no-wait'],
      ['--session', 's', '--queue'],
      ['--session', 's', '--resume', 'extra'],
      ['x', '--graph', '--no-wait'],
    ])
      assert.equal(parseMakaRunArgs(args).kind, 'error', args.join(' '));
  });

  test('session queries bypass prompt/stdin and model execution preparation', async () => {
    const stdout: string[] = [];
    const exit = await runMakaTextCliCore(
      ['--session', 's', '--status'],
      {
        listSessions: async () => {
          throw new Error('must not list model-compatible Sessions');
        },
        createContext: async () => {
          throw new Error('provider is out of quota');
        },
        runSession: async (options) => ({ sessionId: options.sessionId!, status: 'running' }),
      },
      {
        stdinIsTTY: () => false,
        readStdin: async () => {
          throw new Error('must not read stdin');
        },
        writeStdout: (text) => stdout.push(text),
      },
    );
    assert.equal(exit, 0);
    assert.deepEqual(JSON.parse(stdout.join('')), { sessionId: 's', status: 'running' });
  });

  test('successful status and stop operations do not inherit the child failure exit code', async () => {
    for (const [flags, expected] of [
      [[], 0],
      [['--status'], 0],
      [['--stop'], 0],
      [['--result'], 1],
      [['--wait'], 1],
      [['--approve'], 1],
      [['--deny'], 1],
    ] as const) {
      const exit = await runMakaTextCliCore(
        ['--session', 's', ...flags],
        {
          createContext: async () => {
            throw new Error('must not prepare execution');
          },
          listSessions: async () => [],
          runSession: async () => ({ sessionId: 's', status: 'failed' }),
        },
        {
          stdinIsTTY: () => false,
          readStdin: async () => {
            throw new Error('must not read stdin');
          },
          writeStdout: () => {},
          writeStderr: () => {},
        },
      );
      assert.equal(exit, expected, flags.join(' '));
    }
  });

  test('accepts only the explicit non-interactive sandbox bypass flag', () => {
    assert.deepEqual(parseMakaRunArgs(['run tools', '--yolo']), {
      kind: 'run',
      options: {
        prompt: 'run tools',
        stdinPrompt: false,
        yolo: true,
      },
    });
  });

  test('parses resume and continue session selectors and rejects combining them', () => {
    assert.deepEqual(parseMakaRunArgs(['next', '--resume', 'session-1']), {
      kind: 'run',
      options: { prompt: 'next', stdinPrompt: false, resumeId: 'session-1' },
    });
    assert.deepEqual(parseMakaRunArgs(['next', '--continue']), {
      kind: 'run',
      options: { prompt: 'next', stdinPrompt: false, continueLatest: true },
    });
    assert.equal(parseMakaRunArgs(['next', '--resume', 'session-1', '--continue']).kind, 'error');
  });

  test('accepts a remote Host Project and rejects client cwd semantics', () => {
    assert.deepEqual(parseMakaRunArgs(['next', '--host', 'office', '--project', 'project-1']), {
      kind: 'run',
      options: {
        prompt: 'next',
        stdinPrompt: false,
        hostProfileId: 'office',
        projectId: 'project-1',
      },
    });
    assert.equal(parseMakaRunArgs(['next', '--host', 'office', '--continue']).kind, 'error');
    assert.equal(
      parseMakaRunArgs(['next', '--host', 'office', '--cwd', '/client/path']).kind,
      'error',
    );
  });

  test('forwards --max-steps and an explicit provider default to local and Graph runs', async () => {
    for (const graph of [false, true]) {
      const messages: UserMessageInput[] = [];
      const sessions: CreateSessionRequest[] = [];
      const adapter: MakaRunAdapter = {
        listSessions: async () => [],
        createContext: async (input) => ({
          runtime: {
            createSession: async (request) => {
              sessions.push(request);
              return sessionSummary();
            },
            readExecutionBoundary: async () => ({
              kind: 'managed',
              access: 'writable',
              revision: 0,
            }),
            sendMessage: async function* (_sessionId, message) {
              messages.push(message);
              await input.runOutcomeObserver?.({
                outcomeId: message.turnId,
                status: 'completed',
                finalOutput: 'done',
                sandboxBoundary: 'none',
              });
            },
            respondToSandboxBoundary: async () => {},
            stopSession: async () => {},
            setExecutionBoundaryKind: async () => {},
          },
          target: { connection: { slug: 'test' }, model: 'test' },
          agentGraph: {
            reserveActivity: () => ({ release: () => {} }),
            waitForCompletion: async () => {},
          },
          close: async () => {},
        }),
      };

      const exitCode = await runMakaTextCliCore(
        ['answer once', '--max-steps', '2', '--thinking', 'default', ...(graph ? ['--graph'] : [])],
        adapter,
        {
          workspaceRoot: () => process.cwd(),
          processCwd: () => process.cwd(),
          stdinIsTTY: () => true,
          writeStdout: () => {},
          writeStderr: () => {},
          onSigint: () => () => {},
          newId: () => 'turn-1',
        },
      );

      assert.equal(exitCode, 0);
      assert.equal(messages.length, 1);
      assert.equal(messages[0]?.maxSteps, 2);
      assert.equal(sessions[0]?.thinkingLevel, null);
    }
  });
});

// The contracts below live at the process boundary — a real pipe, a real
// signal, a real exit code — which the injected MakaRunDeps seam cannot
// express. Everything else about `maka run` is covered in process above.
describe('maka run process contract', () => {
  test('uses stdin as the complete prompt for run -', async () => {
    const result = await runFixture(['-'], { input: 'from stdin\nsecond line' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=from stdin\nsecond line\n');
  });

  test('uses non-TTY stdin as the prompt when no positional prompt is provided', async () => {
    const result = await runFixture([], { input: 'implicit stdin prompt' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=implicit stdin prompt\n');
  });

  test('combines a positional instruction with piped stdin context', async () => {
    const result = await runFixture(['summarize'], { input: 'document body' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=summarize\n\ndocument body\n');
  });

  test('fails closed when a sandbox boundary request reaches non-interactive run', async () => {
    const result = await runFixture(['hello'], { scenario: 'sandbox-boundary' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /sandbox boundary expansion is unavailable/);
    assert.doesNotMatch(result.stderr, /not denied/);
    assert.equal(result.stdout, '');
  });

  test('returns exit 130 on SIGINT', async () => {
    const result = await interruptFixture(['hello'], 'slow');
    assert.equal(result.signal, null);
    assert.equal(result.code, 130, result.stderr);
    assert.equal(result.stdout, '');
  });

  test('returns exit 130 when SIGINT interrupts Graph completion wait', async () => {
    const result = await interruptFixture(['implement it', '--graph'], 'graph-wait');
    assert.equal(result.signal, null);
    assert.equal(result.code, 130, result.stderr);
    assert.equal(result.stdout, '');
  });
});

function runFixture(
  args: string[],
  options: { scenario?: string; input?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixturePath, ...args], {
      // The scenario is always set explicitly so an ambient variable from the
      // developer's shell can never repoint a test at another scenario.
      env: { ...process.env, MAKA_RUN_FIXTURE_SCENARIO: options.scenario ?? 'echo' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    // A child that never exits must fail the suite, not hang it.
    const guard = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`fixture did not exit\n${stderr}`));
    }, 15_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });
}

async function interruptFixture(
  args: string[],
  scenario: string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [fixturePath, ...args], {
    env: { ...process.env, MAKA_RUN_FIXTURE_SCENARIO: scenario },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  const ready = new Promise<void>((resolve) => {
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.includes('fixture-ready')) resolve();
    });
  });
  // A fixture that never reports ready must fail the suite, not hang it.
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    ready,
    new Promise<never>((_resolve, reject) => {
      readyTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`fixture never became ready\n${stderr}`));
      }, 10_000);
    }),
  ]);
  if (readyTimer !== undefined) clearTimeout(readyTimer);
  child.kill('SIGINT');

  // A regression that ignores the interrupt would otherwise hang the suite:
  // give the child a bounded window, then force it down and let the signal
  // assertion report the failure.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const result = await Promise.race([
    exited.then(([code, signal]) => ({ code, signal })),
    new Promise<{ code: null; signal: 'SIGKILL' }>((resolve) => {
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, signal: 'SIGKILL' });
      }, 2_000);
    }),
  ]);
  if (killTimer !== undefined) clearTimeout(killTimer);
  return { ...result, stdout, stderr };
}

function sessionSummary(): SessionSummary {
  return {
    id: 'session-1',
    cwd: process.cwd(),
    name: 'Run once',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
  };
}
