import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createSessionStore } from '@maka/storage';
import {
  parseMakaCliArgs,
  formatStartupConnectionError,
  resolveMakaCliExitCode,
  resolveTuiResumeTarget,
} from '../cli.js';

describe('Maka CLI args', () => {
  test('parses canonical commands and rejects malformed input', () => {
    const cases: Array<[string[], unknown]> = [
      [[], { kind: 'tui' }],
      [
        ['eval', 'task-run', 'inspect', 'run-1'],
        { kind: 'eval', args: ['task-run', 'inspect', 'run-1'] },
      ],
      [['inspect', 'run-1', '--json'], { kind: 'inspect', args: ['run-1', '--json'] }],
      [['run', 'hello', '--max-steps', '3'], { kind: 'run', args: ['hello', '--max-steps', '3'] }],
      [['-p', 'hello', '--max-steps', '3'], { kind: 'run', args: ['hello', '--max-steps', '3'] }],
      [['--version'], { kind: 'version', text: '0.1.0' }],
      [['headless'], { kind: 'error', message: 'Unexpected argument: headless', exitCode: 2 }],
      [['--resume', 'abc'], { kind: 'tui', resumeSessionId: 'abc' }],
      [['--resume'], { kind: 'error', message: '--resume requires a session id', exitCode: 2 }],
      [
        ['--resume', '--help'],
        { kind: 'error', message: '--resume requires a session id', exitCode: 2 },
      ],
      [
        ['--resume', 'abc', 'extra'],
        { kind: 'error', message: 'Unexpected argument: extra', exitCode: 2 },
      ],
    ];

    for (const [args, expected] of cases) {
      assert.deepEqual(parseMakaCliArgs(args, '0.1.0'), expected, args.join(' '));
    }
    const help = parseMakaCliArgs(['--help'], '0.1.0');
    assert.equal(help.kind, 'help');
    if (help.kind === 'help') assert.match(help.text, /Usage: maka/);
  });

  test('preserves an established process exit code', () => {
    assert.equal(resolveMakaCliExitCode(2, undefined), 2);
    assert.equal(resolveMakaCliExitCode(0, 143), 143);
  });

  test('establishes the fatal exit before reporting can throw', async () => {
    const cliUrl = new URL('../cli.js', import.meta.url).href;
    const childSource = `
      import { handleMakaCliProcessExit } from ${JSON.stringify(cliUrl)};
      try {
        handleMakaCliProcessExit(1, new Error('fatal'), () => { throw new Error('writer failed'); });
      } catch {}
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      stdio: 'ignore',
    });
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];

    assert.equal(signal, null);
    assert.equal(code, 1);
  });
});

describe('resolveTuiResumeTarget', () => {
  test("anchors the resumed session's stored connection and model", async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-cli-resume-target-'));
    try {
      const session = await createSessionStore(root).create({
        cwd: '/tmp/some-workspace',
        name: 'Resume target',
        backend: 'ai-sdk',
        llmConnectionSlug: 'some-connection',
        model: 'some-model',
        permissionMode: 'ask',
      });

      const result = await resolveTuiResumeTarget(root, session.id);

      assert.deepEqual(result, {
        requestedConnectionSlug: 'some-connection',
        requestedModel: 'some-model',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('returns undefined for a session that does not exist, so startup falls back to the default connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-cli-resume-target-missing-'));
    try {
      const result = await resolveTuiResumeTarget(root, 'nonexistent-session');

      assert.equal(result, undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('startup connection-error guidance', () => {
  const workspaceRoot = '/tmp/maka-workspace';

  test('recognizes connection failures without swallowing unrelated errors', () => {
    for (const reason of ['missing_default_connection', 'missing_api_key']) {
      assert.ok(
        formatStartupConnectionError(new Error(`NO_REAL_CONNECTION:${reason}`), workspaceRoot),
        reason,
      );
    }
    assert.equal(formatStartupConnectionError(new Error('ENOENT'), workspaceRoot), null);
  });
});
