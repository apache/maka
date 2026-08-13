import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmConnection } from '@maka/core/llm-connections';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader, StoredMessage } from '@maka/core/session';
import type { ToolInvocationRecord } from '@maka/core/usage-stats/types';
import { ToolRuntime, type MakaTool } from '../tool-runtime.js';

/**
 * What crosses the Computer Use privacy boundary, and what does not.
 *
 * The rule is about values, not keys: a value that came off the screen or out
 * of a person's head is reduced to its shape, and every key the model sent is
 * kept, in the names the tool accepts. That second half is new. The persisted
 * args used to be the host's approval summary, which renames `window_id` to
 * `windowId`, adds two host-only fields and drops every argument it does not
 * need — and this record is what `model-history.ts` replays to the model as
 * its own call. The model read a dialect the tool rejects and went on using
 * it.
 *
 * Two things now cross that did not:
 *
 * `element_id` — an index the model chose into an observation it had already
 * read (`e12`). Not screen content; it is admitted only when it is a stable
 * identifier, so an accessibility label arriving under that key is dropped.
 *
 * `coordinate`, `start_coordinate`, `region` — geometry the model wrote into
 * the call itself. Not read off the screen; integers only, so a mistyped value
 * still degrades to a shape. Withholding them left a model that clicked a
 * point and missed unable to tell that it had already tried that point.
 *
 * What still does not cross: the value of `text` for `type` and `select_text`,
 * the value of `set_value`, and anything else whose value is screen content or
 * something a person asked to have typed. `text` for `press_key`, `key`,
 * `hold_key` and `secondary_action` is a name from a closed set the executor
 * publishes, so it is carried — that is one argument name meaning six things,
 * and only two of the six come from outside the model.
 */
test('Computer Use snapshots execution args and persists the model-facing projection', async () => {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const invocations: ToolInvocationRecord[] = [];
  const observedImplArgs: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    recordToolInvocation: (record) => {
      invocations.push(record);
    },
  });
  const tool: MakaTool = {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    categoryHint: 'computer_use',
    impl: async (args) => {
      await gate;
      observedImplArgs.push(args);
      return { ok: true };
    },
  };
  const args = {
    action: 'type',
    app: 'Example',
    observation_id: 'frame-1',
    text: 'secret text',
    coordinate: [123, 456],
  };
  const execution = runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    input: args,
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });

  args.app = 'Mutated';
  args.observation_id = 'frame-999';
  args.text = 'changed secret';
  args.coordinate[0] = 999;
  release();
  await execution;

  assert.deepEqual(observedImplArgs, [
    {
      action: 'type',
      app: 'Example',
      observation_id: 'frame-1',
      text: 'secret text',
      coordinate: [123, 456],
    },
  ]);
  const expectedArgs = {
    action: 'type',
    app: 'Example',
    observation_id: 'frame-1',
    // The typed value never crosses; the key does, or the model reads back a
    // `type` call it never made.
    text: '<text:11>',
    // The model's own four digits, so it can see that it already tried here.
    coordinate: [123, 456],
  };
  const call = messages.find((message) => message.type === 'tool_call');
  assert.deepEqual(call?.type === 'tool_call' ? call.args : undefined, expectedArgs);
  const start = events.find((event) => event.type === 'tool_start');
  assert.deepEqual(start?.type === 'tool_start' ? start.args : undefined, expectedArgs);
  assert.equal(invocations.length, 1);
  assert.doesNotMatch(invocations[0]!.argsSummary ?? '', /secret/);
  // Host-only fields that the approval summary added and the model never sent.
  assert.doesNotMatch(invocations[0]!.argsSummary ?? '', /approvalClass|rememberForTurnAllowed/);
  // The dialect the tool actually accepts, not the approval summary's.
  assert.doesNotMatch(invocations[0]!.argsSummary ?? '', /windowId|observationId/);
});

/**
 * The seam. `computer-use.test.ts` covers the projection as a function, but the
 * defect was not in the projection — it was in which projection this line
 * called, and only the runtime decides that. A model reads its history back
 * through `model-history.ts`, which replays `event.content.args`, so the
 * `tool_start` event is the exact surface to assert on: a test that calls
 * `computerUseModelCallArgs` directly stays green while the runtime writes the
 * approval summary, which is how this survived being fixed once already in a
 * backend the desktop app never instantiates.
 */
test('the record a model reads back is the call it made, in the names the tool accepts', async () => {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
  const tool: MakaTool = {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    categoryHint: 'computer_use',
    // What the real Computer Use tool does: resolves the model's element_id
    // against the live observation and attaches the host's own identity.
    permissionArgs: (args) => ({
      ...(args as Record<string, unknown>),
      element_identity: { role: 'AXButton', label: 'Customer SSN 123-45-6789' },
    }),
    impl: async () => ({ ok: true }),
  };

  await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    input: {
      action: 'press_key',
      app: 'TextEdit',
      window_id: 41,
      observation_id: 'obs-7',
      element_id: 'e12',
      text: 'cmd+s',
    },
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });

  const start = events.find((event) => event.type === 'tool_start');
  const persisted = start?.type === 'tool_start' ? start.args : undefined;
  assert.deepEqual(persisted, {
    action: 'press_key',
    app: 'TextEdit',
    // `window_id`, not `windowId`: the key the tool accepts.
    window_id: 41,
    observation_id: 'obs-7',
    // Which control, so ten element actions in a turn are ten distinct rows.
    element_id: 'e12',
    // The key that was pressed. Under the approval summary this was a
    // `press_key` with no key at all.
    text: 'cmd+s',
  });
  // The host's resolution of that element is not something the model can send,
  // and its label is screen content.
  assert.doesNotMatch(JSON.stringify({ messages, events }), /element_identity|Customer SSN/);
  // The two surfaces a reader can see must agree.
  const call = messages.find((message) => message.type === 'tool_call');
  assert.deepEqual(call?.type === 'tool_call' ? call.args : undefined, persisted);
});

/**
 * The other half of the same boundary. Withholding a typed value is correct;
 * withholding which element was acted on is not, and it is what made every
 * element row in a turn read the same. This asserts on the events the runtime
 * emits, not on a hand-built row: the renderer only ever sees this projection,
 * so a label test that builds its own `args` cannot notice the field is gone.
 */
test('Computer Use persists which element a call targeted', async () => {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
  });
  const tool: MakaTool = {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    categoryHint: 'computer_use',
    impl: async () => ({ ok: true }),
  };
  const persisted = async (elementId: string): Promise<unknown> => {
    messages.length = 0;
    events.length = 0;
    await runtime.settleToolCall({
      tool,
      turnId: 'turn-1',
      toolCallId: `tool-${elementId}`,
      input: {
        action: 'click_element',
        app: 'Calculator',
        window_id: 7,
        observation_id: 'frame-1',
        element_id: elementId,
      },
      abortSignal: new AbortController().signal,
      eventSink: {
        push: (event) => events.push(event),
        pushAndWaitUntilConsumed: async (event) => {
          events.push(event);
        },
      },
    });
    const start = events.find((event) => event.type === 'tool_start');
    const call = messages.find((message) => message.type === 'tool_call');
    // The two surfaces a renderer can read must agree.
    assert.deepEqual(
      start?.type === 'tool_start' ? start.args : undefined,
      call?.type === 'tool_call' ? call.args : undefined,
    );
    return start?.type === 'tool_start' ? start.args : undefined;
  };

  // This object is the dialect, not an example of it. `computerActionLabel` in
  // `packages/ui/src/tool-activity/computer-action-label.ts` and
  // `computerCallSummary` in `packages/cli/src/pi-transcript-tools.ts` read
  // these exact key names off the persisted args, and they are the only things
  // that turn a Computer Use row into a sentence. Respell them at the seam —
  // `window_id` to `windowId`, `element_id` to `elementId` — and both renderers
  // silently fall back to "点击该元素" on every row, which is the defect this
  // projection exists to prevent. Neither renderer's own suite can see it: both
  // build their fixtures by calling a projection, so respelling the seam leaves
  // them green. Change this assertion and those two files in one commit.
  assert.deepEqual(await persisted('e7'), {
    action: 'click_element',
    app: 'Calculator',
    window_id: 7,
    observation_id: 'frame-1',
    element_id: 'e7',
  });
  // Two clicks in one turn have to be distinguishable, which is the whole
  // reason the field is carried.
  assert.equal(((await persisted('e9')) as { element_id?: string }).element_id, 'e9');
  // A shape filter is not a privacy boundary. Arguments are not validated
  // before this projection runs — the test below asserts an invalid call still
  // persists a record — so a model that put a key under `element_id` reaches
  // here, and the identifier shape `[A-Za-z0-9._:-]{1,256}` admits one. It is
  // redacted at the seam, on the same terms `app` already is, because this is
  // the object that lands in the transcript and in the model's own history.
  assert.equal(
    (
      (await persisted('sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh')) as {
        element_id?: string;
      }
    ).element_id,
    '[redacted]',
  );
  // Free text under that key is kept, deliberately: the model has to read back
  // the call it made, and an element id it invented is still what it sent. The
  // renderers are what refuse to print one — `computer-action-label.test.ts`
  // pins that — because a row is read by a person and this record is read by
  // the model that wrote it.
  assert.equal(
    ((await persisted('Customer SSN 123-45-6789')) as { element_id?: string }).element_id,
    'Customer SSN 123-45-6789',
  );
});

test('the model reads its own call back in the names the tool accepts', async () => {
  // The record replayed to the model used to be the host's approval
  // projection: `approvalClass`, `rememberForTurnAllowed`, `windowId`. Two of
  // those are not arguments at all and the third is a key the tool rejects, so
  // the model went on calling it that way — six of eleven calls on a real
  // desktop run, and 29 rejections in this machine's telemetry.
  const events: SessionEvent[] = [];
  const runtimeEvents: unknown[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async () => {},
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    runId: 'run-1',
    runtimeCommitSink: {
      commitToolPrepared: async (input) => {
        runtimeEvents.push(input.runtimeEvent);
        return { status: 'committed' as const, created: true, runtimeEventSeq: 1 };
      },
      commitToolOutcome: async () => ({
        status: 'committed' as const,
        created: true,
        runtimeEventSeq: 2,
      }),
    },
  });
  const tool: MakaTool = {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    categoryHint: 'computer_use',
    impl: async () => ({ ok: true }),
  };
  await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-1',
    input: {
      action: 'click_element',
      app: 'Example',
      window_id: 12747,
      observation_id: 'frame-1',
      element_id: '7',
    },
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });
  const call = runtimeEvents.find(
    (event) => (event as { content?: { kind?: string } }).content?.kind === 'function_call',
  ) as { content: { args: Record<string, unknown> } } | undefined;
  assert.deepEqual(call?.content.args, {
    action: 'click_element',
    app: 'Example',
    window_id: 12747,
    observation_id: 'frame-1',
    element_id: '7',
  });
});

test('Computer Use validation failures still persist a redacted call and result', async () => {
  const messages: StoredMessage[] = [];
  const events: SessionEvent[] = [];
  const invocations: ToolInvocationRecord[] = [];
  const runtime = createTestToolRuntime({
    sessionId: 'session-1',
    header: header(),
    connection: connection(),
    modelId: 'mock-model',
    appendMessage: async (message) => {
      messages.push(message);
    },
    newId: nextId(),
    now: () => 1,
    getPermissionPauseTarget: () => null,
    recordToolInvocation: (record) => {
      invocations.push(record);
    },
  });
  const tool: MakaTool = {
    name: 'maka_computer',
    description: 'test',
    parameters: {},
    categoryHint: 'computer_use',
    permissionArgs: () => {
      throw new Error('AX label: Customer SSN 123-45-6789');
    },
    impl: async () => {
      assert.fail('invalid arguments must not reach the implementation');
    },
  };

  const { result } = await runtime.settleToolCall({
    tool,
    turnId: 'turn-1',
    toolCallId: 'tool-invalid',
    input: {
      action: 'type',
      text: 'private text',
      coordinate: [123, 456],
    },
    abortSignal: new AbortController().signal,
    eventSink: {
      push: (event) => events.push(event),
      pushAndWaitUntilConsumed: async (event) => {
        events.push(event);
      },
    },
  });

  assert.equal((result as { error?: string }).error, 'Computer Use arguments failed validation');
  const serialized = JSON.stringify({ messages, events, invocations });
  // The AX label thrown by `permissionArgs` and the value the model asked to
  // have typed both stay out. `123|456` is no longer part of this pattern: it
  // matched the model's own coordinate, which now crosses on purpose, and it
  // also matched the first three digits of the SSN, so the two could not be
  // told apart. The SSN is asserted in full instead.
  assert.doesNotMatch(serialized, /Customer SSN|123-45-6789|private text/);
  // A rejected call is exactly when the model most needs to see what it sent.
  const start = events.find((event) => event.type === 'tool_start');
  assert.deepEqual(start?.type === 'tool_start' ? start.args : undefined, {
    action: 'type',
    text: '<text:12>',
    coordinate: [123, 456],
  });
  assert.equal(
    messages.some((message) => message.type === 'tool_call'),
    true,
  );
  assert.equal(
    messages.some((message) => message.type === 'tool_result'),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'tool_start'),
    true,
  );
  assert.equal(
    events.some((event) => event.type === 'tool_result'),
    true,
  );
  assert.equal(invocations[0]?.errorClass, 'InvalidArguments');
});

function nextId(): () => string {
  let sequence = 0;
  return () => `id-${++sequence}`;
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace',
    cwd: '/workspace',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'mock-model',
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function connection(): LlmConnection {
  return {
    slug: 'test',
    name: 'Test',
    providerType: 'openai-compatible',
    baseUrl: 'https://example.invalid',
    defaultModel: 'mock-model',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
