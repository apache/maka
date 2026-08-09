import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { parseMakaCliArgs, resolveMakaCliExitCode } from '../cli.js';

describe('Maka CLI args', () => {
  test('parses canonical commands and rejects malformed input', () => {
    const cases: Array<[string[], unknown]> = [
      [[], { kind: 'tui' }],
      [
        ['eval', 'task-run', 'inspect', 'run-1'],
        { kind: 'eval', args: ['task-run', 'inspect', 'run-1'] },
      ],
      [['inspect', 'run-1', '--json'], { kind: 'inspect', args: ['run-1', '--json'] }],
      [['runtime-host', 'serve'], { kind: 'runtime-host-serve' }],
      [
        ['runtime-host', 'serve', '--root', '/srv/maka'],
        { kind: 'runtime-host-serve', rootPath: '/srv/maka' },
      ],
      [
        ['runtime-host'],
        {
          kind: 'error',
          message: 'runtime-host requires the serve or access command',
          exitCode: 2,
        },
      ],
      [
        ['runtime-host', 'serve', '--root'],
        { kind: 'error', message: '--root requires a value', exitCode: 2 },
      ],
      [
        ['runtime-host', 'serve', '--websocket-port', '43120', '--websocket-host', '::1'],
        {
          kind: 'runtime-host-serve',
          websocket: { host: '::1', port: 43120 },
        },
      ],
      [
        [
          'runtime-host',
          'access',
          'issue',
          '--principal',
          'device-1',
          '--grant',
          'session.catalog.query',
          '--grant',
          'subscription.open',
        ],
        {
          kind: 'runtime-host-access-issue',
          principalId: 'device-1',
          operationGrants: ['session.catalog.query', 'subscription.open'],
          canPublishClientCapabilities: false,
          canUseHostPaths: false,
        },
      ],
      [
        ['runtime-host', 'access', 'revoke', '--credential', 'credential-1'],
        { kind: 'runtime-host-access-revoke', credentialId: 'credential-1' },
      ],
      [['run', 'hello', '--max-steps', '3'], { kind: 'run', args: ['hello', '--max-steps', '3'] }],
      [['-p', 'hello', '--max-steps', '3'], { kind: 'run', args: ['hello', '--max-steps', '3'] }],
      [['--version'], { kind: 'version', text: '0.1.0' }],
      [['headless'], { kind: 'error', message: 'Unexpected argument: headless', exitCode: 2 }],
      [['--resume', 'abc'], { kind: 'tui', resumeSessionId: 'abc' }],
      [
        ['--resume', 'abc', '--cwd', '../moved repo'],
        { kind: 'tui', resumeSessionId: 'abc', resumeCwd: '../moved repo' },
      ],
      [['--resume'], { kind: 'error', message: '--resume requires a session id', exitCode: 2 }],
      [
        ['--resume', '--help'],
        { kind: 'error', message: '--resume requires a session id', exitCode: 2 },
      ],
      [
        ['--resume', 'abc', 'extra'],
        { kind: 'error', message: 'Unexpected argument: extra', exitCode: 2 },
      ],
      [
        ['--resume', 'abc', '--cwd'],
        { kind: 'error', message: '--cwd requires a directory', exitCode: 2 },
      ],
      [
        ['--resume', 'abc', '--cwd', '/repo', 'extra'],
        { kind: 'error', message: 'Unexpected argument: extra', exitCode: 2 },
      ],
    ];

    for (const [args, expected] of cases) {
      assert.deepEqual(parseMakaCliArgs(args, '0.1.0'), expected, args.join(' '));
    }
    const help = parseMakaCliArgs(['--help'], '0.1.0');
    assert.equal(help.kind, 'help');
    if (help.kind === 'help') assert.match(help.text, /Usage: maka/);
    if (help.kind === 'help') assert.match(help.text, /--resume <id> --cwd <path>/);
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
