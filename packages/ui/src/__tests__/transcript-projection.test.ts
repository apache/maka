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
import type { ShellRunSnapshotResult, ShellRunUpdate } from '@maka/core/events';
import type { ShellRunToolResult } from '@maka/core/shell-run-result';
import type { StoredMessage } from '@maka/core/session';
import { createTranscriptProjection, valuesEqual } from '../transcript-projection.js';
import { foldShellRunToolActivities, timelineTools, type ToolActivityItem, type TurnViewModel } from '../materialize.js';
import type { LiveTurnProjection } from '../live-turn-projection.js';

const REF = 'maka://runtime/background-tasks/pty-1';
const SESSION = 'session-1';

/**
 * A transcript with background-command history: `turn-1` owns a Bash whose
 * durable revision permanently leads the `tool_result` snapshot persisted in
 * messages. Re-deriving the overlay per token rebuilt that turn on every
 * delta; the projection has to merge it once.
 */
function history(): StoredMessage[] {
  return [
    { type: 'user', id: 'u1', turnId: 'turn-1', ts: 1, text: 'run a job' },
    toolCall('bash-1', 'turn-1', 'Bash', { command: 'job', pty: true }, 2),
    toolResult('bash-1', 'turn-1', shellRun(1), 3),
    { type: 'assistant', id: 'a1', turnId: 'turn-1', ts: 4, text: 'started', modelId: 'model-1' },
    { type: 'user', id: 'u2', turnId: 'turn-2', ts: 5, text: 'and now?' },
    { type: 'assistant', id: 'a2', turnId: 'turn-2', ts: 6, text: 'done', modelId: 'model-1' },
  ];
}

const backgroundUpdate: ShellRunUpdate = {
  sessionId: SESSION,
  ownership: { kind: 'local' },
  sourceTurnId: 'turn-1',
  sourceToolCallId: 'bash-1',
  result: shellRunSnapshot(9),
};

function streamingTurn(text: string): LiveTurnProjection {
  return {
    turnId: 'turn-3',
    phase: 'streamed',
    steps: [{
      stepId: 'step-1',
      contentOrder: ['text'],
      text: { text, truncated: false, complete: false },
      tools: [],
    }],
  };
}

describe('incremental transcript projection', () => {

  test('a shell-run update whose semantics are unchanged affects nothing', () => {
    const projection = createTranscriptProjection();
    const messages = history();
    const base = { sessionId: SESSION, messages, liveTurn: streamingTurn('he') };
    const settled = projection.project({ ...base, shellRunUpdates: [backgroundUpdate] });

    // A new update object carrying an already-merged revision says nothing new.
    const restated = projection.project({
      ...base,
      shellRunUpdates: [{ ...backgroundUpdate, result: shellRunSnapshot(9) }],
    });
    assert.strictEqual(restated, settled, 'a restated revision must not move a single turn');

    const advanced = projection.project({
      ...base,
      shellRunUpdates: [{ ...backgroundUpdate, result: shellRunSnapshot(10) }],
    });
    assert.notStrictEqual(advanced[0], settled[0], 'a real revision advance must move the owning turn');
    assert.strictEqual(advanced[1], settled[1]);
    const advancedBash = advanced[0]?.tools[0];
    assert.equal(advancedBash?.result?.kind === 'shell_run' ? advancedBash.result.revision : undefined, 10);
  });



  test('a turn missing from the durable snapshot is dropped, leaving the rest identical', () => {
    const projection = createTranscriptProjection();
    const before = projection.project({ sessionId: SESSION, messages: history() });
    const after = projection.project({ sessionId: SESSION, messages: history().slice(0, 4) });
    assert.notStrictEqual(after, before, 'a dropped turn must move the published list');
    assert.deepEqual(after.map((turn) => turn.turnId), ['turn-1']);
    assert.strictEqual(after[0], before[0]);
  });

  test('deleting an earlier turn keeps the surviving turns identical', () => {
    // Turn order shifts, so identity cannot come from position — a surviving
    // turn is recognised by value, wherever it lands.
    const projection = createTranscriptProjection();
    const before = projection.project({
      sessionId: SESSION,
      messages: [
        ...history(),
        { type: 'user', id: 'u3', turnId: 'turn-3', ts: 7, text: 'third' },
        { type: 'assistant', id: 'a3', turnId: 'turn-3', ts: 8, text: 'third answer', modelId: 'model-1' },
      ],
    });
    const after = projection.project({
      sessionId: SESSION,
      messages: [
        ...history().slice(0, 4),
        { type: 'user', id: 'u3', turnId: 'turn-3', ts: 7, text: 'third' },
        { type: 'assistant', id: 'a3', turnId: 'turn-3', ts: 8, text: 'third answer', modelId: 'model-1' },
      ],
    });
    assert.deepEqual(after.map((turn) => turn.turnId), ['turn-1', 'turn-3']);
    assert.strictEqual(after[0], before[0]);
    assert.strictEqual(after[1], before[2], 'the turn that moved up keeps identity');
  });

  test('an edited-and-resent prompt invalidates its own turn and nothing before it', () => {
    const projection = createTranscriptProjection();
    const before = projection.project({ sessionId: SESSION, messages: history() });
    const after = projection.project({
      sessionId: SESSION,
      messages: [
        ...history().slice(0, 4),
        { type: 'user', id: 'u2', turnId: 'turn-2', ts: 5, text: 'and now, differently?' },
        { type: 'assistant', id: 'a2', turnId: 'turn-2', ts: 6, text: 'done', modelId: 'model-1' },
      ],
    });
    assert.strictEqual(after[0], before[0]);
    assert.notStrictEqual(after[1], before[1]);
    assert.equal(after[1]?.user?.text, 'and now, differently?');
  });

  test('a live step handed off to durable messages rebuilds only its own turn', () => {
    const projection = createTranscriptProjection();
    const live = projection.project({
      sessionId: SESSION,
      messages: [...history(), { type: 'user', id: 'u3', turnId: 'turn-3', ts: 7, text: 'third' }],
      liveTurn: streamingTurn('half an ans'),
    });
    assert.equal(live[2]?.timeline.some((item) => item.kind === 'text' && item.live === true), true);

    // Handoff: the answer lands in messages and the live projection retires.
    const settled = projection.project({
      sessionId: SESSION,
      messages: [
        ...history(),
        { type: 'user', id: 'u3', turnId: 'turn-3', ts: 7, text: 'third' },
        { type: 'assistant', id: 'step-1', turnId: 'turn-3', ts: 8, text: 'half an answer', modelId: 'model-1' },
      ],
    });
    assert.strictEqual(settled[0], live[0], 'the handoff is not a whole-transcript event');
    assert.strictEqual(settled[1], live[1]);
    assert.notStrictEqual(settled[2], live[2], 'the turn genuinely changed, so its reference must move');
    assert.equal(settled[2]?.assistant?.text, 'half an answer');
    assert.equal(
      settled[2]?.timeline.some((item) => item.kind === 'text' && item.live === true),
      false,
      'the live text must not survive its handoff',
    );
  });


  test('an ownership flip at an unchanged revision invalidates the owning turn', () => {
    // Isolating the ownership term: the persisted result and the update carry
    // the SAME revision, so the state merge reports no change and the badge is
    // the only thing that moved. A source session closing after its idle pty
    // wrote its last output reaches exactly this state. With a leading
    // revision the merge would mask the ownership comparison entirely.
    const projection = createTranscriptProjection();
    const messages = history();
    const owned: ShellRunUpdate = {
      sessionId: SESSION,
      ownership: { kind: 'source_owned', sourceSessionId: 'source', ownerSessionId: 'source' },
      sourceTurnId: 'turn-1',
      sourceToolCallId: 'bash-1',
      result: shellRunSnapshot(1),
    };
    const before = projection.project({ sessionId: SESSION, messages, shellRunUpdates: [owned] });
    const bash = before[0]?.tools[0];
    assert.equal(bash?.shellRunSource, 'owned');
    assert.equal(bash?.result?.kind === 'shell_run' ? bash.result.revision : undefined, 1);

    const after = projection.project({
      sessionId: SESSION,
      messages,
      shellRunUpdates: [{
        ...owned,
        ownership: { kind: 'source_unavailable', sourceSessionId: 'source' },
        result: shellRunSnapshot(1),
      }],
    });
    assert.notStrictEqual(after[0], before[0], 'the ownership badge moved, so the owning turn must move');
    assert.equal(after[0]?.tools[0]?.shellRunSource, 'unavailable');
    assert.strictEqual(after[1], before[1]);
  });

  test('a plain text delta never touches the message log at all', () => {
    // The one claim this whole layer exists to make. Every property read is
    // counted, not just `Symbol.iterator`: a pass that re-derives the
    // transcript per token with `filter`/`map`/`slice` or a plain index loop
    // reads the array without ever iterating it, which is exactly the shape of
    // regression that made the original defect invisible.
    const projection = createTranscriptProjection();
    let reads = 0;
    const messages = history();
    const counted = new Proxy(messages, {
      get(target, property, receiver) {
        reads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    projection.project({
      sessionId: SESSION,
      messages: counted,
      liveTurn: streamingTurn('h'),
      shellRunUpdates: [backgroundUpdate],
    });
    // Bounded, not merely non-zero: the first projection walks the log a small
    // constant number of times, so a second full pass would fail here too.
    // Measured at 10 reads per message; the ceiling leaves headroom for an
    // extra property lookup per message but not for another whole pass.
    assert.ok(reads >= messages.length, `the first projection must read the log (${reads})`);
    assert.ok(reads <= 14 * messages.length, `the first projection must not walk the log repeatedly (${reads})`);

    const baseline = reads;
    for (const text of ['he', 'hel', 'hell', 'hello']) {
      projection.project({
        sessionId: SESSION,
        messages: counted,
        liveTurn: streamingTurn(text),
        shellRunUpdates: [backgroundUpdate],
      });
    }
    assert.equal(reads, baseline, 'a delta must not read the message log at all');
  });

  test('an update list mutated in place still advances the projection', () => {
    // The store hands the same array back after pushing into it. Remembering
    // the caller's array by reference would make it compare equal to itself and
    // silently swallow the new update.
    const projection = createTranscriptProjection();
    const messages = history();
    const updates: ShellRunUpdate[] = [backgroundUpdate];
    const before = projection.project({ sessionId: SESSION, messages, shellRunUpdates: updates });
    assert.equal(revisionOf(before[0]), 9);

    updates.push({ ...backgroundUpdate, result: shellRunSnapshot(21) });
    const after = projection.project({ sessionId: SESSION, messages, shellRunUpdates: updates });
    assert.equal(revisionOf(after[0]), 21, 'an update appended to the same array must be applied');
  });

  test('a session switch shows the new session and retains nothing of the old', () => {
    // Two sessions in one revision lineage can carry the same turn and message
    // ids with different content. Correctness here comes from the value
    // reconciliation, which cannot reuse a turn whose content differs — the
    // sessionId reset is hygiene, bounding what the projection holds on to
    // rather than standing between the user and a stale transcript.
    const projection = createTranscriptProjection();
    const first = projection.project({ sessionId: SESSION, messages: history() });
    const other = projection.project({
      sessionId: 'session-2',
      messages: [
        ...history().slice(0, 5),
        { type: 'assistant', id: 'a2', turnId: 'turn-2', ts: 6, text: 'a different answer', modelId: 'model-1' },
      ],
    });
    assert.notStrictEqual(other[0], first[0], 'a turn from the previous session must not be retained');
    assert.equal(other[1]?.assistant?.text, 'a different answer');

    // Nothing of session-1 survived: re-projecting it rebuilds every turn.
    const back = projection.project({ sessionId: SESSION, messages: history() });
    assert.notStrictEqual(back[0], first[0]);
    assert.notStrictEqual(back[1], first[1]);
  });

  test('affects the ShellRun owner turn, not the turn the event names', () => {
    // A WriteStdin in turn-2 carries a shell_run whose `ref` belongs to the
    // Bash in turn-1, and `foldShellRunToolActivities` folds it back into that
    // owner. The turn an event names is therefore NOT the set of turns it
    // affects — which is why the affected set is derived from the projection's
    // own output rather than passed through from the event.
    const projection = createTranscriptProjection();
    const before = projection.project({ sessionId: SESSION, messages: history() });
    const after = projection.project({
      sessionId: SESSION,
      messages: [
        ...history(),
        toolCall('write-1', 'turn-3', 'WriteStdin', { ref: REF, input: 'go\n' }, 7),
        toolResult('write-1', 'turn-3', shellRun(4), 8),
      ],
    });
    assert.notStrictEqual(after[0], before[0], 'the owner turn moved, though the event named turn-3');
    const owner = after[0]?.tools[0];
    assert.equal(owner?.toolName, 'Bash');
    assert.equal(owner?.result?.kind === 'shell_run' ? owner.result.revision : undefined, 4);
    assert.strictEqual(after[1], before[1], 'the untouched turn keeps identity');
  });

  test('folds a child that renders ahead of the Bash owning the run', () => {
    // A turn's tools are a flattening of its timeline, and a live overlay moves
    // that turn's tools to the end of it — which can order a child ahead of its
    // parent. Folding must not depend on that order: scanning only what has
    // been folded so far would leave the child as an orphan row and never take
    // its revision into the parent.
    const child: ToolActivityItem = {
      toolUseId: 'stop-1',
      toolName: 'StopBackgroundTask',
      status: 'completed',
      args: {},
      result: shellRun(5),
    };
    const parent: ToolActivityItem = {
      toolUseId: 'bash-1',
      toolName: 'Bash',
      status: 'running',
      args: {},
      result: shellRun(1),
    };
    const folded = foldShellRunToolActivities([child, parent]);
    assert.deepEqual(folded.map((tool) => tool.toolUseId), ['bash-1']);
    const result = folded[0]?.result;
    assert.equal(result?.kind === 'shell_run' ? result.revision : undefined, 5);
  });

  test('applies an update whose only target is a live-only tool', () => {
    // A durable update can arrive before the Bash tool_call is persisted, so
    // the canonical settled tool map has no target for it yet. The overlay runs
    // over the live-merged turns, where the live-only tool already exists.
    const projection = createTranscriptProjection();
    const turns = projection.project({
      sessionId: SESSION,
      messages: [],
      liveTurn: {
        turnId: 'turn-live',
        phase: 'streamed',
        steps: [{
          stepId: 'tool:bash-live',
          contentOrder: ['tools'],
          tools: [{ toolUseId: 'bash-live', toolName: 'Bash', status: 'running', args: { command: 'job', pty: true } }],
        }],
      },
      shellRunUpdates: [{
        sessionId: SESSION,
        ownership: { kind: 'source_owned', sourceSessionId: 'source', ownerSessionId: 'source' },
        sourceTurnId: 'turn-live',
        sourceToolCallId: 'bash-live',
        result: shellRunSnapshot(2),
      }],
    });
    assert.deepEqual(turns.map((turn) => turn.turnId), ['turn-live']);
    const tool = turns[0]?.tools[0];
    assert.equal(tool?.result?.kind, 'shell_run');
    assert.equal(tool?.shellRunSource, 'owned');
  });
});

/**
 * Representative scalar, nested, content, and derived changes must invalidate
 * the memoized turn identity.
 */
describe('turn identity moves across structural change classes', () => {
  const base: StoredMessage[] = [
    { type: 'user', id: 'u1', turnId: 'turn-1', ts: 1, text: 'ask' },
    { type: 'assistant', id: 'a1', turnId: 'turn-1', ts: 4, text: 'answer', modelId: 'model-1' },
    { type: 'turn_state', id: 's1', turnId: 'turn-1', ts: 5, status: 'completed', partialOutputRetained: false },
  ];

  const cases: Array<{
    field: keyof TurnViewModel;
    /** Rows whose field cannot be isolated against the shared base bring their own. */
    from?: StoredMessage[];
    refresh: StoredMessage[];
  }> = [
    {
      field: 'tools',
      refresh: [...base, toolCall('read-1', 'turn-1', 'Read', { path: '/x' }, 6)],
    },
    {
      field: 'status',
      refresh: [
        ...base.slice(0, 2),
        { type: 'turn_state', id: 's1', turnId: 'turn-1', ts: 5, status: 'failed', partialOutputRetained: false },
      ],
    },
    {
      field: 'partialOutputRetained',
      // Recorded OR derived from the turn's own content, so isolating the
      // recorded term needs a turn that produced nothing.
      from: [
        base[0]!,
        { type: 'turn_state', id: 's1', turnId: 'turn-1', ts: 5, status: 'aborted', partialOutputRetained: false },
      ],
      refresh: [
        base[0]!,
        { type: 'turn_state', id: 's1', turnId: 'turn-1', ts: 5, status: 'aborted', partialOutputRetained: true },
      ],
    },
    {
      field: 'assistant',
      refresh: [
        base[0]!,
        { type: 'assistant', id: 'a1', turnId: 'turn-1', ts: 4, text: 'a longer answer', modelId: 'model-1' },
        base[2]!,
      ],
    },
  ];

  for (const { field, from, refresh } of cases) {
    test(`a refresh that only changes \`${field}\` moves the turn`, () => {
      const projection = createTranscriptProjection();
      const before = projection.project({ sessionId: SESSION, messages: from ?? base });
      // A refresh re-reads the ledger over IPC: all-new objects either way, so
      // identity can only come from the value comparison under test.
      const after = projection.project({ sessionId: SESSION, messages: refresh });

      // Self-check: the row really does move the field it names, so a row that
      // stops isolating its field fails loudly instead of passing vacuously.
      assert.notDeepEqual(after[0]?.[field], before[0]?.[field], `\`${field}\` must actually differ`);
      assert.notStrictEqual(after[0], before[0], `a moved \`${field}\` must move the turn`);
    });
  }
});

describe('valuesEqual', () => {
  test('fails closed on anything that is not a plain object', () => {
    // These have no own enumerable keys, so a plain key walk calls every one of
    // them equal. `TurnFooterContext.pendingActions` is already a ReadonlySet;
    // the day one of these reaches a derived per-turn prop, "equal" would mean
    // the UI stops updating rather than merely re-rendering once too often.
    assert.equal(valuesEqual(new Set([1]), new Set([2])), false);
    assert.equal(valuesEqual(new Set([1]), {}), false);
    assert.equal(valuesEqual(new Map([['a', 1]]), new Map([['a', 2]])), false);
    assert.equal(valuesEqual(new Date(0), new Date(999)), false);
    assert.equal(valuesEqual(new Error('a'), new Error('b')), false);
    // Identity still short circuits, and a shared reference nested in plain
    // data stays comparable.
    const shared = new Set([1]);
    assert.equal(valuesEqual(shared, shared), true);
    assert.equal(valuesEqual({ set: shared }, { set: shared }), true);
    assert.equal(valuesEqual({ set: shared }, { set: new Set([1]) }), false);
  });
});

function revisionOf(turn: TurnViewModel | undefined): number | undefined {
  const result = turn?.tools[0]?.result;
  return result?.kind === 'shell_run' ? result.revision : undefined;
}

function toolCall(
  id: string,
  turnId: string,
  toolName: string,
  args: unknown,
  ts: number,
): Extract<StoredMessage, { type: 'tool_call' }> {
  return { type: 'tool_call', id, turnId, ts, toolName, args };
}

function toolResult(
  toolUseId: string,
  turnId: string,
  content: ShellRunToolResult,
  ts: number,
): Extract<StoredMessage, { type: 'tool_result' }> {
  return { type: 'tool_result', id: `result-${toolUseId}`, turnId, ts, toolUseId, isError: false, content };
}

function shellRun(revision: number): Extract<ShellRunToolResult, { mode: 'pty' }> {
  return {
    kind: 'shell_run',
    ref: REF,
    mode: 'pty',
    status: 'running',
    cwd: '/repo',
    cmd: 'job',
    startedAt: 1,
    updatedAt: revision,
    revision,
    output: {
      mode: 'pty',
      screen: 'ready',
      scrollback: '',
      cols: 80,
      rows: 24,
      cursor: { x: 5, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
  };
}

function shellRunSnapshot(revision: number): Extract<ShellRunSnapshotResult, { mode: 'pty' }> {
  return {
    kind: 'shell_run',
    ref: REF,
    mode: 'pty',
    status: 'running',
    cwd: '/repo',
    cmd: 'job',
    startedAt: 1,
    updatedAt: revision,
    revision,
    output: {
      mode: 'pty',
      screen: 'ready',
      scrollback: '',
      cols: 80,
      rows: 24,
      cursor: { x: 5, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
  };
}
