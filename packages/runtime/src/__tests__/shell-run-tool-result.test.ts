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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { type PtyShellOutput, type ShellRunRecord } from '@maka/core/shell-run';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import { createSessionStore } from '@maka/storage';

import {
  projectPtyOutputForModel,
  shellRunContent,
  terminalContent,
} from '../shell-run-tool-result.js';

describe('PTY model output projection', () => {
  test('shares one UTF-8 budget in screen, alternate, then latest scrollback priority', () => {
    const output = ptyOutput({
      screen: 'SCREEN',
      lastAlternateScreen: 'ALT'.repeat(20),
      scrollback: 'SCROLL'.repeat(20),
    });
    const projected = projectPtyOutputForModel(output, 80);

    assert.equal(projected.screen, output.screen);
    assert.equal(projected.lastAlternateScreen, output.lastAlternateScreen);
    assert.notEqual(projected.scrollback, output.scrollback);
    assert.equal(projected.truncated, true);
    assert.ok(modelTextBytes(projected) <= 80);

    const screenOnly = projectPtyOutputForModel(
      ptyOutput({
        screen: '\u754c'.repeat(100),
        lastAlternateScreen: 'must-not-fit',
        scrollback: 'must-not-fit',
      }),
      100,
    );
    assert.ok(modelTextBytes(screenOnly) <= 100);
    assert.equal(screenOnly.lastAlternateScreen, undefined);
    assert.equal(screenOnly.scrollback, '');
    assert.equal(screenOnly.screen.includes('\uFFFD'), false);
  });

  test('returns a losslessly serializable PTY result without an alternate screen', () => {
    const result = shellRunContent(
      {
        shellRunId: 'shell-1',
        sessionId: 'session-1',
        sourceTurnId: 'turn-1',
        sourceToolCallId: 'tool-1',
        cwd: '/workspace',
        command: 'storybook',
        status: 'cancelled',
        startedAt: 1,
        updatedAt: 2,
        completedAt: 2,
        exitCode: 130,
        failureMessage: 'Command cancelled',
        revision: 2,
        output: ptyOutput({}),
      },
      { kind: 'stop', applied: true },
    );
    const event: RuntimeEvent = {
      id: 'operation-1_response',
      invocationId: 'invocation-1',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 2,
      partial: false,
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'tool-1',
        name: 'StopBackgroundTask',
        result,
      },
      refs: { operationId: 'operation-1', toolCallId: 'tool-1' },
    };

    assert.doesNotThrow(() => encodeCanonicalRuntimeEvent(event));
  });
});

describe('shell run sandbox denial projection', () => {
  test('reports a diagnostic signal only for a failed sandboxed process', () => {
    const base = failedShellRun();

    assert.equal(terminalContent(base).sandboxDenial, undefined);
    assert.deepEqual(
      terminalContent({
        ...base,
        sandboxExecution: { type: 'macos-seatbelt', enforced: true },
      }).sandboxDenial,
      {
        likely: true,
        backend: 'macos-seatbelt',
      },
    );
    assert.equal(
      terminalContent({
        ...base,
        sandboxExecution: { type: 'none', enforced: false },
      }).sandboxDenial,
      undefined,
    );
  });

  test('round-trips the producer sandbox denial through strict FileSessionStore recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-shell-result-recovery-'));
    try {
      const store = createSessionStore(root);
      const session = await store.create({
        cwd: '/workspace',
        llmConnectionSlug: 'fake',
        model: 'fake-model',
        permissionMode: 'ask',
      });
      const content = terminalContent({
        ...failedShellRun(),
        sessionId: session.id,
        sandboxExecution: { type: 'macos-seatbelt', enforced: true },
      });
      await store.appendMessage(session.id, {
        type: 'tool_result',
        id: 'tool-result-1',
        turnId: 'turn-1',
        ts: 2,
        toolUseId: 'tool-1',
        isError: true,
        content,
      });

      const messages = await store.readMessagesForRecovery(session.id);
      const result = messages.find((message) => message.id === 'tool-result-1');
      assert.deepEqual(result?.type === 'tool_result' ? result.content : undefined, content);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PTY flattening for sandbox denial', () => {
  test('detects denial in PTY scrollback field', () => {
    const record: ShellRunRecord = {
      ...failedShellRun(),
      output: ptyOutput({ scrollback: 'Operation not permitted', screen: '' }),
      sandboxExecution: { type: 'macos-seatbelt', enforced: true },
    };
    assert.equal(terminalContent(record).sandboxDenial?.likely, true);
  });

  test('detects denial in PTY screen field', () => {
    const record: ShellRunRecord = {
      ...failedShellRun(),
      output: ptyOutput({ scrollback: '', screen: 'sandbox-denied: write' }),
      sandboxExecution: { type: 'macos-seatbelt', enforced: true },
    };
    assert.equal(terminalContent(record).sandboxDenial?.likely, true);
  });

  test('detects denial in PTY lastAlternateScreen field', () => {
    const record: ShellRunRecord = {
      ...failedShellRun(),
      output: ptyOutput({
        scrollback: '',
        screen: '',
        lastAlternateScreen: 'launching sandbox-exec profile',
      }),
      sandboxExecution: { type: 'macos-seatbelt', enforced: true },
    };
    assert.equal(terminalContent(record).sandboxDenial?.likely, true);
  });

  test('does NOT detect denial split across PTY fields (regex cannot cross newline)', () => {
    // flattenSandboxDenialText joins scrollback + "\n" + screen + "\n" + lastAlt;
    // the regex branch "sandbox(?:ed)?[^\n]*den(?:y|ied)" uses [^\n]* which cannot
    // span the newline separator, so "sandbox" in scrollback and "denied" in screen
    // must NOT be matched together.
    const record: ShellRunRecord = {
      ...failedShellRun(),
      output: ptyOutput({
        scrollback: 'sandbox setup',
        screen: 'then denied',
        lastAlternateScreen: undefined,
      }),
      sandboxExecution: { type: 'macos-seatbelt', enforced: true },
    };
    assert.equal(terminalContent(record).sandboxDenial, undefined);
  });

  test('does not flag PTY output when sandbox is not enforced', () => {
    const record: ShellRunRecord = {
      ...failedShellRun(),
      output: ptyOutput({ screen: 'Operation not permitted' }),
      sandboxExecution: { type: 'macos-seatbelt', enforced: false },
    };
    assert.equal(terminalContent(record).sandboxDenial, undefined);
  });
});

function failedShellRun(): ShellRunRecord {
  return {
    shellRunId: 'shell-1',
    sessionId: 'session-1',
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'tool-1',
    cwd: '/workspace',
    command: 'write outside',
    status: 'failed',
    startedAt: 1,
    updatedAt: 2,
    completedAt: 2,
    exitCode: 1,
    revision: 2,
    output: {
      mode: 'pipes',
      stdout: '',
      stderr: 'Operation not permitted',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
}

function ptyOutput(overrides: Partial<PtyShellOutput>): PtyShellOutput {
  return {
    mode: 'pty',
    screen: '',
    scrollback: '',
    cols: 80,
    rows: 24,
    cursor: { x: 0, y: 0, visible: true },
    alternateScreen: false,
    truncated: false,
    redacted: false,
    ...overrides,
  };
}

function modelTextBytes(output: PtyShellOutput): number {
  const text = output.screen + (output.lastAlternateScreen ?? '') + output.scrollback;
  return Buffer.byteLength(text, 'utf8');
}
