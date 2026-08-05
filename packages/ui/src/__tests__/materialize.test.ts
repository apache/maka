import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AttachmentRef, StoredMessage } from "@maka/core";
import {
  materializeChat,
  materializeTools,
  materializeTurns,
  overlayLiveTurn,
  type TurnTimelineItem,
} from "../materialize.js";
import { applyLiveTurnEvent, armLiveTurn } from "../live-turn-projection.js";

const imageAttachment: AttachmentRef = {
  kind: "image",
  name: "chart.png",
  mimeType: "image/png",
  bytes: 1024,
  ref: { kind: "session_file", sessionId: "s1", relativePath: "chart.png" },
};

const codeAttachment: AttachmentRef = {
  kind: "code",
  name: "main.ts",
  mimeType: "text/typescript",
  bytes: 512,
  ref: { kind: "workspace_file", relativePath: "src/main.ts" },
};

describe("materializeChat attachments", () => {
  test("projects frozen inline references onto chat and turn user messages", () => {
    const inlineReferences = [
      {
        kind: "skill" as const,
        value: "/skill:writer",
        label: "Writer",
        start: 4,
      },
      {
        kind: "workspace_file" as const,
        value: "@docs/my plan.md",
        label: "my plan.md",
        start: 21,
      },
    ];
    const messages: StoredMessage[] = [
      {
        type: "user",
        id: "m1",
        turnId: "t1",
        ts: 1,
        text: "model envelope",
        displayText: "Use /skill:writer on @docs/my plan.md",
        inlineReferences,
      },
    ];

    assert.deepEqual(
      materializeChat(messages)[0]?.inlineReferences,
      inlineReferences,
    );
    assert.deepEqual(
      materializeTurns(messages)[0]?.user?.inlineReferences,
      inlineReferences,
    );
  });

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

  test("projects user message attachments onto the chat item", () => {
    const messages: StoredMessage[] = [
      {
        type: "user",
        id: "m1",
        turnId: "t1",
        ts: 1,
        text: "see this",
        attachments: [imageAttachment, codeAttachment],
      },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].attachments, [imageAttachment, codeAttachment]);
  });

  test("leaves attachments absent when the user message has none", () => {
    const messages: StoredMessage[] = [
      { type: "user", id: "m1", turnId: "t1", ts: 1, text: "plain prompt" },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].attachments, undefined);
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

  test("surfaces automatic context compaction system notes inline", () => {
    const messages: StoredMessage[] = [
      {
        type: "system_note",
        id: "note-1",
        turnId: "t1",
        ts: 1,
        kind: "context_compacted",
      },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].role, "system");
    assert.equal(
      items[0].text,
      "Context compacted to keep this session within the model window.",
    );
  });

  test("surfaces history compaction fail-open notices inline", () => {
    const messages: StoredMessage[] = [
      {
        type: "system_note",
        id: "note-1",
        turnId: "t1",
        ts: 1,
        kind: "context_compaction_failed_open",
      },
    ];
    const items = materializeChat(messages);
    assert.equal(items.length, 1);
    assert.equal(items[0].role, "system");
    assert.equal(
      items[0].text,
      "Context summary failed; the session continued without a new summary.",
    );
  });

  test("surfaces a step-limit system notice inline", () => {
    const items = materializeChat([
      {
        type: "system_note",
        id: "note-1",
        turnId: "t1",
        ts: 1,
        kind: "step_limit",
      },
    ]);

    assert.equal(items.length, 1);
    assert.equal(items[0].role, "system");
    assert.equal(
      items[0].text,
      "Reached the configured step limit. The task may be incomplete. Send “continue” to resume.",
    );
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

  // Only a turn that has itself ended makes the missing result mean the tool
  // never finished.
  for (const turnStatus of ["aborted", "failed", "completed"] as const) {
    test(`reads an unfinished call in a ${turnStatus} turn as interrupted`, () => {
      const [turn] = materializeTurns([
        userMsg("t1", 1, "run it"),
        {
          type: "turn_state",
          id: "s1",
          turnId: "t1",
          ts: 2,
          status: turnStatus,
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
  }

  // Sessions written before turn_state carry no record at all, so they keep
  // reading as interrupted rather than stranding old rows on a spinner.
  test("reads an unfinished call with no turn record as interrupted", () => {
    const [turn] = materializeTurns([
      userMsg("t1", 1, "run it"),
      {
        type: "tool_call",
        id: "bash-1",
        turnId: "t1",
        ts: 2,
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

  // Only the active session is subscribed and events do not replay, so a turn
  // that ends while the user is looking elsewhere leaves the projection frozen
  // mid-run; reconcileTerminalLiveTurn hands a tool off only once it is
  // interrupted or has a result, so a frozen `running` never clears itself. A
  // recorded terminal turn_state is what breaks the tie.
  for (const turnStatus of ["aborted", "failed", "completed"] as const) {
    test(`a stale live running loses to a ${turnStatus} turn`, () => {
      const settled = materializeTurns([
        userMsg("t1", 1, "run it"),
        {
          type: "turn_state",
          id: "s1",
          turnId: "t1",
          ts: 2,
          status: turnStatus,
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
      // The tail the user was watching still belongs to live — only the status
      // is taken back.
      assert.equal(tool?.outputChunks?.length, 1);
    });
  }

  // A legacy turn has no turn_state, so `status` falls back to an inferred
  // `completed`. That is a guess about old data, not evidence this turn ended,
  // and must not be allowed to take a status away from live.
  test("an inferred legacy status never overrides live", () => {
    const settled = materializeTurns([
      userMsg("t1", 1, "run it"),
      {
        type: "tool_call",
        id: "bash-1",
        turnId: "t1",
        ts: 2,
        toolName: "Bash",
        args: { command: "sleep 60" },
      },
    ]);
    assert.equal(settled[0]?.statusSource, "inferred");
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
              args: {},
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
