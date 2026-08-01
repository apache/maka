import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, test } from 'node:test';
import { createConnectionStore, createSessionStore } from '@maka/storage';
import {
  parseMakaCliArgs,
  formatStartupConnectionError,
  resolveMakaCliExitCode,
  resolveTuiResumeTarget,
} from '../cli.js';
import { createMakaCliRuntimeContext } from '../runtime-bootstrap.js';

const execFileAsync = promisify(execFile);
const cliPath = new URL('../cli.js', import.meta.url).pathname;

function runCliProcess(
  entrypoint: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entrypoint, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end();
  });
}

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

  test('coordinates repeated exit requests through the shell cleanup grace period', async () => {
    const cliUrl = new URL('../cli.js', import.meta.url).href;
    const childSource = `
      import { beginMakaCliExit } from ${JSON.stringify(cliUrl)};
      setInterval(() => {}, 1_000);
      beginMakaCliExit(0);
      setTimeout(() => beginMakaCliExit(1), 100);
    `;
    const startedAt = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      stdio: 'ignore',
    });
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    clearTimeout(watchdog);

    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.ok(Date.now() - startedAt >= 2_500);
  });

  test('inspects a Session through the executable entrypoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-cli-inspect-'));
    try {
      const connections = createConnectionStore(root);
      await connections.create({
        slug: 'local',
        name: 'Local',
        providerType: 'ollama',
        defaultModel: 'local-model',
      });
      const context = await createMakaCliRuntimeContext({
        surface: 'run',
        workspaceRoot: root,
        cwd: '/tmp/workspace',
      });
      let sessionId: string;
      try {
        sessionId = (
          await context.runtime.createSession({
            cwd: context.cwd,
            name: 'CLI inspect',
            backend: 'ai-sdk',
            llmConnectionSlug: context.target.connection.slug,
            model: context.target.model,
            permissionMode: 'ask',
          })
        ).id;
      } finally {
        await context.close();
      }
      const result = await runCliProcess(cliPath, [
        'inspect',
        sessionId,
        '--store',
        root,
        '--kind',
        'session',
        '--json',
      ]);

      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      const document = JSON.parse(result.stdout) as { schemaVersion: string; kind: string };
      assert.equal(document.schemaVersion, 'maka.session_inspect.v1');
      assert.equal(document.kind, 'session');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('runs a fake evaluation through the unified executable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maka-unified-eval-'));
    try {
      await mkdir(join(dir, 'fixture'), { recursive: true });
      await writeFile(join(dir, 'fixture', 'marker.txt'), 'ok', 'utf8');
      const specPath = join(dir, 'spec.json');
      const outDir = join(dir, 'out');
      await writeFile(
        specPath,
        JSON.stringify({
          configs: [
            { id: 'fake-cfg', backend: 'fake', llmConnectionSlug: 'fake', model: 'fake-model' },
          ],
          tasks: [
            {
              id: 't-pass',
              instruction: 'go',
              workspaceDir: 'fixture',
              verification: { command: 'test -f marker.txt', protectedPaths: [] },
            },
          ],
        }),
        'utf8',
      );

      const result = await runCliProcess(cliPath, ['eval', 'run', specPath, '--out', outDir]);

      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /deprecated/);
      assert.match(result.stdout, /t-pass/);
      assert.match(await readFile(join(outDir, 'comparison.md'), 'utf8'), /t-pass/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('returns exit 2 for missing non-interactive input before configuration startup', async () => {
    const result = await runCliProcess(cliPath, ['run']);

    assert.equal(result.code, 2);
    assert.match(result.stderr, /missing prompt input/);
    assert.equal(result.stdout, '');
  });

  test('runs when launched through a bin symlink', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'maka-cli-bin-'));
    try {
      const linkPath = join(tempDir, 'maka');
      await symlink(cliPath, linkPath);
      const { stdout } = await execFileAsync(linkPath, ['--version']);

      assert.equal(stdout.trim(), '0.1.0');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
