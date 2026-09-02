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
import { TERMINAL_MOUSE_EVENTS } from '@maka/core/terminal-input';
import {
  buildLocalForegroundBashTool,
  buildManagedBashTool,
  createWriteStdinSchemas,
  shapeTerminalResult,
  WRITE_STDIN_EXAMPLE_REF,
  WRITE_STDIN_MINIMAL_EXAMPLES,
  type ShellRunLauncher,
} from '../shell-tools.js';
import type { ShellPlan } from '../shell-detect.js';
import { ShellPreferenceError } from '../shell-detect.js';

const pwshPlan: ShellPlan = {
  kind: 'pwsh',
  displayName: 'PowerShell 7 (pwsh)',
  exe: 'C:\\pf\\pwsh.exe',
};

test('an explicit Git Bash tool declares POSIX syntax', () => {
  const tool = buildLocalForegroundBashTool({
    shell: {
      plan: {
        kind: 'git-bash',
        displayName: 'Git Bash',
        exe: 'C:\\Program Files\\Git\\bin\\bash.exe',
      },
    },
  });
  assert.match(tool.description, /Git Bash/);
  assert.match(tool.description, /POSIX shell syntax/);
  assert.doesNotMatch(tool.description, /write PowerShell syntax/);
});

describe('Bash tool fails closed when the turn shell plan carries a setup error', () => {
  const brokenShell = {
    plan: { kind: 'cmd', displayName: 'cmd.exe' } as ShellPlan,
    setupError: new ShellPreferenceError(
      'executable_missing',
      'The configured Git Bash was not found',
    ),
  };

  test('description declares the outage instead of dialect guidance', () => {
    const tool = buildLocalForegroundBashTool({ shell: brokenShell });
    assert.match(tool.description, /unavailable this turn/);
    assert.doesNotMatch(tool.description, /write cmd syntax/);
  });

  test('local foreground execution throws the setup error before spawning', async () => {
    const tool = buildLocalForegroundBashTool({ shell: brokenShell });
    await assert.rejects(
      async () => {
        await tool.impl({ command: 'echo never-runs' }, fakeToolContext());
      },
      (error: unknown) => {
        assert.ok(error instanceof ShellPreferenceError);
        assert.equal(error.code, 'executable_missing');
        return true;
      },
    );
  });

  test('managed execution throws before any shell-run reaches the host', async () => {
    const controller: ShellRunLauncher = {
      runForegroundBash: () => Promise.reject(new Error('must not be called')),
      runBackgroundBash: () => Promise.reject(new Error('must not be called')),
    };
    const tool = buildManagedBashTool(controller, { shell: brokenShell });
    await assert.rejects(async () => {
      await tool.impl({ command: 'echo never-runs' }, fakeToolContext());
    }, ShellPreferenceError);
    await assert.rejects(async () => {
      await tool.impl({ command: 'echo never-runs', run_in_background: true }, fakeToolContext());
    }, ShellPreferenceError);
  });
});

describe('Bash tool shell is threaded through to execution, not just the description', () => {
  test('foreground tool executes with the same shell it declares', async () => {
    // /bin/echo stands in for pwsh.exe: if the tool's shell reaches the
    // spawn, stdout echoes the PowerShell flags and wrapper back. A shell that only
    // reached the description would run via the default POSIX shell and
    // print a bare 'wired-marker'.
    const tool = buildLocalForegroundBashTool({
      shell: { plan: { kind: 'pwsh', displayName: 'PowerShell 7 (pwsh)', exe: '/bin/echo' } },
    });
    const result = (await tool.impl({ command: 'echo wired-marker' }, fakeToolContext())) as {
      output: { stdout: string };
    };
    assert.ok(
      result.output.stdout.startsWith(
        '-NoLogo -NoProfile -NonInteractive -Command $__makaUtf8 = [System.Text.UTF8Encoding]::new($false)\n',
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
    const tool = buildManagedBashTool(controller, { shell: { plan: pwshPlan } });
    await tool.impl({ command: 'echo hi', run_in_background: true }, fakeToolContext());
    assert.deepEqual((captured[0] as { shell?: unknown }).shell, pwshPlan);
  });

  test('managed completion callback remains exactly-once when the launcher settles it', async () => {
    let completionCount = 0;
    const controller: ShellRunLauncher = {
      async runForegroundBash(input) {
        input.onCompletion?.({ successful: true });
        return {
          kind: 'terminal',
          cwd: input.cwd,
          cmd: input.command,
          status: 'completed',
          exitCode: 0,
          output: {
            mode: 'pipes',
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            redacted: false,
          },
        };
      },
      runBackgroundBash: () => Promise.reject(new Error('not used')),
    };
    const tool = buildManagedBashTool(controller, {
      transformCommand: ({ ctx }) => ({
        cwd: ctx.cwd,
        onCompletion: () => {
          completionCount += 1;
        },
      }),
    });

    await tool.impl({ command: 'true' }, fakeToolContext());
    assert.equal(completionCount, 1);
  });
});

describe('Bash provider-facing result projection', () => {
  test('managed Bash removes only the duplicated foreground command', async () => {
    const tool = buildManagedBashTool(fakeShellRuns());
    const terminal = {
      kind: 'terminal',
      cwd: '/workspace',
      cmd: 'printf foreground',
      status: 'completed',
      exitCode: 0,
      output: {
        mode: 'pipes',
        stdout: 'foreground',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        redacted: false,
      },
    };
    const background = {
      kind: 'shell_run',
      ref: 'maka://runtime/background-tasks/sr_test',
      mode: 'pipes',
      status: 'running',
      cwd: '/workspace',
      cmd: 'printf background',
      startedAt: 1,
      updatedAt: 1,
      revision: 1,
    };

    assert.deepEqual(
      await tool.toModelOutput?.({ toolCallId: 'foreground', input: {}, output: terminal }),
      {
        type: 'json',
        value: {
          kind: 'terminal',
          cwd: '/workspace',
          status: 'completed',
          exitCode: 0,
          output: terminal.output,
        },
      },
    );
    assert.deepEqual(
      await tool.toModelOutput?.({ toolCallId: 'background', input: {}, output: background }),
      { type: 'json', value: background },
    );
    assert.equal(terminal.cmd, 'printf foreground');
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

describe('WriteStdin provider/strict contract conformance', () => {
  const { providerParameters, strictParameters } = createWriteStdinSchemas();

  // Each example's first action, or undefined for a resize-only (action-less) example.
  const firstActionOf = (payload: Readonly<Record<string, unknown>>) => {
    const actions = payload.actions;
    return Array.isArray(actions) ? (actions[0] as Record<string, unknown> | undefined) : undefined;
  };

  const acceptedByBothLayers = (
    label: string,
    payload: Readonly<Record<string, unknown>>,
  ): boolean => {
    const provider = providerParameters.safeParse(payload);
    assert.ok(
      provider.success,
      `provider schema rejected the documented "${label}" example: ${
        provider.success ? '' : provider.error.message
      }`,
    );
    const strict = strictParameters.safeParse(payload);
    assert.ok(
      strict.success,
      `strict validator rejected the documented "${label}" example: ${
        strict.success ? '' : strict.error.message
      }`,
    );
    return provider.success && strict.success;
  };

  test('every documented minimal example is accepted by BOTH the provider and strict layers', () => {
    for (const { label, payload } of WRITE_STDIN_MINIMAL_EXAMPLES) {
      acceptedByBothLayers(label, payload);
    }
  });

  test('every mouse event has a covering example that passes both layers', () => {
    // Derives coverage from the source of truth: adding a new mouse event to
    // TERMINAL_MOUSE_EVENTS fails here until a minimal example is pinned for it.
    for (const event of TERMINAL_MOUSE_EVENTS) {
      const covering = WRITE_STDIN_MINIMAL_EXAMPLES.filter(({ payload }) => {
        const action = firstActionOf(payload);
        return action?.type === 'mouse' && action?.event === event;
      });
      assert.ok(
        covering.length >= 1,
        `no minimal WriteStdin example covers the '${event}' mouse event`,
      );
      for (const { label, payload } of covering) {
        acceptedByBothLayers(label, payload);
      }
    }
  });

  test('every action type has a covering example', () => {
    // Same drift-proofing for the action `type` enum itself.
    const actionTypes = ['text', 'key', 'mouse'] as const;
    for (const type of actionTypes) {
      const covered = WRITE_STDIN_MINIMAL_EXAMPLES.some(
        ({ payload }) => firstActionOf(payload)?.type === type,
      );
      assert.ok(covered, `no minimal WriteStdin example covers the '${type}' action type`);
    }
  });

  test('provider null/0/empty placeholders are tolerated and normalized away by the strict layer', () => {
    // A provider that fills every optional field with a null/0/'' placeholder
    // rather than omitting it must still round-trip to the minimal legal action.
    const withPlaceholders = {
      ref: WRITE_STDIN_EXAMPLE_REF,
      actions: [
        {
          type: 'key',
          key: 'enter',
          text: '',
          event: null,
          x: 0,
          y: 0,
          button: null,
          direction: null,
          modifiers: [],
        },
      ],
      size: null,
    };
    const strict = strictParameters.safeParse(withPlaceholders);
    assert.ok(
      strict.success,
      `strict validator should normalize provider placeholders, got: ${
        strict.success ? '' : strict.error.message
      }`,
    );
    assert.deepEqual(strict.data.actions, [{ type: 'key', key: 'enter' }]);
  });

  test('strict validation is not vacuous: contract violations are rejected', () => {
    // Mouse click without a button is structurally invalid.
    assert.equal(
      strictParameters.safeParse({
        ref: WRITE_STDIN_EXAMPLE_REF,
        actions: [{ type: 'mouse', event: 'click', x: 0, y: 0 }],
      }).success,
      false,
    );
    // A non-canonical ref must be refused even when the actions are legal.
    assert.equal(
      strictParameters.safeParse({
        ref: 'not-a-runtime-ref',
        actions: [{ type: 'key', key: 'enter' }],
      }).success,
      false,
    );
    // input and actions are mutually exclusive.
    assert.equal(
      strictParameters.safeParse({
        ref: WRITE_STDIN_EXAMPLE_REF,
        input: 'x',
        actions: [{ type: 'key', key: 'enter' }],
      }).success,
      false,
    );
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
