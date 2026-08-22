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
import { describe, test } from 'node:test';
import {
  bashToolTurnShellGuidance,
  buildPtyShellSpawnPlan,
  buildShellSpawnPlan,
  detectShell,
  resolveShellPlan,
  resolveTurnShellPlan,
  ShellPreferenceError,
  throwIfShellSetupFailed,
  turnShellDisplayName,
  validateShellPreference,
} from '../shell-detect.js';

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

describe('resolveShellPlan', () => {
  const executable = 'C:\\Program Files\\Git\\bin\\bash.exe';

  test('keeps automatic detection unchanged when no override is selected', () => {
    const plan = resolveShellPlan(
      { preference: 'auto', executable },
      {
        platform: 'win32',
        env: winEnv(),
        fileExists: existsIn('C:\\Program Files\\PowerShell\\7\\pwsh.exe'),
      },
    );
    assert.equal(plan.kind, 'pwsh');
  });

  test('resolves an existing absolute bash.exe on the Windows Host', () => {
    assert.deepEqual(
      resolveShellPlan(
        { preference: 'git_bash', executable },
        { platform: 'win32', fileExists: existsIn(executable) },
      ),
      { kind: 'git-bash', displayName: 'Git Bash', exe: executable },
    );
  });

  test('recognizes the legacy System32 WSL shim as a distinct Bash plan', () => {
    const executable = 'C:\\Windows\\System32\\bash.exe';
    assert.deepEqual(
      resolveShellPlan(
        { preference: 'git_bash', executable },
        { platform: 'win32', env: winEnv(), fileExists: existsIn(executable) },
      ),
      { kind: 'legacy-wsl-bash', displayName: 'Legacy WSL Bash', exe: executable },
    );
  });

  test('fails closed for another platform, a relative path, or a missing executable', () => {
    for (const run of [
      () =>
        resolveShellPlan(
          { preference: 'git_bash', executable },
          { platform: 'linux', fileExists: existsIn(executable) },
        ),
      () =>
        resolveShellPlan(
          { preference: 'git_bash', executable: '.\\bash.exe' },
          { platform: 'win32', fileExists: () => true },
        ),
      () =>
        resolveShellPlan(
          { preference: 'git_bash', executable },
          { platform: 'win32', fileExists: () => false },
        ),
    ]) {
      assert.throws(run, ShellPreferenceError);
    }
  });

  test('probes GNU Bash identity before accepting the preference', async () => {
    const settings = { preference: 'git_bash' as const, executable };
    const plan = await validateShellPreference(settings, {
      platform: 'win32',
      fileExists: existsIn(executable),
      probeVersion: async () => 'GNU bash, version 5.2.37(1)-release',
    });
    assert.equal(plan.kind, 'git-bash');
    await assert.rejects(
      validateShellPreference(settings, {
        platform: 'win32',
        fileExists: existsIn(executable),
        probeVersion: async () => 'not a shell',
      }),
      (error: unknown) => error instanceof ShellPreferenceError && error.code === 'not_bash',
    );
  });
});

describe('resolveTurnShellPlan', () => {
  const executable = 'C:\\\\Program Files\\\\Git\\\\bin\\\\bash.exe';

  test('resolves a healthy explicit preference into a ready plan', () => {
    const shell = resolveTurnShellPlan(
      { preference: 'git_bash', executable },
      { platform: 'win32', fileExists: existsIn(executable) },
    );
    assert.deepEqual(shell, {
      plan: { kind: 'git-bash', displayName: 'Git Bash', exe: executable },
    });
    assert.equal(shell.setupError, undefined);
  });

  test('captures a moved or uninstalled executable instead of throwing at turn admission', () => {
    const shell = resolveTurnShellPlan(
      { preference: 'git_bash', executable },
      { platform: 'win32', fileExists: () => false },
    );
    assert.ok(shell.setupError instanceof ShellPreferenceError);
    assert.equal(shell.setupError.code, 'executable_missing');
    // The fallback plan exists only so guidance surfaces still have a shape;
    // execution never reaches it (throwIfShellSetupFailed gates the boundary).
    assert.equal(shell.plan, resolveTurnShellPlan({ preference: 'auto', executable }).plan);
  });

  test('keeps automatic detection error-free', () => {
    const shell = resolveTurnShellPlan(
      { preference: 'auto', executable: '' },
      { platform: 'darwin', env: {}, fileExists: () => false },
    );
    assert.equal(shell.plan.kind, 'posix');
    assert.equal(shell.setupError, undefined);
  });

  test('fails closed at the Bash boundary without falling back to another shell', () => {
    const broken = resolveTurnShellPlan(
      { preference: 'git_bash', executable },
      { platform: 'win32', fileExists: () => false },
    );
    assert.throws(() => throwIfShellSetupFailed(broken), ShellPreferenceError);
    const healthy = resolveTurnShellPlan(
      { preference: 'git_bash', executable },
      { platform: 'win32', fileExists: existsIn(executable) },
    );
    throwIfShellSetupFailed(healthy);
  });

  test('declares the outage to the model instead of naming a shell that cannot run', () => {
    const broken = resolveTurnShellPlan(
      { preference: 'git_bash', executable },
      { platform: 'win32', fileExists: () => false },
    );
    const guidance = bashToolTurnShellGuidance(broken);
    assert.match(guidance, /unavailable this turn/);
    assert.match(guidance, /not found/i);
    assert.doesNotMatch(guidance, /write POSIX shell syntax/);
    assert.match(turnShellDisplayName(broken), /Unavailable/);

    const healthy = resolveTurnShellPlan(
      { preference: 'git_bash', executable },
      { platform: 'win32', fileExists: existsIn(executable) },
    );
    assert.match(bashToolTurnShellGuidance(healthy), /write POSIX shell syntax/);
    assert.equal(turnShellDisplayName(healthy), 'Git Bash');
  });
});

describe('buildShellSpawnPlan', () => {
  test('spawns an explicit Git Bash executable with POSIX command syntax', () => {
    assert.deepEqual(
      buildShellSpawnPlan(
        {
          kind: 'git-bash',
          displayName: 'Git Bash',
          exe: 'C:\\Program Files\\Git\\bin\\bash.exe',
        },
        'printf "%s\\n" ready',
      ),
      {
        file: 'C:\\Program Files\\Git\\bin\\bash.exe',
        args: ['-c', 'printf "%s\\n" ready'],
        useShellOption: false,
      },
    );
  });

  test('feeds the legacy WSL shim through stdin instead of quoting a command argument', () => {
    assert.deepEqual(
      buildShellSpawnPlan(
        {
          kind: 'legacy-wsl-bash',
          displayName: 'Legacy WSL Bash',
          exe: 'C:\\Windows\\System32\\bash.exe',
        },
        'printf "%s\\n" ready',
      ),
      {
        file: 'C:\\Windows\\System32\\bash.exe',
        args: ['-s'],
        useShellOption: false,
        stdin: 'printf "%s\\n" ready\n',
      },
    );
  });

  test('never falls back to the platform shell for a malformed explicit Bash plan', () => {
    assert.throws(
      () => buildShellSpawnPlan({ kind: 'git-bash', displayName: 'Git Bash' }, 'echo unsafe'),
      /missing its executable/,
    );
    assert.throws(
      () =>
        buildPtyShellSpawnPlan(
          { kind: 'legacy-wsl-bash', displayName: 'Legacy WSL Bash' },
          'echo unsafe',
        ),
      /missing its executable/,
    );
  });

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

    assert.deepEqual(
      buildPtyShellSpawnPlan(
        {
          kind: 'git-bash',
          displayName: 'Git Bash',
          exe: 'C:\\Program Files\\Git\\bin\\bash.exe',
        },
        'exec bash -l',
      ),
      {
        file: 'C:\\Program Files\\Git\\bin\\bash.exe',
        args: ['-c', 'exec bash -l'],
      },
    );
    assert.deepEqual(
      buildPtyShellSpawnPlan(
        {
          kind: 'legacy-wsl-bash',
          displayName: 'Legacy WSL Bash',
          exe: 'C:\\Windows\\System32\\bash.exe',
        },
        'exec bash -l',
      ),
      {
        file: 'C:\\Windows\\System32\\bash.exe',
        args: ['-c', 'exec bash -l'],
      },
    );
  });
});
