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

  test('rejects unsupported Session overrides before connecting while preserving legacy selectors', () => {
    for (const setting of [['--cwd', '/tmp'], ['--timeout', '10'], ['--graph']]) {
      assert.equal(parseMakaRunArgs(['--session', 's', 'check', ...setting]).kind, 'error');
      assert.equal(parseMakaRunArgs(['check', '--resume', 's', ...setting]).kind, 'run');
    }
    assert.equal(parseMakaRunArgs(['--session', 's', 'check', '--max-steps', '2']).kind, 'run');
    for (const extra of [
      [],
      ['--status'],
      ['--resume'],
      ['--queue', 'check'],
      ['--steer', 'check'],
    ])
      assert.equal(
        parseMakaRunArgs(['--session', 's', '--max-steps', '2', ...extra]).kind,
        'error',
        extra.join(' '),
      );
  });

  test('Session model settings persist independently of explicit resume or a new prompt', () => {
    for (const settings of [
      ['--model', 'other-model'],
      ['--connection', 'other-account', '--model', 'other-model'],
      ['--thinking', 'high'],
    ]) {
      const change = parseMakaRunArgs(['--session', 's', ...settings]);
      assert.equal(change.kind, 'run');
      if (change.kind !== 'run') return;
      assert.equal(change.options.resumeExecution, undefined);
      assert.equal(change.options.prompt, undefined);
      const resume = parseMakaRunArgs(['--session', 's', ...settings, '--resume']);
      assert.equal(resume.kind, 'run');
      if (resume.kind === 'run') assert.equal(resume.options.resumeExecution, true);
      const prompt = parseMakaRunArgs(['--session', 's', ...settings, 'continue']);
      assert.equal(prompt.kind, 'run');
      if (prompt.kind === 'run') {
        assert.equal(prompt.options.prompt, 'continue');
        assert.equal(prompt.options.resumeExecution, undefined);
      }
    }
  });

  test('invalid Session options return a short usage error without opening the Host or reading stdin', async () => {
    for (const args of [
      ['--session', 's', '--status', '--cwd', '/tmp'],
      ['--session', 's', '--wait', '--max-steps', '2'],
      ['--unknown'],
    ]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exit = await runMakaTextCliCore(
        args,
        {
          createContext: async () => assert.fail('must not prepare execution'),
          listSessions: async () => assert.fail('must not select a Session'),
          runSession: async () => assert.fail('must not connect to Host'),
        },
        {
          cliCommand: () => 'npm run cli:dev --',
          stdinIsTTY: () => false,
          readStdin: async () => assert.fail('must not read stdin'),
          writeStdout: (text) => stdout.push(text),
          writeStderr: (text) => stderr.push(text),
        },
      );
      assert.equal(exit, 2);
      assert.deepEqual(stdout, []);
      assert.equal(stderr.join('').trim().split('\n').length, 2);
      assert.match(stderr.join(''), /npm run cli:dev -- run --help/);
      assert.doesNotMatch(stderr.join(''), /Usage:/);
    }
  });

  test('recap selects one Session action and rejects execution and wait combinations', () => {
    assert.deepEqual(parseMakaRunArgs(['--session', 's', '--recap', '--json']), {
      kind: 'run',
      options: { sessionId: 's', recap: true, json: true, stdinPrompt: false },
    });
    assert.equal(parseMakaRunArgs(['--recap']).kind, 'error');
    for (const extra of [
      ['prompt'],
      ['-'],
      ['--result'],
      ['--stop'],
      ['--resume'],
      ['--approve'],
      ['--deny'],
      ['--answer', '["Yes"]'],
      ['--steer', 'prompt'],
      ['--queue', 'prompt'],
      ['--wait'],
      ['--no-wait'],
    ])
      assert.equal(
        parseMakaRunArgs(['--session', 's', '--recap', ...extra]).kind,
        'error',
        extra.join(' '),
      );
  });

  test('accepts equivalent repeated flags and combines status with recap without discarding either', () => {
    assert.deepEqual(
      parseMakaRunArgs([
        '--session',
        's',
        '--session',
        's',
        '--status',
        '--recap',
        '--json',
        '--json',
      ]),
      {
        kind: 'run',
        options: { sessionId: 's', status: true, recap: true, json: true, stdinPrompt: false },
      },
    );
    assert.deepEqual(
      parseMakaRunArgs(['check', '--no-wait', '--no-wait', '--model', 'm', '--model', 'm']),
      {
        kind: 'run',
        options: { prompt: 'check', noWait: true, model: 'm', stdinPrompt: false },
      },
    );
    for (const extra of [['--answer', '["Yes"]'], ['--result'], ['--stop']])
      assert.equal(
        parseMakaRunArgs(['--session', 's', '--status', '--recap', ...extra]).kind,
        'error',
      );
    assert.equal(parseMakaRunArgs(['--session', 's', '--session', 'other']).kind, 'error');
    assert.equal(parseMakaRunArgs(['check', '--model', 'm', '--model', 'other']).kind, 'error');
  });

  test('recap prints text or JSON without reading stdin or returning the Turn failure code', async () => {
    for (const json of [false, true]) {
      const stdout: string[] = [];
      const result = {
        sessionId: 's',
        status: 'failed' as const,
        recap: 'The review found a bug.',
      };
      const exit = await runMakaTextCliCore(
        ['--session', 's', '--recap', ...(json ? ['--json'] : [])],
        {
          listSessions: async () => assert.fail('must not select a Session'),
          createContext: async () => assert.fail('must not prepare execution'),
          runSession: async (options) => {
            assert.equal(options.recap, true);
            return result;
          },
        },
        {
          stdinIsTTY: () => false,
          readStdin: async () => assert.fail('recap must not read stdin'),
          writeStdout: (text) => stdout.push(text),
        },
      );
      assert.equal(exit, 0);
      assert.equal(stdout.join(''), json ? `${JSON.stringify(result)}\n` : `${result.recap}\n`);
    }
  });

  test('recap generation errors exit nonzero without printing a task result', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exit = await runMakaTextCliCore(
      ['--session', 's', '--recap', '--json'],
      {
        listSessions: async () => [],
        createContext: async () => assert.fail('must not prepare execution'),
        runSession: async () => {
          throw new Error('Session recap failed: provider');
        },
      },
      { writeStdout: (text) => stdout.push(text), writeStderr: (text) => stderr.push(text) },
    );
    assert.equal(exit, 1);
    assert.deepEqual(stdout, []);
    assert.match(stderr.join(''), /Session recap failed: provider/);
  });

  test('completed status and stop receipts remain visible without --json', async () => {
    for (const flags of [[], ['--status'], ['--stop']]) {
      const stdout: string[] = [];
      const receipt = { sessionId: 's', status: 'completed' as const, queued: 0 };
      const exit = await runMakaTextCliCore(
        ['--session', 's', ...flags],
        {
          createContext: async () => {
            throw new Error('unexpected execution');
          },
          listSessions: async () => [],
          runSession: async () => receipt,
        },
        { writeStdout: (text) => stdout.push(text) },
      );
      assert.equal(exit, 0);
      assert.deepEqual(JSON.parse(stdout.join('')), receipt);
    }
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
