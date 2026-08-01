import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import type { SessionSummary } from '@maka/core/session';
import { parseMakaRunArgs } from '../run-command.js';

const fixturePath = fileURLToPath(new URL('./run-command-fixture.js', import.meta.url));

describe('maka run argument parsing', () => {
  test('parses prompt, target, thinking, timeout, and max steps', () => {
    assert.deepEqual(
      parseMakaRunArgs([
        'explain this',
        '--cwd',
        '/repo',
        '--connection',
        'local',
        '--model',
        'model-1',
        '--thinking',
        'high',
        '--timeout',
        '1.5',
        '--max-steps',
        '7',
      ]),
      {
        kind: 'run',
        options: {
          prompt: 'explain this',
          stdinPrompt: false,
          cwd: '/repo',
          connection: 'local',
          model: 'model-1',
          thinking: 'high',
          timeoutMs: 1500,
          maxSteps: 7,
        },
      },
    );
  });

  test('recognizes stdin prompt mode and rejects malformed limits', () => {
    assert.deepEqual(parseMakaRunArgs(['-']), {
      kind: 'run',
      options: { stdinPrompt: true },
    });
    assert.equal(parseMakaRunArgs(['x', '--timeout', '0']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--max-steps', '1.5']).kind, 'error');
  });

  test('parses Graph Mode as an explicit non-interactive turn', () => {
    assert.deepEqual(parseMakaRunArgs(['implement the graph', '--graph']), {
      kind: 'run',
      options: {
        prompt: 'implement the graph',
        stdinPrompt: false,
        graph: true,
      },
    });
    assert.equal(parseMakaRunArgs(['x', '--graph', '--graph']).kind, 'error');
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

  test('rejects removed permission modes and rule flags', () => {
    assert.equal(parseMakaRunArgs(['x', '--permission-mode', 'ask']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--allow', 'tool:Read']).kind, 'error');
    assert.equal(parseMakaRunArgs(['x', '--deny', 'Bash(npm test)']).kind, 'error');
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

  test('preserves an explicit default thinking constraint for resumed sessions', () => {
    assert.deepEqual(parseMakaRunArgs(['next', '--resume', 'session-1', '--thinking', 'default']), {
      kind: 'run',
      options: {
        prompt: 'next',
        stdinPrompt: false,
        resumeId: 'session-1',
        thinkingDefaultExplicit: true,
      },
    });
  });
});

describe('maka run process contract', () => {
  test('writes only the final answer to stdout', async () => {
    const result = await runFixture(['hello'], { input: '' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=hello\n');
    assert.equal(result.stderr, '');
  });

  test('waits for the complete Graph before printing the final supervisor output', async () => {
    const result = await runFixture(['implement it', '--graph'], {
      input: '',
      env: { MAKA_RUN_EXPECT_GRAPH: '1' },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'graph completed\n');
    assert.equal(result.stderr, '');
  });

  test('does not wait for Graph completion after the root invocation fails', async () => {
    const result = await runFixture(['implement it', '--graph'], {
      scenario: 'graph-runtime-error',
      input: '',
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /provider failed before graph creation/);
    assert.doesNotMatch(result.stderr, /graph-wait-called/);
  });

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

  test('returns exit 2 for missing input and pre-invocation configuration errors', async () => {
    const missing = await runFixture([], { input: '' });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /missing prompt input/);

    const config = await runFixture(['hello'], { scenario: 'config-error', input: '' });
    assert.equal(config.code, 2);
    assert.match(config.stderr, /unknown connection/);
  });

  test('returns exit 1 for runtime failure and missing final output', async () => {
    const runtime = await runFixture(['hello'], { scenario: 'runtime-error', input: '' });
    assert.equal(runtime.code, 1);
    assert.match(runtime.stderr, /provider failed after startup/);

    const missing = await runFixture(['hello'], { scenario: 'missing-output', input: '' });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /no final output/);
  });

  test('returns exit 1 without successful output when the explicit step limit is reached', async () => {
    const result = await runFixture(['hello'], { scenario: 'step-limit', input: '' });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /tool-step limit reached/);
  });

  test('fails closed when a sandbox boundary request reaches non-interactive run', async () => {
    const result = await runFixture(['hello'], { scenario: 'sandbox-boundary', input: '' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /sandbox boundary expansion is unavailable/);
    assert.equal(result.stdout, '');
  });

  test('fails closed when a tool reports an unresolved sandbox boundary requirement', async () => {
    const result = await runFixture(['hello'], {
      scenario: 'sandbox-boundary-tool-result',
      input: '',
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /sandbox boundary expansion is unavailable/);
    assert.equal(result.stdout, '');
  });

  test('accepts a completed boundary-safe alternative', async () => {
    const result = await runFixture(['hello'], {
      scenario: 'sandbox-boundary-recovered',
      input: '',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'recovered safely\n');
  });

  test('creates an Auto boundary by default', async () => {
    const result = await runFixture(['hello'], {
      input: '',
      env: { MAKA_RUN_EXPECT_PERMISSION_MODE: 'ask' },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=hello\n');
  });

  test('passes max steps as an invocation-local context limit', async () => {
    const result = await runFixture(['hello', '--max-steps', '3'], {
      input: '',
      env: { MAKA_RUN_EXPECT_MAX_STEPS: '3' },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^maxSteps=3;/);
  });

  test('creates a bypass boundary only when --yolo is explicit', async () => {
    const result = await runFixture(['hello', '--yolo'], {
      input: '',
      env: { MAKA_RUN_EXPECT_PERMISSION_MODE: 'bypass' },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=hello\n');
  });

  test('returns exit 2 for removed permission flags before runtime startup', async () => {
    const result = await runFixture(['hello', '--permission-mode', 'ask'], { input: '' });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /unknown option: --permission-mode/);
    assert.equal(result.stdout, '');
  });

  test('resumes an explicit session without creating a new identity', async () => {
    const cwd = await realpath(process.cwd());
    const resumed = fixtureSession({
      id: 'resume-me',
      cwd,
      llmConnectionSlug: 'fixture',
      model: 'fixture-model',
      permissionMode: 'execute',
    });
    const result = await runFixture(
      [
        'continue this',
        '--resume',
        resumed.id,
        '--connection',
        resumed.llmConnectionSlug,
        '--model',
        resumed.model,
      ],
      {
        input: '',
        env: {
          MAKA_RUN_FIXTURE_SESSIONS: JSON.stringify([resumed]),
          MAKA_RUN_EXPECT_NO_CREATE: '1',
          MAKA_RUN_EXPECT_SESSION_ID: resumed.id,
          MAKA_RUN_EXPECT_CONTEXT_CWD: cwd,
          MAKA_RUN_EXPECT_CONTEXT_CONNECTION: resumed.llmConnectionSlug,
          MAKA_RUN_EXPECT_CONTEXT_MODEL: resumed.model,
          MAKA_RUN_EXPECT_CWD_OVERRIDE: JSON.stringify({ sessionId: resumed.id, cwd }),
        },
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=continue this\n');
  });

  test('names the mode the same way the desktop and TUI do (#1616)', async () => {
    const help = await runFixture(['--help'], { input: '' });

    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /--yolo\s+Give this session full access to your files and network/);
    assert.doesNotMatch(help.stdout, /sandbox/i);
    assert.doesNotMatch(help.stdout, /bypass/i);
  });

  test('fails closed when resuming a bypass session without --yolo', async () => {
    const cwd = await realpath(process.cwd());
    const resumed = fixtureSession({
      id: 'resume-bypass',
      cwd,
      permissionMode: 'bypass',
    });
    const result = await runFixture(['continue this', '--resume', resumed.id], {
      input: '',
      env: {
        MAKA_RUN_FIXTURE_SESSIONS: JSON.stringify([resumed]),
        MAKA_RUN_BOUNDARY_KIND: 'bypass',
        MAKA_RUN_EXPECT_NO_SEND: '1',
      },
    });

    assert.equal(result.code, 2);
    // The session id in this fixture is literally `resume-bypass`, so only the
    // sentence itself is checked for the old name.
    assert.match(result.stderr, /resuming a full-access session .* requires --yolo/i);
    assert.doesNotMatch(result.stderr, /Bypass session/i);
    assert.equal(result.stdout, '');
  });

  test('resumes in Bypass only when --yolo is explicit', async () => {
    const cwd = await realpath(process.cwd());
    const resumed = fixtureSession({
      id: 'resume-bypass',
      cwd,
      permissionMode: 'bypass',
    });
    const result = await runFixture(['continue this', '--resume', resumed.id, '--yolo'], {
      input: '',
      env: {
        MAKA_RUN_FIXTURE_SESSIONS: JSON.stringify([resumed]),
        MAKA_RUN_BOUNDARY_KIND: 'bypass',
        MAKA_RUN_EXPECT_BOUNDARY_KIND: 'bypass',
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=continue this\n');
  });

  test('returns exit 2 when explicit configuration conflicts with a resumed session', async () => {
    const resumed = fixtureSession({ id: 'resume-me', cwd: process.cwd() });
    const result = await runFixture(
      ['continue this', '--resume', resumed.id, '--model', 'different-model'],
      {
        input: '',
        env: { MAKA_RUN_FIXTURE_SESSIONS: JSON.stringify([resumed]) },
      },
    );

    assert.equal(result.code, 2);
    assert.match(result.stderr, /--model conflicts with resumed session/);
    assert.equal(result.stdout, '');
  });

  test('continues the deterministic latest cwd-compatible session', async () => {
    const cwd = await realpath(process.cwd());
    const sessions = [
      fixtureSession({ id: 'b', cwd, lastMessageAt: 200 }),
      fixtureSession({ id: 'a', cwd, lastMessageAt: 200, status: 'aborted' }),
      fixtureSession({ id: 'newer-other-cwd', cwd: '/missing-other', lastMessageAt: 300 }),
    ];
    const result = await runFixture(['continue this', '--continue'], {
      input: '',
      env: {
        MAKA_RUN_FIXTURE_SESSIONS: JSON.stringify(sessions),
        MAKA_RUN_EXPECT_NO_CREATE: '1',
        MAKA_RUN_EXPECT_SESSION_ID: 'a',
        MAKA_RUN_EXPECT_CONTEXT_CWD: cwd,
        MAKA_RUN_EXPECT_CONTEXT_CONNECTION: 'fixture',
        MAKA_RUN_EXPECT_CONTEXT_MODEL: 'fixture-model',
        MAKA_RUN_EXPECT_CWD_OVERRIDE: JSON.stringify({ sessionId: 'a', cwd }),
      },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'prompt=continue this\n');
  });

  test('returns exit 2 when continue finds no compatible session', async () => {
    const result = await runFixture(['continue this', '--continue'], {
      input: '',
      env: { MAKA_RUN_FIXTURE_SESSIONS: '[]' },
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /no compatible session found for cwd/);
    assert.equal(result.stdout, '');
  });

  test('returns exit 1 when the invocation timeout stops the run', async () => {
    const result = await runFixture(['hello', '--timeout', '0.05'], {
      scenario: 'slow',
      input: '',
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /timed out after 50ms/);
  });

  test('returns exit 1 when a graph descendant leaves a boundary failure unresolved', async () => {
    const result = await runFixture(['graph task', '--graph'], {
      input: '',
      env: {
        MAKA_RUN_EXPECT_GRAPH: '1',
        MAKA_RUN_GRAPH_BOUNDARY_FAILURE: '1',
      },
    });

    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stdout, '');
  });

  test('returns exit 130 on SIGINT', async () => {
    const child = spawn(process.execPath, [fixturePath, 'hello'], {
      env: { ...process.env, MAKA_RUN_FIXTURE_SCENARIO: 'slow' },
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
    await ready;
    child.kill('SIGINT');

    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, null);
    assert.equal(code, 130, stderr);
    assert.equal(stdout, '');
  });

  test('returns exit 130 when SIGINT interrupts Graph completion wait', async () => {
    const child = spawn(process.execPath, [fixturePath, 'implement it', '--graph'], {
      env: { ...process.env, MAKA_RUN_FIXTURE_SCENARIO: 'graph-wait' },
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
    await ready;
    child.kill('SIGINT');

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    const result = await Promise.race([
      exited.then(([code, signal]) => ({ code, signal })),
      new Promise<{ code: null; signal: 'SIGKILL' }>((resolve) => {
        killTimer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({ code: null, signal: 'SIGKILL' });
        }, 500);
      }),
    ]);
    if (killTimer !== undefined) clearTimeout(killTimer);

    assert.equal(result.signal, null);
    assert.equal(result.code, 130, stderr);
    assert.equal(stdout, '');
  });
});

function runFixture(
  args: string[],
  options: {
    scenario?: string;
    input?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixturePath, ...args], {
      env: {
        ...process.env,
        ...(options.scenario ? { MAKA_RUN_FIXTURE_SCENARIO: options.scenario } : {}),
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? '');
  });
}

function fixtureSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'fixture-existing',
    cwd: process.cwd(),
    name: 'Fixture existing',
    isFlagged: false,
    isArchived: false,
    labels: [],
    hasUnread: false,
    lastMessageAt: 100,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionSlug: 'fixture',
    connectionLocked: false,
    model: 'fixture-model',
    permissionMode: 'explore',
    ...overrides,
  };
}
