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
import { describe, it } from 'node:test';

import {
  ShellRunUpdateBuffer,
  decodeCanonicalShellToolResultContent,
  mergeShellRunState,
  mergeShellRunStateWithDiagnostics,
  mergeShellRunUpdate,
  projectShellRunUpdateForSession,
  type ShellRunMergeDiagnostic,
  type ShellRunToolResult,
} from '../shell-run-result.js';
import type { ShellRunUpdate } from '../events.js';

describe('mergeShellRunState', () => {
  it('orders state by revision and strips child operations', () => {
    const current = shellRun({ revision: 2, output: pipeOutput('old') });
    const older = shellRun({ revision: 1, output: pipeOutput('stale') });
    const newer = shellRun({
      revision: 3,
      updatedAt: 3,
      output: pipeOutput('new'),
      operation: { kind: 'stop', applied: true },
    });

    const ignored = mergeShellRunState(current, older);
    assert.equal(
      ignored.result.output?.mode === 'pipes' ? ignored.result.output.stdout : '',
      'old',
    );
    const merged = mergeShellRunState(current, newer);
    assert.equal(merged.changed, true);
    assert.equal(merged.result.output?.mode === 'pipes' ? merged.result.output.stdout : '', 'new');
    assert.equal('operation' in merged.result, false);
  });

  it('only enriches a same-revision compact handoff with output', () => {
    const compact = shellRun({ revision: 1, output: undefined });
    const full = shellRun({ revision: 1, output: pipeOutput('ready') });

    const enriched = mergeShellRunState(compact, full);
    assert.equal(enriched.changed, true);
    assert.equal(
      enriched.result.output?.mode === 'pipes' ? enriched.result.output.stdout : '',
      'ready',
    );
    assert.equal(mergeShellRunState(full, compact).changed, false);
  });

  it('rejects conflicting state at one revision and a different ref', () => {
    const current = shellRun({ revision: 2, output: pipeOutput('one') });
    const conflicting = shellRun({ revision: 2, output: pipeOutput('two') });
    const other = shellRun({ ref: 'maka://runtime/background-tasks/other', revision: 3 });

    assert.equal(
      mergeShellRunState(current, conflicting).invariantViolation,
      'same_revision_conflict',
    );
    assert.equal(mergeShellRunState(current, other).invariantViolation, 'ref_mismatch');

    const diagnostics: ShellRunMergeDiagnostic[] = [];
    mergeShellRunStateWithDiagnostics(current, conflicting, 'test.reconciliation', (diagnostic) => {
      diagnostics.push(diagnostic);
    });
    assert.deepEqual(diagnostics, [
      {
        context: 'test.reconciliation',
        violation: 'same_revision_conflict',
        currentRef: current.ref,
        candidateRef: conflicting.ref,
        currentRevision: 2,
        candidateRevision: 2,
      },
    ]);
  });
});

describe('ShellRun view updates', () => {
  it('fans an owner revision into the inherited view identity', () => {
    const inherited = shellRunUpdate({
      sessionId: 'branch',
      ownership: {
        kind: 'source_owned',
        sourceSessionId: 'parent',
        ownerSessionId: 'owner',
      },
      result: shellRun({ revision: 2 }),
    });
    const owner = shellRunUpdate({
      sessionId: 'owner',
      ownership: { kind: 'local' },
      result: shellRun({
        revision: 3,
        status: 'completed',
        completedAt: 3,
        exitCode: 0,
      }),
    });

    const projected = projectShellRunUpdateForSession('branch', [inherited], owner);

    assert.equal(projected.length, 1);
    assert.equal(projected[0]?.sessionId, 'branch');
    assert.equal(projected[0]?.sourceToolCallId, 'bash-1');
    assert.deepEqual(projected[0]?.ownership, inherited.ownership);
    assert.equal(projected[0]?.result.status, 'completed');
    assert.equal(projected[0]?.result.revision, 3);
  });

  it('applies ownership-only changes without letting stale revisions rewrite ownership', () => {
    const owned = shellRunUpdate({
      ownership: {
        kind: 'source_owned',
        sourceSessionId: 'parent',
        ownerSessionId: 'owner',
      },
      result: shellRun({ revision: 2 }),
    });
    const unavailable = shellRunUpdate({
      ownership: { kind: 'source_unavailable', sourceSessionId: 'parent' },
      result: shellRun({ revision: 2 }),
    });
    const changed = mergeShellRunUpdate(owned, unavailable, 'test.ownership');
    assert.equal(changed.changed, true);
    assert.deepEqual(changed.update.ownership, unavailable.ownership);

    const stale = shellRunUpdate({
      ownership: { kind: 'local' },
      result: shellRun({ revision: 1 }),
    });
    const retained = mergeShellRunUpdate(changed.update, stale, 'test.stale-ownership');
    assert.equal(retained.changed, false);
    assert.deepEqual(retained.update.ownership, unavailable.ownership);
  });

  it('bounds hydration updates while retaining the latest revision of recently active refs', () => {
    const buffer = new ShellRunUpdateBuffer('test.hydration-buffer', 2);
    const first = shellRunUpdate({
      result: shellRun({ ref: 'maka://runtime/background-tasks/run-1', revision: 1 }),
    });
    const second = shellRunUpdate({
      result: shellRun({ ref: 'maka://runtime/background-tasks/run-2', revision: 1 }),
    });
    const refreshedFirst = shellRunUpdate({
      result: shellRun({ ref: 'maka://runtime/background-tasks/run-1', revision: 2 }),
    });
    const third = shellRunUpdate({
      result: shellRun({ ref: 'maka://runtime/background-tasks/run-3', revision: 1 }),
    });

    buffer.add(first);
    buffer.add(second);
    buffer.add(refreshedFirst);
    buffer.add(second);
    buffer.add(third);

    assert.equal(buffer.size, 2);
    const drained = buffer.drain();
    assert.equal(drained.overflowed, true);
    assert.deepEqual(
      drained.updates.map((update) => [update.result.ref, update.result.revision]),
      [
        ['maka://runtime/background-tasks/run-1', 2],
        ['maka://runtime/background-tasks/run-3', 1],
      ],
    );
    assert.equal(buffer.size, 0);
    assert.deepEqual(buffer.drain(), { updates: [], overflowed: false });
  });
});

describe('decodeCanonicalShellToolResultContent', () => {
  it('accepts canonical current terminal state and rejects contradictory exit status', () => {
    const current = {
      kind: 'terminal',
      cwd: '/repo',
      cmd: 'printf ok',
      status: 'completed',
      exitCode: 0,
      output: pipeOutput('ok'),
    };
    assert.equal(decodeCanonicalShellToolResultContent(current).state, 'valid');
    assert.equal(
      decodeCanonicalShellToolResultContent({ ...current, exitCode: 1 }).state,
      'invalid',
    );
    assert.equal(
      decodeCanonicalShellToolResultContent({
        kind: 'terminal',
        cwd: '/repo',
        cmd: 'printf bad',
        status: 'completed',
        exitCode: 1,
        stdout: 'bad',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      }).state,
      'invalid',
    );
  });

  it('rejects non-canonical nested output and contradictory current state', () => {
    const valid = shellRun();
    assert.equal(decodeCanonicalShellToolResultContent(valid).state, 'valid');
    assert.equal(
      decodeCanonicalShellToolResultContent({ ...valid, status: 'starting' }).state,
      'valid',
    );

    const invalid = [
      {
        ...valid,
        output: { ...pipeOutput(''), stdoutTail: 'legacy' },
      },
      {
        ...valid,
        completedAt: 2,
      },
      {
        ...valid,
        status: 'completed',
        completedAt: 2,
        exitCode: 1,
      },
    ];
    for (const value of invalid) {
      assert.equal(decodeCanonicalShellToolResultContent(value).state, 'invalid');
    }
  });

  it('accepts queued PTY input and rejects the superseded applied field', () => {
    const base = {
      ...shellRun(),
      mode: 'pty',
      output: {
        mode: 'pty',
        screen: '$ ',
        scrollback: '',
        cols: 80,
        rows: 24,
        cursor: { x: 2, y: 0, visible: true },
        alternateScreen: false,
        truncated: false,
        redacted: false,
      },
    } as const;
    assert.equal(
      decodeCanonicalShellToolResultContent({
        ...base,
        operation: {
          kind: 'pty_control',
          failed: false,
          input: { bytes: 1, queued: true },
        },
      }).state,
      'valid',
    );
    assert.equal(
      decodeCanonicalShellToolResultContent({
        ...base,
        operation: {
          kind: 'pty_control',
          failed: false,
          input: { bytes: 1, applied: true },
        },
      }).state,
      'invalid',
    );
  });
});

function shellRun(
  overrides: Partial<Extract<ShellRunToolResult, { mode: 'pipes' }>> = {},
): Extract<ShellRunToolResult, { mode: 'pipes' }> {
  return {
    kind: 'shell_run',
    ref: 'maka://runtime/background-tasks/run-1',
    mode: 'pipes',
    status: 'running',
    cwd: '/repo',
    cmd: 'sleep 1',
    startedAt: 1,
    updatedAt: overrides.revision ?? 1,
    revision: 1,
    output: pipeOutput(''),
    ...overrides,
  };
}

function pipeOutput(
  stdout: string,
): NonNullable<Extract<ShellRunToolResult, { mode: 'pipes' }>['output']> {
  return {
    mode: 'pipes',
    stdout,
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    redacted: false,
  };
}

function shellRunUpdate(overrides: Partial<ShellRunUpdate>): ShellRunUpdate {
  return {
    sessionId: 'branch',
    ownership: { kind: 'local' },
    sourceTurnId: 'turn-1',
    sourceToolCallId: 'bash-1',
    result: shellRun(),
    ...overrides,
  };
}
