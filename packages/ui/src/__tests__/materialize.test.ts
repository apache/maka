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

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StoredMessage } from '@maka/core/session';
import {
  materializeChat,
  materializeTools,
  materializeTurns,
  overlayLiveTurn,
  type TurnTimelineItem,
} from "../materialize.js";
import {
  applyLiveTurnEvent,
  armLiveTurn,
} from "../live-turn-projection.js";

const originalUser = {
  type: "user" as const,
  id: "original",
  turnId: "t1",
  ts: 1,
  text: "request",
};
const beforeAssistant = {
  type: "assistant" as const,
  id: "before-steer",
  turnId: "t1",
  ts: 2,
  text: "before",
  modelId: "fixture",
};
const steeringUser = {
  type: "user" as const,
  id: "steer-1",
  turnId: "t1",
  ts: 3,
  text: "steer",
};

function timelineText(turn: ReturnType<typeof materializeTurns>[number] | undefined): string[] {
  return turn?.timeline.map((item) =>
    item.kind === "user" ? `user:${item.message.text}` : `${item.kind}:${"text" in item ? item.text : ""}`,
  ) ?? [];
}

describe("steering timeline", () => {
  test("keeps a steering message at its conversational position", () => {
    const [turn] = materializeTurns([
      originalUser,
      beforeAssistant,
      steeringUser,
      {
        type: "assistant",
        id: "after-steer",
        turnId: "t1",
        ts: 4,
        text: "after",
        modelId: "fixture",
      },
    ]);

    assert.deepEqual(timelineText(turn), [
      "text:before",
      "user:steer",
      "text:after",
    ]);
  });

  test("renders one live steering message while its persisted row catches up", () => {
    const settled = materializeTurns([originalUser]);
    const before = applyLiveTurnEvent(armLiveTurn("t1"), {
      type: "text_complete",
      id: "event-before",
      messageId: "before-steer",
      turnId: "t1",
      ts: 1,
      text: "before",
    });
    const live = applyLiveTurnEvent(before, {
      type: "steering_message",
      id: "event-steer",
      messageId: "steer-1",
      turnId: "t1",
      ts: 2,
      content: { text: "inserted instruction" },
    });

    const [overlaid] = overlayLiveTurn(settled, live);
    assert.deepEqual(timelineText(overlaid), ["text:before", "user:inserted instruction"]);

    const persisted = materializeTurns([
      originalUser,
      beforeAssistant,
      { type: "user", id: "steer-1", turnId: "t1", ts: 2, text: "inserted instruction" },
    ]);
    const [deduplicated] = overlayLiveTurn(persisted, live);
    assert.deepEqual(timelineText(deduplicated), ["text:before", "user:inserted instruction"]);
  });

  test("keeps the current answer ahead of a durable steering event that arrives first", () => {
    const persisted = materializeTurns([
      originalUser,
      {
        type: "user",
        id: "steer-1",
        turnId: "t1",
        ts: 2,
        text: "inserted instruction",
        steeringEventId: "event-steer",
      },
    ]);
    const live = applyLiveTurnEvent(armLiveTurn("t1"), {
      type: "text_delta",
      id: "event-before",
      messageId: "before-steer",
      turnId: "t1",
      ts: 1,
      text: "before",
    });

    const [overlaid] = overlayLiveTurn(persisted, live);

    assert.deepEqual(timelineText(overlaid), ["text:before", "user:inserted instruction"]);
  });

  test("keeps a persisted tool before live steering during handoff", () => {
    const persisted = materializeTurns([
      originalUser,
      {
        type: "tool_call",
        id: "tool-1",
        turnId: "t1",
        stepId: "tool-step",
        ts: 2,
        toolName: "Read",
        args: {},
      },
      steeringUser,
    ]);
    const tool = applyLiveTurnEvent(armLiveTurn("t1"), {
      type: "tool_start",
      id: "tool-event",
      turnId: "t1",
      stepId: "tool-step",
      toolUseId: "tool-1",
      toolName: "Read",
      args: {},
      ts: 2,
    });
    const steering = applyLiveTurnEvent(tool, {
      type: "steering_message",
      id: "steer-event",
      messageId: "steer-1",
      turnId: "t1",
      ts: 3,
      content: { text: "steer" },
    });
    const live = applyLiveTurnEvent(steering, {
      type: "text_delta",
      id: "text-event",
      messageId: "after-steer",
      turnId: "t1",
      ts: 4,
      text: "after",
    });

    const [overlaid] = overlayLiveTurn(persisted, live);
    assert.deepEqual(timelineText(overlaid), ["tools:", "user:steer", "text:after"]);
    assert.deepEqual(
      overlaid?.timeline.flatMap((item) =>
        item.kind === "tools" ? item.items.map((tool) => tool.toolUseId) : []),
      ["tool-1"],
    );
  });
});

describe("materializeChat message metadata", () => {
  test("preserves an explicit empty reference projection as the new-format marker", () => {
    const messages: StoredMessage[] = [
      {
        type: "user",
        id: "m-empty",
        turnId: "t-empty",
        ts: 1,
        text: "plain text",
        inlineReferences: [],
      },
    ];
    assert.deepEqual(materializeChat(messages)[0]?.inlineReferences, []);
    assert.deepEqual(materializeTurns(messages)[0]?.user?.inlineReferences, []);
  });

  test("preserves Host provenance on a Goal continuation", () => {
    const messages: StoredMessage[] = [
      {
        type: "user",
        id: "m1",
        turnId: "t1",
        ts: 1,
        text: "[Goal continuation] Keep working.",
        origin: { kind: "goal", goalId: "goal-1" },
      },
    ];

    assert.deepEqual(materializeChat(messages)[0]?.hostOrigin, {
      kind: "goal",
      goalId: "goal-1",
    });
    assert.deepEqual(materializeTurns(messages)[0]?.user?.hostOrigin, {
      kind: "goal",
      goalId: "goal-1",
    });
  });
});

// ── #1307: the timeline model stays flat (fold is a render concern) ──────────

function userMsg(turnId: string, ts: number, text: string): StoredMessage {
  return { type: "user", id: `u-${turnId}`, turnId, ts, text };
}

test('retains persisted nested tool activity identity', () => {
  const [tool] = materializeTools([{
    type: 'tool_call',
    id: 'nested-1',
    turnId: 'turn-1',
    ts: 1,
    toolName: 'Read',
    args: { path: 'README.md' },
    origin: 'code_mode',
    modelVisibility: 'hidden',
    parentToolCallId: 'exec-1',
    parentOperationId: 'exec-operation-1',
  }]);

  assert.deepEqual(tool, {
    toolUseId: 'nested-1',
    toolName: 'Read',
    activityKind: undefined,
    displayName: undefined,
    intent: undefined,
    status: 'interrupted',
    args: { path: 'README.md' },
    result: undefined,
    durationMs: undefined,
    origin: 'code_mode',
    modelVisibility: 'hidden',
    parentToolCallId: 'exec-1',
    parentOperationId: 'exec-operation-1',
  });
});

function shellRunResult(revision: number) {
  return {
    kind: "shell_run" as const,
    ref: "maka://runtime/background-tasks/pty-1",
    mode: "pty" as const,
    status: "running" as const,
    cwd: "/repo",
    cmd: "job",
    startedAt: 1,
    updatedAt: revision,
    revision,
    output: {
      mode: "pty" as const,
      screen: "ready",
      scrollback: "",
      cols: 80,
      rows: 24,
      cursor: { x: 0, y: 0, visible: true },
      alternateScreen: false,
      truncated: false,
      redacted: false,
    },
  };
}

describe("flat timeline under tool projection (#1307 P1 regression)", () => {
  test("shell-run folding away a turn’s only tool leaves a flat thinking-only timeline", () => {
    // Turn t1 owns the Bash ShellRun parent; the live turn t2's ONLY tool is a
    // Read carrying a shell_run result with the same ref, so foldShellRunTurns
    // merges it into t1's Bash and drops it from t2 entirely. With the fold
    // living in the model this used to strand an illegal thinking-only
    // "processing" block with an empty summary; the flat model simply drops
    // the emptied tools group.
    const settled = materializeTurns([
      {
        type: "tool_call",
        id: "bash-1",
        turnId: "t1",
        ts: 1,
        toolName: "Bash",
        args: { command: "job", pty: true },
      },
      {
        type: "tool_result",
        id: "r-bash-1",
        turnId: "t1",
        ts: 2,
        toolUseId: "bash-1",
        isError: false,
        content: shellRunResult(1),
      },
      userMsg("t2", 3, "q"),
    ]);
    const turns = overlayLiveTurn(settled, {
      turnId: "t2",
      phase: "streamed",
      steps: [
        {
          stepId: "a1",
          thinking: {
            text: "watching the background job",
            truncated: false,
            complete: false,
          },
          tools: [
            {
              toolUseId: "read-1",
              toolName: "Read",
              stepId: "a1",
              status: "completed",
              args: {},
              result: shellRunResult(2),
            },
          ],
        },
      ],
    });
    const liveTurn = turns.find((turn) => turn.turnId === "t2");
    assert.deepEqual(
      liveTurn?.timeline.map((item: TurnTimelineItem) => item.kind),
      ["thinking"],
    );
  });
});

describe("live content over persisted partial rows", () => {
  test("replaces persisted thinking with its live projection instead of rendering it twice", () => {
    const settled = materializeTurns([
      userMsg("t1", 1, "inspect it"),
      {
        type: "turn_state",
        id: "state-1",
        turnId: "t1",
        ts: 2,
        status: "running",
        partialOutputRetained: false,
      },
      {
        type: "assistant",
        id: "assistant-1",
        turnId: "t1",
        ts: 3,
        text: "",
        modelId: "test-model",
        thinking: { text: "persisted partial" },
        contentOrder: ["thinking"],
      },
    ]);
    const turns = overlayLiveTurn(settled, {
      turnId: "t1",
      phase: "streamed",
      steps: [
        {
          stepId: "assistant-1",
          thinking: {
            text: "complete live reasoning",
            truncated: false,
            complete: false,
          },
          contentOrder: ["thinking"],
          tools: [],
        },
      ],
    });
    const thinking = turns[0]?.timeline.filter(
      (item) => item.kind === "thinking",
    );

    assert.equal(thinking?.length, 1);
    assert.equal(
      thinking?.[0]?.kind === "thinking" ? thinking[0].text : undefined,
      "complete live reasoning",
    );
  });
});

describe("unfinished tools take their status from the turn", () => {
  // A missing tool_result is the absence of evidence, not evidence of a
  // terminal state. The turn record says which: a running turn means the call
  // is still in flight. This is the persisted-only path — no live projection —
  // which is what a reader sees after a renderer reload or when it re-attaches
  // to a session running in the background.
  test("reads an unfinished call in a running turn as running", () => {
    const [turn] = materializeTurns([
      userMsg("t1", 1, "run it"),
      {
        type: "turn_state",
        id: "s1",
        turnId: "t1",
        ts: 2,
        status: "running",
        partialOutputRetained: false,
      },
      {
        type: "tool_call",
        id: "bash-1",
        turnId: "t1",
        ts: 3,
        toolName: "Bash",
        args: { command: "sleep 600" },
      },
    ]);
    assert.equal(turn?.status, "running");
    assert.equal(turn?.tools[0]?.status, "running");
  });

  test("reads an unfinished call in a terminal turn as interrupted", () => {
    const [turn] = materializeTurns([
      userMsg("t1", 1, "run it"),
      {
        type: "turn_state",
        id: "s1",
        turnId: "t1",
        ts: 2,
        status: "failed",
        partialOutputRetained: false,
      },
      {
        type: "tool_call",
        id: "bash-1",
        turnId: "t1",
        ts: 3,
        toolName: "Bash",
        args: { command: "sleep 600" },
      },
    ]);
    assert.equal(turn?.tools[0]?.status, "interrupted");
  });
});

describe("live tool status over persisted", () => {
  // Runtime appends turn_state when the turn opens, before any tool_call, so a
  // turn that can have a live projection always has one on disk.
  test("keeps a still-running tool running when persisted has no result yet", () => {
    const settled = materializeTurns([
      userMsg("t1", 1, "run it"),
      {
        type: "turn_state",
        id: "s1",
        turnId: "t1",
        ts: 2,
        status: "running",
        partialOutputRetained: false,
      },
      {
        type: "tool_call",
        id: "bash-1",
        turnId: "t1",
        ts: 3,
        toolName: "Bash",
        args: { command: "sleep 60" },
      },
    ]);
    const turns = overlayLiveTurn(settled, {
      turnId: "t1",
      phase: "streamed",
      steps: [
        {
          stepId: "a1",
          tools: [
            {
              toolUseId: "bash-1",
              toolName: "Bash",
              stepId: "a1",
              status: "running",
              args: { command: "sleep 60" },
            },
          ],
        },
      ],
    });
    const tools = turns
      .find((turn) => turn.turnId === "t1")
      ?.timeline.find((item: TurnTimelineItem) => item.kind === "tools");
    assert.equal(
      tools?.kind === "tools" ? tools.items[0]?.status : undefined,
      "running",
    );
  });

  test("a stale live running loses to a terminal turn", () => {
    const settled = materializeTurns([
      userMsg("t1", 1, "run it"),
      {
        type: "turn_state",
        id: "s1",
        turnId: "t1",
        ts: 2,
        status: "failed",
        partialOutputRetained: false,
      },
      {
        type: "tool_call",
        id: "bash-1",
        turnId: "t1",
        ts: 3,
        toolName: "Bash",
        args: { command: "sleep 60" },
      },
    ]);
    const turns = overlayLiveTurn(settled, {
      turnId: "t1",
      phase: "streamed",
      steps: [
        {
          stepId: "a1",
          tools: [
            {
              toolUseId: "bash-1",
              toolName: "Bash",
              stepId: "a1",
              status: "running",
              args: { command: "sleep 60" },
              outputChunks: [
                {
                  seq: 0,
                  stream: "stdout",
                  text: "partial output",
                  redacted: false,
                  createdAt: 4,
                },
              ],
            },
          ],
        },
      ],
    });
    const tools = turns
      .find((turn) => turn.turnId === "t1")
      ?.timeline.find((item: TurnTimelineItem) => item.kind === "tools");
    const tool = tools?.kind === "tools" ? tools.items[0] : undefined;
    assert.equal(tool?.status, "interrupted");
    assert.equal(tool?.outputChunks?.length, 1);
  });

  test("keeps durable tool detail while a Runtime Host Turn is still live", () => {
    const settled = materializeTurns([
      userMsg("t1", 1, "use the computer"),
      {
        type: "turn_state",
        id: "s1",
        turnId: "t1",
        ts: 2,
        status: "running",
        partialOutputRetained: false,
      },
      {
        type: "tool_call",
        id: "computer-1",
        turnId: "t1",
        ts: 3,
        toolName: "maka_computer",
        args: { action: "click_element", element_id: "615" },
      },
      {
        type: "tool_result",
        id: "result-1",
        turnId: "t1",
        ts: 4,
        toolUseId: "computer-1",
        isError: false,
        content: { kind: "text", text: "unsupported_action" },
      },
    ]);

    const turns = overlayLiveTurn(settled, {
      turnId: "t1",
      phase: "streamed",
      steps: [
        {
          stepId: "tool:computer-1",
          tools: [
            {
              toolUseId: "computer-1",
              toolName: "maka_computer",
              status: "running",
              args: undefined,
              // Runtime Host live events carry lifecycle but not the durable
              // result payload.
              result: { kind: "text", text: "" },
            },
          ],
        },
      ],
    });

    const toolGroup = turns
      .find((turn) => turn.turnId === "t1")
      ?.timeline.find((item: TurnTimelineItem) => item.kind === "tools");
    const tool = toolGroup?.kind === "tools" ? toolGroup.items[0] : undefined;
    assert.deepEqual(tool?.args, {
      action: "click_element",
      element_id: "615",
    });
    assert.deepEqual(tool?.result, {
      kind: "text",
      text: "unsupported_action",
    });
    assert.equal(tool?.status, "running");
  });

  // Deleting the merge exception rests entirely on the live side carrying its
  // own interrupted signal, so drive the real chain — a tool_start followed by
  // an abort — rather than hand-building an already-interrupted projection,
  // which would pass on the spread alone.
  test("an aborted turn interrupts its in-flight tool through the live chain", () => {
    const settled = materializeTurns([
      userMsg("t1", 1, "run it"),
      {
        type: "turn_state",
        id: "s1",
        turnId: "t1",
        ts: 2,
        status: "running",
        partialOutputRetained: false,
      },
      {
        type: "tool_call",
        id: "bash-1",
        turnId: "t1",
        ts: 3,
        toolName: "Bash",
        args: { command: "sleep 60" },
      },
    ]);
    const started = applyLiveTurnEvent(armLiveTurn("t1"), {
      type: "tool_start",
      id: "event-1",
      turnId: "t1",
      toolUseId: "bash-1",
      toolName: "Bash",
      args: { command: "sleep 60" },
      ts: 4,
    });
    const running = applyLiveTurnEvent(started, {
      type: "tool_output_delta",
      id: "event-2",
      turnId: "t1",
      sessionId: "s",
      toolCallId: "bash-1",
      toolUseId: "bash-1",
      seq: 0,
      stream: "stdout",
      chunk: "still going\n",
      redacted: false,
      createdAt: 5,
      ts: 5,
    });
    assert.equal(running?.steps[0]?.tools[0]?.status, "running");

    const aborted = applyLiveTurnEvent(running, {
      type: "abort",
      id: "event-3",
      turnId: "t1",
      reason: "user_stop",
      ts: 6,
    });
    const tools = overlayLiveTurn(settled, aborted!)
      .find((turn) => turn.turnId === "t1")
      ?.timeline.find((item: TurnTimelineItem) => item.kind === "tools");
    assert.equal(
      tools?.kind === "tools" ? tools.items[0]?.status : undefined,
      "interrupted",
    );
  });
});
