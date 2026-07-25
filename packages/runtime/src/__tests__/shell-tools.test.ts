import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildLocalForegroundBashTool,
  buildManagedBashTool,
  shapeTerminalResult,
  type ShellRunLauncher,
} from '../shell-tools.js';
import type { ShellPlan } from '../shell-detect.js';

const pwshPlan: ShellPlan = {
  kind: 'pwsh',
  displayName: 'PowerShell 7 (pwsh)',
  exe: 'C:\\pf\\pwsh.exe',
};

describe('Bash tool description declares the executing shell', () => {
  test('foreground and background variants declare command activity', () => {
    assert.equal(buildLocalForegroundBashTool().activityKind, 'command');
    assert.equal(buildManagedBashTool(fakeShellRuns()).activityKind, 'command');
  });

  test('foreground tool tells the model commands run under PowerShell 7', () => {
    const tool = buildLocalForegroundBashTool({ shell: pwshPlan });
    assert.match(tool.description, /PowerShell 7 \(pwsh\)/);
    assert.match(tool.description, /PowerShell syntax/);
    assert.match(tool.description, /git ls-files/);
    assert.match(tool.description, /node_modules/);
    assert.match(tool.description, /Subject to permission policy\.$/);
  });

  test('foreground tool description is unchanged on POSIX', () => {
    const tool = buildLocalForegroundBashTool({ shell: { kind: 'posix', displayName: '/bin/sh' } });
    assert.equal(
      tool.description,
      'Run a shell command in the session cwd. Subject to permission policy.',
    );
  });

  test('background tool tells the model commands run under PowerShell 7', () => {
    const tool = buildManagedBashTool(fakeShellRuns(), { shell: pwshPlan });
    assert.match(tool.description, /PowerShell 7 \(pwsh\)/);
    assert.match(tool.description, /git ls-files/);
    assert.match(tool.description, /run_in_background=true/);
  });
});

describe('Bash tool shell is threaded through to execution, not just the description', () => {
  test('foreground tool executes with the same shell it declares', async () => {
    // /bin/echo stands in for pwsh.exe: if the tool's shell reaches the
    // spawn, stdout echoes the PowerShell flags back. A shell that only
    // reached the description would run via the default POSIX shell and
    // print a bare 'wired-marker'.
    const tool = buildLocalForegroundBashTool({
      shell: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: '/bin/echo' },
    });
    const result = (await tool.impl({ command: 'echo wired-marker' }, fakeToolContext())) as {
      output: { stdout: string };
    };
    assert.ok(
      result.output.stdout.startsWith(
        '-NoLogo -NoProfile -NonInteractive -Command echo wired-marker\n',
      ),
      `expected declared shell to execute, got: ${result.output.stdout}`,
    );
  });

  test('background tool forwards its shell to the shell-run controller', async () => {
    const captured: unknown[] = [];
    const controller: ShellRunLauncher = {
      runForegroundBash: () => Promise.reject(new Error('not used')),
      runBackgroundBash: (input: unknown) => {
        captured.push(input);
        return Promise.resolve({
          kind: 'shell_run',
          ref: 'maka://runtime/background-tasks/sr_test',
          mode: 'pipes',
          status: 'running',
          cwd: '.',
          cmd: '',
          startedAt: 1,
          updatedAt: 1,
          revision: 1,
        });
      },
    };
    const tool = buildManagedBashTool(controller, { shell: pwshPlan });
    await tool.impl({ command: 'echo hi', run_in_background: true }, fakeToolContext());
    assert.deepEqual((captured[0] as { shell?: unknown }).shell, pwshPlan);
  });
});

describe('shapeTerminalResult sandbox denial projection', () => {
  test('surfaces sandboxDenial when a sandboxed command fails with a denial message', () => {
    const result = shapeTerminalResult({
      cwd: '/ws',
      command: 'rm -rf /',
      result: {
        exitCode: 1,
        stdout: '',
        stderr: 'Operation not permitted',
        sandboxed: true,
        sandboxType: 'macos-seatbelt',
      },
    });
    assert.deepEqual(result.sandboxDenial, {
      likely: true,
      backend: 'macos-seatbelt',
      recovery: 'require_escalated',
    });
  });

  test('omits sandboxDenial when sandboxed is false', () => {
    const result = shapeTerminalResult({
      cwd: '/ws',
      command: 'ls /no-such-dir',
      result: {
        exitCode: 1,
        stdout: '',
        stderr: 'Operation not permitted',
        sandboxed: false,
      },
    });
    assert.equal(result.sandboxDenial, undefined);
  });

  test('omits sandboxDenial when sandboxed field is absent (BoundedShellResult shape)', () => {
    const result = shapeTerminalResult({
      cwd: '/ws',
      command: 'ls',
      result: {
        exitCode: 1,
        stdout: '',
        stderr: 'Operation not permitted',
        stdoutTruncated: false,
        stderrTruncated: false,
        timedOut: false,
        aborted: false,
      },
    });
    assert.equal(result.sandboxDenial, undefined);
  });
});

function fakeToolContext() {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}

function fakeShellRuns() {
  return {
    runForegroundBash: () => Promise.reject(new Error('not used')),
    runBackgroundBash: () => Promise.reject(new Error('not used')),
  };
}
