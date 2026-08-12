import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildPtyShellSpawnPlan, buildShellSpawnPlan, detectShell } from '../shell-detect.js';

const winEnv = (over: Record<string, string> = {}) => ({
  Path: 'C:\\Windows\\System32;C:\\Users\\u\\bin',
  ProgramFiles: 'C:\\Program Files',
  SystemRoot: 'C:\\Windows',
  ...over,
});

const existsIn =
  (...paths: string[]) =>
  (p: string) =>
    paths.includes(p);

describe('detectShell', () => {
  test('on win32 picks pwsh from PATH ahead of everything else', () => {
    const plan = detectShell({
      platform: 'win32',
      env: winEnv(),
      fileExists: existsIn(
        'C:\\Users\\u\\bin\\pwsh.exe',
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ),
    });
    assert.equal(plan.kind, 'pwsh');
    assert.equal(plan.exe, 'C:\\Users\\u\\bin\\pwsh.exe');
  });

  test('on win32 finds pwsh at its default install location when not on PATH', () => {
    const plan = detectShell({
      platform: 'win32',
      env: winEnv(),
      fileExists: existsIn('C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
    });
    assert.equal(plan.kind, 'pwsh');
    assert.equal(plan.exe, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  });

  test('on win32 falls back to Windows PowerShell 5.1 when pwsh is absent', () => {
    const plan = detectShell({
      platform: 'win32',
      env: winEnv(),
      fileExists: existsIn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    });
    assert.equal(plan.kind, 'powershell');
    assert.equal(plan.exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  test('on win32 falls back to cmd.exe when no PowerShell exists', () => {
    const plan = detectShell({ platform: 'win32', env: winEnv(), fileExists: () => false });
    assert.deepEqual(plan, { kind: 'cmd', displayName: 'cmd.exe' });
  });

  test('on POSIX platforms keeps the system default shell', () => {
    const plan = detectShell({ platform: 'darwin', env: {}, fileExists: () => false });
    assert.deepEqual(plan, { kind: 'posix', displayName: '/bin/sh' });
  });
});

describe('buildShellSpawnPlan', () => {
  test('spawns PowerShell explicitly and preserves the command in an isolated script block', () => {
    const command = "using namespace System.Text\nWrite-Output '$HOME'";
    const spawnPlan = buildShellSpawnPlan(
      { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: 'C:\\Users\\u\\bin\\pwsh.exe' },
      command,
      { INHERITED: 'kept', __maka_runtime_powershell_command: 'caller value' },
    );
    assert.equal(spawnPlan.file, 'C:\\Users\\u\\bin\\pwsh.exe');
    assert.equal(spawnPlan.useShellOption, false);
    assert.deepEqual(spawnPlan.args.slice(0, 4), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
    ]);
    const script = spawnPlan.args[4] ?? '';
    assert.match(script, /\[Console\]::OutputEncoding = \$__makaUtf8/u);
    assert.equal(spawnPlan.env?.INHERITED, 'kept');
    assert.ok(spawnPlan.env?.__MAKA_RUNTIME_POWERSHELL_COMMAND?.startsWith(`${command}\n`));
    assert.equal(spawnPlan.env?.__maka_runtime_powershell_command, undefined);
    assert.match(script, /SetEnvironmentVariable\('__MAKA_RUNTIME_POWERSHELL_COMMAND', \$null\)/u);
    assert.doesNotMatch(
      script,
      /Write-Output/u,
      'user syntax is not interpolated into the wrapper',
    );
  });

  test('appends an exit-code wrapper so native command exit codes survive -Command', () => {
    // pwsh -Command maps the process exit code to 0/1 from $? — a native
    // command exiting 42 comes back as 1. The wrapper re-raises $LASTEXITCODE,
    // and only when the final statement actually failed, so a recovered
    // failure (native exit 3, then a succeeding cmdlet) still exits 0.
    const spawnPlan = buildShellSpawnPlan(
      { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: 'C:\\pf\\pwsh.exe' },
      'npm test',
    );
    assert.equal(
      spawnPlan.env?.__MAKA_RUNTIME_POWERSHELL_COMMAND,
      'npm test\n' +
        '$__makaOk = $?\n' +
        'if (-not $__makaOk) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 } }',
    );
    assert.equal(
      spawnPlan.args[4],
      '$__makaUtf8 = [System.Text.UTF8Encoding]::new($false)\n' +
        '[Console]::OutputEncoding = $__makaUtf8\n' +
        '$OutputEncoding = $__makaUtf8\n' +
        "$__makaCommandText = [Environment]::GetEnvironmentVariable('__MAKA_RUNTIME_POWERSHELL_COMMAND')\n" +
        "[Environment]::SetEnvironmentVariable('__MAKA_RUNTIME_POWERSHELL_COMMAND', $null)\n" +
        '$__makaCommand = [ScriptBlock]::Create($__makaCommandText)\n' +
        '. $__makaCommand',
    );
  });

  test('keeps shell:true for the system default shells (posix and cmd)', () => {
    for (const plan of [
      { kind: 'posix', displayName: '/bin/sh' } as const,
      { kind: 'cmd', displayName: 'cmd.exe' } as const,
    ]) {
      assert.deepEqual(buildShellSpawnPlan(plan, 'echo hi'), {
        file: 'echo hi',
        args: [],
        useShellOption: true,
      });
    }
  });
});

describe('buildPtyShellSpawnPlan', () => {
  test('uses explicit argv for POSIX, cmd, and PowerShell PTYs', () => {
    assert.deepEqual(
      buildPtyShellSpawnPlan({ kind: 'posix', displayName: '/bin/sh' }, 'printf ready'),
      { file: '/bin/sh', args: ['-c', 'printf ready'] },
    );
    assert.deepEqual(
      buildPtyShellSpawnPlan({ kind: 'cmd', displayName: 'cmd.exe' }, 'echo ready', {
        ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      }),
      {
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', 'echo ready'],
      },
    );

    const powershell = buildPtyShellSpawnPlan(
      { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: 'C:\\pf\\pwsh.exe' },
      'Write-Output ready',
      { INHERITED: 'kept' },
    );
    assert.equal(powershell.file, 'C:\\pf\\pwsh.exe');
    assert.deepEqual(powershell.args.slice(0, 3), ['-NoLogo', '-NoProfile', '-Command']);
    assert.doesNotMatch(powershell.args.join(' '), /-NonInteractive/);
    assert.match(
      powershell.args[3] ?? '',
      /\$OutputEncoding = \$__makaUtf8\n\$__makaCommandText = \[Environment\]::GetEnvironmentVariable/u,
    );
    assert.equal(powershell.env?.INHERITED, 'kept');
    assert.ok(
      powershell.env?.__MAKA_RUNTIME_POWERSHELL_COMMAND?.startsWith('Write-Output ready\n'),
    );
  });
});
